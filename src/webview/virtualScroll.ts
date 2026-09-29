/**
 * virtualScroll.ts — 左侧记录目录的 DOM 渲染层（vanilla TS，无框架）。
 *
 * 翻页式目录：固定每页 PAGE_SIZE 条，上一页/下一页 + 窗口式页码跳转切换，不再用无限滚动。
 * 设计体系（docs/DESIGN_SYSTEM.md §3.3 / §3.4 / §4.1）：
 *   - 窗口式页码：固定 7 槽位（首页 + 当前页±1 + 末页 + 省略号），任意页数宽度恒定；
 *   - 换页动画：旧卡片逐个向左滑出消失 → 新卡片从右逐个滑入（错峰）；
 *   - 卡片化：圆角浮卡 + hover 上浮 + 选中左高亮条生长（样式在 styles.ts）。
 *   - 只渲染「当前页」的固定条数 DOM，与总行数无关，超大文件也不卡。
 */

import type { FieldLike } from './logic.ts';
import { parseJumpTarget } from './logic.ts';
import { findRanges } from '../core/query.ts';
import { renderHighlight } from './utils.ts';

/** 目录每页固定条数。 */
export const PAGE_SIZE = 20;

export interface RecordEntry {
  value?: unknown;
  ok: boolean;
  error?: string;
  /** 有界摘要（列表卡片渲染用）；阶段三起宿主对 ok 记录始终提供。 */
  summary?: { key: string; display: string }[];
  /** 超大对象被截断（完整值须经 READ_RECORD 按需拉取）。 */
  truncated?: boolean;
  /** 值类型（徽章用），截断态下仍能渲染徽章。 */
  kind?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  /** 顶层 key 数(object)/元素数(array)，徽章用。 */
  count?: number;
}

/** 选中时的修饰键状态（决定是单选、切换选中还是范围选择）。 */
export interface SelectMods {
  /** Ctrl / Cmd：切换该行的选中状态（多选）。 */
  ctrl: boolean;
  /** Shift：从锚点到该行做范围选择。 */
  shift: boolean;
}

/** 无修饰键（键盘导航、程序化选中用）。 */
const NO_MODS: SelectMods = { ctrl: false, shift: false };

export interface ListCallbacks {
  /** 按行号取已加载的记录；未加载返回 undefined（渲染「加载中…」占位）。 */
  getRecord(line: number): RecordEntry | undefined;
  getFields(): readonly FieldLike[] | null;
  /** 可选：字段摘要（无 summary 时回退用）。 */
  summarize?(value: unknown): { key: string; display: string }[];
  /** 选中某行；`mods` 携带修饰键，由调用方决定如何更新选区。 */
  onSelect(line: number, mods: SelectMods): void;
  /** 当前页展示位区间变化（[first, lastExclusive)），通知控制器按需拉取。 */
  onRangeChange(first: number, lastExclusive: number): void;
  /** 可选：跳转到源文件对应行（右键「定位到源码行」）。 */
  onJumpToSource?(line: number): void;
  /** 可选：编辑该行（右键「编辑第 N 行」打开编辑浮层）。 */
  onEditRecord?(line: number): void;
  /** 可选：删除该行（右键「删除第 N 行」；**二次确认由调用方负责**）。 */
  onDeleteRecord?(line: number): void;
  /** 可选：在本行之前插入一行（右键「在第 N 行前插入」）。 */
  onInsertRecord?(line: number): void;
  /** 可选：删除选中的多行（右键菜单；选区 > 1 行时出现）。 */
  onDeleteSelected?(): void;
  /** 可选：复制选中的多行（右键菜单；选区 > 1 行时出现）。 */
  onCopySelected?(): void;
  /** 批量导出选中的行到新文件（只读源文件；目标由宿主侧保存对话框决定）。 */
  onExportSelected?(): void;
  /** 可选：清空过滤条件（空态「清除过滤」按钮）。 */
  onClearFilter?(): void;
  /** 可选：按需拉取某行完整值（截断态「复制该行 JSON」用）。 */
  onRequestRecord?(line: number): Promise<{ value?: unknown; ok: boolean; error?: string }>;
}

/** 页面信息（供外部展示/统计）。 */
export interface PageInfo {
  page: number; // 当前页（0 起）
  pages: number; // 总页数
  pageSize: number;
  totalRows: number;
}

/**
 * 滑动窗口式页码：只显示 3 个连续页码按钮（+ 必要省略号）。
 * 首页/尾页由两侧的 `«`/`»` 箭头按钮负责，这里不再重复显示第 1 页/末页数字按钮。
 * 窗口随当前页滑动：翻页时整段 3 页窗口前移/后移一格。
 */
const WINDOW = 3;
function pagerSlots(cur: number, total: number): Array<number | '…'> {
  if (total <= 0) return [];
  if (total <= WINDOW) return Array.from({ length: total }, (_, i) => i);
  const lo = Math.max(0, Math.min(cur - 1, total - WINDOW)); // 窗口起点（尽量含当前页，扩展到 3 个）
  const hi = lo + WINDOW - 1;
  const out: Array<number | '…'> = [];
  if (lo > 0) out.push('…'); // 窗口之前还有页 → 省略号
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < total - 1) out.push('…'); // 窗口之后还有页 → 省略号
  return out;
}

export class VirtualRecordList {
  readonly scrollEl: HTMLElement;
  readonly pagerEl: HTMLElement;
  private readonly inner: HTMLElement;
  private readonly navEl: HTMLElement; // 分页第一行：导航 + 页码窗口
  private readonly sideEl: HTMLElement; // 分页第二行：跳页 + 统计
  private rawTotal = -1; // 底层总行数（未过滤）；-1 = 尚未收到概览，渲染前不可用
  private totalRows = 0; // 展示行数（过滤后即 translation 长度）
  /** 展示位 -> 真实行号；null 表示不过滤（展示位 == 真实行号）。 */
  private translation: number[] | null = null;
  private selectedLine: number | undefined;
  /**
   * 多选集合（由外部驱动，列表只负责渲染）。
   *
   * 与 `selectedLine` 是两个概念：`selectedLine` 是「详情面板正在展示哪一行」，
   * 多选集合是「批量操作作用于哪些行」。单选时两者一致，多选时详情仍跟随最后点击的行。
   */
  private selectedLines: ReadonlySet<number> = new Set();
  private page = 0; // 当前页（0 起）
  /**
   * 「跳至」输入框的草稿值（用户正在输入但尚未提交的内容）。
   *
   * 为何必须记住：分页条每次都会重建（取数完成 / 换页 / 过滤变化都会 refresh），
   * 不记住草稿的话，用户敲到一半的输入会被重建冲掉 —— 表现为「输页码输不进去」。
   */
  private jumpDraft: string | undefined;
  /**
   * 当前生效的搜索词（用于卡片预览命中高亮）。
   *
   * 为何由外部注入而非列表自查：搜索状态的唯一来源在 queryActions，
   * 列表只负责「按给定的词把命中标出来」——注入式让两处不会各自演进。
   */
  private searchNeedle: string | null = null;
  readonly pageSize: number;
  private disposed = false;
  /** 换页动画序号：防止快速连点时旧 setTimeout 覆盖新渲染。 */
  private pageSeq = 0;

  constructor(
    private readonly cb: ListCallbacks,
    pageSize: number = PAGE_SIZE
  ) {
    this.pageSize = Math.max(1, Math.floor(pageSize));

    /* 滚动区（渲染当前页；原型 .jlv-list-wrap） */
    const scroll = document.createElement('div');
    scroll.className = 'jlv-list-wrap';
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'listbox');
    scroll.setAttribute('aria-label', '记录目录');
    const inner = document.createElement('div');
    inner.className = 'jlv-inner';
    scroll.appendChild(inner);
    scroll.addEventListener('keydown', (e) => this.handleKey(e));
    this.scrollEl = scroll;
    this.inner = inner;

    /* 分页条（两行：导航+页码窗口 / 跳页+统计） */
    const pager = document.createElement('div');
    pager.className = 'jlv-pager';
    this.navEl = document.createElement('div');
    this.navEl.className = 'jlv-pager-nav';
    this.sideEl = document.createElement('div');
    this.sideEl.className = 'jlv-pager-side';
    pager.append(this.navEl, this.sideEl);
    this.pagerEl = pager;
  }

  /* ---------------------- 公开 API（与旧虚拟滚动对齐） ---------------------- */

  setTotalRows(n: number): void {
    const prevRaw = this.rawTotal;
    const prevTotal = this.totalRows;
    this.rawTotal = n;
    this.totalRows = this.translation ? this.translation.length : n;
    this.clampPage();
    // 仅在「此前已渲染过 且 总行数未变化」时跳过重建：避免首开时 init 概览与 GET_OVERVIEW
    // 反复刷新同一数值，导致目录重复重建并重播入场动画 = 闪烁。
    // 首次设置（prevRaw<0）必须渲染，否则空文件(0 行)永远不会画出空态。
    if (prevRaw >= 0 && this.totalRows === prevTotal) return;
    this.render(false);
  }

  setTranslation(rows: number[] | null): void {
    this.translation = rows;
    this.totalRows = this.translation ? this.translation.length : this.rawTotal;
    this.clampPage();
    this.render(false);
  }

  /** 数据到达 / 字段变化后刷新当前页内容（不翻页、不播换页动画）。 */
  refresh(): void {
    this.render(false);
  }

  flushNow(): void {
    this.render(false);
  }

  /** 跳转到指定**真实行**所在页（过滤态映射到展示位后再定位）。 */
  scrollToLine(line: number): void {
    const d = this.displayPosOf(line);
    if (d < 0) {
      this.page = 0;
    } else {
      this.page = Math.floor(d / this.pageSize);
    }
    this.clampPage();
    this.render(true);
  }

  /**
   * 选中真实行并保证其所在页可见；选中行已在当前页时**仅更新选中高亮**（不重建 DOM、不播换页动画）。
   * 用于「上一条/下一条」逐条导航——避免每次导航都触发目录整体刷新动画。
   * 无论同页/跨页，都会把选中项滚动进可视区（跟随移动）。
   */
  focus(line: number): void {
    const d = this.displayPosOf(line);
    if (d < 0) {
      this.page = 0;
      this.clampPage();
      this.render(true);
    } else {
      const targetPage = Math.floor(d / this.pageSize);
      if (targetPage !== this.page) {
        // 跨页：正常播换页动画
        this.page = targetPage;
        this.render(true);
      }
    }
    this.selectedLine = line;
    this.applySelection();
    // 把选中项滚动进可视区（rAF 等渲染完成后再滚动，避免被渲染重置）
    const el = this.scrollEl.querySelector<HTMLElement>(`#jlv-opt-${line}`);
    if (el && typeof el.scrollIntoView === 'function') {
      if (this.disposed) return;
      requestAnimationFrame(() => {
        if (this.disposed || this.selectedLine !== line) return;
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    }
  }

  getScrollTop(): number {
    return this.scrollEl.scrollTop;
  }

  /**
   * 设置用于卡片预览高亮的搜索词（null = 清除高亮）。
   *
   * 只影响**已渲染**的卡片：列表不会为高亮去预取数据 —— 那等于把「内存与可视区成正比」
   * 这一核心约束换成「为了标几个字把整文件读一遍」。
   */
  setSearchNeedle(needle: string | null): void {
    const next = needle && needle.length > 0 ? needle : null;
    if (next === this.searchNeedle) return;
    this.searchNeedle = next;
    this.refresh();
  }

  select(line: number): void {
    this.selectedLine = line;
    this.applySelection();
  }

  getSelected(): number | undefined {
    return this.selectedLine;
  }

  /**
   * 设置多选集合。外部（装配层）是唯一状态源，列表只负责把它渲染出来 ——
   * 状态放在两处（列表一份、装配层一份）迟早在某条路径上不同步。
   */
  setSelectedLines(lines: ReadonlySet<number>): void {
    this.selectedLines = lines;
    this.applySelection();
  }

  /** 彻底清除选中（多选集合 + 当前行标记）。批量删除后行号已失效，必须走它。 */
  clearAllSelection(): void {
    this.selectedLine = undefined;
    this.selectedLines = new Set();
    this.applySelection();
  }

  getPageInfo(): PageInfo {
    return {
      page: this.page,
      pages: this.pages,
      pageSize: this.pageSize,
      totalRows: this.totalRows,
    };
  }

  /** 当前页真实行的闭区间范围 [0 起]，空页返回 null。 */
  getCurrentPageRealBounds(): [number, number] | null {
    const start = this.pageStart();
    const count = this.pageCount();
    if (count <= 0) return null;
    return [this.realLine(start), this.realLine(start + count - 1)];
  }

  dispose(): void {
    this.disposed = true;
    this.pageSeq++;
    this.inner.textContent = '';
    this.pagerEl.remove();
  }

  /* ---------------------- 分页数学 ---------------------- */

  private get pages(): number {
    return Math.max(1, Math.ceil(this.totalRows / this.pageSize));
  }

  private pageStart(): number {
    return this.page * this.pageSize;
  }

  private pageCount(): number {
    return Math.min(this.pageSize, Math.max(0, this.totalRows - this.pageStart()));
  }

  private clampPage(): void {
    const max = this.pages - 1;
    if (this.page > max) this.page = max;
    if (this.page < 0) this.page = 0;
  }

  private goToPage(p: number): void {
    this.clampPage();
    const target = Math.max(0, Math.min(p, this.pages - 1));
    if (target === this.page) return;
    this.page = target;
    this.render(true);
  }

  /**
   * 提交跳转输入（页码 / `#记录号` / `百分比`）。
   *
   * 非法或越界一律**回退原页码且不跳转**（设计体系 §3.3）—— 静默跳到别的页比不跳更糟：
   * 用户会以为自己看到的还是他要找的位置。
   */
  private commitPageInput(): void {
    const input = this.sideEl.querySelector<HTMLInputElement>('.jlv-pager-input');
    if (!input) return;
    const target = parseJumpTarget(input.value, { pages: this.pages, totalRows: this.totalRows });
    if (!target) {
      this.jumpDraft = undefined;
      input.value = String(this.page + 1);
      return;
    }
    this.jumpDraft = undefined;
    switch (target.kind) {
      case 'page':
        this.goToPage(target.value - 1);
        input.value = String(this.page + 1);
        break;
      case 'record':
        // 记录号是**展示位**（1 基）：过滤态下按当前视图计数，与用户在界面上数到的一致。
        this.reveal(this.realLine(target.value - 1));
        break;
      case 'ratio': {
        const d = Math.min(
          this.totalRows - 1,
          Math.max(0, Math.floor(this.totalRows * target.value))
        );
        this.reveal(this.realLine(d));
        break;
      }
    }
  }

  private realLine(d: number): number {
    return this.translation ? this.translation[d] : d;
  }

  private displayPosOf(real: number): number {
    if (!this.translation) return real >= 0 && real < this.rawTotal ? real : -1;
    const idx = this.translation.indexOf(real);
    return idx;
  }

  /* ---------------------- 渲染 ---------------------- */

  /**
   * 渲染当前页。
   * animate=true 表示换页/跳转：旧卡片先向左滑出（错峰），再重建新卡片从右滑入；
   * animate=false（数据刷新）直接重建，不播动画。
   */
  private render(animate: boolean): void {
    if (this.disposed) return;
    // 尚未收到概览（rawTotal<0）前不渲染：避免首帧先画「0 行」空态、再刷成卡片，造成闪烁。
    if (this.rawTotal < 0) return;
    this.clampPage();
    this.scrollEl.scrollTop = 0;
    this.updatePager();

    const cards = Array.from(this.inner.children) as HTMLElement[];
    if (animate && cards.length > 0) {
      // reduced-motion：动画被样式禁用，出口直接完成（不等固定时长）。
      if (matchMediaReduced()) {
        this.rebuild(true);
        return;
      }
      // 出口：旧卡片逐个向左滑出
      cards.forEach((c, i) => {
        c.classList.add('jlv-card-leaving');
        c.style.transitionDelay = `${Math.min(i, 10) * 15}ms`;
      });
      const mySeq = ++this.pageSeq;
      const exitMs = 160 + Math.min(cards.length, 10) * 15;
      setTimeout(() => {
        if (this.disposed || mySeq !== this.pageSeq) return;
        this.rebuild(true);
      }, exitMs);
      return;
    }
    // 仅「翻页/跳转」触发入场动画；纯数据刷新（数据到达、字段变化、概览刷新）直接重建，不重播淡入。
    this.rebuild(animate);
  }

  /** 重建当前页 DOM（enter=true 才加「从右滑入 + 错峰」入场动画，用于翻页/跳转）。 */
  private rebuild(enter: boolean): void {
    this.inner.textContent = '';

    // 空态：文件中无记录 / 过滤后无结果。
    if (this.totalRows <= 0) {
      const empty = document.createElement('div');
      empty.className = 'jlv-empty';
      empty.setAttribute('role', 'status'); // 空态/无结果变化播报给读屏
      const filtered = this.translation !== null && this.translation.length === 0;

      const icon = document.createElement('div');
      icon.className = 'jlv-empty__icon';
      icon.innerHTML = filtered ? ICON_EMPTY_FILTER : ICON_EMPTY_FILE;

      const text = document.createElement('div');
      text.className = 'jlv-empty__text';
      text.textContent = filtered ? '没有符合过滤条件的记录' : '文件中没有记录（0 行）';

      const sub = document.createElement('div');
      sub.className = 'jlv-empty__sub';
      sub.textContent = filtered ? '可调整条件或清除过滤查看全部记录' : '暂无可展示的数据';

      empty.appendChild(icon);
      empty.appendChild(text);
      empty.appendChild(sub);

      if (filtered && this.cb.onClearFilter) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'jlv-tbtn jlv-empty__action';
        clear.textContent = '清除过滤';
        clear.addEventListener('click', () => this.cb.onClearFilter?.());
        empty.appendChild(clear);
      }

      this.inner.appendChild(empty);
      return;
    }

    const start = this.pageStart();
    const count = this.pageCount();
    for (let i = 0; i < count; i++) {
      const card = this.createLine(start + i);
      // 仅翻页/跳转播入场：从右滑入（错峰 15ms × 最多 10 张）；数据刷新不加，避免每次刷新重放淡入闪烁
      if (enter) {
        card.classList.add('jlv-card-enter');
        card.style.animationDelay = `${Math.min(i, 10) * 15}ms`;
      }
      this.inner.appendChild(card);
    }

    // 通知宿主拉取当前页对应真实行
    if (count > 0) this.cb.onRangeChange(start, start + count);

    this.applySelection();
  }

  /** 构造单行记录（原型卡片：行号徽章 + 类型徽章 + 字段摘要预览）。 */
  private createLine(d: number): HTMLElement {
    const real = this.realLine(d);
    const card = document.createElement('div');
    card.className = 'jlv-record-card';
    card.id = `jlv-opt-${real}`;
    card.dataset.line = String(real);
    card.setAttribute('role', 'option');
    card.addEventListener('click', (e) => {
      const line = Number(card.dataset.line);
      if (!Number.isNaN(line)) {
        // 修饰键交给调用方解读：Ctrl/Cmd 切换、Shift 范围、无修饰即单选。
        this.cb.onSelect(line, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
      }
      this.scrollEl.focus({ preventScroll: true }); // 便于后续键盘导航
    });

    const entry = this.cb.getRecord(real);

    /* 头部：行号徽章 + 类型徽章 + keys 徽章 + 复制按钮 */
    const head = document.createElement('div');
    head.className = 'jlv-card-head';

    const lno = document.createElement('span');
    lno.className = 'jlv-line-badge';
    lno.textContent = `L${real + 1}`;
    head.appendChild(lno);

    if (entry === undefined) {
      card.classList.add('loading');
      const t = document.createElement('span');
      t.className = 'jlv-type-badge';
      t.textContent = '…';
      head.appendChild(t);
    } else if (entry.ok === false) {
      card.classList.add('error');
      const t = document.createElement('span');
      t.className = 'jlv-type-badge error';
      t.textContent = 'error';
      head.appendChild(t);
    } else {
      const kind = entry.kind ?? jsonKindOfValue(entry.value);
      const t = document.createElement('span');
      t.className = `jlv-type-badge ${kind}`;
      t.textContent = kind;
      head.appendChild(t);
      if (kind === 'object' || kind === 'array') {
        const cnt = document.createElement('span');
        cnt.className = 'jlv-type-badge string';
        const n =
          entry.count ?? (kind === 'object' ? countKeys(entry.value) : countItems(entry.value));
        cnt.textContent = `${n} ${kind === 'object' ? 'keys' : 'items'}`;
        head.appendChild(cnt);
      }
      if (entry.truncated) {
        const trunc = document.createElement('span');
        trunc.className = 'jlv-type-badge truncated';
        trunc.textContent = '已截断';
        trunc.title = '该行过大，列表仅显示摘要；点击该行在右侧详情按需加载完整值';
        head.appendChild(trunc);
      }
    }

    // 悬停复制行号按钮（点击不触发选中/详情跳转）
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'jlv-card-line__copy';
    copy.title = `复制行号 L${real + 1}`;
    copy.setAttribute('aria-label', `复制行号 L${real + 1}`);
    copy.innerHTML = ICON_COPY;
    copy.addEventListener('click', (e) => {
      e.stopPropagation();
      void copyLine(`L${real + 1}`, copy);
    });
    head.appendChild(copy);
    card.appendChild(head);

    /* 预览：错误信息 或 关键字段摘要 */
    const preview = document.createElement('div');
    preview.className = 'jlv-card-preview';
    if (entry === undefined) {
      preview.textContent = '加载中…';
    } else if (entry.ok === false) {
      preview.classList.add('error-text');
      preview.textContent = entry.error ?? 'JSON 解析失败';
    } else {
      // 优先用宿主回传的有界 summary（阶段三）；缺失时回退到从 value 现算。
      const items =
        entry.summary && entry.summary.length > 0
          ? entry.summary
          : this.cb.summarize && entry.value !== undefined
            ? this.cb.summarize(entry.value)
            : [];
      // 逐段构建 DOM（不再拼 innerHTML）：既让命中片段能以 <mark> 呈现，
      // 也让用户数据彻底不进 HTML 解析器（用户数据 → 文本节点，恒定安全）。
      const needle = this.searchNeedle;
      items.slice(0, 3).forEach((it, idx) => {
        if (idx > 0) preview.appendChild(document.createTextNode(' · '));
        const keyEl = document.createElement('span');
        keyEl.className = 'key';
        keyEl.textContent = it.key;
        preview.appendChild(keyEl);
        preview.appendChild(document.createTextNode(': '));
        const valEl = document.createElement('span');
        valEl.className = previewKind(it.display);
        const val = it.display.length > 40 ? `${it.display.slice(0, 40)}…` : it.display;
        renderHighlight(valEl, val, needle ? findRanges(val, needle) : []);
        preview.appendChild(valEl);
      });
    }
    card.appendChild(preview);

    // 右键菜单：编辑此行 / 定位到源码行 / 复制行号 / 复制该行 JSON
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, this.buildCtxItems(real, entry));
    });

    return card;
  }

  /**
   * 构造某一行的右键菜单项。
   *
   * 抽成方法是为了让**键盘入口**复用同一份清单（Shift+F10 / 菜单键）——
   * 两处各写一份的话，日后的菜单项早晚只加到鼠标那一份上。
   */
  private buildCtxItems(real: number, entry: RecordEntry | undefined): CtxItem[] {
    const items: CtxItem[] = [];

    // 右键的行若在选区中且选区不止一行 → 批量操作置顶。
    // 用户先框选再右键，意图显然是「对这一批做点什么」，此时把单行操作放前面会误导。
    const inSelection = this.selectedLines.has(real);
    const selCount = this.selectedLines.size;
    if (inSelection && selCount > 1) {
      if (this.cb.onCopySelected) {
        items.push({
          label: `复制选中的 ${selCount} 行`,
          run: () => this.cb.onCopySelected?.(),
        });
      }
      if (this.cb.onExportSelected) {
        items.push({
          label: `导出选中的 ${selCount} 行为新文件`,
          run: () => this.cb.onExportSelected?.(),
        });
      }
      if (this.cb.onDeleteSelected) {
        items.push({
          label: `删除选中的 ${selCount} 行`,
          run: () => this.cb.onDeleteSelected?.(),
        });
      }
      items.push({ sep: true });
    }

    if (this.cb.onEditRecord) {
      items.push({
        label: `编辑第 ${real + 1} 行`,
        run: () => this.cb.onEditRecord?.(real),
      });
      items.push({ sep: true });
    }
    if (this.cb.onInsertRecord) {
      items.push({
        label: `在第 ${real + 1} 行前插入`,
        run: () => this.cb.onInsertRecord?.(real),
      });
    }
    if (this.cb.onDeleteRecord) {
      items.push({
        label: `删除第 ${real + 1} 行`,
        run: () => this.cb.onDeleteRecord?.(real),
      });
      items.push({ sep: true });
    }
    if (this.cb.onJumpToSource) {
      items.push({
        label: `定位到源码行 L${real + 1}`,
        run: () => this.cb.onJumpToSource?.(real),
      });
      items.push({ sep: true });
    }
    items.push({
      label: `复制行号 L${real + 1}`,
      run: () => void writeClipboard(`L${real + 1}`),
    });
    if (entry && entry.ok !== false && entry.value !== undefined) {
      items.push({
        label: '复制该行 JSON',
        run: () => void writeClipboard(formatJsonValue(entry.value)),
      });
    } else if (entry && entry.truncated && this.cb.onRequestRecord) {
      items.push({
        label: '复制该行 JSON',
        run: () => void this.copyFullOnDemand(real),
      });
    }
    return items;
  }

  private applySelection(): void {
    let activeId: string | undefined;
    // 选中视觉**以多选集合为准**；集合为空时退化为「当前行」的单选视觉。
    // 若两者都标记，会出现「视觉上是选中的、选区里却没有它」这种不一致 ——
    // 而用户接下来的批量操作按选区执行，那种不一致的后果是删错行。
    const multiActive = this.selectedLines.size > 0;
    for (const el of Array.from(this.inner.children) as HTMLElement[]) {
      const line = Number(el.dataset.line);
      const isCurrent = line === this.selectedLine;
      const isMulti = this.selectedLines.has(line);
      const showSelected = multiActive ? isMulti : isCurrent;
      el.classList.toggle('selected', showSelected);
      // 多选中额外标出「详情正在展示哪一行」
      el.classList.toggle('current', multiActive && isCurrent);
      el.setAttribute('aria-selected', showSelected ? 'true' : 'false');
      if (isCurrent && el.id) activeId = el.id;
    }
    // 同步 listbox 的 activedescendant，读屏可感知选中行（仅当选中的行在当前页）。
    if (activeId) this.scrollEl.setAttribute('aria-activedescendant', activeId);
    else this.scrollEl.removeAttribute('aria-activedescendant');
  }

  /**
   * 截断态：按需拉取完整值后复制到剪贴板（失败/拒绝则退而复制预览文本）。
   * 避免列表缓存持有超大对象——仅在用户主动「复制该行 JSON」时才走 READ_RECORD。
   */
  private async copyFullOnDemand(line: number): Promise<void> {
    const cb = this.cb.onRequestRecord;
    if (!cb) return;
    try {
      const res = await cb(line);
      if (res && res.ok !== false && res.value !== undefined) {
        await writeClipboard(formatJsonValue(res.value));
        return;
      }
    } catch {
      /* 落到预览复制 */
    }
    const entry = this.cb.getRecord(line);
    const preview = entry?.summary?.[0]?.display ?? '（无法复制完整值）';
    await writeClipboard(preview);
  }

  /** 重建分页条（两行：导航+窗口页码 / 跳页+统计）。 */
  private updatePager(): void {
    const pages = this.pages;
    const p = this.page;

    /* 第一行：首页 « ‹ 页码窗口 › » 末页 */
    this.navEl.textContent = '';
    const mkBtn = (
      label: string,
      title: string,
      onClick: () => void,
      nav: boolean
    ): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'jlv-pager-btn';
      if (nav) b.classList.add('jlv-pager-navbtn');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      return b;
    };
    const first = mkBtn('«', '首页', () => this.goToPage(0), true);
    first.disabled = p <= 0;
    const prev = mkBtn('‹', '上一页', () => this.goToPage(p - 1), true);
    prev.disabled = p <= 0;
    const next = mkBtn('›', '下一页', () => this.goToPage(p + 1), true);
    next.disabled = p >= pages - 1;
    const last = mkBtn('»', '末页', () => this.goToPage(pages - 1), true);
    last.disabled = p >= pages - 1;

    this.navEl.append(first, prev);
    for (const slot of pagerSlots(p, pages)) {
      if (slot === '…') {
        const dot = document.createElement('span');
        dot.className = 'jlv-pager-ellipsis';
        dot.textContent = '…';
        this.navEl.appendChild(dot);
      } else {
        const b = mkBtn(String(slot + 1), `第 ${slot + 1} 页`, () => this.goToPage(slot), false);
        if (slot === p) b.classList.add('active');
        this.navEl.appendChild(b);
      }
    }
    this.navEl.append(next, last);

    /* 第二行：跳至 [输入] · N 页 | 统计 */
    this.sideEl.textContent = '';
    const inputWrap = document.createElement('span');
    inputWrap.className = 'jlv-pager-input-wrap';
    inputWrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;white-space:nowrap;';
    const label = document.createElement('span');
    label.textContent = '跳至';
    const input = document.createElement('input');
    // text 而非 number：要接受 `#1234` / `L1234` / `50%` 这类写法，number 输入框会把它们吞掉。
    input.type = 'text';
    input.inputMode = 'numeric';
    input.className = 'jlv-pager-input';
    input.size = 8;
    // 正在输入的内容必须能扛住分页条重建（取数完成后会 refresh）——
    // 否则用户输入页码到一半，数据一到就把输入冲掉了（O9）。
    input.value = this.jumpDraft ?? String(p + 1);
    input.title = `页码 / 记录号 / 百分比（如 12、#1234、50%）`;
    input.setAttribute('aria-label', '跳转：页码、#记录号或百分比');
    input.addEventListener('input', () => {
      this.jumpDraft = input.value;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.commitPageInput();
    });
    input.addEventListener('change', () => this.commitPageInput());
    inputWrap.append(label, input);
    this.sideEl.appendChild(inputWrap);

    const summary = document.createElement('div');
    summary.className = 'jlv-pager-summary';
    summary.textContent = `${this.pageSize}/页 · ${this.totalRows.toLocaleString('en-US')} 条记录`;
    this.sideEl.appendChild(summary);
  }

  /** 滚动/切换分页到指定真实行所在页，并选中该行（同时联动详情面板）。 */
  private reveal(real: number): void {
    const d = this.displayPosOf(real);
    if (d < 0) {
      this.page = 0;
      this.clampPage();
      this.render(true);
      this.select(real);
    } else {
      const targetPage = Math.floor(d / this.pageSize);
      if (targetPage !== this.page) {
        this.page = targetPage;
        this.render(true);
      }
      this.select(real);
    }
    this.cb.onSelect(real, NO_MODS); // 键盘导航也要加载右栏详情（此前遗漏，功能级缺陷）
  }

  /** 目录键盘导航。 */
  private handleKey(e: KeyboardEvent): void {
    const pageStartD = this.pageStart();
    const pageEndD = pageStartD + this.pageCount();

    // Ctrl/Cmd + C：复制当前选中行号
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      if (this.selectedLine !== undefined) {
        e.preventDefault();
        void writeClipboard(`L${this.selectedLine + 1}`);
      }
      return;
    }

    // 菜单键 / Shift+F10：右键菜单的键盘等价入口。
    //
    // 为何必须有：菜单里装着「编辑此行 / 删除 / 定位到源码行 / 复制 JSON」这些**没有其它入口**
    // 的操作 —— 纯鼠标可及等于把它们对键盘用户整个关掉（也顺带关掉了读屏用户）。
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const line = this.selectedLine;
      if (line === undefined) return;
      const card = (Array.from(this.inner.children) as HTMLElement[]).find(
        (el) => Number(el.dataset.line) === line
      );
      if (!card) return;
      e.preventDefault();
      const rect = card.getBoundingClientRect();
      // 定位到卡片右侧偏下：与鼠标右键的位置习惯一致，且不会盖住被操作的那一行。
      openContextMenu(
        Math.max(4, rect.right - 40),
        Math.min(rect.bottom - 4, window.innerHeight - 8),
        this.buildCtxItems(line, this.cb.getRecord(line))
      );
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const curD = this.selectedLine === undefined ? -1 : this.displayPosOf(this.selectedLine);
      let d: number;
      if (curD >= pageStartD && curD < pageEndD) {
        d = e.key === 'ArrowDown' ? curD + 1 : curD - 1;
      } else {
        d = e.key === 'ArrowDown' ? pageStartD : pageEndD - 1;
      }
      d = Math.max(0, Math.min(d, this.totalRows - 1));
      this.reveal(this.realLine(d));
      return;
    }

    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      this.goToPage(e.key === 'PageDown' ? this.page + 1 : this.page - 1);
      const d = Math.min(this.pageStart(), this.totalRows - 1);
      if (d >= 0) {
        const real = this.realLine(d);
        this.select(real);
        this.cb.onSelect(real, NO_MODS);
      }
      return;
    }

    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const d = e.key === 'Home' ? 0 : Math.max(0, this.totalRows - 1);
      this.page = Math.floor(d / this.pageSize);
      this.clampPage();
      this.render(true);
      const real = this.realLine(d);
      this.select(real);
      this.cb.onSelect(real, NO_MODS);
      return;
    }

    // Enter：激活当前选中行（加载详情），无选中时选当前页第一行。
    if (e.key === 'Enter') {
      e.preventDefault();
      const real =
        this.selectedLine !== undefined && this.displayPosOf(this.selectedLine) >= 0
          ? this.selectedLine
          : this.realLine(this.pageStart());
      this.reveal(real);
      return;
    }

    if (e.key === 'Escape') {
      this.scrollEl.blur();
    }
  }
}

/* ------------------- 卡片辅助（原型预览） ------------------- */

/** 用户是否偏好减少动态效果（prefers-reduced-motion）。 */
function matchMediaReduced(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function jsonKindOfValue(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return Array.isArray(value) ? 'array' : 'object';
}

function countKeys(value: unknown): number {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).length
    : 0;
}

function countItems(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** 根据摘要显示文本猜测渲染类（原型：str/num/bool/key）。 */
function previewKind(display: string): string {
  if (display.startsWith('"') && display.endsWith('"')) return 'str';
  if (/^-?\d+(\.\d+)?$/.test(display)) return 'num';
  if (display === 'true' || display === 'false') return 'bool';
  return 'str';
}

/* ------------------- 复制行号 ------------------- */

const ICON_COPY =
  '<svg width="12" height="12" viewBox="0 0 16 16"><rect x="5" y="5" width="8" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M11 2.5H4.5A1.5 1.5 0 0 0 3 4v7.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const ICON_COPIED =
  '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M3 8.5l3.2 3L13 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_EMPTY_FILE =
  '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" opacity=".6"/><path d="M14 3v6h6" opacity=".6"/><path d="M8 13h8M8 16h5"/></svg>';
const ICON_EMPTY_FILTER =
  '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h18M6 9h12M9 14h6M12 18h3"/></svg>';

/** 写文本到剪贴板（主用 Clipboard API，失败回退 execCommand）。 */
async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall through */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch {
    /* ignore */
  }
  document.body.removeChild(ta);
}

/** 复制文本到剪贴板，并在按钮上给出短暂反馈。 */
async function copyLine(text: string, btn: HTMLButtonElement): Promise<void> {
  await writeClipboard(text);
  const prev = btn.innerHTML;
  const prevTitle = btn.title;
  btn.innerHTML = ICON_COPIED;
  btn.classList.add('copied');
  btn.title = '已复制';
  setTimeout(() => {
    btn.innerHTML = prev;
    btn.classList.remove('copied');
    btn.title = prevTitle;
  }, 1200);
}

/* ------------------- 右键菜单 ------------------- */

interface CtxItem {
  label?: string;
  run?: () => void;
  /** 分隔线项。 */
  sep?: boolean;
}

let ctxEl: HTMLElement | null = null;
let ctxBound = false;
let ctxFrame = 0;

function ensureCtx(): HTMLElement {
  // 复用已建元素，但**必须确认它仍挂在文档里**：一旦脱离（被宿主清空 body 之类），
  // 继续改一个游离节点等于菜单静默不显示 —— 复用与可用性以 isConnected 为闸。
  const el = ctxEl ?? document.createElement('div');
  if (!ctxEl) {
    el.className = 'jlv-ctx';
    el.hidden = true;
  }
  if (!el.isConnected) document.body.appendChild(el);
  ctxEl = el;
  return el;
}

function bindCtxGlobalOnce(): void {
  if (ctxBound) return;
  ctxBound = true;
  document.addEventListener('pointerdown', (e) => {
    if (ctxEl && !ctxEl.hidden && !ctxEl.contains(e.target as Node)) ctxEl.hidden = true;
  });
  document.addEventListener('contextmenu', () => {
    if (ctxEl) ctxEl.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ctxEl) ctxEl.hidden = true;
  });
  window.addEventListener('blur', () => {
    if (ctxEl) ctxEl.hidden = true;
  });
  window.addEventListener('resize', () => {
    if (ctxEl) ctxEl.hidden = true;
  });
}

/** 在 (x, y) 弹出右键菜单；items 为菜单项（含动作）。 */
function openContextMenu(x: number, y: number, items: CtxItem[]): void {
  bindCtxGlobalOnce();
  const el = ensureCtx();
  el.textContent = '';
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'jlv-ctx-sep';
      el.appendChild(s);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'jlv-ctx-item';
    b.textContent = it.label ?? '';
    b.addEventListener('click', () => {
      el.hidden = true;
      it.run?.();
    });
    el.appendChild(b);
  }
  el.hidden = false;
  const w = el.offsetWidth || 160;
  const h = el.offsetHeight || 40;
  el.style.left = `${Math.max(0, Math.min(x, window.innerWidth - w - 4))}px`;
  el.style.top = `${Math.max(0, Math.min(y, window.innerHeight - h - 4))}px`;
  // 用 rAF 再量一次精确尺寸（首帧未布局）
  cancelAnimationFrame(ctxFrame);
  ctxFrame = requestAnimationFrame(() => {
    const w2 = el.offsetWidth;
    const h2 = el.offsetHeight;
    el.style.left = `${Math.max(0, Math.min(x, window.innerWidth - w2 - 4))}px`;
    el.style.top = `${Math.max(0, Math.min(y, window.innerHeight - h2 - 4))}px`;
  });
}

/** 把任意 JSON 值格式化为多行文本。 */
function formatJsonValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
