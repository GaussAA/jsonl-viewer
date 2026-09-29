/**
 * toolbar.ts — 左栏工具栏浮卡（按原型 1:1 复刻）。
 *
 * 结构：J 图标 + 文件名 + 状态点副标题 / 搜索框 + 上一条/下一条 / 筛选·字段按钮 + 页码范围。
 * Task 6 搜索 / 过滤 / 字段定制逻辑保留：搜索防抖、匹配计数与导航、筛选与字段浮层面板。
 */

import { isConditionGroup } from './queryLogic.ts';
import type { Condition, FieldCondition, FieldLayout, FilterOp } from './queryLogic.ts';
import { formatBuildMs, formatCount } from './logic.ts';

export interface ToolbarInfo {
  fileName: string;
  totalRecords: number;
  range: [number, number];
  buildMs: number | undefined;
  status: 'connecting' | 'indexing' | 'ready' | 'error';
  statusText?: string;
  /**
   * 坏行计数。
   *
   * `partial` 表示这只是**已发现**的下界（未做过全文件扫描）—— 界面上必须与
   * 「共 N 个」区分开，否则用户会据一个偏小的数字认定文件基本干净。
   */
  badLines?: { count: number; partial: boolean };
}

export interface ToolbarHandlers {
  onSearch?: (query: string) => void;
  onSearchPrev?: () => void;
  onSearchNext?: () => void;
  /** 「全部替换」：查询取自搜索框，替换文本取自替换输入框。 */
  onReplaceAll?: (query: string, replacement: string) => void;
  /** 「编辑历史」：打开会话历史浮层（撤销/重做/回退到某一步）。 */
  onOpenHistory?: () => void;
  /** 「坏行诊断」：打开坏行浮层（查看 / 扫描 / 全选清除）。 */
  onOpenBadLines?: () => void;
  onApplyFilter?: (cond: Condition | null) => void;
  /** 打开全量数据画像（F4）。与「筛选」并列但语义不同：那个改视图，这个只读统计。 */
  onOpenProfile?: () => void;
  onApplyLayout?: (layout: FieldLayout) => void;
}

export interface ToolbarStatsEls {
  fileNameEl: HTMLElement;
  totalRecordsEl: HTMLElement;
  loadedEl: HTMLElement;
  rangeEl: HTMLElement;
  buildMsEl: HTMLElement;
  statusEl: HTMLElement;
  statusRootEl: HTMLElement;
  /** 坏行徽章（无坏行时隐藏）。 */
  badLinesBtn: HTMLButtonElement;
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
/** 一个条件行：DOM + 读出条件的能力。 */
interface CondRow {
  el: HTMLElement;
  fieldSel: HTMLSelectElement;
  /** 读出本行条件；字段未选（还没填完）时返回 null。 */
  read: () => FieldCondition | null;
}

interface FilterPanelState {
  /** 当前所有条件行（setFields 回填字段选项时要遍历它们）。 */
  rows: CondRow[];
  /** 组逻辑选择器（且 / 或）。 */
  groupSel: HTMLSelectElement;
  /** 把一棵条件树回填进面板（面板重建后由外部再次调用）。 */
  applyCond: (cond: Condition | null) => void;
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
  els: ToolbarStatsEls;
  searchInput(): HTMLInputElement | null;
  setFields(fields: readonly FieldOption[] | null): void;
  setLayout(layout: FieldLayout): void;
  setSearchResult(total: number, index: number): void;
  setFilterTruncated(truncated: boolean): void;
  /** 用给定条件回填筛选面板（恢复偏好时调用，保证「所见即当前条件」）。 */
  setFilterCondition(cond: Condition | null): void;
  /**
   * 查询失败态：非 null 时在计数位置显示失败文案。
   *
   * 为何必须有它：原先失败走的是 `setSearchResult(0, 0)` —— 与「真的没有命中」
   * 在界面上完全同形。用户看到「0」只会认为文件里没有这个词，而不会想到「是请求挂了」。
   */
  setQueryError(message: string | null): void;
  /** 替换输入框（未展开时仍存在，只是不可见）。 */
  replaceInput(): HTMLInputElement;
  /** 展开 / 收起替换行；返回展开后的状态。 */
  toggleReplace(open?: boolean): boolean;
  /** 替换执行中：禁用按钮并改文案，避免重复点击触发第二次写入。 */
  setReplaceBusy(busy: boolean): void;
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
  const totalRecordsEl = document.createElement('span');
  const loadedEl = document.createElement('span');
  loadedEl.hidden = true;
  const buildMsEl = document.createElement('span');
  // 坏行徽章：只在确有坏行时出现（常驻一个「0 坏行」只是噪音）。
  const badLinesBtn = document.createElement('button');
  badLinesBtn.type = 'button';
  badLinesBtn.className = 'jlv-bad-chip';
  badLinesBtn.hidden = true;
  badLinesBtn.addEventListener('click', () => handlers.onOpenBadLines?.());
  statusRootEl.append(statusDot, statusEl, totalRecordsEl, badLinesBtn, loadedEl, buildMsEl);

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

  /* ---------- 查找替换：切换按钮 + 替换行（默认收起） ---------- */
  const replaceToggle = document.createElement('button');
  replaceToggle.type = 'button';
  replaceToggle.className = 'jlv-nav-btn jlv-replace-toggle';
  replaceToggle.title = '查找替换';
  replaceToggle.setAttribute('aria-label', '查找替换');
  replaceToggle.setAttribute('aria-expanded', 'false');
  replaceToggle.innerHTML = ICON_REPLACE;

  const replaceRow = document.createElement('div');
  replaceRow.className = 'jlv-replace';
  replaceRow.hidden = true;

  const replaceInputEl = document.createElement('input');
  replaceInputEl.type = 'text';
  replaceInputEl.className = 'jlv-replace-input';
  replaceInputEl.placeholder = '替换为…';
  replaceInputEl.autocomplete = 'off';
  replaceInputEl.spellcheck = false;

  const replaceBtn = document.createElement('button');
  replaceBtn.type = 'button';
  replaceBtn.className = 'jlv-btn jlv-replace-go';
  replaceBtn.textContent = '全部替换';
  replaceBtn.title = '把搜索框命中的文本全部替换掉（立即写入磁盘）';
  replaceBtn.addEventListener('click', () =>
    handlers.onReplaceAll?.(searchInputEl.value, replaceInputEl.value)
  );

  replaceRow.append(replaceInputEl, replaceBtn);

  const setReplaceBusy = (busy: boolean): void => {
    replaceBtn.disabled = busy;
    replaceInputEl.disabled = busy;
    replaceBtn.textContent = busy ? '替换中…' : '全部替换';
  };

  const toggleReplace = (open?: boolean): boolean => {
    // hidden 在新 DOM 类型里是 boolean | 'until-found'，此处归一化为布尔（我们只用 true/false）。
    const next = open ?? replaceRow.hidden === true;
    replaceRow.hidden = !next;
    replaceToggle.setAttribute('aria-expanded', String(next));
    replaceToggle.classList.toggle('active', next);
    if (next) replaceInputEl.focus();
    return next;
  };
  replaceToggle.addEventListener('click', () => void toggleReplace());

  search.append(
    iconSpan('jlv-search-ic', ICON_SEARCH),
    searchInputEl,
    searchClear,
    matchInfo,
    navGroup,
    replaceToggle
  );
  root.appendChild(search);
  root.appendChild(replaceRow);

  const updateClear = (): void => {
    searchClear.hidden = searchInputEl.value.length === 0;
  };

  /* ---------- 按钮行：筛选 / 字段 + 页码范围 ---------- */
  const actions = document.createElement('div');
  actions.className = 'jlv-toolbar-actions';

  const historyBtn = document.createElement('button');
  historyBtn.type = 'button';
  historyBtn.className = 'jlv-btn';
  historyBtn.title = '编辑历史（撤销 / 重做 / 回退到某一步）';
  historyBtn.appendChild(iconSpan('jlv-btn-ic', ICON_HISTORY));
  historyBtn.appendChild(document.createTextNode('历史'));
  historyBtn.addEventListener('click', () => handlers.onOpenHistory?.());

  const filterBtn = document.createElement('button');
  filterBtn.type = 'button';
  filterBtn.className = 'jlv-btn';
  filterBtn.title = '字段值过滤';
  filterBtn.appendChild(iconSpan('jlv-btn-ic', ICON_FILTER));
  filterBtn.appendChild(document.createTextNode('筛选'));

  const profileBtn = document.createElement('button');
  profileBtn.type = 'button';
  profileBtn.className = 'jlv-btn';
  profileBtn.title = '数据画像：扫描整个文件统计字段分布与数据质量（只读，不改数据）';
  profileBtn.appendChild(iconSpan('jlv-btn-ic', ICON_PROFILE));
  profileBtn.appendChild(document.createTextNode('画像'));
  profileBtn.addEventListener('click', () => handlers.onOpenProfile?.());

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

  actions.append(historyBtn, filterBtn, profileBtn, customizeBtn, rangeEl);
  root.appendChild(actions);
  root.appendChild(filterNoteEl);

  /* ---------- 过滤面板（原型 .jlv-float-panel） ---------- */
  let filterPanel: FloatPanel<FilterPanelState> | null = null;
  let filterPanelDispose: (() => void) | null = null;
  /** 当前生效的过滤条件（面板回填 / 重开时保持所见即所得）。 */
  let panelFilterCond: Condition | null = null;
  /** 由 buildFilterPanel 赋值的回填入口（面板尚未建过时为 null）。 */
  let applyCondToFilterPanel: ((c: Condition | null) => void) | null = null;
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
    /** 面板内可聚焦控件（**排除标题栏的关闭按钮**）。 */
    const focusables = (): HTMLElement[] =>
      [
        ...panel.querySelectorAll<HTMLElement>(
          'button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'
        ),
      ].filter((el) => el !== closeBtn && !el.hasAttribute('disabled'));

    // 单实例复用：关闭仅淡出后隐藏（不移除 DOM），下次打开直接显示
    const close = (): void => {
      // 关闭时把焦点还给触发按钮（无论由 Esc / 外点 / 关闭按钮触发）：
      // 否则键盘用户关闭浮层后「丢失位置」，只能从文档开头重新 Tab。
      if (panel.contains(document.activeElement)) anchor.focus();
      onClose?.();
      panel.classList.add('closing');
      setTimeout(() => {
        panel.style.display = 'none';
        panel.classList.remove('closing');
      }, 120); // 与样式 --dur-fast:120ms 对齐（此前 100ms 会截断淡出）
    };
    closeBtn.addEventListener('click', close);

    // 打开：显示 + 焦点移入**第一个表单控件**。
    //
    // 为何要显式排除关闭按钮：h3（含 closeBtn）在 DOM 上先于表单节点入 panel，
    // 故宽泛的 `querySelector('button, input, select')` 命中的正是「关闭」——
    // M9 那次「焦点移入面板」的修复实际把焦点放到了关闭按钮上，紧接着按 Enter 就把面板关了。
    const open = (): void => {
      panel.style.display = 'block';
      const first = focusables()[0];
      (first ?? closeBtn).focus();
    };

    // Tab 循环（focus trap）：面板是 `aria-modal` 浮层，焦点不该穿到背后的列表上。
    // 关闭时把焦点还给触发按钮 —— 否则键盘用户关闭面板后「丢失位置」，只能从头 Tab。
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
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

  /** 条件行数上限：一层 AND/OR 的真实用法远用不到 8 个，设界防面板变成无底洞。 */
  const MAX_COND_ROWS = 8;

  const buildFilterPanel = (): void => {
    const { panel, close, open, dispose } = panelShell('字段筛选', filterBtn, () =>
      filterBtn.classList.remove('active')
    );
    filterPanelDispose = dispose;
    // 条件行比原单条件面板宽（字段+运算符+值+非+删除），单独放宽上限。
    panel.classList.add('jlv-panel-filter');

    const OPS: Array<[string, FilterOp]> = [
      ['等于', 'eq'],
      ['包含', 'contains'],
      ['存在', 'exists'],
      ['类型', 'type'],
    ];

    // 组逻辑：只在条件 ≥ 2 行时显示 —— 单条件时它没有意义，显示出来只会让人以为必须选。
    const groupRow = document.createElement('div');
    groupRow.className = 'jlv-cond-group';
    const groupLabel = document.createElement('span');
    groupLabel.textContent = '匹配';
    const groupSel = document.createElement('select');
    groupSel.title = '条件之间的组合方式';
    for (const [text, val] of [
      ['全部条件（且）', 'and'],
      ['任一条件（或）', 'or'],
    ]) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = text;
      groupSel.appendChild(o);
    }
    groupRow.append(groupLabel, groupSel);

    const list = document.createElement('div');
    list.className = 'jlv-cond-list';
    const rows: CondRow[] = [];

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'jlv-btn jlv-cond-add';
    addBtn.textContent = '＋ 添加条件';

    const syncChrome = (): void => {
      groupRow.hidden = rows.length < 2;
      addBtn.disabled = rows.length >= MAX_COND_ROWS;
      addBtn.title = addBtn.disabled ? `最多 ${MAX_COND_ROWS} 个条件` : '再添加一个条件';
    };

    /** 造一个条件行。init 给定时按它回填（打开面板 / 恢复偏好时用）。 */
    const makeCondRow = (init?: FieldCondition): CondRow => {
      const el = document.createElement('div');
      el.className = 'jlv-cond-row';

      const negWrap = document.createElement('label');
      negWrap.className = 'jlv-cond-neg';
      negWrap.title = '取反：该条件「不满足」时才算命中';
      const neg = document.createElement('input');
      neg.type = 'checkbox';
      neg.checked = !!init?.negate;
      negWrap.append(neg, document.createTextNode('非'));

      const fieldSel = document.createElement('select');
      fieldSel.title = '字段';
      populateFieldSel(fieldSel);
      if (init?.field) fieldSel.value = init.field;

      const opSel = document.createElement('select');
      opSel.title = '运算符';
      for (const [opLabel, val] of OPS) {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = opLabel;
        opSel.appendChild(o);
      }
      if (init?.op) opSel.value = init.op;

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

      const syncTypeUI = (): void => {
        const op = opSel.value as FilterOp;
        valueInput.style.display = op === 'exists' ? 'none' : '';
        typeSel.style.display = op === 'type' ? '' : 'none';
      };
      opSel.addEventListener('change', syncTypeUI);
      if (init) {
        if (init.op === 'type') typeSel.value = init.value;
        else valueInput.value = init.value;
      }
      syncTypeUI();

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'jlv-cond-del';
      delBtn.title = '移除此条件';
      delBtn.setAttribute('aria-label', '移除此条件');
      delBtn.textContent = '✕';

      el.append(negWrap, fieldSel, opSel, valueInput, typeSel, delBtn);

      const read = (): FieldCondition | null => {
        const field = fieldSel.value;
        const op = opSel.value as FilterOp;
        if (!field || !op) return null;
        const value = op === 'type' ? typeSel.value : valueInput.value;
        const base: FieldCondition = { field, op, value };
        return neg.checked ? { ...base, negate: true } : base;
      };
      return { el, fieldSel, read };
    };

    const addRow = (init?: FieldCondition): void => {
      if (rows.length >= MAX_COND_ROWS) return;
      const row = makeCondRow(init);
      row.el.querySelector<HTMLButtonElement>('.jlv-cond-del')?.addEventListener('click', () => {
        const i = rows.indexOf(row);
        if (i >= 0) rows.splice(i, 1);
        row.el.remove();
        // 至少留一行空的：全删光只会得到一个空白面板，用户不知道下一步该做什么。
        if (rows.length === 0) addRow();
        syncChrome();
      });
      rows.push(row);
      list.appendChild(row.el);
      syncChrome();
    };

    /**
     * 把条件树回填进面板。
     *
     * `not` 组在这里做等价转换：`not(a, b)` ≡ `and(非a, 非b)`（都不满足 = 每个都不满足），
     * 而界面只暴露「且 / 或 + 每项可非」这一层 —— 与其为一个很少用的算子单独做 UI，
     * 不如把它翻译成界面能表达的形式，语义完全一致。
     */
    const applyCond = (cond: Condition | null): void => {
      for (const r of rows) r.el.remove();
      rows.length = 0;
      if (cond && isConditionGroup(cond)) {
        groupSel.value = cond.kind === 'or' ? 'or' : 'and';
        for (const it of cond.items) {
          if (isConditionGroup(it)) continue; // 只回填一层（界面不支持更深的嵌套）
          addRow(cond.kind === 'not' ? { ...it, negate: !it.negate } : it);
        }
      } else if (cond) {
        groupSel.value = 'and';
        addRow(cond);
      }
      if (rows.length === 0) addRow();
      syncChrome();
    };

    const buildCond = (): Condition | null => {
      const items: FieldCondition[] = [];
      for (const r of rows) {
        const c = r.read();
        if (c) items.push(c);
      }
      if (items.length === 0) return null;
      // 单个条件仍产出**叶子**而不是只有一项的组：与历史序列化形状、协议旧通道
      // 完全一致，也让「只有一个条件」的界面与旧版逐字段相同。
      if (items.length === 1) return items[0];
      return { kind: groupSel.value === 'or' ? 'or' : 'and', items };
    };

    const applyBtn = document.createElement('button');
    applyBtn.className = 'jlv-btn-panel primary';
    applyBtn.textContent = '应用';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'jlv-btn-panel';
    clearBtn.textContent = '清除';

    addBtn.addEventListener('click', () => addRow());
    applyBtn.addEventListener('click', () => {
      const cond = buildCond();
      panelFilterCond = cond;
      handlers.onApplyFilter?.(cond);
      close(); // close 内 onClose 会移除按钮 active（面板关闭即恢复样式）
    });
    clearBtn.addEventListener('click', () => {
      panelFilterCond = null;
      applyCond(null);
      handlers.onApplyFilter?.(null);
      close();
    });

    panel.append(groupRow, list, addBtn);
    const acts = document.createElement('div');
    acts.className = 'jlv-panel-actions';
    acts.append(clearBtn, applyBtn);
    panel.appendChild(acts);

    Object.assign(panel, { close, open });
    const fp = panel as FloatPanel<FilterPanelState>;
    fp.__state = { rows, groupSel, applyCond };
    filterPanel = fp;
    applyCondToFilterPanel = applyCond; // 面板重建后，外部的 setFilterCondition 仍可用
    applyCond(panelFilterCond); // 打开前已知的条件先回填（否则用户看不到自己设过什么）
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
    // 用 Set 存「应显示」的字段：下方对每个字段都要判定一次，数组 includes 是 O(n) 线性扫。
    const shownSet = new Set([...panelLayout.pinned, ...panelLayout.order]);
    const seen = new Set<string>();

    for (const f of panelFields) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      const isShown = shownSet.has(f.key) && !hiddenSet.has(f.key);
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
    totalRecordsEl,
    loadedEl,
    rangeEl,
    buildMsEl,
    statusEl,
    statusRootEl,
    badLinesBtn,
  };

  const update = (info: Partial<ToolbarInfo> & { fileName?: string }): void => {
    if (info.fileName !== undefined) fileNameEl.textContent = info.fileName;
    if (info.totalRecords !== undefined)
      totalRecordsEl.textContent = ` · ${formatCount(info.totalRecords)} 条记录`;
    if (info.buildMs !== undefined) buildMsEl.textContent = ` · ${formatBuildMs(info.buildMs)}`;
    if (info.range) rangeEl.textContent = `${info.range[0] + 1}–${info.range[1] + 1}`;
    if (info.badLines) {
      const { count, partial } = info.badLines;
      badLinesBtn.hidden = count === 0;
      // 未扫描时用「N+」而非确数 —— 它只是已发现的下界。写成确数会让用户
      // 据一个偏小的数字认定「文件基本干净」，那是最危险的误判。
      badLinesBtn.textContent = partial ? `⚠ ${count}+ 坏行` : `⚠ ${count} 坏行`;
      badLinesBtn.classList.toggle('partial', partial);
      badLinesBtn.title = partial
        ? `已发现 ${count} 个坏行（仅在已浏览范围内，未扫描整个文件）—— 点击查看`
        : `共 ${count} 个坏行 —— 点击查看`;
    }
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
    // 每一行都要重填字段选项：新文件可能多出/少了字段，只填第一行会让其余行停在旧选项上。
    for (const row of filterPanel?.__state?.rows ?? []) populateFieldSel(row.fieldSel);
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

  const setQueryError = (message: string | null): void => {
    if (message === null) {
      matchInfo.classList.remove('error');
      if (!matchInfo.dataset.count) matchInfo.hidden = true;
      matchInfo.textContent = matchInfo.dataset.count ?? '';
      return;
    }
    matchInfo.classList.add('error');
    matchInfo.hidden = false;
    matchInfo.textContent = message;
    delete matchInfo.dataset.count;
    prevBtn.disabled = true;
    nextBtn.disabled = true;
  };

  const setSearchResult = (total: number, index: number): void => {
    // 一旦有真实计数，失败态即告结束（否则「0 匹配」会顶着一句错误文案）。
    matchInfo.classList.remove('error');
    if (total <= 0) {
      delete matchInfo.dataset.count;
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
    matchInfo.dataset.count = matchInfo.textContent;
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
    setQueryError,
    els,
    update,
    searchInput: () =>
      document.querySelector<HTMLInputElement>('.jlv-search input') ?? searchInputEl,
    setFields,
    setLayout,
    setSearchResult,
    setFilterTruncated,
    setFilterCondition: (cond: Condition | null): void => {
      panelFilterCond = cond;
      applyCondToFilterPanel?.(cond);
    },
    replaceInput: () => replaceInputEl,
    toggleReplace,
    setReplaceBusy,
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
const ICON_REPLACE =
  '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M3 5.5h7.5a2.5 2.5 0 0 1 0 5H6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M8 3L5.6 5.5 8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 10.5H9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const ICON_HISTORY =
  '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M8 4v4l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2.8 8a5.2 5.2 0 1 1 1.5 3.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2 5.6v2.6h2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_PROFILE =
  '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M2 13.2h12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="2.5" y="7.5" width="2.4" height="5" rx="0.6" fill="currentColor" opacity="0.55"/><rect x="6.8" y="4.5" width="2.4" height="8" rx="0.6" fill="currentColor" opacity="0.8"/><rect x="11.1" y="2.5" width="2.4" height="10" rx="0.6" fill="currentColor"/></svg>';
const ICON_COLUMNS =
  '<svg width="12" height="12" viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="2" width="5" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
