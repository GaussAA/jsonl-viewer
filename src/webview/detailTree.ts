/**
 * detailTree.ts — JSON 树详情面板的 DOM 渲染层（vanilla TS，无框架）。
 *
 * 树形逻辑（路径、折叠状态、大数组分段）全部委托给 detailLogic.ts（纯逻辑、可单测）；
 * 本模块只负责把「给定已展开的树形结构」渲染成 DOM：
 *   - 类型着色（CSS 类 + 主题变量）、SVG 折叠图标（无额外依赖）；
 *   - 工具按钮：全部展开 / 全部折叠 / 展开到第 N 层；
 *   - 路径面包屑：展示当前节点的 JSON 路径，点击段可导航并高亮；
 *   - 懒递归 + 大数组分段预览：只为「已展开」的节点建 DOM，超大数组仅渲染首屏
 *     + 「还有 M 项，加载更多」，避免一次性生成海量节点。
 *
 * 该组件与协议层解耦：只要给出一个 JSON 值即可渲染（值来自宿主 readRecord 返回）。
 */

import {
  containerPreview,
  expandContainer,
  isContainer,
  jsonKindOf,
  LARGE_ARRAY_PREVIEW,
  MAX_RENDER_DEPTH,
  pathKey,
  segText,
  TreeState,
} from './detailLogic.ts';
import type { PathSeg } from './detailLogic.ts';

export interface DetailTreeController {
  /** 面板根元素（`.jlv-detail`），供宿主放入布局。 */
  readonly root: HTMLElement;
  /** 展示一条记录的完整 JSON 值（替换旧值、重置折叠状态）。 */
  showRecord(value: unknown): void;
  /** 加载中占位。 */
  showLoading(): void;
  /** 展示错误行信息。 */
  showError(message: string): void;
  /** 清空（未选中）。 */
  clear(): void;
  /** 释放监听器。 */
  dispose(): void;
}

/** 单条标量展示时截断的最大长度（避免把超长字符串塞进 DOM）。 */
const MAX_SCALAR_TEXT = 400;

/** 面包屑/树行内使用的标量格式化。 */
function formatScalar(value: string | number | boolean, kind: string): { text: string; title: string } {
  let text: string;
  if (kind === 'string') {
    text = JSON.stringify(value);
  } else if (kind === 'null') {
    text = 'null';
  } else {
    text = String(value);
  }
  return { text, title: text.length > MAX_SCALAR_TEXT ? text : '' };
}

/** 构造内联 SVG 折叠箭头。 */
function chevronSvg(): string {
  return `<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true" focusable="false"><polygon points="2,1 8,5 2,9" fill="currentColor"></polygon></svg>`;
}

export function createDetailTree(host: HTMLElement): DetailTreeController {
  const root = document.createElement('aside');
  root.className = 'jlv-detail';

  /* ---------------- 工具条 ---------------- */
  const tools = document.createElement('div');
  tools.className = 'jlv-tree-tools';

  const group = document.createElement('div');
  group.className = 'jlv-tree-tools-group';

  const btnExpandAll = document.createElement('button');
  btnExpandAll.className = 'jlv-tbtn';
  btnExpandAll.title = '展开所有层级（大数组仍分段预览）';
  btnExpandAll.dataset.act = 'expandAll';
  btnExpandAll.appendChild(icon('jlv-tbtn__ic', ICON_EXPAND));
  btnExpandAll.appendChild(document.createTextNode('全部展开'));

  const btnCollapseAll = document.createElement('button');
  btnCollapseAll.className = 'jlv-tbtn';
  btnCollapseAll.title = '只保留顶层';
  btnCollapseAll.dataset.act = 'collapseAll';
  btnCollapseAll.appendChild(icon('jlv-tbtn__ic', ICON_COLLAPSE));
  btnCollapseAll.appendChild(document.createTextNode('全部折叠'));

  // 展开深度选择：原生 <select> 的弹层由系统绘制、无法随主题染色，故用自绘下拉替代。
  let selectedDepth = 2; // 当前选中的「展开到第 N 层」深度
  const depthWrap = document.createElement('div');
  depthWrap.className = 'jlv-depth';
  const depthTrigger = document.createElement('button');
  depthTrigger.type = 'button';
  depthTrigger.className = 'jlv-depth__trigger';
  depthTrigger.title = '展开到第 N 层';
  const depthLabel = document.createElement('span');
  depthLabel.className = 'jlv-depth__label';
  depthLabel.textContent = '2 层';
  depthTrigger.appendChild(depthLabel);
  depthTrigger.insertAdjacentHTML('beforeend', chevronSvg());
  const depthMenu = document.createElement('div');
  depthMenu.className = 'jlv-depth__menu';
  depthMenu.hidden = true;
  for (let i = 1; i <= 6; i++) {
    const text = `${i} 层`;
    const optBtn = document.createElement('button');
    optBtn.type = 'button';
    optBtn.className = 'jlv-depth__item';
    optBtn.dataset.level = String(i);
    optBtn.textContent = text;
    depthMenu.appendChild(optBtn);
  }
  depthWrap.appendChild(depthTrigger);
  depthWrap.appendChild(depthMenu);
  syncDepthMenu(); // 标记默认选中的「2 层」

  const btnExpandLevel = document.createElement('button');
  btnExpandLevel.className = 'jlv-tbtn';
  btnExpandLevel.dataset.act = 'expandLevel';
  btnExpandLevel.appendChild(document.createTextNode('展开到该层'));
  btnExpandLevel.appendChild(icon('jlv-tbtn__ic', ICON_LEVEL));

  group.appendChild(btnExpandAll);
  group.appendChild(btnCollapseAll);
  group.appendChild(depthWrap);
  group.appendChild(btnExpandLevel);
  tools.appendChild(group);

  const toolsSpacer = document.createElement('div');
  toolsSpacer.className = 'jlv-tree-tools__spacer';
  tools.appendChild(toolsSpacer);

  /* ---------------- 面包屑 ---------------- */
  const crumb = document.createElement('nav');
  crumb.className = 'jlv-tree-crumb';

  /* ---------------- 树体 ---------------- */
  const body = document.createElement('div');
  body.className = 'jlv-detail-body jlv-tree-body';

  root.appendChild(tools);
  root.appendChild(crumb);
  root.appendChild(body);
  host.appendChild(root);

  /* ---------------- 树状态 ---------------- */
  const state = new TreeState(1); // 默认展开到第 1 层
  const revealed: Record<string, number> = {}; // 父 pathKey -> 「加载更多」额外项数
  let currentValue: unknown = undefined;
  let selectedSegs: PathSeg[] = [];
  let disposed = false;

  function render(): void {
    if (disposed) return;
    renderBreadcrumb();
    renderBody();
  }

  function renderBreadcrumb(): void {
    crumb.textContent = '';
    const rootBtn = crumbButton('$', 0);
    crumb.appendChild(rootBtn);
    selectedSegs.forEach((seg, i) => {
      const prefix = selectedSegs.slice(0, i + 1);
      crumb.append(crumbSeparator('/'));
      const b = crumbButton(segText(seg), prefix.length);
      if (i === selectedSegs.length - 1) b.classList.add('current');
      crumb.appendChild(b);
    });
  }

  function crumbButton(text: string, index: number): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'jlv-crumb-seg';
    b.textContent = text;
    b.title = text;
    b.dataset.index = String(index);
    return b;
  }

  function crumbSeparator(text: string): HTMLElement {
    const s = document.createElement('span');
    s.className = 'jlv-crumb-sep';
    s.textContent = text;
    return s;
  }

  function renderBody(): void {
    body.textContent = '';
    if (currentValue === undefined) {
      const hint = document.createElement('div');
      hint.className = 'jlv-tree-hint';
      hint.textContent = '点击左侧记录查看详情';
      body.appendChild(hint);
      return;
    }
    buildNode(body, [], 0, currentValue);

    // 定位当前选中节点到可视区
    if (selectedSegs.length > 0) {
      const key = pathKey(selectedSegs);
      const el = body.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(key)}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }
  }

  /** 递归构建单个节点及其（已展开的）子树。
   *  节点 = 块容器（.jlv-tree-node）：header 行在上、子树块（.jlv-tree-block）在其下方逐级缩进；
   *  避免旧版「子节点作为 flex 项横向堆积到父标签右侧」造成深层嵌套水平压缩的问题。 */
  function buildNode(
    parent: HTMLElement,
    segs: PathSeg[],
    depth: number,
    value: unknown
  ): void {
    const kind = jsonKindOf(value);
    const container = isContainer(value);

    const node = document.createElement('div');
    node.className = 'jlv-tree-node';

    const row = document.createElement('div');
    row.className = 'jlv-tree-row';
    row.dataset.depth = String(depth);
    row.dataset.container = container ? '1' : '0';
    row.dataset.treeKey = pathKey(segs);
    if (segs.length > 0 && pathKey(segs) === pathKey(selectedSegs)) row.classList.add('selected');

    // 折叠箭头（容器才有；标量用占位对齐）
    const toggler = document.createElement('span');
    toggler.className = 'toggler';
    if (container) toggler.innerHTML = chevronSvg();

    // key：数组下标以 [n] 呈现并弱化，避免与对象键混淆
    const last = segs[segs.length - 1];
    const keyEl = document.createElement('span');
    keyEl.className = 'jlv-key';
    if (segs.length === 0) {
      keyEl.textContent = '$';
    } else {
      keyEl.textContent = segTextKey(last);
      if (last.kind === 'index') keyEl.classList.add('jlv-index');
    }

    const colon = document.createElement('span');
    colon.className = 'jlv-colon';
    colon.textContent = ':';

    row.appendChild(toggler);
    row.appendChild(keyEl);
    row.appendChild(colon);

    let childrenEl: HTMLElement | null = null;

    if (!container) {
      const { text, title } = formatScalar(value as string | number | boolean, kind);
      const v = document.createElement('span');
      v.className = `jlv-value ${kindClass(kind)}`;
      v.textContent = text;
      if (title) v.title = title;
      row.appendChild(v);
    } else {
      // 容器：根据展开状态决定「摘要预览」或完整子树
      const expanded = depth < MAX_RENDER_DEPTH && state.isExpanded(segs, depth);
      row.classList.add(expanded ? 'expanded' : 'collapsed');

      const preview = document.createElement('span');
      preview.className = `jlv-value ${kindClass(kind)} jlv-summary`;
      preview.textContent = expanded ? '' : containerPreview(value as object);
      row.appendChild(preview);

      if (expanded) {
        childrenEl = document.createElement('div');
        childrenEl.className = 'jlv-tree-block';
        const { items, remaining } = expandContainer(value as object, pathKey(segs), revealed);
        for (const it of items) buildNode(childrenEl, [...segs, it.seg], depth + 1, it.value);
        if (remaining > 0) {
          const more = document.createElement('div');
          more.className = 'jlv-load-more';
          more.dataset.parent = pathKey(segs);
          more.textContent = `… 还有 ${remaining} 项，点击加载更多`;
          childrenEl.appendChild(more);
        }
      }
    }

    node.appendChild(row);
    if (childrenEl) node.appendChild(childrenEl);
    parent.appendChild(node);
  }

  function navigateTo(segs: PathSeg[]): void {
    // 确保各祖先（含目标，若为容器）强制展开，使深层节点可见。
    for (let i = 1; i <= segs.length; i++) state.forceExpand(segs.slice(0, i));
    selectedSegs = segs;
    render();
  }

  /* ---------------- 事件 ---------------- */

  function syncDepthMenu(): void {
    depthLabel.textContent = `${selectedDepth} 层`;
    depthMenu.querySelectorAll<HTMLElement>('.jlv-depth__item').forEach((it) =>
      it.classList.toggle('selected', Number(it.dataset.level) === selectedDepth)
    );
  }
  function setDepthMenu(open: boolean): void {
    depthMenu.hidden = !open;
    depthWrap.classList.toggle('open', open);
  }

  depthTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    setDepthMenu(depthMenu.hidden);
    if (!depthMenu.hidden) {
      const cur = depthMenu.querySelector<HTMLElement>('.jlv-depth__item.selected');
      cur?.scrollIntoView({ block: 'nearest' });
    }
  });
  depthMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const item = (e.target as HTMLElement).closest<HTMLElement>('.jlv-depth__item');
    if (!item) return;
    selectedDepth = Number(item.dataset.level);
    syncDepthMenu();
    setDepthMenu(false);
  });
  // 点击下拉外任意处关闭菜单。
  document.addEventListener('click', () => setDepthMenu(false));
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !depthMenu.hidden) setDepthMenu(false);
  });

  tools.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'expandAll') state.expandAll();
    else if (act === 'collapseAll') state.collapseAll();
    else if (act === 'expandLevel') state.expandToLevel(selectedDepth);
    render();
  });

  crumb.addEventListener('click', (e) => {
    const seg = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
    if (!seg) return;
    const index = Number(seg.dataset.index);
    navigateTo(selectedSegs.slice(0, index));
  });

  body.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const more = target.closest<HTMLElement>('.jlv-load-more');
    if (more) {
      const parent = more.dataset.parent ?? '$';
      revealed[parent] = (revealed[parent] ?? 0) + LARGE_ARRAY_PREVIEW;
      render();
      return;
    }
    const row = target.closest<HTMLElement>('.jlv-tree-row');
    if (!row) return;
    const depth = Number(row.dataset.depth);
    const container = row.dataset.container === '1';
    // 选中当前节点
    selectedSegs = row.dataset.treeKey === '$' ? [] : parseSegsFromNode(row);
    if (container && selectedSegs.length > 0) state.toggle(selectedSegs, depth);
    render();
  });

  /** 从行上把 treeKey 反解为 segs（存储的 key 是无歧义编码，与 pathKey 同源）。 */
  function parseSegsFromNode(row: HTMLElement): PathSeg[] {
    const key = row.dataset.treeKey ?? '$';
    if (key === '$') return [];
    const parts = key.split('\u0000');
    return parts.map((part): PathSeg => {
      const kind = part.startsWith('i:') ? 'index' : 'key';
      const raw = part.slice(2);
      let parsed: string;
      try {
        parsed = JSON.parse(raw) as string;
      } catch {
        parsed = raw;
      }
      return { kind, key: parsed };
    });
  }

  /* ---------------- 公开 API ---------------- */

  const controller: DetailTreeController = {
    root,
    showRecord(value) {
      currentValue = value;
      selectedSegs = [];
      state.collapseAll();
      state.expandToLevel(1);
      for (const k of Object.keys(revealed)) delete revealed[k];
      render();
    },
    showLoading() {
      currentValue = undefined;
      render();
      const hint = body.querySelector('.jlv-tree-hint');
      if (!hint) return;
      hint.textContent = '';
      hint.className = 'jlv-tree-loading';
      const ring = document.createElement('div');
      ring.className = 'jlv-progress-ring';
      hint.appendChild(ring);
      const label = document.createElement('span');
      label.textContent = '加载中…';
      hint.appendChild(label);
    },
    showError(message) {
      currentValue = undefined;
      render();
      const hint = body.querySelector<HTMLElement>('.jlv-tree-hint');
      if (!hint) return;
      hint.className = 'jlv-tree-error';
      hint.textContent = message || '无法解析该记录。';
    },
    clear() {
      currentValue = undefined;
      selectedSegs = [];
      render();
    },
    dispose() {
      disposed = true;
      root.remove();
    },
  };

  render();
  return controller;
}

/** 树中键显示：数组下标用 [n]；对象不含特殊字符直接用名；否则带引号形式。 */
function segTextKey(seg: PathSeg): string {
  if (seg.kind === 'index') return `[${seg.key}]`;
  if (seg.key === '') return '""';
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg.key)) return seg.key;
  return JSON.stringify(seg.key);
}

/** 类型 -> CSS 类（对应 styles.ts 中的主题色）。 */
function kindClass(kind: string): string {
  switch (kind) {
    case 'string':
      return 'str';
    case 'number':
      return 'num';
    case 'boolean':
      return 'bool';
    case 'null':
      return 'null';
    default:
      return 'obj';
  }
}

/* -------------------------- 工具图标 -------------------------- */

/** 携带 class 的图标容器（innerHTML 注入内联 SVG，跟随 currentColor）。 */
function icon(className: string, svg: string): HTMLElement {
  const s = document.createElement('span');
  s.className = className;
  s.innerHTML = svg;
  return s;
}

const ICON_EXPAND =
  '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M2 3h12M2 7h12M6 11h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M8 11l-1.5 1.5L8 14l1.5-1.5z" fill="currentColor"/></svg>';
const ICON_COLLAPSE =
  '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M2 5h12M2 9h12M2 13h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const ICON_LEVEL =
  '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M3 3v6a2 2 0 0 0 2 2h8M9 7l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';