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
  arraySegmentCount,
  containerPreview,
  expandContainer,
  isContainer,
  jsonKindOf,
  LARGE_ARRAY_PREVIEW,
  MAX_RENDER_DEPTH,
  pathKey,
  pathToString,
  segText,
  TreeState,
} from './detailLogic.ts';
import type { PathSeg } from './detailLogic.ts';
import { isFieldEditableKind, parseFieldInput } from './editLogic.ts';
import { findRanges } from '../core/query.ts';
import { renderHighlight } from './utils.ts';

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

/**
 * 挂在 `.jlv-load-more` 上的**父容器**元数据（增量追加时用来定位目标容器）。
 *
 * 为什么把父值直接挂上，而不是点的时候按 `data-parent` 反查行：
 * `pathKey` 以 NUL(`\u0000`) 作分隔符，而 `CSS.escape` 会把 NUL 转义成 U+FFFD ——
 * 于是 `[data-tree-key="\ufffd…"]` 属性选择器**永远匹配不上**含两段以上路径的容器，
 * 「加载更多」在嵌套容器里会静默退回整树重建（或错插节点）。直接挂元数据既避开了
 * 这条编码歧义，也省掉一次 O(行数) 的查询。
 */
interface LoadMoreMeta {
  __value?: unknown;
  __segs?: PathSeg[];
  __childDepth?: number;
}

/** LoadMore HTMLElement + 父容器元数据。 */
type LoadMore = HTMLElement & LoadMoreMeta;

/** 右栏头部工具的导航回调（上一条 / 下一条 JSON 条目）。 */
export interface DetailTreeNavHandlers {
  /** 切换到上一条 JSON 条目。 */
  onPrevRecord?(): void;
  /** 切换到下一条 JSON 条目。 */
  onNextRecord?(): void;
  /** 编辑当前显示的记录（打开编辑浮层）。 */
  onEdit?(): void;
  /**
   * 编辑某个**字段的值**（仅标量）。
   *
   * `segs` 是该字段的路径、`value` 是其当前值。定位与落盘由装配层负责 ——
   * 本模块只把「用户点了哪个字段」这件事报出去。
   */
  onEditField?(segs: PathSeg[], value: unknown): void;
  /**
   * 原地编辑：双击字段值后，把新值交装配层落盘（Enter 提交时调用）。
   * 返回 `{ ok: false, error }` 时编辑态保持并显示错误；成功后由装配层重建详情树。
   * 未提供时双击不进入编辑态（铅笔浮层仍是可用入口）。
   */
  onInlineEdit?(
    segs: PathSeg[],
    from: unknown,
    to: unknown
  ): Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
}

export interface DetailTreeController {
  /** 面板根元素（`.jlv-col-detail`），供宿主放入布局。 */
  readonly root: HTMLElement;
  /**
   * 展示一条记录的完整 JSON 值。
   *
   * @param line 源行号（头部 Record # 展示）
   * @param rawTextAvailable 该行在磁盘上的**原文**是否可用。只有在可用时才渲染字段级
   *   编辑入口 —— 没有原文就无法在文本里安全定位并替换目标值，此时宁可不出按钮，
   *   也不要给一个点了必然报错的入口。
   */
  showRecord(value: unknown, line?: number, rawTextAvailable?: boolean): void;
  /** 加载中占位。 */
  showLoading(): void;
  /** 展示错误行信息。 */
  showError(message: string, line?: number): void;
  /** 清空（未选中）。 */
  clear(): void;
  /** 设置上一条/下一条按钮的启用状态。 */
  setNavEnabled(prev: boolean, next: boolean): void;
  /** 打开「本条记录内查找」条并聚焦输入框（Ctrl+F / 工具按钮）。 */
  showFind(): void;
  /** 关闭查找条并撤掉高亮。 */
  hideFind(): void;
  /** 查找条是否打开（装配层用于 Esc 分层处理）。 */
  isFindOpen(): boolean;
  /** 释放监听器。 */
  dispose(): void;
}

/** 单条标量展示时截断的最大长度（避免把超长字符串塞进 DOM）。 */
const MAX_SCALAR_TEXT = 400;

/** 面包屑/树行内使用的标量格式化。 */
function formatScalar(
  value: string | number | boolean,
  kind: string
): { text: string; title: string } {
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

export function createDetailTree(
  host: HTMLElement,
  navHandlers: DetailTreeNavHandlers = {}
): DetailTreeController {
  /* 右栏：大卡片（原型 .col-detail > .detail-card > .detail-header + 树体） */
  const root = document.createElement('aside');
  root.className = 'jlv-col-detail';
  const card = document.createElement('div');
  card.className = 'jlv-detail-card';

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

  /* 展开/折叠切换：单个按钮，展开态高亮，再点一次折叠 */
  const btnExpandAll = document.createElement('button');
  btnExpandAll.type = 'button';
  btnExpandAll.className = 'jlv-dh-tool';
  btnExpandAll.title = '展开所有层级（再次点击可全部折叠）';
  btnExpandAll.setAttribute('aria-label', '展开所有层级（再次点击可全部折叠）');
  btnExpandAll.setAttribute('aria-pressed', 'false');
  btnExpandAll.dataset.act = 'expandToggle';
  btnExpandAll.appendChild(icon('', ICON_EXPAND));

  const btnPrevRecord = document.createElement('button');
  btnPrevRecord.type = 'button';
  btnPrevRecord.className = 'jlv-dh-tool';
  btnPrevRecord.title = '上一条 JSON 条目';
  btnPrevRecord.setAttribute('aria-label', '上一条 JSON 条目');
  btnPrevRecord.disabled = true;
  btnPrevRecord.appendChild(icon('', ICON_PREV));
  btnPrevRecord.addEventListener('click', () => navHandlers.onPrevRecord?.());

  const btnNextRecord = document.createElement('button');
  btnNextRecord.type = 'button';
  btnNextRecord.className = 'jlv-dh-tool';
  btnNextRecord.title = '下一条 JSON 条目';
  btnNextRecord.setAttribute('aria-label', '下一条 JSON 条目');
  btnNextRecord.disabled = true;
  btnNextRecord.appendChild(icon('', ICON_NEXT));
  btnNextRecord.addEventListener('click', () => navHandlers.onNextRecord?.());

  const btnFind = document.createElement('button');
  btnFind.type = 'button';
  btnFind.className = 'jlv-dh-tool';
  btnFind.title = '在本条记录内查找（Ctrl+F）';
  btnFind.setAttribute('aria-label', '在本条记录内查找');
  btnFind.dataset.act = 'find';
  btnFind.appendChild(icon('', ICON_SEARCH));
  btnFind.addEventListener('click', () => showFind());

  const btnCopy = document.createElement('button');
  btnCopy.type = 'button';
  btnCopy.className = 'jlv-dh-tool';
  btnCopy.title = '复制 JSON';
  btnCopy.setAttribute('aria-label', '复制 JSON');
  btnCopy.appendChild(icon('', ICON_COPY));

  const btnEdit = document.createElement('button');
  btnEdit.type = 'button';
  btnEdit.className = 'jlv-dh-tool';
  btnEdit.title = '编辑当前记录的 JSON';
  btnEdit.setAttribute('aria-label', '编辑当前记录的 JSON');
  btnEdit.disabled = true; // 未选中记录前不可用（由 setRecordHeader 同步）
  btnEdit.appendChild(icon('', ICON_EDIT));
  btnEdit.addEventListener('click', () => navHandlers.onEdit?.());

  tools.append(btnExpandAll, btnPrevRecord, btnNextRecord, btnFind, btnEdit, btnCopy);
  header.append(dhLeft, tools);

  /* 树体 */
  const body = document.createElement('div');
  body.className = 'jlv-tree-body';
  body.setAttribute('role', 'tree');
  body.setAttribute('aria-label', 'JSON 内容');

  card.append(header, body);
  root.appendChild(card);
  host.appendChild(root);

  /* ---------------- 详情内查找（Ctrl+F） ----------------
     只对**已渲染**的节点做匹配与高亮：这既是最有用的范围（用户正在看的这段），
     也避免「为查找把整条记录展开」——大记录一展开就是几万个节点。 */
  const findBar = document.createElement('div');
  findBar.className = 'jlv-find';
  findBar.hidden = true;
  const findInput = document.createElement('input');
  findInput.type = 'text';
  findInput.className = 'jlv-find-input';
  findInput.placeholder = '本条记录内查找（仅已展开部分）';
  findInput.setAttribute('aria-label', '在本条记录内查找');
  const findCount = document.createElement('span');
  findCount.className = 'jlv-find-count';
  findCount.setAttribute('aria-live', 'polite');
  const mkFindBtn = (label: string, title: string, act: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'jlv-find-btn';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.dataset.act = act;
    return b;
  };
  const btnFindPrev = mkFindBtn('↑', '上一个命中（Shift+Enter）', 'findPrev');
  const btnFindNext = mkFindBtn('↓', '下一个命中（Enter）', 'findNext');
  const btnFindClose = mkFindBtn('✕', '关闭查找（Esc）', 'findClose');
  findBar.append(findInput, findCount, btnFindPrev, btnFindNext, btnFindClose);
  card.append(header, findBar, body);
  root.appendChild(card);
  host.appendChild(root);

  /* ---------------- 树状态 ---------------- */
  const state = new TreeState(1); // 默认展开到第 1 层
  const revealed: Record<string, number> = {}; // 父 pathKey -> 「加载更多」额外项数
  let currentValue: unknown = undefined;
  let currentLine: number | undefined = undefined;
  /** 当前行原文是否可用（决定是否渲染字段级编辑入口）。 */
  let rawTextAvailable = false;
  let selectedSegs: PathSeg[] = [];
  let disposed = false;
  /** 最近一次由用户 toggle 展开的路径：重建后仅该节点播抽屉动画（设计体系 §4.1）。 */
  let lastExpandedKey: string | null = null;
  /** 展开模式：'level1' 只展开顶层 | 'all' 全部展开（切换按钮高亮）。 */
  let expandMode: 'level1' | 'all' = 'level1';

  /** 依据 expandMode 刷新切换按钮的视觉状态（高亮 + aria-pressed）。 */
  function syncExpandToggle(): void {
    const active = expandMode === 'all';
    btnExpandAll.classList.toggle('active', active);
    btnExpandAll.setAttribute('aria-pressed', String(active));
    btnExpandAll.title = active ? '全部折叠到顶层' : '展开所有层级（再次点击可全部折叠）';
    btnExpandAll.setAttribute('aria-label', btnExpandAll.title);
  }

  /** 更新头部：Record # 徽标 + 源行（切换记录时轻弹）。 */
  function setRecordHeader(line: number | undefined): void {
    // 无记录时不提供编辑入口（避免对不存在的行发起编辑）。
    btnEdit.disabled = line === undefined;
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
    // 重建会丢掉所有 <mark>：展开/折叠/加载更多之后必须重新套用，
    // 否则用户点一次「展开」查找高亮就整体消失了。
    if (findNeedle) applyFind();
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

  /**
   * 创建「加载更多」入口。三处渲染点（根的顶层、整树构建、局部懒展开）共用，
   * 以免键盘/读屏属性在一处补齐、另一处又漏掉（此前根层那一处便缺 role/tabIndex）。
   *
   * 同时把父容器的值 / 路径 / 子级深度挂在元素上（见 `LoadMoreMeta`）。
   */
  function mkLoadMore(
    parentKey: string,
    remaining: number,
    owner: { value: unknown; segs: readonly PathSeg[]; childDepth: number }
  ): LoadMore {
    const more = document.createElement('div') as LoadMore;
    more.className = 'jlv-load-more';
    more.dataset.parent = parentKey;
    more.textContent = `… 还有 ${remaining} 项，点击加载更多`;
    more.tabIndex = 0;
    more.setAttribute('role', 'button');
    more.setAttribute('aria-label', `还有 ${remaining} 项，加载更多`);
    more.__value = owner.value;
    more.__segs = [...owner.segs];
    more.__childDepth = owner.childDepth;
    return more;
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
      if (remaining > 0)
        body.appendChild(
          mkLoadMore('$', remaining, { value: currentValue, segs: [], childDepth: 1 })
        );
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

  /**
   * 原地编辑一个标量字段：值 span 原地变输入框，Enter 提交 / Esc 取消 / blur 还原。
   *
   * 与铅笔浮层并存：双击是快速通道（所见即所改），浮层提供「应用到全部」等高级选项。
   * 失败（定位失败/宿主拒绝）时输入框红框并显示原因，编辑态保持 —— 用户就在原地，
   * 改完再试，不丢输入。成功后装配层会整体重建详情树，此处的 DOM 随之被替换。
   */
  function beginInlineEdit(
    valueEl: HTMLElement,
    segs: readonly PathSeg[],
    original: string | number | boolean,
    kind: 'string' | 'number' | 'boolean'
  ): void {
    if (valueEl.classList.contains('editing')) return; // 已在编辑态，忽略重复双击
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'jlv-inline-edit';
    input.value = String(original);
    input.spellcheck = false;

    let settled = false;
    const finish = (restore: boolean): void => {
      if (settled) return; // 提交开始后 blur 不再还原（成功由重建更新）
      settled = true;
      valueEl.classList.remove('editing', 'error');
      valueEl.textContent = restore ? formatScalar(original, kind).text : '';
      input.remove();
    };

    valueEl.classList.add('editing');
    valueEl.textContent = '';
    valueEl.appendChild(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 防止冒泡到树行的键盘导航
      if (e.key === 'Escape') {
        finish(true);
        return;
      }
      if (e.key !== 'Enter') return;
      const parsed = parseFieldInput(input.value, kind);
      if (!parsed.ok) {
        valueEl.classList.add('error');
        input.title = parsed.error;
        return;
      }
      settled = true; // 提交开始
      void Promise.resolve(navHandlers.onInlineEdit?.([...segs], original, parsed.value))
        .then((res) => {
          if (res && res.ok === false) {
            settled = false;
            valueEl.classList.add('error');
            input.title = res.error ?? '保存失败';
            input.focus();
          } else {
            valueEl.classList.remove('editing', 'error');
            input.remove();
          }
        })
        .catch((err: unknown) => {
          settled = false;
          valueEl.classList.add('error');
          input.title = err instanceof Error ? err.message : String(err);
          input.focus();
        });
    });
    input.addEventListener('blur', () => finish(true));
  }

  /**
   * 递归构建单个节点及其（已展开的）子树。
   * 节点 = 块容器（.jlv-tree-node）：header 行在上、子树块（.jlv-tree-block）在其下方逐级缩进；
   * 避免旧版「子节点作为 flex 项横向堆积到父标签右侧」造成深层嵌套水平压缩的问题。
   *
   * `parent` 收 `Node` 而非 `HTMLElement`：本函数只需 `appendChild`，放宽后「加载更多」
   * 可以先把新节点建进 `DocumentFragment`、再一次性插入（见 `loadMoreInto`），
   * 避免逐个节点触发容器重排。
   */
  function buildNode(parent: Node, segs: PathSeg[], depth: number, value: unknown): void {
    const kind = jsonKindOf(value);
    const container = isContainer(value);

    const node = document.createElement('div');
    node.className = 'jlv-tree-node';
    (node as TreeNode).__value = value; // 存数据引用：局部展开懒构建用
    // 可访问性：`role=treeitem` 的直接子代若是节点容器，必须声明为 group，
    // 否则读屏拿到的层级是断的（treeitem → div → treeitem，中间的 div 无角色）。
    node.setAttribute('role', 'group');

    const row = document.createElement('div');
    row.className = 'jlv-tree-row';
    row.dataset.depth = String(depth);
    row.dataset.container = container ? '1' : '0';
    row.dataset.treeKey = pathKey(segs);
    const isSelected = segs.length > 0 && pathKey(segs) === pathKey(selectedSegs);
    if (isSelected) row.classList.add('selected');

    // 可访问性：树行语义。容器行可聚焦（Enter/Space 展开折叠）；标量行供读屏游走。
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    // 选中态必须同时对读屏可见（此前只有 CSS class `.selected`，读屏完全感知不到）。
    row.setAttribute('aria-selected', isSelected ? 'true' : 'false');
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

      // 字段级编辑入口：仅**标量**、且该行原文可用时渲染（平时隐形，悬停显形）。
      // 容器不给入口 —— 改整个对象/数组应走整行编辑，那是更诚实的入口。
      // 可编辑类型的判定复用 editLogic 的单一来源：入口显示了而浮层拒绝打开，
      // 比不显示入口更糟。
      // 原地编辑：双击标量值 → 值 span 原地变输入框（Enter 提交 / Esc 取消）。
      // 与铅笔浮层并存：双击是快速通道（所见即所改），浮层提供「应用到全部」等高级选项。
      if (rawTextAvailable && navHandlers.onInlineEdit && isFieldEditableKind(kind)) {
        v.classList.add('inline-editable');
        v.title = (v.title ? v.title + ' · ' : '') + '双击可原地编辑';
        v.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          beginInlineEdit(v, segs, value as string | number | boolean, kind);
        });
      }

      if (rawTextAvailable && navHandlers.onEditField && isFieldEditableKind(kind)) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'jlv-field-edit';
        const pathText = pathToString([...segs]) || '$';
        editBtn.title = `编辑 ${pathText}`;
        editBtn.setAttribute('aria-label', editBtn.title);
        editBtn.appendChild(icon('', ICON_EDIT));
        editBtn.addEventListener('click', (e) => {
          // 阻止冒泡到 body 的委托：那会把「点编辑」也算作「点行选中」并跳转面包屑，
          // 而用户此刻要的是改值、不是导航。
          e.stopPropagation();
          navHandlers.onEditField?.(segs, value);
        });
        row.appendChild(editBtn);
      }
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
        if (remaining > 0)
          blockInner.appendChild(
            mkLoadMore(pathKey(segs), remaining, { value, segs, childDepth: depth + 1 })
          );
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

  tools.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'expandToggle') {
      if (expandMode === 'level1') {
        // 全部展开：增量式逐层瀑布（不整树重建，无刷新感）
        expandMode = 'all';
        syncExpandToggle();
        state.expandAll();
        const rows = Array.from(
          body.querySelectorAll<HTMLElement>('.jlv-tree-row[data-container="1"]')
        );
        chunkedExpand(rows);
      } else {
        // 全部折叠：逐个抽屉收回（错峰），保留缓存，不整树重建
        expandMode = 'level1';
        syncExpandToggle();
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
      }
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
        const w = window as {
          requestIdleCallback?: (cb: () => void, o?: { timeout?: number }) => void;
        };
        if (typeof w.requestIdleCallback === 'function')
          w.requestIdleCallback(step, { timeout: 80 });
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
  function buildChildrenInto(
    inner: HTMLElement,
    segs: PathSeg[],
    value: unknown,
    depth: number
  ): void {
    const { items, remaining } = expandContainer(value as object, pathKey(segs), revealed);
    for (const it of items) buildNode(inner, [...segs, it.seg], depth + 1, it.value);
    if (remaining > 0)
      inner.appendChild(
        mkLoadMore(pathKey(segs), remaining, { value, segs, childDepth: depth + 1 })
      );
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

  /**
   * 「加载更多」的**增量**实现（O12）。
   *
   * 为什么不能走 `render()`：整树重建在「全部展开」态会把已展开的整棵子树重造一遍，
   * 与 `chunkedExpand` 的分批初衷完全抵消 —— 宽记录 / 深树时点一次「加载更多」就冻住
   * 主线程，而它本该只多出 50 个兄弟节点。这里只把**新增的那一批**插到入口之前。
   *
   * 结构约定：「加载更多」恒是其父容器的最后一个子元素，因此插入锚点就是它自己；
   * 父容器的值 / 路径 / 子级深度由 `mkLoadMore` 直接挂在元素上（见 `LoadMoreMeta`）。
   */
  function loadMoreInto(more: HTMLElement): void {
    const m = more as LoadMore;
    const container = more.parentElement;
    const parent = more.dataset.parent ?? '$';
    const value = m.__value;
    // 元数据缺失 / 目标容器已不在（理论上不该发生）：退回整树重建 ——
    // 宁可慢一次，也不要多插或错插节点。
    if (!container || m.__value === undefined || !isContainer(value)) {
      render();
      return;
    }
    const segs = m.__segs ?? [];
    const childDepth = m.__childDepth ?? 1;

    const oldExtra = revealed[parent] ?? 0;
    const newExtra = oldExtra + LARGE_ARRAY_PREVIEW;
    const len = Array.isArray(value) ? value.length : 0;
    // 已经渲染过的项数：新一批要从这里往后切，否则会把旧项再建一遍（重复节点）。
    const before = arraySegmentCount(len, oldExtra).visible;
    const { items, remaining } = expandContainer(value as object, parent, { [parent]: newExtra });
    revealed[parent] = newExtra;

    const frag = document.createDocumentFragment();
    for (const it of items.slice(before)) {
      buildNode(frag, [...segs, it.seg], childDepth, it.value);
    }
    // 高亮必须先于插入：fragment 插入后即被清空，之后再查它就什么也查不到了。
    applyFindTo(frag);
    container.insertBefore(frag, more);

    if (remaining > 0) {
      more.textContent = `… 还有 ${remaining} 项，点击加载更多`;
      more.setAttribute('aria-label', `还有 ${remaining} 项，加载更多`);
    } else {
      more.remove();
    }
    refreshFindState();
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
      loadMoreInto(more); // 增量追加，不整树重建（O12）
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

  /* ---------------- 查找：应用 / 计数 / 跳转 ---------------- */

  /** 当前查找词（空串 = 不高亮）。 */
  let findNeedle = '';
  /** 已跳转到的命中序号（用于「3/17」与上下条）。 */
  let findCursor = 0;

  /**
   * 把查找高亮应用到 `scope` 内**已渲染**的行（通常整棵树；增量追加时只传新插入的那一段，
   * 避免为一个「加载更多」把整棵深树的文本节点全部重写一遍）。
   *
   * 原文存在元素的 dataset 里而不是从 DOM 反解：高亮会把文本节点换成 text + <mark> 的组合，
   * 没有原文这一层，第二次匹配就会在「已被切碎的上一次结果」上做，越搜越乱。
   */
  function applyFindTo(scope: ParentNode): void {
    for (const row of Array.from(scope.querySelectorAll<HTMLElement>('.jlv-tree-row'))) {
      for (const sel of ['.jlv-key', '.jlv-value']) {
        const el = row.querySelector<HTMLElement>(sel);
        if (!el) continue;
        if (el.dataset.findOrig === undefined) el.dataset.findOrig = el.textContent ?? '';
        const text = el.dataset.findOrig;
        renderHighlight(el, text, findNeedle ? findRanges(text, findNeedle) : []);
      }
    }
  }

  /** 命中游标与计数的收敛。结构一变就必须重算：上一次的「当前命中」标记已随之失效。 */
  function refreshFindState(): void {
    const hits = findHits();
    if (findCursor >= hits.length) findCursor = 0;
    markActiveHit(hits);
    updateFindCount(hits.length);
  }

  function applyFind(): void {
    applyFindTo(body);
    refreshFindState();
  }

  function findHits(): HTMLElement[] {
    return Array.from(body.querySelectorAll<HTMLElement>('mark.jlv-hit'));
  }

  function markActiveHit(hits: HTMLElement[]): void {
    for (const [i, el] of hits.entries()) el.classList.toggle('active', i === findCursor);
  }

  function updateFindCount(total: number): void {
    if (!findNeedle) {
      findCount.textContent = '';
      return;
    }
    findCount.textContent = total === 0 ? '无命中' : `${findCursor + 1}/${total}`;
  }

  /** 跳转到下一个/上一个命中（环形）。命中可能在折叠的子树里 —— 那时它根本没渲染，
   *  故不做「自动展开去找」：那等于替用户做了「展开到哪一层」的决定。 */
  function stepFind(dir: 1 | -1): void {
    const hits = findHits();
    if (hits.length === 0) return;
    findCursor = (findCursor + dir + hits.length) % hits.length;
    markActiveHit(hits);
    hits[findCursor].scrollIntoView({ block: 'center' });
    updateFindCount(hits.length);
  }

  function showFind(): void {
    findBar.hidden = false;
    findInput.focus();
    findInput.select();
    applyFind();
  }

  function hideFind(): void {
    findBar.hidden = true;
    findNeedle = '';
    findInput.value = '';
    findCursor = 0;
    applyFind(); // 撤掉所有高亮
  }

  findInput.addEventListener('input', () => {
    findNeedle = findInput.value.trim();
    findCursor = 0;
    applyFind();
    // 输入即定位到首个命中：搜索框里的实时反馈比「按了 Enter 才跳」更贴近预期。
    if (findNeedle && findHits().length > 0) {
      findHits()[0].scrollIntoView({ block: 'center' });
    }
  });
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      hideFind();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      stepFind(e.shiftKey ? -1 : 1);
    }
  });
  btnFindPrev.addEventListener('click', () => stepFind(-1));
  btnFindNext.addEventListener('click', () => stepFind(1));
  btnFindClose.addEventListener('click', () => hideFind());

  // Ctrl/Cmd+F：在详情面板内打开查找（焦点在详情里时生效）。
  // 不用 document 级监听：那会与列表/工具栏的快捷键抢同一组按键。
  root.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      showFind();
    }
  });

  /* ---------------- 公开 API ---------------- */

  const controller: DetailTreeController = {
    root,
    showRecord(value, line, rawAvailable = false) {
      currentValue = value;
      currentLine = line;
      rawTextAvailable = rawAvailable;
      setRecordHeader(line);
      selectedSegs = [];
      // 默认「完全折叠」：所有容器折叠，仅展示顶层字段 + 容器摘要预览。
      // 仅当用户通过「全部展开」切换为 all 模式时整棵展开。
      state.collapseAll();
      if (expandMode === 'all') state.expandAll();
      for (const k of Object.keys(revealed)) delete revealed[k];
      render();
      replayRowAnim(); // 切换记录：字段逐条出现
    },
    showLoading() {
      currentValue = undefined;
      // 占位期间不提供字段编辑：此时树里没有真实字段，原文与行号都可能已变。
      rawTextAvailable = false;
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
      // 坏行没有可解析的值，自然也没有字段级编辑可言。
      rawTextAvailable = false;
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
      rawTextAvailable = false;
      setRecordHeader(undefined);
      selectedSegs = [];
      render();
    },
    showFind,
    hideFind,
    isFindOpen: () => !findBar.hidden,
    setNavEnabled(prev, next) {
      btnPrevRecord.disabled = !prev;
      btnNextRecord.disabled = !next;
    },
    dispose() {
      disposed = true;
      root.remove();
    },
  };

  syncExpandToggle();
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
const ICON_PREV =
  '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_NEXT =
  '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_COPY =
  '<svg width="12" height="12" viewBox="0 0 16 16"><rect x="5" y="5" width="8" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M11 2.5H4.5A1.5 1.5 0 0 0 3 4v7.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const ICON_SEARCH =
  '<svg width="12" height="12" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const ICON_EDIT =
  '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M11.2 2.3a1.6 1.6 0 0 1 2.3 2.3L5.9 12.2l-3 .8.8-3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

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
