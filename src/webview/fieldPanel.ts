/**
 * fieldPanel.ts — 详情树的「字段级编辑」浮层。
 *
 * 与 `editPanel` / `historyPanel` / `badLinesPanel` 同一套浮层语义（设计体系 §3.6）。
 *
 * ## 它只负责收集新值，不负责落盘
 *
 * 定位（在原文里找到该字段的字节区间）、外科式替换、走编辑链路，全部由装配层完成 ——
 * 那些是「一行数据的正确性问题」，不该混进一个只管 DOM 的模块里。
 *
 * ## 输入语义按类型分派（这是刻意的，不是不一致）
 *
 * | 原值类型 | 输入方式 | 理由 |
 * |---|---|---|
 * | string / number | 裸文本输入框 | 所见即所得：用户改的是值本身，不是 JSON token |
 * | boolean | 两个按钮，一键切换 | 只有两个可能值，给输入框是多余的仪式 |
 * | null / object / array | **不提供入口**（由调用方的入口判定拦下） | 见 `editLogic.FieldEditKind` 的说明 |
 *
 * 类型恒为原类型：用户点的是「编辑这个字段的值」，不是「改字段类型」。要换类型请走
 * 整行编辑 —— 两种入口各司其职，比让一个输入框猜意图可靠得多。
 */

import {
  initialFieldText,
  isFieldEditableKind,
  parseFieldInput,
  type FieldEditKind,
} from './editLogic.ts';
import { jsonKindOf, pathToString, type PathSeg } from './detailLogic.ts';

/** 批量模式的附加参数（勾选「应用到全部」时携带）。 */
export interface FieldSubmitExtra {
  /** 是否把这次改动应用到其他行中相同路径、相同值的字段。 */
  applyAll: boolean;
  /** 浮层打开时的原值 —— 批量模式的匹配基准。 */
  from: unknown;
}

export interface FieldPanelDeps {
  /**
   * 提交新值。装配层负责定位原文、外科式替换、走整行编辑链路；
   * `extra.applyAll` 为真时改走批量字段级替换（装配层自行做二次确认）。
   */
  submit(
    segs: readonly PathSeg[],
    next: unknown,
    extra?: FieldSubmitExtra
  ): Promise<{ ok: boolean; error?: string }>;
  /** 提示成功（失败由浮层内部显示，不弹提示 —— 用户就在浮层里，看得见）。 */
  notify(message: string): void;
}

export interface FieldPanelController {
  /** 供装配层挂载的根节点（浮层 backdrop）。 */
  readonly root: HTMLElement;
  /** 打开浮层。`value` 的类型决定输入方式；不可编辑的类型直接拒绝打开。 */
  open(segs: readonly PathSeg[], value: unknown): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

/** 原值预览的最大长度（浮层里只做「确认改的是哪个字段」之用）。 */
const PREVIEW_MAX = 80;

function preview(value: unknown): string {
  const s = JSON.stringify(value) ?? String(value);
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}…` : s;
}

export function createFieldPanel(deps: FieldPanelDeps): FieldPanelController {
  let opened = false;
  let busy = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let currentSegs: readonly PathSeg[] = [];
  /** 浮层打开时的原值（勾选「应用到全部」时作为批量匹配基准上交）。 */
  let openedValue: unknown = undefined;

  const backdrop = document.createElement('div');
  backdrop.className = 'jlv-field-backdrop';
  backdrop.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'jlv-field';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', '编辑字段值');

  /* ---------------- 头部 ---------------- */
  const head = document.createElement('div');
  head.className = 'jlv-edit-head';

  const title = document.createElement('div');
  title.className = 'jlv-edit-title';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'jlv-btn';
  closeBtn.textContent = '取消';
  closeBtn.addEventListener('click', () => close());

  const headActions = document.createElement('div');
  headActions.className = 'jlv-edit-head-actions';
  headActions.append(closeBtn);
  head.append(title, headActions);

  /* ---------------- 主体 ---------------- */
  const meta = document.createElement('div');
  meta.className = 'jlv-field-meta';

  const body = document.createElement('div');
  body.className = 'jlv-field-body';

  /* 「应用到全部」：默认不勾 —— 单行改值是高频操作，批量是低频的重操作，
   * 默认值必须偏向轻的那边；批量还有二次确认横幅兜底，双保险各管一道。 */
  const applyAllCheck = document.createElement('input');
  applyAllCheck.type = 'checkbox';
  const applyAllText = document.createElement('span');
  applyAllText.textContent = '同时更新其他行中此路径下值相同的字段';
  const applyAllRow = document.createElement('label');
  applyAllRow.className = 'jlv-field-applyall';
  applyAllRow.append(applyAllCheck, applyAllText);
  applyAllRow.title = '批量按「路径 + 当前值」精确匹配后替换；其他字段里的相同文本不受影响';

  const errorEl = document.createElement('div');
  errorEl.className = 'jlv-field-error';
  errorEl.hidden = true;

  panel.append(head, meta, body, applyAllRow, errorEl);
  backdrop.append(panel);

  /* ---------------- 内部工具 ---------------- */

  function clearError(): void {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function showError(message: string): void {
    errorEl.hidden = false;
    errorEl.textContent = message;
  }

  /**
   * 提交新值。
   *
   * 失败时**保持浮层打开**并显示原因（用户就在浮层里，关掉再重开只会丢输入）。
   * 批量标志在提交瞬间从复选框读取 —— 各保存入口（文本保存按钮 / Enter / 布尔按钮）
   * 都不必自己关心它。
   */
  async function save(next: unknown): Promise<void> {
    if (busy) return;
    const applyAll = applyAllCheck.checked;
    // 批量模式**先关浮层**：确认横幅（z-index 30）低于浮层（85），留着浮层会把确认
    // 挡在后面；且确认动作本就发生在浮层之外 —— 与整行批量替换是同一个交互位形，
    // 同类危险操作必须长得一样。代价是确认取消后浮层已关，但重新操作的成本很低。
    if (applyAll) close();
    busy = true;
    clearError();
    setControlsEnabled(false);
    try {
      const res = await deps.submit(currentSegs, next, { applyAll, from: openedValue });
      if (res.ok) {
        // 批量结果由装配层以横幅给出（含替换行数等统计）；浮层若再报「已更新 X」
        // 会把它**盖掉** —— 用户看到的最后一条信息必须是最完整的那个。
        if (!applyAll) deps.notify(`已更新 ${pathToString([...currentSegs]) || '$'}`);
        close();
      } else if (applyAll) {
        // 批量模式下**不在这里再报一次**：装配层（commitFieldReplaceAll）已经把完整
        // 原因写在横幅上了 —— 取消是「已取消：文件未被修改」、失败是宿主的原始错误。
        // 此处若再 notify 一遍，就会把那条更完整、更关键的信息**覆盖**成含糊的
        // 「已取消」/「批量替换失败」，用户因此无法判断文件到底动没动。
      } else {
        showError(res.error ?? '保存失败');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (applyAll) deps.notify(msg);
      else showError(msg);
    } finally {
      busy = false;
      setControlsEnabled(true);
    }
  }

  /** 提交中禁用所有可点控件（防止重复提交第二次写入）。 */
  function setControlsEnabled(enabled: boolean): void {
    for (const el of Array.from(
      panel.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>(
        'button, input, textarea'
      )
    )) {
      el.disabled = !enabled;
    }
  }

  /* ---------------- 输入区构建（按类型分派） ---------------- */

  /** 保存按钮（两种输入形态共用同一外观与提交语义）。 */
  function saveButton(run: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'jlv-btn jlv-field-save';
    b.textContent = '保存';
    b.title = '保存（Ctrl+Enter）';
    b.addEventListener('click', run);
    return b;
  }

  function buildBody(kind: FieldEditKind, text: string): void {
    body.textContent = '';
    clearError();

    if (kind === 'boolean') {
      buildBooleanBody(text === 'true');
      return;
    }

    const actions = document.createElement('div');
    actions.className = 'jlv-field-actions';

    // 两种形态各写一遍（而非共用一个联合类型的元素）：一来联合类型的 addEventListener
    // 重载无法解析事件参数，二来 string 要保留「改成含换行的值」这一能力（textarea），
    // 而 number 是单行（input，Enter 即保存）—— 本来就不是同一个控件。
    if (kind === 'string') {
      const ta = document.createElement('textarea');
      ta.className = 'jlv-field-input';
      ta.rows = 4;
      ta.spellcheck = false;
      ta.value = text;
      ta.setAttribute('aria-label', '新值');

      const runSave = (): void => {
        const parsed = parseFieldInput(ta.value, 'string');
        if (!parsed.ok) {
          showError(parsed.error);
          return;
        }
        void save(parsed.value);
      };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          runSave();
        }
      });
      actions.append(saveButton(runSave));
      body.append(ta, actions);
      ta.focus();
      return;
    }

    const inp = document.createElement('input');
    inp.className = 'jlv-field-input';
    inp.type = 'text';
    inp.spellcheck = false;
    inp.value = text;
    inp.setAttribute('aria-label', '新值');

    const runSave = (): void => {
      const parsed = parseFieldInput(inp.value, 'number');
      if (!parsed.ok) {
        showError(parsed.error);
        return;
      }
      void save(parsed.value);
    };
    // 单行输入里 Enter 就交给它（Ctrl+Enter 也照收，两个都符合直觉）。
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runSave();
      }
    });
    actions.append(saveButton(runSave));
    body.append(inp, actions);
    inp.focus();
  }

  /** 布尔值：两个按钮直接给值，不需要输入框。 */
  function buildBooleanBody(isTrue: boolean): void {
    const mk = (label: string, value: boolean): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'jlv-btn';
      if (value === isTrue) b.classList.add('active');
      b.textContent = label;
      b.title = value === isTrue ? '当前值' : `设为 ${label}`;
      b.addEventListener('click', () => void save(value));
      return b;
    };
    const group = document.createElement('div');
    group.className = 'jlv-field-bool';
    group.append(mk('true', true), mk('false', false));
    body.append(group);
  }

  /* ---------------- 开关 ---------------- */

  function open(segs: readonly PathSeg[], value: unknown): void {
    if (opened) return;
    const kind = jsonKindOf(value);
    if (!isFieldEditableKind(kind)) {
      // 入口侧已过滤；此处防御并**明确告知**，而不是打开一个改不了任何东西的浮层。
      deps.notify(`该类型（${kind}）不支持字段级编辑，请用整行编辑。`);
      return;
    }
    currentSegs = segs;
    openedValue = value;
    applyAllCheck.checked = false; // 每次打开都从「只改这一个」开始 —— 批量必须显式选择
    title.textContent = `编辑 ${pathToString([...segs]) || '$'}`;
    meta.textContent = `原值 ${preview(value)}（${kind}）`;
    buildBody(kind, initialFieldText(value));

    opened = true;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    backdrop.hidden = false;
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
      panel.classList.add('open');
    });
  }

  function close(): void {
    if (!opened) return;
    opened = false;
    busy = false;
    backdrop.classList.remove('open');
    panel.classList.remove('open');
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      // 过渡期间可能又被打开 —— 定时器不得把新开的浮层藏掉。
      if (!opened) backdrop.hidden = true;
      closeTimer = undefined;
    }, 120);
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && opened) {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKeyDown);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  return {
    root: backdrop,
    open,
    close,
    isOpen: () => opened,
    dispose: () => {
      document.removeEventListener('keydown', onKeyDown);
      if (closeTimer) clearTimeout(closeTimer);
    },
  };
}
