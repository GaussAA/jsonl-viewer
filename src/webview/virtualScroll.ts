/**
 * virtualScroll.ts — 左侧记录目录的 DOM 渲染层（vanilla TS，无框架）。
 *
 * 翻页式目录：固定每页 PAGE_SIZE 条，上一页/下一页 + 页码跳转切换，不再用无限滚动。
 * 每条记录只展示行号（L1、L2…），不展示字段摘要。
 *   - 只渲染「当前页」的固定条数 DOM，与总行数无关，超大文件也不卡；
 *   - 每次翻页/改页通过 onRangeChange 通知宿主拉取该页对应的真实行区间；
 *   - 过滤态下页面作用于「过滤后的展示行」（translation 映射真实行）。
 */

import type { FieldLike } from './logic.ts';

/** 目录每页固定条数。 */
export const PAGE_SIZE = 20;

export interface RecordEntry {
  value?: unknown;
  ok: boolean;
  error?: string;
}

export interface ListCallbacks {
  /** 按行号取已加载的记录；未加载返回 undefined（渲染「加载中…」占位）。 */
  getRecord(line: number): RecordEntry | undefined;
  getFields(): readonly FieldLike[] | null;
  /** 可选：字段摘要（本目录不再使用，保留以兼容调用方）。 */
  summarize?(value: unknown): { key: string; display: string }[];
  onSelect(line: number): void;
  /** 当前页展示位区间变化（[first, lastExclusive)），通知控制器按需拉取。 */
  onRangeChange(first: number, lastExclusive: number): void;
  /** 可选：跳转到源文件对应行（右键「定位到源码行」）。 */
  onJumpToSource?(line: number): void;
  /** 可选：清空过滤条件（空态「清除过滤」按钮）。 */
  onClearFilter?(): void;
}

/** 页面信息（供外部展示/统计）。 */
export interface PageInfo {
  page: number; // 当前页（0 起）
  pages: number; // 总页数
  pageSize: number;
  totalRows: number;
}

export class VirtualRecordList {
  readonly scrollEl: HTMLElement;
  readonly pagerEl: HTMLElement;
  private readonly inner: HTMLElement;
  private rawTotal = 0; // 底层总行数（未过滤）
  private totalRows = 0; // 展示行数（过滤后即 translation 长度）
  /** 展示位 -> 真实行号；null 表示不过滤（展示位 == 真实行号）。 */
  private translation: number[] | null = null;
  private selectedLine: number | undefined;
  private page = 0; // 当前页（0 起）
  readonly pageSize: number;
  private disposed = false;

  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly pageInput: HTMLInputElement;
  private readonly pagesLabel: HTMLElement;
  private readonly summaryLabel: HTMLElement;

  constructor(
    private readonly cb: ListCallbacks,
    pageSize: number = PAGE_SIZE
  ) {
    this.pageSize = Math.max(1, Math.floor(pageSize));

    /* 滚动区（渲染当前页） */
    const scroll = document.createElement('div');
    scroll.className = 'jlv-scroll';
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'listbox');
    scroll.setAttribute('aria-label', '记录目录');
    const inner = document.createElement('div');
    inner.className = 'jlv-inner';
    scroll.appendChild(inner);
    scroll.addEventListener('keydown', (e) => this.handleKey(e));
    this.scrollEl = scroll;
    this.inner = inner;

    /* 分页条 */
    const pager = document.createElement('div');
    pager.className = 'jlv-pager';

    this.prevBtn = document.createElement('button');
    this.prevBtn.type = 'button';
    this.prevBtn.className = 'jlv-tbtn jlv-pager-btn';
    this.prevBtn.textContent = '‹';
    this.prevBtn.title = '上一页';
    this.prevBtn.addEventListener('click', () => this.goToPage(this.page - 1));

    this.nextBtn = document.createElement('button');
    this.nextBtn.type = 'button';
    this.nextBtn.className = 'jlv-tbtn jlv-pager-btn';
    this.nextBtn.textContent = '›';
    this.nextBtn.title = '下一页';
    this.nextBtn.addEventListener('click', () => this.goToPage(this.page + 1));

    this.pageInput = document.createElement('input');
    this.pageInput.type = 'number';
    this.pageInput.className = 'jlv-pager-input';
    this.pageInput.min = '1';
    this.pageInput.value = '1';
    this.pageInput.title = '跳转到第几页';
    this.pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.commitPageInput();
    });
    this.pageInput.addEventListener('change', () => this.commitPageInput());

    this.pagesLabel = document.createElement('span');
    this.pagesLabel.className = 'jlv-pager-pages';

    const pagerSpacer = document.createElement('div');
    pagerSpacer.className = 'jlv-pager-spacer';

    this.summaryLabel = document.createElement('span');
    this.summaryLabel.className = 'jlv-pager-summary';

    pager.append(this.prevBtn, this.pageInput, this.pagesLabel, this.nextBtn, pagerSpacer, this.summaryLabel);
    this.pagerEl = pager;
  }

  /* ---------------------- 公开 API（与旧虚拟滚动对齐） ---------------------- */

  setTotalRows(n: number): void {
    this.rawTotal = n;
    this.totalRows = this.translation ? this.translation.length : n;
    this.clampPage();
    this.render();
  }

  setTranslation(rows: number[] | null): void {
    this.translation = rows;
    this.totalRows = this.translation ? this.translation.length : this.rawTotal;
    this.clampPage();
    this.render();
  }

  /** 数据到达 / 字段变化后刷新当前页内容（不翻页）。 */
  refresh(): void {
    this.render();
  }

  flushNow(): void {
    this.render();
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
    this.render();
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
    this.render();
  }

  private commitPageInput(): void {
    const n = Number(this.pageInput.value);
    if (!Number.isFinite(n)) return;
    this.goToPage(Math.floor(n) - 1);
    // 输入框立即回读实际页码，避免溢出显示。
    this.pageInput.value = String(this.page + 1);
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

  private render(): void {
    if (this.disposed) return;
    this.clampPage();
    this.scrollEl.scrollTop = 0; // 新页从顶部开始
    this.inner.textContent = '';

    // 空态：文件中无记录 / 过滤后无结果。
    if (this.totalRows <= 0) {
      const empty = document.createElement('div');
      empty.className = 'jlv-empty';
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
      this.updatePager();
      return;
    }

    const start = this.pageStart();
    const count = this.pageCount();
    for (let i = 0; i < count; i++) {
      this.inner.appendChild(this.createLine(start + i));
    }

    // 通知宿主拉取当前页对应真实行
    if (count > 0) this.cb.onRangeChange(start, start + count);

    this.updatePager();
    this.applySelection();
  }

  /** 构造单行记录（仅显示行号 Ln，悬停可复制行号）。 */
  private createLine(d: number): HTMLElement {
    const real = this.realLine(d);
    const card = document.createElement('div');
    card.className = 'jlv-card jlv-card-line';
    card.dataset.line = String(real);
    card.setAttribute('role', 'option');
    card.addEventListener('click', () => {
      const line = Number(card.dataset.line);
      if (!Number.isNaN(line)) this.cb.onSelect(line);
      this.scrollEl.focus({ preventScroll: true }); // 便于后续键盘导航
    });

    const lno = document.createElement('span');
    lno.className = 'jlv-card__lno';
    lno.textContent = `L${real + 1}`;
    card.appendChild(lno);

    // 悬停复制行号按钮（点击不触发选中/详情跳转）
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'jlv-card-line__copy';
    copy.title = `复制行号 L${real + 1}`;
    copy.innerHTML = ICON_COPY;
    copy.addEventListener('click', (e) => {
      e.stopPropagation();
      void copyLine(`L${real + 1}`, copy);
    });
    card.appendChild(copy);

    const entry = this.cb.getRecord(real);

    // 右键菜单：定位到源码行 / 复制行号 / 复制该行 JSON
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items: CtxItem[] = [];
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
      }
      openContextMenu(e.clientX, e.clientY, items);
    });

    if (entry === undefined) {
      card.classList.add('loading');
    } else if (entry.ok === false) {
      card.classList.add('error');
    }
    return card;
  }

  private applySelection(): void {
    for (const el of Array.from(this.inner.children) as HTMLElement[]) {
      const isSel = Number(el.dataset.line) === this.selectedLine;
      el.classList.toggle('selected', isSel);
      el.setAttribute('aria-selected', isSel ? 'true' : 'false');
    }
  }

  updatePager(): void {
    const pages = this.pages;
    this.prevBtn.disabled = this.page <= 0;
    this.nextBtn.disabled = this.page >= pages - 1;
    this.pageInput.value = String(this.page + 1);
    this.pageInput.max = String(pages);
    this.pagesLabel.textContent = ` / ${pages} 页`;
    this.summaryLabel.textContent = `每页 ${this.pageSize} 条`;
  }

  /** 滚动/切换分页到指定真实行所在页，并选中该行。 */
  private reveal(real: number): void {
    const d = this.displayPosOf(real);
    if (d < 0) {
      this.page = 0;
      this.clampPage();
      this.render();
      this.select(real);
      return;
    }
    const targetPage = Math.floor(d / this.pageSize);
    if (targetPage !== this.page) {
      this.page = targetPage;
      this.render();
    }
    this.select(real);
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
      if (d >= 0) this.select(this.realLine(d));
      return;
    }

    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const d = e.key === 'Home' ? 0 : Math.max(0, this.totalRows - 1);
      this.page = Math.floor(d / this.pageSize);
      this.clampPage();
      this.render();
      this.select(this.realLine(d));
      return;
    }

    if (e.key === 'Escape') {
      this.scrollEl.blur();
    }
  }
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
  if (ctxEl) return ctxEl;
  const el = document.createElement('div');
  el.className = 'jlv-ctx';
  el.hidden = true;
  document.body.appendChild(el);
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