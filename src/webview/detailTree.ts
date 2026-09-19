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

/** 挂在 `.jlv-tree-node` 上的懒展开元数据（替代散落的 as unknown as 链式断言）。 */
interface TreeNodeMeta {
  /** 原始 JS 值，供局部展开时懒构建子节点。 */
  __value?: unknown;
  /** 缓存的子节点抽屉 block（展开动画用）。 */
  __blockEl?: HTMLElement;
  /** 缓存的子节点 inner 容器。 */
  __innerEl?: HTMLElement;
}

/** 挂在 `.jlv-tree-row` 上的 DOM 缓存。 */
interface TreeRowMeta {
  /** 缓存的 `.jlv-value` span（折叠态预览/展开态清空复用）。 */
  __valueEl?: HTMLElement;
}

/** Node HTMLElement + 懒展开元数据。 */
type TreeNode = HTMLElement & TreeNodeMeta;

/** Row HTMLElement + 缓存元数据。 */
type TreeRow = HTMLElement & TreeRowMeta;

export interface DetailTreeController {
  /** 面板根元素（`.jlv-col-detail`），供宿主放入布局。 */
  readonly root: HTMLElement;
  /** 展示一条记录的完整 JSON 值（line 用于头部 Record # 展示，可选）。 */
  showRecord(value: unknown, line?: number): void;
  /** 加载中占位。 */
  showLoading(): void;
  /** 展示错误行信息。 */
  showError(message: string, line?: number): void;
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
  if (text.length > MAX_SCALAR_TEXT) {
    // 只把截断后的文本放进 DOM（避免超大文本节点卡顿），全文放 title（hover 可看）。
    return { text: `${text.slice(0, MAX_SCALAR_TEXT)}…`, title: text };
  }
  return { text, title: '' };
}

/** 构造内联 SVG 折叠箭头。 */
function chevronSvg(): string {
  return `<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true" focusable="false"><polygon points="2,1 8,5 2,9" fill="currentColor"></polygon></svg>`;
}

/** 用户是否偏好减少动态效果（prefers-reduced-motion）。 */
function matchMediaReduced(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function createDetailTree(host: HTMLElement): DetailTreeController {
  /* 右栏：大卡片（原型 .col-detail > .detail-card > .detail-header + 树体） */
  const root = document.createElement('aside');
  root.className = 'jlv-col-detail';
  const card = document.createElement('div');
  card.className = 'jlv-detail-card';

  /* document 级监听器引用（供 dispose 清理）。 */
  let closeDepthMenuOnDocClick: ((e: MouseEvent) => void) | null = null;

  const header = document.createElement('div');
  header.className = 'jlv-detail-header';
  const dhLeft = document.createElement('div');
  dhLeft.className = 'jlv-dh-left';
  const dhLine = document.createElement('span');
  dhLine.className = 'jlv-dh-line';
  dhLine.textContent = 'Record #—';
  const dhSrc = document.createElement('span');
  dhSrc.className = 'jlv-dh-src';
  dhSrc.textContent = '';
  const dhDivider = document.createElement('span');
  dhDivider.className = 'jlv-dh-divider';
  dhDivider.textContent = '·';
  const crumb = document.createElement('nav');
  crumb.className = 'jlv-dh-crumb';
  dhLeft.append(dhLine, dhSrc, dhDivider, crumb);

  /* 工具按钮组（原型 .dh-tools） */
  const tools = document.createElement('div');
  tools.className = 'jlv-dh-tools';

  const btnExpandAll = document.createElement('button');
  btnExpandAll.type = 'button';
  btnExpandAll.className = 'jlv-dh-tool';
  btnExpandAll.title = '展开所有层级（大数组仍分段预览）';
  btnExpandAll.setAttribute('aria-label', '展开所有层级（大数组仍分段预览）');
  btnExpandAll.dataset.act = 'expandAll';
  btnExpandAll.appendChild(icon('', ICON_EXPAND));

  const btnCollapseAll = document.createElement('button');
  btnCollapseAll.type = 'button';
  btnCollapseAll.className = 'jlv-dh-tool';
  btnCollapseAll.title = '只保留顶层';
  btnCollapseAll.setAttribute('aria-label', '只保留顶层');
  btnCollapseAll.dataset.act = 'collapseAll';
  btnCollapseAll.appendChild(icon('', ICON_COLLAPSE));

  // 展开深度选择：自绘下拉
  let selectedDepth = 2;
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
  syncDepthMenu();

  const btnExpandLevel = document.createElement('button');
  btnExpandLevel.type = 'button';
  btnExpandLevel.className = 'jlv-dh-tool';
  btnExpandLevel.dataset.act = 'expandLevel';
  btnExpandLevel.title = '展开到该层';
  btnExpandLevel.setAttribute('aria-label', '展开到该层');
  btnExpandLevel.appendChild(icon('', ICON_LEVEL));

  const btnCopy = document.createElement('button');
  btnCopy.type = 'button';
  btnCopy.className = 'jlv-dh-tool';
  btnCopy.title = '复制 JSON';
  btnCopy.setAttribute('aria-label', '复制 JSON');
  btnCopy.appendChild(icon('', ICON_COPY));

  tools.append(btnExpandAll, btnCollapseAll, depthWrap, btnExpandLevel, btnCopy);
  header.append(dhLeft, tools);

  /* 树体 */
  const body = document.createElement('div');
  body.className = 'jlv-tree-body';
  body.setAttribute('role', 'tree');
  body.setAttribute('aria-label', 'JSON 内容');

  card.append(header, body);
  root.appendChild(card);
  host.appendChild(root);

  /* ---------------- 树状态 ---------------- */
  const state = new TreeState(1); // 默认展开到第 1 层
  const revealed: Record<string, number> = {}; // 父 pathKey -> 「加载更多」额外项数
  let currentValue: unknown = undefined;
  let currentLine: number | undefined = undefined;
  let selectedSegs: PathSeg[] = [];
  let disposed = false;
  /** 最近一次由用户 toggle 展开的路径：重建后仅该节点播抽屉动画（设计体系 §4.1）。 */
  let lastExpandedKey: string | null = null;

  /** 更新头部：Record # 徽标 + 源行（切换记录时轻弹）。 */
  function setRecordHeader(line: number | undefined): void {
    if (line === undefined) {
      dhLine.textContent = 'Record #—';
      dhSrc.textContent = '';
      return;
    }
    dhLine.textContent = `Record #${line + 1}`;
    dhSrc.textContent = `源 L${line + 1}`;
    dhLine.classList.remove('pop');
    void dhLine.offsetWidth;
    dhLine.classList.add('pop');
  }

  /* ---------------- 抽屉动画（设计体系 §4.4） ---------------- */

  /** 展开动画：0 → scrollHeight 抽屉拉出 + 淡入（delayMs 用于批量操作的瀑布错峰）。 */
  function animateOpen(el: HTMLElement, delayMs = 0): void {
    el.style.transition = 'none';
    el.style.height = '0px';
    el.style.opacity = '0';
    // 元素需先挂载到 DOM 才能正确测量 scrollHeight；用 rAF 延迟到下一帧（render 已完成）
    requestAnimationFrame(() => {
      const d = delayMs ? ` ${delayMs}ms` : '';
      el.style.transition = `height 200ms cubic-bezier(0.16,1,0.3,1)${d}, opacity 160ms ease-out${d}`;
      el.style.height = `${el.scrollHeight}px`;
      el.style.opacity = '1';
      const onEnd = (e: TransitionEvent): void => {
        if (e.propertyName !== 'height') return;
        el.style.height = 'auto';
        el.removeEventListener('transitionend', onEnd);
      };
      el.addEventListener('transitionend', onEnd);
    });
  }

  /** 收起动画：当前高度 → 0 抽屉收回 + 淡出，播完 resolve。 */
  function animateClose(el: HTMLElement, delayMs = 0): Promise<void> {
    return new Promise((resolve) => {
      // reduced-motion：动画被样式禁用，收回直接完成（不等固定时长）。
      if (matchMediaReduced()) {
        el.style.height = '0px';
        el.style.opacity = '0';
        resolve();
        return;
      }
      el.style.transition = 'none';
      el.style.height = `${el.scrollHeight}px`;
      el.style.opacity = '1';
      void el.offsetWidth;
      const d = delayMs ? ` ${delayMs}ms` : '';
      el.style.transition = `height 200ms cubic-bezier(0.16,1,0.3,1)${d}, opacity 160ms ease-out${d}`;
      el.style.height = '0px';
      el.style.opacity = '0';
      setTimeout(resolve, 220 + delayMs);
    });
  }

  /** 切换记录：右栏字段逐条出现（舒缓错峰，设计体系 §4.1）。 */
  function replayRowAnim(): void {
    body.classList.remove('animating');
    const rows = body.querySelectorAll<HTMLElement>('.jlv-tree-row');
    rows.forEach((r, i) => {
      r.style.animationDelay = `${Math.min(i, 10) * 30}ms`;
    });
    void body.offsetWidth;
    body.classList.add('animating');
  }

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
    // 不渲染根节点「$」行：直接以第一层字段作为顶层展示（$ 仅为内部根锚点）
    if (isContainer(currentValue)) {
      const { items, remaining } = expandContainer(currentValue as object, '$', revealed);
      for (const it of items) buildNode(body, [it.seg], 1, it.value);
      if (remaining > 0) {
        const more = document.createElement('div');
        more.className = 'jlv-load-more';
        more.dataset.parent = '$';
        more.textContent = `… 还有 ${remaining} 项，点击加载更多`;
        body.appendChild(more);
      }
    } else {
      // 根为标量（罕见兜底）：原样展示
      buildNode(body, [], 0, currentValue);
    }

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
    (node as TreeNode).__value = value; // 存数据引用：局部展开懒构建用

    const row = document.createElement('div');
    row.className = 'jlv-tree-row';
    row.dataset.depth = String(depth);
    row.dataset.container = container ? '1' : '0';
    row.dataset.treeKey = pathKey(segs);
    if (segs.length > 0 && pathKey(segs) === pathKey(selectedSegs)) row.classList.add('selected');

    // 可访问性：树行语义。容器行可聚焦（Enter/Space 展开折叠）；标量行供读屏游走。
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.tabIndex = container ? 0 : -1;
    if (container) row.setAttribute('aria-expanded', 'false');

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
      const keyText = segTextKey(last);
      keyEl.textContent = keyText;
      keyEl.title = keyText; // 长 key 被省略时 hover 看全名
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
      row.setAttribute('aria-expanded', String(expanded));

      const preview = document.createElement('span');
      preview.className = `jlv-value ${kindClass(kind)} jlv-summary`;
      preview.textContent = expanded ? '' : containerPreview(value as object);
      row.appendChild(preview);

      if (expanded) {
        childrenEl = document.createElement('div');
        childrenEl.className = 'jlv-tree-block';
        const blockInner = document.createElement('div');
        blockInner.className = 'jlv-tree-block-inner';
        childrenEl.appendChild(blockInner);
        const { items, remaining } = expandContainer(value as object, pathKey(segs), revealed);
        for (const it of items) buildNode(blockInner, [...segs, it.seg], depth + 1, it.value);
        if (remaining > 0) {
          const more = document.createElement('div');
          more.className = 'jlv-load-more';
          more.dataset.parent = pathKey(segs);
          more.textContent = `… 还有 ${remaining} 项，点击加载更多`;
          more.tabIndex = 0;
          more.setAttribute('role', 'button');
          more.setAttribute('aria-label', `还有 ${remaining} 项，加载更多`);
          blockInner.appendChild(more);
        }
        // 仅对「用户本次 toggle 展开的节点」播抽屉动画；批量重建（切换/全部展开/加载更多）保持干脆
        if (pathKey(segs) === lastExpandedKey) {
          lastExpandedKey = null;
          animateOpen(childrenEl);
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
    setDepthMenu(!!depthMenu.hidden);
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
  closeDepthMenuOnDocClick = () => setDepthMenu(false);
  document.addEventListener('click', closeDepthMenuOnDocClick);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !depthMenu.hidden) setDepthMenu(false);
  });

  tools.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'expandAll') {
      // 全部展开：增量式逐层瀑布（不整树重建，无刷新感）
      state.expandAll();
      const rows = Array.from(body.querySelectorAll<HTMLElement>('.jlv-tree-row[data-container="1"]'));
      chunkedExpand(rows);
    } else if (act === 'collapseAll') {
      // 全部折叠：逐个抽屉收回（错峰），保留缓存，不整树重建
      state.collapseAll();
      const rows = body.querySelectorAll<HTMLElement>('.jlv-tree-row[data-container="1"]');
      let i = 0;
      rows.forEach((row) => {
        const depth = Number(row.dataset.depth);
        if (depth === 0 || !row.classList.contains('expanded')) return;
        const node = row.closest<HTMLElement>('.jlv-tree-node');
        if (node) void collapseNodeLocal(row, node, i * 30);
        i++;
      });
    } else if (act === 'expandLevel') {
      state.expandToLevel(selectedDepth);
      // 展开到 N 层：分批增量式（depth < N 的容器）
      const rows = Array.from(body.querySelectorAll<HTMLElement>('.jlv-tree-row[data-container="1"]')).filter(
        (row) => Number(row.dataset.depth) < selectedDepth
      );
      chunkedExpand(rows);
    }
  });

  /**
   * M8：分批展开容器行——每批同步构建 50 行后让出主线程（rAF/idle），
   * 避免深树全量展开时一次性同步建整棵子树 DOM 卡住主线程。
   * 动画错峰仅对当批生效（每批从 0 重新计数，封顶 10 行）。
   */
  function chunkedExpand(rows: HTMLElement[]): void {
    let i = 0;
    const CHUNK = 50;
    const step = (): void => {
      const end = Math.min(i + CHUNK, rows.length);
      for (; i < end; i++) {
        const row = rows[i];
        if (row.classList.contains('expanded')) continue;
        const node = row.closest<HTMLElement>('.jlv-tree-node');
        if (node) expandNodeLocal(row, node, (i % 10) * 30);
      }
      if (i < rows.length) {
        const w = window as { requestIdleCallback?: (cb: () => void, o?: { timeout?: number }) => void };
        if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(step, { timeout: 80 });
        else setTimeout(step, 16);
      }
    };
    step();
  }

  // 复制 JSON：脉冲反馈（设计体系 §4.1）
  btnCopy.addEventListener('click', () => {
    if (currentValue === undefined) return;
    const text = formatJsonValue(currentValue);
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    } else {
      legacyCopy(text);
    }
    btnCopy.classList.remove('copy-pulse');
    void btnCopy.offsetWidth;
    btnCopy.classList.add('copy-pulse');
  });

  crumb.addEventListener('click', (e) => {
    const seg = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
    if (!seg) return;
    const index = Number(seg.dataset.index);
    navigateTo(selectedSegs.slice(0, index));
  });

  /** 从行上反解 segs（treeKey 编码同 pathKey）。 */
  function segsOf(row: HTMLElement): PathSeg[] {
    return row.dataset.treeKey === '$' ? [] : parseSegsFromNode(row);
  }

  /** 局部构建某容器节点的子节点到 inner（懒构建，缓存保留）。 */
  function buildChildrenInto(inner: HTMLElement, segs: PathSeg[], value: unknown, depth: number): void {
    const { items, remaining } = expandContainer(value as object, pathKey(segs), revealed);
    for (const it of items) buildNode(inner, [...segs, it.seg], depth + 1, it.value);
    if (remaining > 0) {
      const more = document.createElement('div');
      more.className = 'jlv-load-more';
      more.dataset.parent = pathKey(segs);
      more.textContent = `… 还有 ${remaining} 项，点击加载更多`;
      inner.appendChild(more);
    }
  }

  /** 局部展开一个容器节点：懒构建子节点 + 抽屉动画（不整树重建）。 */
  function expandNodeLocal(row: HTMLElement, node: HTMLElement, delayMs = 0): void {
    const n = node as TreeNode;
    const r = row as TreeRow;
    // 用 __blockEl/__innerEl 缓存，避免每次都 querySelector（高频 toggle 时可省下 30%+ DOM 查询时间）。
    let block = n.__blockEl ?? null;
    let inner = n.__innerEl ?? null;
    if (!block || !inner) {
      block = document.createElement('div');
      block.className = 'jlv-tree-block';
      inner = document.createElement('div');
      inner.className = 'jlv-tree-block-inner';
      block.appendChild(inner);
      node.appendChild(block);
      n.__blockEl = block;
      n.__innerEl = inner;
    }
    if (inner.childElementCount === 0 && n.__value !== undefined) {
      const segs = segsOf(row);
      buildChildrenInto(inner, segs, n.__value, Number(row.dataset.depth));
    }
    const val = r.__valueEl ?? row.querySelector<HTMLElement>('.jlv-value');
    if (val) r.__valueEl = val;
    if (val) val.textContent = '';
    row.classList.add('expanded');
    row.classList.remove('collapsed');
    row.setAttribute('aria-expanded', 'true');
    if (block) animateOpen(block, delayMs);
  }

  /** 局部折叠一个容器节点：抽屉收回 + 保留缓存（不整树重建）。 */
  function collapseNodeLocal(row: HTMLElement, node: HTMLElement, delayMs = 0): Promise<void> {
    const n = node as TreeNode;
    const r = row as TreeRow;
    const block = n.__blockEl ?? null;
    const val = r.__valueEl ?? row.querySelector<HTMLElement>('.jlv-value');
    if (val) r.__valueEl = val;
    if (val && block && n.__value !== undefined) {
      // 折叠态预览文本
      val.textContent = containerPreview(n.__value as object);
    }
    row.classList.add('collapsed');
    row.classList.remove('expanded');
    row.setAttribute('aria-expanded', 'false');
    if (block) return animateClose(block, delayMs);
    return Promise.resolve();
  }

  /* 键盘可达：Enter/Space 在树行上触发展开/折叠，在「加载更多」上加载。 */
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement;
    if (target.closest('button')) return; // button 自身处理 Enter/Space
    const more = target.closest<HTMLElement>('.jlv-load-more');
    if (more) {
      e.preventDefault();
      more.click(); // 合成 click 冒泡到下方 click handler
      return;
    }
    const row = target.closest<HTMLElement>('.jlv-tree-row');
    if (!row) return;
    e.preventDefault();
    row.click(); // 复用点击逻辑（容器 toggle / 标量选中）
  });

  body.addEventListener('click', async (e) => {
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
    if (container && selectedSegs.length > 0) {
      const node = row.closest<HTMLElement>('.jlv-tree-node');
      if (!node) return;
      if (state.isExpanded(selectedSegs, depth)) {
        // 折叠：局部抽屉收回，不整树重建
        state.toggle(selectedSegs, depth);
        await collapseNodeLocal(row, node);
      } else {
        // 展开：局部构建 + 抽屉拉出，不整树重建
        state.toggle(selectedSegs, depth);
        expandNodeLocal(row, node);
      }
      renderBreadcrumb();
    }
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
    showRecord(value, line) {
      currentValue = value;
      currentLine = line;
      setRecordHeader(line);
      selectedSegs = [];
      state.collapseAll();
      state.expandToLevel(1);
      for (const k of Object.keys(revealed)) delete revealed[k];
      render();
      replayRowAnim(); // 切换记录：字段逐条出现
    },
    showLoading() {
      currentValue = undefined;
      setRecordHeader(currentLine);
      render();
      replayRowAnim();
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
    showError(message, line) {
      currentValue = undefined;
      currentLine = line;
      // 坏行也更新页头（此前遗漏：页头停留在上一个 Record #N）。
      setRecordHeader(line);
      render();
      const hint = body.querySelector<HTMLElement>('.jlv-tree-hint');
      if (!hint) return;
      hint.className = 'jlv-tree-error';
      hint.textContent = message || '无法解析该记录。';
    },
    clear() {
      currentValue = undefined;
      currentLine = undefined;
      setRecordHeader(undefined);
      selectedSegs = [];
      render();
    },
    dispose() {
      disposed = true;
      // 清理 document 级监听器（关键：否则 webview 关闭后依然驻留）。
      if (closeDepthMenuOnDocClick) {
        document.removeEventListener('click', closeDepthMenuOnDocClick);
        closeDepthMenuOnDocClick = null;
      }
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
const ICON_COPY =
  '<svg width="12" height="12" viewBox="0 0 16 16"><rect x="5" y="5" width="8" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M11 2.5H4.5A1.5 1.5 0 0 0 3 4v7.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

/** 把任意 JSON 值格式化为多行文本。 */
function formatJsonValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 写文本到剪贴板（Clipboard API 失败时回退 execCommand）。 */
function legacyCopy(text: string): void {
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