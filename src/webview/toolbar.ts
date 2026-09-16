/**
 * toolbar.ts — 顶部概要栏 + Task 6 的搜索 / 过滤 / 字段定制控件。
 *
 * 概要栏展示：文件名、总行数、已解析/当前范围行数、打开耗时、后端状态。
 * Task 6 新增：
 *   - 全文/字段级搜索输入框（300ms 防抖回调 onSearch）+ 上一条/下一条 + 匹配计数。
 *   - 「筛选」切换一个过滤面板（字段 + 运算符 + 值）；「字段」切换字段显示定制面板。
 * 全部样式来自 styles.ts 的 --vscode-* 变量，贴合主题。DOM/UI 不强测。
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
  /** 防抖后的搜索输入（query 为空表示清空搜索）。 */
  onSearch?: (query: string) => void;
  onSearchPrev?: () => void;
  onSearchNext?: () => void;
  /** 应用/清空字段值过滤（cond 为 null/空 = 清除过滤）。 */
  onApplyFilter?: (cond: FieldCondition | null) => void;
  /** 应用字段显示定制布局（含「恢复默认」）。 */
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

export function createToolbar(host: HTMLElement, handlers: ToolbarHandlers = {}): {
  root: HTMLElement;
  update(info: Partial<ToolbarInfo> & { fileName?: string }): void;
  refresh(): void;
  els: ToolbarStatsEls;
  searchInput(): HTMLInputElement | null;
  /** 设置推断字段，填充过滤字段下拉 + 字段定制面板。 */
  setFields(fields: readonly FieldOption[] | null): void;
  /** 反映当前字段定制布局（勾选/固定/顺序/字段数上限）。 */
  setLayout(layout: FieldLayout): void;
  /** 更新搜索结果状态：total = 命中总数，index = 当前展示第几个（0 起）。 */
  setSearchResult(total: number, index: number): void;
} {
  const root = document.createElement('header');
  root.className = 'jlv-topbar';

  const fileNameEl = document.createElement('span');
  fileNameEl.className = 'jlv-title';
  const totalLinesEl = document.createElement('span');
  totalLinesEl.className = 'jlv-stat';
  const loadedEl = document.createElement('span');
  loadedEl.className = 'jlv-stat';
  const rangeEl = document.createElement('span');
  rangeEl.className = 'jlv-stat';
  const buildMsEl = document.createElement('span');
  buildMsEl.className = 'jlv-stat';
  const statusRootEl = document.createElement('span');
  statusRootEl.className = 'jlv-status';
  const statusDot = document.createElement('span');
  statusDot.className = 'dot';
  const statusEl = document.createElement('span');
  statusEl.textContent = '…';
  statusRootEl.appendChild(statusDot);
  statusRootEl.appendChild(statusEl);

  // 概要
  const titleBlock = document.createElement('div');
  titleBlock.style.display = 'flex';
  titleBlock.style.alignItems = 'center';
  titleBlock.style.gap = '12px';
  titleBlock.style.minWidth = '0';
  titleBlock.appendChild(fileNameEl);
  titleBlock.appendChild(totalLinesEl);
  titleBlock.appendChild(loadedEl);
  titleBlock.appendChild(rangeEl);
  titleBlock.appendChild(buildMsEl);

  /* ---------------------- 搜索控件 ---------------------- */
  const search = document.createElement('input');
  search.className = 'jlv-field jlv-search';
  search.type = 'search';
  search.placeholder = '搜索记录…';
  search.autocomplete = 'off';
  search.spellcheck = false;

  const prevBtn = document.createElement('button');
  prevBtn.className = 'jlv-tbtn jlv-nav';
  prevBtn.textContent = '↑';
  prevBtn.title = '上一个匹配';
  const nextBtn = document.createElement('button');
  nextBtn.className = 'jlv-tbtn jlv-nav';
  nextBtn.textContent = '↓';
  nextBtn.title = '下一个匹配';
  const matchInfo = document.createElement('span');
  matchInfo.className = 'jlv-match';
  matchInfo.textContent = '';
  prevBtn.disabled = true;
  nextBtn.disabled = true;

  const searchGroup = document.createElement('div');
  searchGroup.className = 'jlv-ctrl-group';
  searchGroup.appendChild(search);
  searchGroup.appendChild(prevBtn);
  searchGroup.appendChild(nextBtn);
  searchGroup.appendChild(matchInfo);

  /* ---------------------- 面板切换按钮 ---------------------- */
  const filterBtn = document.createElement('button');
  filterBtn.className = 'jlv-tbtn';
  filterBtn.textContent = '筛选';
  filterBtn.title = '字段值过滤';
  const customizeBtn = document.createElement('button');
  customizeBtn.className = 'jlv-tbtn';
  customizeBtn.textContent = '字段';
  customizeBtn.title = '字段显示定制（显隐/排序/固定）';

  const spacer = document.createElement('div');
  spacer.className = 'spacer';

  root.appendChild(titleBlock);
  root.appendChild(spacer);
  root.appendChild(searchGroup);
  root.appendChild(filterBtn);
  root.appendChild(customizeBtn);
  root.appendChild(statusRootEl);

  /* ---------------------- 过滤面板 ---------------------- */
  let filterPanel: HTMLElement | null = null;
  const buildFilterPanel = (): HTMLElement => {
    const panel = document.createElement('div');
    panel.className = 'jlv-panel';

    const fieldSel = document.createElement('select');
    fieldSel.className = 'jlv-depth';
    fieldSel.title = '字段';
    const opSel = document.createElement('select');
    opSel.className = 'jlv-depth';
    opSel.title = '运算符';
    const valueInput = document.createElement('input');
    valueInput.className = 'jlv-field';
    valueInput.placeholder = '值';
    valueInput.spellcheck = false;

    const OPS: Array<[string, FieldCondition['op']]> = [
      ['等于', 'eq'],
      ['包含', 'contains'],
      ['存在', 'exists'],
      ['类型', 'type'],
    ];
    for (const [label, val] of OPS) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = label;
      opSel.appendChild(o);
    }
    const typeSel = document.createElement('select');
    typeSel.className = 'jlv-depth';
    typeSel.title = '值类型';
    for (const t of ['string', 'number', 'boolean', 'null', 'object', 'array']) {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t;
      typeSel.appendChild(o);
    }

    const applyBtn = document.createElement('button');
    applyBtn.className = 'jlv-tbtn';
    applyBtn.textContent = '应用';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'jlv-tbtn';
    clearBtn.textContent = '清除';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'jlv-tbtn';
    closeBtn.textContent = '✕';
    closeBtn.title = '关闭';

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
    applyBtn.addEventListener('click', () => handlers.onApplyFilter?.(buildCond()));
    clearBtn.addEventListener('click', () => handlers.onApplyFilter?.(null));
    closeBtn.addEventListener('click', () => {
      panel.style.display = 'none';
      filterBtn.classList.remove('active');
    });

    panel.appendChild(label('字段', fieldSel));
    panel.appendChild(label('运算符', opSel));
    panel.appendChild(label('值', valueInput));
    panel.appendChild(label('类型', typeSel));
    panel.appendChild(applyBtn);
    panel.appendChild(clearBtn);
    panel.appendChild(closeBtn);

    // 暴露给 setFields 填充
    (panel as unknown as { _fieldSel?: HTMLSelectElement })._fieldSel = fieldSel;
    return panel;
  };

  filterBtn.addEventListener('click', () => {
    if (!filterPanel) {
      filterPanel = buildFilterPanel();
      root.ownerDocument.body.appendChild(filterPanel);
      // 定位到工具条下方
      const r = root.getBoundingClientRect();
      filterPanel.style.top = `${r.bottom}px`;
    }
    const visible = filterPanel.style.display !== 'none';
    filterPanel.style.display = visible ? 'none' : 'flex';
    filterBtn.classList.toggle('active', !visible);
  });

  /* ---------------------- 字段定制面板 ---------------------- */
  let layoutPanel: HTMLElement | null = null;
  let panelFields: FieldOption[] = [];
  let panelLayout: FieldLayout = { pinned: [], order: [], hidden: [], maxKeys: 4 };

  const buildLayoutPanel = (): HTMLElement => {
    const panel = document.createElement('div');
    panel.className = 'jlv-panel';
    panel.style.flexDirection = 'column';
    panel.style.alignItems = 'stretch';
    panel.style.maxHeight = '40vh';
    panel.style.overflow = 'auto';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const maxLabel = label('展示字段数', document.createElement('input'));
    const maxInput = maxLabel.querySelector('input') as HTMLInputElement;
    maxInput.type = 'number';
    maxInput.min = '1';
    maxInput.max = '20';
    maxInput.value = '4';
    maxInput.style.width = '56px';
    head.appendChild(maxLabel);

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'jlv-tbtn';
    restoreBtn.textContent = '恢复默认';
    const close2 = document.createElement('button');
    close2.className = 'jlv-tbtn';
    close2.textContent = '✕';
    close2.title = '关闭';
    head.appendChild(restoreBtn);
    head.appendChild(close2);
    panel.appendChild(head);

    const list = document.createElement('div');
    list.className = 'jlv-layout-list';
    panel.appendChild(list);

    const emit = (): void => {
      const layout = readLayoutFromDom();
      handlers.onApplyLayout?.(layout);
    };
    maxInput.addEventListener('change', emit);
    restoreBtn.addEventListener('click', () => onRestoreDefault());
    close2.addEventListener('click', () => {
      panel.style.display = 'none';
      customizeBtn.classList.remove('active');
    });

    (panel as unknown as { _emit?: () => void; _list?: HTMLElement })._emit = emit;
    (panel as unknown as { _list?: HTMLElement })._list = list;
    // 由 setLayout 重建，这里不填充
    return panel;
  };

  const readLayoutFromDom = (): FieldLayout => {
    const list = layoutPanel && ((layoutPanel as unknown as { _list?: HTMLElement })._list as HTMLElement);
    const rows = list ? Array.from(list.querySelectorAll<HTMLElement >('.jlv-layout-row')) : [];
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
    const maxInput = layoutPanel?.querySelector<HTMLInputElement>('input[type=number]');
    const maxKeys = maxInput ? Number(maxInput.value) || 4 : panelLayout.maxKeys;
    return { pinned, order, hidden, maxKeys };
  };

  const onRestoreDefault = (): void => {
    const layout = {
      pinned: [],
      order: panelFields.map((f) => f.key),
      hidden: [],
      maxKeys: 4,
    };
    handlers.onApplyLayout?.(layout);
  };

  const rebuildLayoutRows = (): void => {
    if (!layoutPanel) return;
    const list = (layoutPanel as unknown as { _list?: HTMLElement })._list as HTMLElement;
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
      row.className = 'jlv-layout-row';
      row.dataset.key = f.key;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'jlv-layout-hidden';
      cb.checked = hiddenSet.has(f.key);
      cb.title = '隐藏该字段';
      cb.addEventListener('change', () => emitLayout());

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'jlv-tbtn jlv-pin';
      pin.textContent = '📌';
      pin.title = '固定到最前';
      pin.classList.toggle('pinned', pinnedSet.has(f.key) && isShown);
      pin.addEventListener('click', (e) => {
        e.preventDefault();
        togglePin(f.key);
      });

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'jlv-tbtn';
      upBtn.textContent = '↑';
      upBtn.title = '前移';
      upBtn.addEventListener('click', (e) => {
        e.preventDefault();
        moveField(f.key, -1);
      });
      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'jlv-tbtn';
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

      row.appendChild(name);
      row.appendChild(cb);
      row.appendChild(pin);
      row.appendChild(upBtn);
      row.appendChild(downBtn);
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
    const maxInput = layoutPanel?.querySelector<HTMLInputElement>('input[type=number]');
    if (maxInput) maxInput.value = String(layout.maxKeys);
  };

  customizeBtn.addEventListener('click', () => {
    if (!layoutPanel) {
      layoutPanel = buildLayoutPanel();
      root.ownerDocument.body.appendChild(layoutPanel);
      rebuildLayoutRows();
      const r = root.getBoundingClientRect();
      layoutPanel.style.top = `${r.bottom}px`;
    }
    const visible = layoutPanel.style.display !== 'none';
    layoutPanel.style.display = visible ? 'none' : 'block';
    customizeBtn.classList.toggle('active', !visible);
  });

  /* --------------------- 概要栏 update / els --------------------- */
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
    if (info.totalLines !== undefined) {
      totalLinesEl.textContent = `共 ${info.totalLines.toLocaleString('en-US')} 行`;
    }
    if (info.loadedLines !== undefined) {
      loadedEl.textContent = `已解析 ${info.loadedLines.toLocaleString('en-US')} 行`;
    }
    if (info.range) {
      rangeEl.textContent = `当前可见 ${info.range[0] + 1}–${info.range[1]} 行`;
    }
    if (info.buildMs !== undefined) {
      buildMsEl.textContent = `打开 ${formatMs(info.buildMs)}`;
    }
    if (info.status) {
      statusRootEl.className = `jlv-status ${info.status === 'ready' ? 'ready' : info.status === 'error' ? 'error' : ''}`;
      statusEl.textContent = info.statusText ?? statusText(info.status);
    }
  };

  /* --------------------- Task 6 对外控制器 --------------------- */
  host.appendChild(root);

  // 搜索防抖（300ms）+ 导航
  if (typeof handlers.onSearch === 'function') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    search.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => handlers.onSearch?.(search.value), 300);
    });
  }
  prevBtn.addEventListener('click', () => handlers.onSearchPrev?.());
  nextBtn.addEventListener('click', () => handlers.onSearchNext?.());

  const setFields = (fields: readonly FieldOption[] | null): void => {
    panelFields = fields ? [...fields] : [];
    // 填充过滤字段下拉
    const fieldSel = filterPanel && (filterPanel as unknown as { _fieldSel?: HTMLSelectElement })._fieldSel;
    if (fieldSel) {
      fieldSel.textContent = '';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '(全部字段)';
      fieldSel.appendChild(none);
      for (const f of panelFields) {
        if (f.key.startsWith('$')) continue; // 过滤用真实字段
        const o = document.createElement('option');
        o.value = f.key;
        o.textContent = f.key;
        fieldSel.appendChild(o);
      }
    }
    if (layoutPanel) {
      // 合并进新推断字段（保留既有定制，剔除不存在字段）
      panelLayout = trimLayoutToFields(panelLayout, new Set(panelFields.map((f) => f.key)));
      rebuildLayoutRows();
    }
  };

  const trimLayoutToFields = (layout: FieldLayout, known: Set<string>): FieldLayout => {
    return {
      pinned: layout.pinned.filter((k) => known.has(k)),
      order: layout.order.filter((k) => known.has(k)),
      hidden: layout.hidden.filter((k) => known.has(k)),
      maxKeys: layout.maxKeys,
    };
  };

  const setLayout = (layout: FieldLayout): void => {
    panelLayout = layout;
    if (layoutPanel) applyLayoutToPanel(layout);
  };

  const setSearchResult = (total: number, index: number): void => {
    if (total <= 0) {
      matchInfo.textContent = '';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      return;
    }
    prevBtn.disabled = false;
    nextBtn.disabled = false;
    const shown = Math.max(1, index + 1);
    matchInfo.textContent = `${shown}/${total}`;
  };

  return {
    root,
    els,
    update,
    refresh: () => update({}),
    searchInput: () => document.querySelector<HTMLInputElement>('.jlv-search') ?? search,
    setFields,
    setLayout,
    setSearchResult,
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