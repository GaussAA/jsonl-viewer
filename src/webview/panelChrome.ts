/**
 * panelChrome.ts — 浮层通用「外壳」零件：头部按钮 / 头部容器 / 报告式主体骨架。
 *
 * badLinesPanel / historyPanel / profilePanel 的头部与「状态行 + 提示 + 列表」骨架
 * 原先逐字抄写，改一个 class 名要同步三处。开合状态机见 `panelAnimation.ts`，
 * 这里只负责 DOM 零件；DOM 结构、class 名与创建顺序须与设计体系 §3.6 保持一致。
 */

/** 头部按钮：`jlv-btn` 外观；`title` 缺省则不设置该属性。 */
export function createPanelButton(
  text: string,
  onClick: () => void,
  title?: string
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'jlv-btn';
  btn.textContent = text;
  if (title !== undefined) btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

/** 头部容器：左侧标题，右侧动作区（按传入顺序排列）。 */
export function createPanelHead(
  title: HTMLElement,
  actions: readonly HTMLElement[]
): HTMLDivElement {
  const head = document.createElement('div');
  head.className = 'jlv-edit-head';
  const headActions = document.createElement('div');
  headActions.className = 'jlv-edit-head-actions';
  headActions.append(...actions);
  head.append(title, headActions);
  return head;
}

/** 头部标题节点（文案可缺省，由字段浮层等在打开时再填）。 */
export function createPanelTitle(text?: string): HTMLDivElement {
  const title = document.createElement('div');
  title.className = 'jlv-edit-title';
  if (text !== undefined) title.textContent = text;
  return title;
}

export interface ReportBody {
  status: HTMLDivElement;
  note: HTMLDivElement;
  list: HTMLDivElement;
}

/**
 * 报告式浮层主体（坏行诊断 / 数据画像共用）：状态行 + 默认隐藏的提示 + 列表。
 *
 * 提示默认隐藏：只有「结果不完整」之类需要自曝的场合才显示，由面板自己切换。
 */
export function createReportBody(): ReportBody {
  const status = document.createElement('div');
  status.className = 'jlv-bad-status';

  const note = document.createElement('div');
  note.className = 'jlv-bad-note';
  note.hidden = true;

  const list = document.createElement('div');
  list.className = 'jlv-bad-list';

  return { status, note, list };
}
