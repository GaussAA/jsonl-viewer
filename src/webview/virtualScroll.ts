/**
 * virtualScroll.ts — 虚拟滚动的 DOM 渲染层（vanilla TS，自研，不用框架）。
 *
 * 位置数学全部委托给 logic.ts 的 VirtualListLayout（纯逻辑、可单测）；
 * 本模块只负责：
 *   - 维护 scroll 容器 + 绝对定位的卡片元素与「元素对象池」；
 *   - 用 requestAnimationFrame 合并 DOM 写入（切可见区、复用/回收、测量、重定位）；
 *   - 行高实测回写（进入视口时测 offsetHeight -> layout.setSize），随后一个 rAF 再重排一次。
 *
 * 内存策略：DOM 只存在「可视区 + overscan」个卡片；离开范围的卡片回收到对象池（清空内容
 * 引用即可释放底层记录对象）。整个列表的 DOM 节点数 O(可见区)，与总行数无关。
 */

import {
  FieldLike,
  OVERSCAN_ROWS,
  summarizeRecord,
  VirtualListLayout,
} from './logic.ts';

export interface RecordEntry {
  value?: unknown;
  ok: boolean;
  error?: string;
}

export interface ListCallbacks {
  /** 按行号取已加载的记录；未加载返回 undefined（渲染「加载中…」占位）。 */
  getRecord(line: number): RecordEntry | undefined;
  getFields(): readonly FieldLike[] | null;
  /** 可选：用「字段显示定制布局」输出卡片摘要；缺省回落 summarizeRecord。 */
  summarize?(value: unknown): { key: string; display: string }[];
  onSelect(line: number): void;
  /** 可视区窗口变化，通知控制器按需拉取。 */
  onRangeChange(first: number, lastExclusive: number): void;
}

export class VirtualRecordList {
  readonly scrollEl: HTMLElement;
  private readonly inner: HTMLElement;
  private readonly layout = new VirtualListLayout();
  private readonly placed = new Map<number, HTMLElement>(); // 展示位 -> card（当前在 DOM）
  private readonly pool: HTMLElement[] = []; // 可复用的游离卡片
  private rawTotal = 0; // 底层总行数（未过滤）
  private totalRows = 0; // 展示行数（过滤后即 translation 长度）
  /** 展示位 -> 真实行号；null 表示不过滤（展示位 == 真实行号）。 */
  private translation: number[] | null = null;
  private selectedLine: number | undefined;
  private dirty = false;
  private rafId = 0;
  private disposed = false;

  constructor(
    private readonly cb: ListCallbacks,
    private readonly overscan = OVERSCAN_ROWS
  ) {
    const scroll = document.createElement('div');
    scroll.className = 'jlv-scroll';
    const inner = document.createElement('div');
    inner.className = 'jlv-inner';
    scroll.appendChild(inner);
    scroll.addEventListener('scroll', () => this.schedule());
    this.scrollEl = scroll;
    this.inner = inner;
  }

  setTotalRows(n: number): void {
    this.rawTotal = n;
    if (this.translation) {
      this.totalRows = this.translation.length;
    } else {
      if (n === this.totalRows) return;
      this.totalRows = n;
    }
    this.schedule();
  }

  /**
   * 设置过滤显示的展示位 -> 真实行号映射。传 null 清除过滤（恢复全量）。
   * 行高按「展示位」记录；过滤态下滚动条长度随筛选结果行数伸缩。
   */
  setTranslation(rows: number[] | null): void {
    this.translation = rows;
    this.totalRows = this.translation ? this.translation.length : this.rawTotal;
    // 保存滚动位置尽力：不清 scrollTop。
    this.schedule();
  }

  /** 展示位 -> 真实行号。 */
  private realLine(d: number): number {
    return this.translation ? this.translation[d] : d;
  }

  /** 真实行号 -> 展示位（不命中返回 -1）。 */
  private displayPosOf(real: number): number {
    if (!this.translation) return real >= 0 && real < this.rawTotal ? real : -1;
    const idx = this.translation.indexOf(real);
    return idx;
  }

  /** 数据到达 / 字段变化 / resize 后希望刷新当前可视内容时调用。 */
  refresh(): void {
    this.schedule();
  }

  /** 立刻同步重排一次（用于确定性的初始渲染 / 重置）。仍走 rAF 约定的同一步骤。 */
  flushNow(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.renderOnce();
  }

  /** 跳转到指定**真实行**（滚动该行到顶）。过滤态下映射到对应展示位。 */
  scrollToLine(line: number): void {
    let d = this.displayPosOf(line);
    if (d < 0) d = 0; // 不在当前过滤集合时，兜底到列表顶部（尽力）。
    const dst = Math.max(0, Math.min(d, Math.max(0, this.totalRows - 1)));
    const top = this.layout.getItemOffset(dst);
    this.scrollEl.scrollTop = top;
    this.schedule();
  }

  getScrollTop(): number {
    return this.scrollEl.scrollTop;
  }

  select(line: number): void {
    this.selectedLine = line;
    this.applySelection();
  }

  getSelected(): number | undefined {
    return this.selectedLine;
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.pool.length = 0;
    this.placed.clear();
  }

  /* ------------------------------ 内部 ------------------------------ */

  private schedule(): void {
    if (this.disposed) return;
    if (this.rafId) return; // 已排入本轮 rAF，合并写入
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.renderOnce();
      if (this.needsReposition) {
        this.needsReposition = false;
        this.rafId = requestAnimationFrame(() => {
          this.rafId = 0;
          this.renderOnce();
        });
      }
    });
  }

  private needsReposition = false;

  /** 单次渲染：切可视区 -> 填内容 -> 定位 -> 测量。 */
  private renderOnce(): void {
    if (this.totalRows <= 0) {
      this.cleanupAll();
      this.inner.style.height = '0px';
      return;
    }
    const scrollTop = this.scrollEl.scrollTop;
    const viewportHeight = this.scrollEl.clientHeight || window.innerHeight;
    const range = this.layout.getVisibleRange(scrollTop, viewportHeight, this.overscan);
    const last = Math.min(range.lastExclusive, this.totalRows);

    // 1) 回收离开可视区（含 overscan）的卡片进对象池（按展示位判定）
    for (const [d, el] of Array.from(this.placed.entries())) {
      if (d >= range.first && d < last) continue;
      this.placed.delete(d);
      el.remove();
      this.pool.push(el);
    }

    // 2) 确保可视区卡片存在并填内容（仅进入视口时构建一次）
    let measuredSomething = false;
    for (let d = range.first; d < last; d++) {
      let el = this.placed.get(d);
      if (!el) {
        el = this.acquire();
        this.fill(el, d);
        el.style.top = `${this.layout.getItemOffset(d)}px`;
        this.inner.appendChild(el);
        this.placed.set(d, el);
        // 首次渲染该展示位时测量实际高度并回写布局
        const h = el.offsetHeight;
        this.layout.setSize(d, h);
        measuredSomething = true;
      }
    }

    // 2b) 重灌仍处于「加载中/占位」、但此刻数据已可从缓存取到的卡片。
    //     此前首次渲染时缓存为空，只填了占位；数据到达后 refresh() 不会重灌已在
    //     视图内的卡片，导致列表永远停“加载中…”。这里按需补一次真实内容。
    for (const [d, el] of this.placed) {
      if (el.dataset.loaded === '0') {
        const entry = this.cb.getRecord(this.realLine(d));
        if (entry) {
          this.fill(el, d);
          const h = el.offsetHeight; // 真实内容高度可能与占位不同，需重测
          this.layout.setSize(d, h);
          measuredSomething = true;
        }
      }
    }

    if (measuredSomething) this.needsReposition = true;

    // 3) 定位所有在位卡片（测量可能已让偏移变化）
    for (const [d, el] of this.placed) {
      el.style.top = `${this.layout.getItemOffset(d)}px`;
    }

    // 4) 更新总高度
    this.inner.style.height = `${this.layout.totalSize(this.totalRows)}px`;

    // 5) 通知控制器当前窗口（展示位范围；webview 会映射为真实行拉取）
    this.cb.onRangeChange(range.first, last);

    this.applySelection();
  }

  private acquire(): HTMLElement {
    return this.pool.pop() ?? this.createCard();
  }

  private createCard(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'jlv-card';
    card.addEventListener('click', () => {
      const line = Number(card.dataset.line);
      if (Number.isNaN(line)) return;
      // 坏行也允许选中（详情面板展示错误信息），由 onSelect 处理器据此分派。
      this.cb.onSelect(line);
    });
    return card;
  }

  private fill(el: HTMLElement, d: number): void {
    const real = this.realLine(d);
    el.dataset.line = String(real);
    el.textContent = ''; // 清空旧内容（复用池节点）
    el.classList.remove('error', 'selected');
    const entry = this.cb.getRecord(real);

    const lineNo = document.createElement('span');
    lineNo.className = 'jlv-line-no';
    lineNo.textContent = `L${real + 1}`;
    el.appendChild(lineNo);

    if (!entry) {
      el.dataset.loaded = '0'; // 仍为占位，等数据到位后由 renderOnce 2b) 重灌
      const hint = document.createElement('span');
      hint.className = 'jlv-tombstone';
      hint.textContent = '加载中…';
      el.appendChild(hint);
      return;
    }

    el.dataset.loaded = '1';

    if (entry.ok === false) {
      el.classList.add('error');
      const bad = document.createElement('div');
      bad.className = 'jlv-card-bad';
      bad.textContent = entry.error ?? 'invalid JSON';
      el.appendChild(bad);
      return;
    }

    const fields = this.cb.getFields();
    const items = this.cb.summarize
      ? this.cb.summarize(entry.value)
      : summarizeRecord(entry.value, fields);
    for (const { key, display } of items) {
      const row = document.createElement('div');
      row.className = 'jlv-kv';
      const k = document.createElement('span');
      k.className = 'key';
      k.textContent = key;
      const v = document.createElement('span');
      v.className = `val ${valueTypeClass(display)}`;
      v.textContent = display;
      v.title = display;
      row.appendChild(k);
      row.appendChild(v);
      el.appendChild(row);
    }
  }

  private applySelection(): void {
    for (const [line, el] of this.placed) {
      el.classList.toggle('selected', line === this.selectedLine);
    }
  }

  private cleanupAll(): void {
    for (const el of this.placed.values()) el.remove();
    this.placed.clear();
    this.pool.length = 0;
  }
}

/** 依据展示文本前缀给值着色（细则：字符串/数值走主题色，其余默认前景）。 */
function valueTypeClass(display: string): string {
  if (display.startsWith('"')) return 'str';
  if (/^-?\d/.test(display)) return 'num';
  return '';
}