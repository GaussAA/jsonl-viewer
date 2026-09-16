/**
 * logic.ts — webview 前端的纯逻辑层（无 DOM / 无 acquireVsCodeApi 依赖）。
 *
 * 所有函数与类都能在 node:test 下直接单测（不依赖浏览器 / vscode 全局），
 * 是虚拟滚动正确性的单一事实来源。包含：
 *   - LRUCache             : 记录缓存（容量上限，命中即提升 recency）。
 *   - ThrottleQueue        : 「节流 + 合并」调度器，合并同窗口请求、避免请求风暴。
 *   - VirtualListLayout    : 可变行高虚拟列表的位置数学（scrollTop <-> line 双向 + 可视区裁剪）。
 *   - computeFetchWindow   : 计算「应新拉取」的缺失行的连续窗口，避免重复解析已缓存行。
 *   - 摘要格式化           : formatValue / summarizeRecord / truncate / 概览数字格式化。
 *
 * 行高策略：默认行高 + 已渲染行「实测覆盖」。仅记录精确访问到的行（存储以 Map<line,height>，
 * 稀疏、与可视区成正比）。任意两条（默认高度、实测高度）之间用二分定位 + 从锚点向前累计，
 * 因此单个滚轮事件的计算量 O(可见区)，与总行数无关。
 */

/* ------------------------------ LRU 缓存 ------------------------------ */

export class LRUCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  /** 命中即提升 recency；返回 undefined 表示未命中。 */
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // re-insert -> move to tail (most recent)
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  /** 是否存在（不改变 recency）。 */
  has(key: K): boolean {
    return this.map.has(key);
  }

  /**
   * 写入。超容量时逐出最久未使用项，返回被逐出的值（用于决定是否释放持有的大对象）；
   * 没有逐出则返回 undefined。
   */
  set(key: K, value: V): V | undefined {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    let evicted: V | undefined;
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as K;
      evicted = this.map.get(oldest);
      this.map.delete(oldest);
    }
    return evicted;
  }

  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  /** 迭代（从最旧到最新），供测试/调优遍历。 */
  *entries(): IterableIterator<[K, V]> {
    yield* this.map.entries();
  }
}

/* ---------------------- 节流 + 合并调度器 ---------------------- */

/**
 * 合并「同一目的」的高频触发，且保证任意时刻最多一个 worker 在执行。
 *
 * - push(v): 只记录最新值 + 安排一次窗口后的执行；窗口内多次 push 合并为一次。
 * - 若某次执行进行中又有 push，则 worker 结束后的「尾随 drain」会用最新值再跑一次，
 *   （中间被覆盖的中间值会被完全跳过，脏数据不执行）。
 * - 由此天然满足「防抖/节流 + 取消在途（以覆盖方式代替真正中止）」的列表拉取需求：
 *   滚动再快也只会产生 1~2 个 readRecords，且始终只请求最新的可视窗口。
 */
export class ThrottleQueue<T> {
  private latest: T | undefined;
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private readonly minIntervalMs: number;
  private readonly worker: (v: T) => void | Promise<void>;

  constructor(minIntervalMs: number, worker: (v: T) => void | Promise<void>) {
    this.minIntervalMs = minIntervalMs;
    this.worker = worker;
  }

  push(v: T): void {
    this.latest = v;
    this.pending = true;
    if (this.running) return; // 尾随 drain 会带上本轮的最新值
    if (this.timer) return; // 已安排执行窗口
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, this.minIntervalMs);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const v = this.latest as T;
        this.pending = false;
        // await：worker 内可以通过异步节奏聚合，期间新 push 只更新 latest。
        await this.worker(v);
      }
    } finally {
      this.running = false;
      if (this.pending) this.pushImpl(); // 执行期间又来了新值，补一次
    }
  }

  private pushImpl(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, this.minIntervalMs);
  }

  /** 立即执行（若有未执行的待办），用于重置/resize 等确定性时机。 */
  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    void this.drain();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = false;
  }
}

/* ------------------- 可变行高虚拟列表位置数学 ------------------- */

interface ItemMeta {
  /** 从列表顶（第 0 行）到本行起始的累计像素偏移。 */
  offset: number;
  /** 本行的像素高度（实测或回退默认）。 */
  size: number;
}

/** 可视区裁剪参数：可视行上/下各多渲染 N 行为缓冲区。 */
export const OVERSCAN_ROWS = 10;

/**
 * 可变行高虚拟列表的「位置引擎」（纯逻辑，可用任何数据源驱动）。
 *
 * 维护：
 *   - `measured: Map<line,px>`  实际测量到的行高（稀疏，只含渲染过的行）。
 *   - `meta: ItemMeta[]`        累计偏移缓存（0..lastBuilt 精确、其后按默认高度补足），
 *                                惰性构建，只随实际访问/渲染向前推进，两次访问间 O(1) 命中。
 *
 * 任意高度被修改（setSize）时，将其后的累计偏移作废，保证偏移永远一致。
 */
export class VirtualListLayout {
  private readonly meta: ItemMeta[] = [];
  private readonly measured = new Map<number, number>();
  defaultSize: number;

  constructor(defaultSize: number = DEFAULT_ROW_HEIGHT) {
    this.defaultSize = defaultSize;
  }

  /** 确保 meta 已构建到 index（含），不足则按 measured/default 顺序补齐。 */
  private ensureMeta(index: number): void {
    const from = this.meta.length;
    if (from > index) return;
    let offset = from === 0 ? 0 : this.meta[from - 1].offset + this.meta[from - 1].size;
    let i = from;
    while (i <= index) {
      const size = this.measured.get(i) ?? this.defaultSize;
      this.meta.push({ offset, size });
      offset += size;
      i++;
    }
  }

  /** 第 index 行起始的累计偏移（line -> scrollTop 方向）。 */
  getItemOffset(index: number): number {
    if (index < 0) return 0;
    this.ensureMeta(index);
    return this.meta[index].offset;
  }

  /** 第 index 行的像素高度（实测优先，否则默认）。 */
  getItemSize(index: number): number {
    return this.measured.get(index) ?? this.defaultSize;
  }

  /** 已测量到的行高；未测量则 undefined。 */
  getMeasured(index: number): number | undefined {
    return this.measured.get(index);
  }

  /** 设行高并作废其后的累计偏移。 */
  setSize(index: number, size: number): void {
    const clamped = Number.isFinite(size) && size > 0 ? size : this.defaultSize;
    if (this.measured.get(index) === clamped) return;
    this.measured.set(index, clamped);
    this.resetFrom(index);
  }

  /** meta 只保留 [0, index)，其后的作废（下次访问会基于真实 measured 重建）。 */
  private resetFrom(index: number): void {
    if (index <= 0) {
      this.meta.length = 0;
      return;
    }
    this.meta.length = Math.min(this.meta.length, index);
  }

  /**
   * scrollTop -> line 方向：返回顶行位于该偏移处的行号。
   * 用一个「按默认高度估算的行号」先建立精确前缀，再二分 + 少量向前补齐，
   * 使典型滚动场景为 O(1)～O(可见区)；极端大跳转一次摊销 O(目标行/默认高)。
   */
  findStartIndex(scrollTop: number): number {
    if (scrollTop <= 0) return 0;
    // 以默认高度估算为下界，保证能覆盖到的偏移足够二分（若前面有更高的实测行，这里还会再补）。
    const est = Math.max(0, Math.floor(scrollTop / this.defaultSize));
    this.ensureMeta(est);
    let guard = 0;
    while (this.meta[this.meta.length - 1].offset <= scrollTop) {
      this.ensureMeta(this.meta.length); // 追加一行
      if (++guard > 1_000_000) break; // 防御
    }
    // 二分：最大的 i，使 meta[i].offset <= scrollTop
    let lo = 0;
    let hi = this.meta.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.meta[mid].offset <= scrollTop) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  /**
   * 可视区裁剪：由 scrollTop + 视口高度 -> [first, lastExclusive)，上下各带 overscan 行缓冲。
   */
  getVisibleRange(
    scrollTop: number,
    viewportHeight: number,
    overscan = OVERSCAN_ROWS
  ): { first: number; lastExclusive: number } {
    const first = Math.max(0, this.findStartIndex(scrollTop) - overscan);
    let end = first;
    const limitPx = scrollTop + viewportHeight;
    let guard = 0;
    while (this.getItemOffset(end) <= limitPx) {
      end++;
      if (++guard > 5_000_000) break; // 防御越界
    }
    end += overscan;
    return { first, lastExclusive: end };
  }

  /** 整列表的总像素高度（含最后一行的高度）。 */
  totalSize(totalRows: number): number {
    if (totalRows <= 0) return 0;
    this.ensureMeta(totalRows - 1);
    const last = totalRows - 1;
    return this.meta[last].offset + this.meta[last].size;
  }
}

/* ------------------- 缺失拉取窗口 ------------------- */

export interface FetchWindow {
  start: number;
  count: number;
}

/**
 * 计算应新拉取的连续子窗口：跳过两端已缓存的连续行，只请求中间缺失段。
 * 返回 null 表示全部已缓存/无缺失。这样可最大限度减少对后端的重复解析。
 */
export function computeFetchWindow(
  wantStart: number,
  wantEnd: number,
  isLoaded: (line: number) => boolean
): FetchWindow | null {
  if (wantEnd <= wantStart) return null;
  let s = wantStart;
  while (s < wantEnd && isLoaded(s)) s++;
  if (s >= wantEnd) return null;
  let e = wantEnd;
  while (e > s && isLoaded(e - 1)) e--;
  return { start: s, count: e - s };
}

/* ------------------- 摘要格式化 ------------------- */

export interface FieldLike {
  key: string;
  type?: string;
  freq?: number;
}

/** 列表卡片的默认行高估算（px）。 */
export const DEFAULT_ROW_HEIGHT = 64;
/** 顶层摘要字段个数上限。 */
export const MAX_TOP_LEVEL_KEYS = 4;
/** 单字段展示的字符串最大长度（超出省略）。 */
export const MAX_STRING_LEN = 120;

/** 字符串超长省略。 */
export function truncate(value: string, max = MAX_STRING_LEN): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + '…';
}

/** 任意 JSON 值 -> 摘要展示文本；对象/数组用折叠提示，字符串超长省略。 */
export function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'string') return truncate(v as string);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
  if (Array.isArray(v)) return `[…] (${v.length} item${v.length === 1 ? '' : 's'})`;
  if (t === 'object') {
    const n = Object.keys(v as object).length;
    return `{…} (${n} field${n === 1 ? '' : 's'})`;
  }
  return String(v);
}

/**
 * 根据字段推断（FieldInfo，可空）挑选摘要字段；无推断时回退到「粗略取前几个顶层 key」。
 * 只返回键确实存在于记录中的字段；不足以展示时再用顶层 key 补齐。
 */
export function summarizeRecord(
  value: unknown,
  fields?: readonly FieldLike[] | null
): { key: string; display: string }[] {
  if (value === null || value === undefined) return [{ key: '', display: formatValue(value) }];
  const t = typeof value;
  if (t !== 'object' || Array.isArray(value)) {
    return [{ key: '', display: formatValue(value) }];
  }
  const rec = value as Record<string, unknown>;
  const keys: string[] = [];
  const used = new Set<string>();
  if (fields && fields.length > 0) {
    for (const f of fields) {
      if (f.key in rec && !used.has(f.key)) {
        keys.push(f.key);
        used.add(f.key);
        if (keys.length >= MAX_TOP_LEVEL_KEYS) break;
      }
    }
  }
  if (keys.length < Math.min(MAX_TOP_LEVEL_KEYS, Object.keys(rec).length)) {
    for (const k of Object.keys(rec)) {
      if (used.has(k)) continue;
      keys.push(k);
      used.add(k);
      if (keys.length >= MAX_TOP_LEVEL_KEYS) break;
    }
  }
  if (keys.length === 0) return [{ key: '', display: '{}' }];
  return keys.map((k) => ({ key: k, display: formatValue(rec[k]) }));
}

/* ------------------- 概览格式化 ------------------- */

export function formatBuildMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}