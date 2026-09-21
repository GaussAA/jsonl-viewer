/**
 * toolbar.ts — 左栏工具栏浮卡（按原型 1:1 复刻）。
 *
 * 结构：J 图标 + 文件名 + 状态点副标题 / 搜索框 + 上一条/下一条 / 筛选·字段按钮 + 页码范围。
 * Task 6 搜索 / 过滤 / 字段定制逻辑保留：搜索防抖、匹配计数与导航、筛选与字段浮层面板。
 */

import type { FieldCondition, FieldLayout } from './queryLogic.ts';

export interface ToolbarInfo {
  fileName: string;
  totalLines: number;
  loadedLines: number;
  range: [number, number];
  buildMs: number | undefined;
  status: 'connecting' | 'indexing' | 'ready' | 'error';
  statusText?: string;
}

export interface ToolbarHandlers {
  onSearch?: (query: string) => void;
  onSearchPrev?: () => void;
  onSearchNext?: () => void;
  onApplyFilter?: (cond: FieldCondition | null) => void;
  onApplyLayout?: (layout: FieldLayout) => void;
}

export interface ToolbarStatsEls {
  fileNameEl: HTMLElement;
  totalLinesEl: HTMLElement;
  loadedEl: HTMLElement;
  rangeEl: HTMLElement;
  buildMsEl: HTMLElement;
  statusEl: HTMLElement;
  statusRootEl: HTMLElement;
}

interface FieldOption {
  key: string;
  type?: string;
}

/** 浮动面板：HTMLElement + 运行时挂接的 open/close 方法 + 内部状态槽。 */
interface FloatPanel<TState extends object = object> extends HTMLElement {
  open(): void;
  close(): void;
  /** 内部状态槽（不同面板存不同字段）。用单个 __state 替代散落的 _xxx 属性，避免 as unknown as 污染。 */
  __state?: TState;
}

/** 筛选面板的内部状态。 */
interface FilterPanelState {
  fieldSel: HTMLSelectElement;
}

/** 字段定制面板的内部状态。 */
interface LayoutPanelState {
  emit: () => void;
  list: HTMLElement;
  maxInput: HTMLInputElement;
}

export function createToolbar(
  host: HTMLElement,
  handlers: ToolbarHandlers = {}
): {
  root: HTMLElement;
  update(info: Partial<ToolbarInfo> & { fileName?: string }): void;
  refresh(): void;
  els: ToolbarStatsEls;
  searchInput(): HTMLInputElement | null;
  setFields(fields: readonly FieldOption[] | null): void;
  setLayout(layout: FieldLayout): void;
  setSearchResult(total: number, index: number): void;
  setFilterTruncated(truncated: boolean): void;
  /** 释放 document 级监听器（webview 关闭时调用）。 */
  destroy(): void;
} {
  const root = document.createElement('div');
  root.className = 'jlv-toolbar';

  /* ---------- 头部：J 图标 + 文件名 + 状态副标题 ---------- */
  const header = document.createElement('div');
  header.className = 'jlv-toolbar-header';

  const icon = document.createElement('div');
  icon.className = 'jlv-toolbar-icon';
  icon.textContent = 'J';

  const titleBox = document.createElement('div');
  titleBox.className = 'jlv-toolbar-title';
  const fileNameEl = document.createElement('div');
  fileNameEl.className = 'jlv-filename';
  fileNameEl.textContent = 'JSONL Viewer';
  const statusRootEl = document.createElement('div');
  statusRootEl.className = 'jlv-sub';
  const statusDot = document.createElement('span');
  statusDot.className = 'jlv-dot-ok';
  const statusEl = document.createElement('span');
  statusEl.textContent = '…';
  const totalLinesEl = document.createElement('span');
  const loadedEl = document.createElement('span');
  loadedEl.hidden = true;
  const buildMsEl = document.createElement('span');
  statusRootEl.append(statusDot, statusEl, totalLinesEl, loadedEl, buildMsEl);

  titleBox.append(fileNameEl, statusRootEl);
  header.append(icon, titleBox);
  root.appendChild(header);

  /* ---------- 搜索行 ---------- */
  const search = document.createElement('div');
  search.className = 'jlv-search';

  const searchInputEl = document.createElement('input');
  searchInputEl.type = 'search';
  searchInputEl.placeholder = '搜索记录…';
  searchInputEl.autocomplete = 'off';
  searchInputEl.spellcheck = false;

  const searchClear = document.createElement('button');
  searchClear.type = 'button';
  searchClear.className = 'jlv-search-clear';
  searchClear.title = '清除搜索';
  searchClear.setAttribute('aria-label', '清除搜索');
  searchClear.hidden = true;
  searchClear.innerHTML = ICON_CLEAR;

  const matchInfo = document.createElement('span');
  matchInfo.className = 'jlv-search-count';
  matchInfo.hidden = true;
  matchInfo.setAttribute('aria-live', 'polite'); // 搜索计数变化播报给读屏

  const navGroup = document.createElement('div');
  navGroup.style.cssText = 'display:flex;align-items:center;gap:4px;flex:none;';
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'jlv-nav-btn';
  prevBtn.textContent = '↑';
  prevBtn.title = '上一个匹配';
  prevBtn.setAttribute('aria-label', '上一个匹配');
  prevBtn.disabled = true;
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'jlv-nav-btn';
  nextBtn.textContent = '↓';
  nextBtn.title = '下一个匹配';
  nextBtn.setAttribute('aria-label', '下一个匹配');
  nextBtn.disabled = true;
  navGroup.append(prevBtn, nextBtn);

  search.append(
    iconSpan('jlv-search-ic', ICON_SEARCH),
    searchInputEl,
    searchClear,
    matchInfo,
    navGroup
  );
  root.appendChild(search);

  const updateClear = (): void => {
    searchClear.hidden = searchInputEl.value.length === 0;
  };

  /* ---------- 按钮行：筛选 / 字段 + 页码范围 ---------- */
  const actions = document.createElement('div');
  actions.className = 'jlv-toolbar-actions';

  const filterBtn = document.createElement('button');
  filterBtn.type = 'button';
  filterBtn.className = 'jlv-btn';
  filterBtn.title = '字段值过滤';
  filterBtn.appendChild(iconSpan('jlv-btn-ic', ICON_FILTER));
  filterBtn.appendChild(document.createTextNode('筛选'));

  const customizeBtn = document.createElement('button');
  customizeBtn.type = 'button';
  customizeBtn.className = 'jlv-btn';
  customizeBtn.title = '字段显示定制（显隐/排序/固定）';
  customizeBtn.appendChild(iconSpan('jlv-btn-ic', ICON_COLUMNS));
  customizeBtn.appendChild(document.createTextNode('字段'));

  const rangeEl = document.createElement('span');
  rangeEl.className = 'jlv-page-info';

  // 过滤结果截断提示（M7：宿主结果被截断时 UI 不再静默显示不全的匹配集）。
  const filterNoteEl = document.createElement('span');
  filterNoteEl.className = 'jlv-filter-note';
  filterNoteEl.hidden = true;
  filterNoteEl.setAttribute('aria-live', 'polite');
  filterNoteEl.textContent = '过滤结果较多，已截断（约前 5 万条）';

  actions.append(filterBtn, customizeBtn, rangeEl);
  root.appendChild(actions);
  root.appendChild(filterNoteEl);

  /* ---------- 过滤面板（原型 .jlv-float-panel） ---------- */
  let filterPanel: FloatPanel<FilterPanelState> | null = null;
  let filterPanelDispose: (() => void) | null = null;
  let panelFields: FieldOption[] = [];

  const populateFieldSel = (fieldSel: HTMLSelectElement): void => {
    fieldSel.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '(全部字段)';
    fieldSel.appendChild(none);
    for (const f of panelFields) {
      if (f.key.startsWith('$')) continue;
      const o = document.createElement('option');
      o.value = f.key;
      o.textContent = f.key;
      fieldSel.appendChild(o);
    }
  };

  const panelShell = (
    title: string,
    anchor: HTMLElement,
    onClose?: () => void
  ): {
    panel: HTMLElement;
    close(): void;
    open(): void;
    /** 释放 document 级监听器（webview dispose 时调用）。 */
    dispose(): void;
  } => {
    const panel = document.createElement('div');
    panel.className = 'jlv-float-panel';
    // 定位：锚定触发按钮下方（fixed + 显式 top/left，防视口默认位置）
    const rect = anchor.getBoundingClientRect();
    panel.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 40)}px`;
    panel.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 320))}px`;
    const h3 = document.createElement('h3');
    const titleSpan = document.createElement('span');
    titleSpan.textContent = title;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'jlv-panel-close';
    closeBtn.textContent = '✕';
    closeBtn.title = '关闭';
    closeBtn.setAttribute('aria-label', '关闭');
    h3.append(titleSpan, closeBtn);
    panel.appendChild(h3);
    document.body.appendChild(panel);
    // 单实例复用：关闭仅淡出后隐藏（不移除 DOM），下次打开直接显示
    const close = (): void => {
      onClose?.();
      panel.classList.add('closing');
      setTimeout(() => {
        panel.style.display = 'none';
        panel.classList.remove('closing');
      }, 120); // 与样式 --dur-fast:120ms 对齐（此前 100ms 会截断淡出）
    };
    closeBtn.addEventListener('click', close);
    // 打开：显示 + 焦点移入第一个可聚焦控件（M9：此前焦点留在触发按钮，读屏/键盘迷失）
    const open = (): void => {
      panel.style.display = 'block';
      const first = panel.querySelector<HTMLElement>('button, input, select');
      (first ?? closeBtn).focus();
    };
    // Esc 关闭面板（焦点在面板内时）
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
    // 外点关闭：点击面板外（且不在触发按钮上）即收起（M9：与原型行为对齐）
    const docPointerDown = (e: PointerEvent): void => {
      if (panel.style.display === 'none') return;
      const t = e.target as HTMLElement;
      if (panel.contains(t) || anchor.contains(t)) return;
      close();
    };
    document.addEventListener('pointerdown', docPointerDown);
    return {
      panel,
      close,
      open,
      dispose: () => {
        document.removeEventListener('pointerdown', docPointerDown);
      },
    };
  };

  const buildFilterPanel = (): void => {
    const { panel, close, open, dispose } = panelShell('字段筛选', filterBtn, () =>
      filterBtn.classList.remove('active')
    );
    filterPanelDispose = dispose;
    const fieldSel = document.createElement('select');
    fieldSel.title = '字段';
    populateFieldSel(fieldSel);
    const opSel = document.createElement('select');
    opSel.title = '运算符';
    const OPS: Array<[string, FieldCondition['op']]> = [
      ['等于', 'eq'],
      ['包含', 'contains'],
      ['存在', 'exists'],
      ['类型', 'type'],
    ];
    for (const [opLabel, val] of OPS) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = opLabel;
      opSel.appendChild(o);
    }
    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.placeholder = '值';
    valueInput.spellcheck = false;
    const typeSel = document.createElement('select');
    typeSel.title = '值类型';
    typeSel.style.display = 'none';
    for (const t of ['string', 'number', 'boolean', 'null', 'object', 'array']) {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t;
      typeSel.appendChild(o);
    }

    const applyBtn = document.createElement('button');
    applyBtn.className = 'jlv-btn-panel primary';
    applyBtn.textContent = '应用';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'jlv-btn-panel';
    clearBtn.textContent = '清除';

    const syncTypeUI = (): void => {
      const op = opSel.value as FieldCondition['op'];
      valueInput.style.display = op === 'exists' ? 'none' : '';
      typeSel.style.display = op === 'type' ? '' : 'none';
    };
    opSel.addEventListener('change', syncTypeUI);
    syncTypeUI();

    const buildCond = (): FieldCondition | null => {
      const field = fieldSel.value;
      const op = opSel.value as FieldCondition['op'];
      if (!field || !op) return null;
      const value = op === 'type' ? typeSel.value : valueInput.value;
      return { field, op, value };
    };
    applyBtn.addEventListener('click', () => {
      handlers.onApplyFilter?.(buildCond());
      close(); // close 内 onClose 会移除按钮 active（面板关闭即恢复样式）
    });
    clearBtn.addEventListener('click', () => {
      handlers.onApplyFilter?.(null);
      close();
    });

    panel.append(
      vlabel('字段', fieldSel),
      vlabel('运算符', opSel),
      vlabel('值', valueInput),
      vlabel('类型', typeSel)
    );
    const acts = document.createElement('div');
    acts.className = 'jlv-panel-actions';
    acts.append(clearBtn, applyBtn);
    panel.appendChild(acts);

    Object.assign(panel, { close, open });
    const fp = panel as FloatPanel<FilterPanelState>;
    fp.__state = { fieldSel };
    filterPanel = fp;
  };

  filterBtn.addEventListener('click', () => {
    // 面板互斥：打开筛选时收起字段面板
    if (layoutPanel && layoutPanel.style.display !== 'none') {
      layoutPanel.style.display = 'none';
      customizeBtn.classList.remove('active');
    }
    if (!filterPanel || !document.body.contains(filterPanel)) {
      // 首次创建：直接显示（避免 display 状态误判导致需点两次）
      buildFilterPanel();
      filterPanel?.open();
      filterBtn.classList.add('active');
      return;
    }
    const visible = filterPanel.style.display !== 'none';
    if (visible) filterPanel.close();
    else filterPanel.open();
    filterBtn.classList.toggle('active', !visible);
  });

  /* ---------- 字段定制面板 ---------- */
  let layoutPanelDispose: (() => void) | null = null;
  let layoutPanel: FloatPanel<LayoutPanelState> | null = null;
  let panelLayout: FieldLayout = { pinned: [], order: [], hidden: [], maxKeys: 4 };

  const buildLayoutPanel = (): void => {
    const { panel, close, open, dispose } = panelShell('字段定制', customizeBtn, () =>
      customizeBtn.classList.remove('active')
    );
    layoutPanelDispose = dispose;

    const head = document.createElement('div');
    head.className = 'jlv-panel-head';
    const maxLabel = label('展示字段数', document.createElement('input'));
    const maxInput = maxLabel.querySelector('input') as HTMLInputElement;
    maxInput.type = 'number';
    maxInput.min = '1';
    maxInput.max = '20';
    maxInput.value = String(panelLayout.maxKeys);
    maxInput.style.width = '56px';
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'jlv-btn';
    restoreBtn.textContent = '恢复默认';
    head.append(maxLabel, restoreBtn);
    panel.appendChild(head);

    const list = document.createElement('div');
    list.className = 'jlv-layout-list';
    panel.appendChild(list);

    const emit = (): void => handlers.onApplyLayout?.(readLayoutFromDom());
    maxInput.addEventListener('change', emit);
    restoreBtn.addEventListener('click', () => onRestoreDefault());

    Object.assign(panel, { close, open });
    const lp = panel as FloatPanel<LayoutPanelState>;
    lp.__state = { emit, list, maxInput };
    layoutPanel = lp;
  };

  const readLayoutFromDom = (): FieldLayout => {
    const st = layoutPanel?.__state;
    const rows = st ? Array.from(st.list.querySelectorAll<HTMLElement>('.jlv-layout-row')) : [];
    const pinned: string[] = [];
    const order: string[] = [];
    const hidden: string[] = [];
    for (const row of rows) {
      const key = row.dataset.key ?? '';
      if (!key) continue;
      const cb = row.querySelector<HTMLInputElement>('.jlv-layout-hidden');
      if (cb?.checked) hidden.push(key);
      else if (row.classList.contains('pinned')) pinned.push(key);
      else order.push(key);
    }
    const maxKeys = st ? Number(st.maxInput.value) || 4 : panelLayout.maxKeys;
    return { pinned, order, hidden, maxKeys };
  };

  const onRestoreDefault = (): void => {
    handlers.onApplyLayout?.({
      pinned: [],
      order: panelFields.map((f) => f.key),
      hidden: [],
      maxKeys: 4,
    });
  };

  const rebuildLayoutRows = (): void => {
    if (!layoutPanel) return;
    const list = layoutPanel.__state?.list;
    if (!list) return;
    list.textContent = '';

    const pinnedSet = new Set(panelLayout.pinned);
    const hiddenSet = new Set(panelLayout.hidden);
    const shown = [...panelLayout.pinned, ...panelLayout.order];
    const seen = new Set<string>();

    for (const f of panelFields) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      const isShown = shown.includes(f.key) && !hiddenSet.has(f.key);
      const row = document.createElement('label');
      row.className = 'jlv-layout-row jlv-field-item';
      row.dataset.key = f.key;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'jlv-layout-hidden';
      cb.checked = hiddenSet.has(f.key);
      cb.title = '隐藏该字段';
      cb.addEventListener('change', () => emitLayout());

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'jlv-btn jlv-pin';
      pin.textContent = '📌';
      pin.title = '固定到最前';
      pin.classList.toggle('pinned', pinnedSet.has(f.key) && isShown);
      pin.addEventListener('click', (e) => {
        e.preventDefault();
        togglePin(f.key);
      });

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'jlv-btn';
      upBtn.textContent = '↑';
      upBtn.title = '前移';
      upBtn.addEventListener('click', (e) => {
        e.preventDefault();
        moveField(f.key, -1);
      });
      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'jlv-btn';
      downBtn.textContent = '↓';
      downBtn.title = '后移';
      downBtn.addEventListener('click', (e) => {
        e.preventDefault();
        moveField(f.key, 1);
      });

      const name = document.createElement('span');
      name.className = 'jlv-layout-name';
      name.textContent = f.key;
      name.title = f.type ? `${f.key} (${f.type})` : f.key;

      row.append(name, cb, pin, upBtn, downBtn);
      list.appendChild(row);
    }
  };

  const emitLayout = (): void => handlers.onApplyLayout?.(readLayoutFromDom());

  const togglePin = (key: string): void => {
    const layout = readLayoutFromDom();
    const isPinned = layout.pinned.includes(key);
    layout.pinned = isPinned
      ? layout.pinned.filter((k) => k !== key)
      : [key, ...layout.pinned.filter((k) => k !== key)];
    layout.order = layout.order.filter((k) => k !== key);
    applyLayoutToPanel(layout);
    handlers.onApplyLayout?.(layout);
  };

  const moveField = (key: string, dir: number): void => {
    const layout = readLayoutFromDom();
    const target = [...layout.order];
    const i = target.indexOf(key);
    if (i < 0) return;
    const j = Math.min(Math.max(i + dir, 0), target.length - 1);
    if (j === i) return;
    target.splice(i, 1);
    target.splice(j, 0, key);
    layout.order = target;
    applyLayoutToPanel(layout);
    handlers.onApplyLayout?.(layout);
  };

  const applyLayoutToPanel = (layout: FieldLayout): void => {
    panelLayout = layout;
    rebuildLayoutRows();
    const maxInput = layoutPanel?.__state?.maxInput;
    if (maxInput) maxInput.value = String(layout.maxKeys);
  };

  customizeBtn.addEventListener('click', () => {
    // 面板互斥：打开字段时收起筛选面板
    if (filterPanel && filterPanel.style.display !== 'none') {
      filterPanel.style.display = 'none';
      filterBtn.classList.remove('active');
    }
    if (!layoutPanel || !document.body.contains(layoutPanel)) {
      // 首次创建：直接显示
      buildLayoutPanel();
      rebuildLayoutRows();
      layoutPanel?.open();
      customizeBtn.classList.add('active');
      return;
    }
    const visible = layoutPanel.style.display !== 'none';
    if (visible) layoutPanel.close();
    else layoutPanel.open();
    customizeBtn.classList.toggle('active', !visible);
  });

  /* ---------- update / els ---------- */
  const els: ToolbarStatsEls = {
    fileNameEl,
    totalLinesEl,
    loadedEl,
    rangeEl,
    buildMsEl,
    statusEl,
    statusRootEl,
  };

  const update = (info: Partial<ToolbarInfo> & { fileName?: string }): void => {
    if (info.fileName !== undefined) fileNameEl.textContent = info.fileName;
    if (info.totalLines !== undefined)
      totalLinesEl.textContent = ` · ${info.totalLines.toLocaleString('en-US')} 行`;
    if (info.buildMs !== undefined) buildMsEl.textContent = ` · ${formatMs(info.buildMs)}`;
    if (info.range) rangeEl.textContent = `${info.range[0] + 1}–${info.range[1] + 1}`;
    if (info.status) {
      statusRootEl.className = `jlv-sub ${info.status === 'ready' ? 'ready' : info.status === 'error' ? 'error' : ''}`;
      statusEl.textContent = info.statusText ?? statusText(info.status);
    }
  };

  host.appendChild(root);

  /* ---------- 搜索交互 ---------- */
  if (typeof handlers.onSearch === 'function') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    searchInputEl.addEventListener('input', () => {
      updateClear();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => handlers.onSearch?.(searchInputEl.value), 300);
    });
    searchClear.addEventListener('click', () => {
      searchInputEl.value = '';
      updateClear();
      handlers.onSearch?.('');
      searchInputEl.focus();
    });
  }
  prevBtn.addEventListener('click', () => handlers.onSearchPrev?.());
  nextBtn.addEventListener('click', () => handlers.onSearchNext?.());

  const setFields = (fields: readonly FieldOption[] | null): void => {
    panelFields = fields ? [...fields] : [];
    const fieldSel = filterPanel?.__state?.fieldSel;
    if (fieldSel) populateFieldSel(fieldSel);
    if (layoutPanel) {
      panelLayout = trimLayoutToFields(panelLayout, new Set(panelFields.map((f) => f.key)));
      rebuildLayoutRows();
    }
  };

  const trimLayoutToFields = (layout: FieldLayout, known: Set<string>): FieldLayout => ({
    pinned: layout.pinned.filter((k) => known.has(k)),
    order: layout.order.filter((k) => known.has(k)),
    hidden: layout.hidden.filter((k) => known.has(k)),
    maxKeys: layout.maxKeys,
  });

  const setLayout = (layout: FieldLayout): void => {
    panelLayout = layout;
    if (layoutPanel) applyLayoutToPanel(layout);
  };

  const setSearchResult = (total: number, index: number): void => {
    if (total <= 0) {
      matchInfo.hidden = true;
      matchInfo.textContent = '';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      return;
    }
    matchInfo.hidden = false;
    prevBtn.disabled = false;
    nextBtn.disabled = false;
    const shown = Math.max(1, index + 1);
    matchInfo.textContent = `${shown}/${total}`;
  };

  /** M7：过滤结果被宿主截断时显示提示。 */
  const setFilterTruncated = (truncated: boolean): void => {
    filterNoteEl.hidden = !truncated;
  };

  /** 释放 document 级监听器（webview 关闭时调用）。防止内存泄漏。 */
  const destroy = (): void => {
    filterPanelDispose?.();
    filterPanelDispose = null;
    layoutPanelDispose?.();
    layoutPanelDispose = null;
  };

  return {
    root,
    els,
    update,
    refresh: () => update({}),
    searchInput: () =>
      document.querySelector<HTMLInputElement>('.jlv-search input') ?? searchInputEl,
    setFields,
    setLayout,
    setSearchResult,
    setFilterTruncated,
    destroy,
  };
}

/* --------------------------- 小工具 --------------------------- */

function label(text: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'jlv-ctrl-label';
  const t = document.createElement('span');
  t.textContent = text;
  wrap.appendChild(t);
  wrap.appendChild(control);
  return wrap;
}

/** 纵向标签（筛选面板：字段名在上、控件在下，占满宽度）。 */
function vlabel(text: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('label');
  const t = document.createElement('span');
  t.textContent = text;
  wrap.appendChild(t);
  wrap.appendChild(control);
  return wrap;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function statusText(s: ToolbarInfo['status']): string {
  switch (s) {
    case 'connecting':
      return '连接中…';
    case 'indexing':
      return '索引构建中…';
    case 'ready':
      return '就绪';
    case 'error':
      return '发生错误';
    default:
      return s;
  }
}

function iconSpan(className: string, svg: string): HTMLElement {
  const s = document.createElement('span');
  s.className = className;
  s.innerHTML = svg;
  return s;
}

const ICON_SEARCH =
  '<svg width="12" height="12" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const ICON_CLEAR =
  '<svg width="10" height="10" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_FILTER =
  '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M2 4h12M5 8h6M8 12h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const ICON_COLUMNS =
  '<svg width="12" height="12" viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="2" width="5" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
