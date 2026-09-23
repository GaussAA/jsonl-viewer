/**
 * badLinesPanel.ts — 坏行诊断浮层。
 *
 * 与 `historyPanel` / `editPanel` 同一套浮层语义（设计体系 §3.6 的弹出/收起节奏）。
 *
 * ## 为何要单独一个浮层
 *
 * 宿主的坏行集合是**惰性积累**的：只覆盖用户读过/抽样过的行。据它判断「文件是否
 * 干净」会得出与事实相反的结论 —— 而「这文件到底有多少坏行」恰恰是数据清洗的第一问。
 * 故本浮层把两件事分开呈现：
 *
 *   1. 「已发现」（partial）—— 顺带的产物，仅供参考；
 *   2. 「扫描整个文件」（全量）—— 用户显式触发的权威结论。
 *
 * 文案上二者必须一眼可分。把 partial 说成全量，比不提供这个功能更糟。
 *
 * ## 为何只回行号、不回错误摘要
 *
 * 扫描时若同时收集每行错误消息，20 万行的内存与载荷都要翻倍，而用户真正需要的
 * 是「坏在哪」。故只回行号，点击即跳转 —— 跳过去后列表/详情会显示该行的真实错误。
 * 不编造摘要，就不会有摘要是错的。
 */

import { formatBytes } from './editLogic.ts';
import type { BadLinesPayload } from '../protocol/rpc.ts';

export interface BadLinesPanelDeps {
  /** 拉取「已发现」集合（partial 恒为 true）。 */
  fetchBadLines(): Promise<BadLinesPayload>;
  /**
   * 全文件扫描。实现方（装配层）负责进度横幅与取消入口 —— 取消要按 requestId
   * 发 CANCEL，那是装配层才有的信息。
   */
  scanBadLines(): Promise<BadLinesPayload>;
  /** 扫描是否在进行中（用于禁用按钮、避免重复触发）。 */
  isScanning(): boolean;
  /** 跳转到指定行（装配层已有能力，并会同步选中与详情）。 */
  jumpTo(line: number): void;
  /**
   * 把这些行写入选区，返回实际选中的行数。
   *
   * 返回 0 表示被拒绝（超出选择上限等），具体原因由实现方提示 —— 静默截断会让
   * 用户以为「坏行都选上了」，然后一次删除删错范围。
   */
  selectLines(lines: readonly number[]): number;
  notify(message: string): void;
}

export interface BadLinesPanelController {
  /** 供装配层挂载的根节点（浮层 backdrop）。 */
  readonly root: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

export function createBadLinesPanel(deps: BadLinesPanelDeps): BadLinesPanelController {
  let opened = false;
  /** 最近一次渲染的数据（「全选」按钮要用）。 */
  let current: BadLinesPayload | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const backdrop = document.createElement('div');
  backdrop.className = 'jlv-bad-backdrop';
  backdrop.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'jlv-bad';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', '坏行诊断');

  /* ---------------- 头部 ---------------- */
  const head = document.createElement('div');
  head.className = 'jlv-edit-head';

  const title = document.createElement('div');
  title.className = 'jlv-edit-title';
  title.textContent = '坏行诊断';

  const scanBtn = document.createElement('button');
  scanBtn.type = 'button';
  scanBtn.className = 'jlv-btn';
  scanBtn.textContent = '扫描整个文件';
  scanBtn.title = '扫描整个文件，找出全部坏行（耗时操作，可取消）';
  scanBtn.addEventListener('click', () => void runScan());

  const selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'jlv-btn';
  selectBtn.textContent = '全选坏行';
  selectBtn.title = '写入选区后可用工具栏下方的「删除」一次清除';
  selectBtn.addEventListener('click', () => {
    if (!current || current.lines.length === 0) return;
    const n = deps.selectLines(current.lines);
    if (n > 0) close();
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'jlv-btn';
  closeBtn.textContent = '关闭';
  closeBtn.addEventListener('click', () => close());

  const headActions = document.createElement('div');
  headActions.className = 'jlv-edit-head-actions';
  headActions.append(scanBtn, selectBtn, closeBtn);
  head.append(title, headActions);

  /* ---------------- 状态行 + 列表 ---------------- */
  const status = document.createElement('div');
  status.className = 'jlv-bad-status';

  const note = document.createElement('div');
  note.className = 'jlv-bad-note';
  note.hidden = true;

  const list = document.createElement('div');
  list.className = 'jlv-bad-list';

  panel.append(head, status, note, list);
  backdrop.append(panel);

  /* ---------------- 渲染 ---------------- */

  function setBusy(busy: boolean): void {
    scanBtn.disabled = busy;
    scanBtn.textContent = busy ? '扫描中…' : '扫描整个文件';
  }

  function renderEmpty(message: string): void {
    list.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'jlv-bad-empty';
    empty.textContent = message;
    list.append(empty);
  }

  function render(data: BadLinesPayload): void {
    current = data;
    // 恢复按钮态：若刷新发生在扫描期间，按钮须保持禁用（避免并发第二次扫描）。
    setBusy(deps.isScanning());
    list.textContent = '';

    /* 状态行：partial 与 truncated 分开表达 —— 一个说「没查全」，一个说「太多装不下」，
       二者给用户的下一步动作完全不同（去扫描 / 换工具）。 */
    const parts: string[] = [];
    if (data.cancelled) parts.push('扫描已取消，未改动坏行集合');
    if (data.partial) parts.push(`已发现 ${data.lines.length} 个坏行（仅在已浏览范围内）`);
    else parts.push(`共 ${data.lines.length} 个坏行`);
    if (data.truncated) parts.push('列表已截断，仅显示前若干条');
    status.textContent = parts.join('｜');

    // 语义提示：未扫描时**必须**说清这不是全量结论。
    note.hidden = !data.partial;
    if (data.partial) {
      note.textContent =
        '注意：这不代表文件只有这些坏行 —— 它只统计了你在浏览中读过的行。' +
        '点「扫描整个文件」可得权威结论。';
    }

    selectBtn.disabled = data.lines.length === 0;

    if (data.lines.length === 0) {
      renderEmpty(data.partial ? '尚未发现坏行（也未做全文件扫描）。' : '整个文件未发现坏行。');
      return;
    }

    // 上限内的行即便被截断也照常列出：用户至少要能做「删掉这些」。
    for (const line of data.lines) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'jlv-bad-row';
      row.dataset.line = String(line);

      const lno = document.createElement('span');
      lno.className = 'jlv-bad-lno';
      lno.textContent = `第 ${line + 1} 行`;

      const hint = document.createElement('span');
      hint.className = 'jlv-bad-hint';
      hint.textContent = '定位';

      row.append(lno, hint);
      row.addEventListener('click', () => {
        deps.jumpTo(line);
        close();
      });
      list.append(row);
    }
  }

  /* ---------------- 交互 ---------------- */

  async function refresh(): Promise<void> {
    try {
      render(await deps.fetchBadLines());
    } catch (e) {
      renderEmpty(`读取坏行失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function runScan(): Promise<void> {
    setBusy(true);
    try {
      const res = await deps.scanBadLines();
      render(res);
      deps.notify(describeBadLines(res));
    } catch (e) {
      // 失败与取消必须分开报 —— 取消是零风险的，报成失败会让人以为文件出了问题。
      deps.notify(`扫描失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      if (opened) await refresh();
    }
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

  function open(): void {
    if (opened) return;
    opened = true;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    backdrop.hidden = false;
    // 下一帧再加类，保证过渡生效（与 editPanel / historyPanel 一致）
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
      panel.classList.add('open');
    });
    void refresh();
  }

  function close(): void {
    if (!opened) return;
    opened = false;
    backdrop.classList.remove('open');
    panel.classList.remove('open');
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      // 过渡期间用户可能又打开了它 —— 关闭定时器不得把新开的浮层藏掉。
      if (!opened) backdrop.hidden = true;
      closeTimer = undefined;
    }, 120);
  }

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

/** 耗时文案：不足 1 秒不显示小数（「0.4 秒」这种精度对用户没有意义）。 */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '耗时未知';
  if (ms < 1000) return '不足 1 秒';
  return `约 ${Math.round(ms / 1000)} 秒`;
}

/** 扫描进度文案（横幅用）。百分比封顶 100，避免尾块越界时显示「101%」。 */
export function scanProgressText(processedBytes: number, totalBytes: number): string {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return '正在扫描坏行…';
  const pct = Math.min(100, Math.round((processedBytes / totalBytes) * 100));
  return `正在扫描坏行… ${pct}%（${formatBytes(processedBytes)} / ${formatBytes(totalBytes)}）`;
}

/**
 * 扫描结果 → 通知文案。
 *
 * 导出供装配层与测试复用：同一套结果只该有一种说法，否则浮层里说「已取消」、
 * 横幅里说「失败」，用户就不知道该信哪个。
 */
export function describeBadLines(res: BadLinesPayload): string {
  if (res.cancelled) return '扫描已取消：坏行集合未被改动。';
  if (res.partial) return '扫描未完成。';
  if (res.lines.length === 0) return `扫描完成（${formatDuration(res.costMs)}）：全文件无坏行。`;
  const scope = res.truncated ? '（列表已截断，仅显示前若干条）' : '';
  return `扫描完成（${formatDuration(res.costMs)}）：共 ${res.lines.length} 个坏行${scope}。`;
}
