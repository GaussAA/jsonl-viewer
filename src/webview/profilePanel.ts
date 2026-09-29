/**
 * profilePanel.ts — 全量 Schema / 数据质量画像浮层（F4）。
 *
 * 与 `badLinesPanel` / `historyPanel` 同一套浮层语义（设计体系 §3.6）。
 *
 * ## 它与「字段定制」面板的区别（两个都列字段，别混）
 *
 * | | 字段定制 | 数据画像 |
 * |---|---|---|
 * | 数据来源 | 抽样前 200 条 | **全文件流式扫描** |
 * | 回答的问题 | 「我想看哪些字段」 | 「这份数据干不干净、结构稳不稳」 |
 * | 是否可写 | 会改偏好 | **只读**，不改任何东西 |
 *
 * ## 一条铁律：中断的结果必须自曝
 *
 * 半份统计与全量统计在界面上一模一样（都是「3 个字段、100% 覆盖」），而用户会据此
 * 判断数据质量。所以只要 `cancelled`，抬头第一句就是「结果不完整，请勿据此判断」，
 * 且列表加标记 —— 宁可显得啰嗦，也不让一份残缺结论被当成结论。
 */

import { formatBytes } from './editLogic.ts';
import {
  fieldHasQualityIssue,
  fieldSummaryLine,
  profileHeadline,
  sortFieldsForDisplay,
  topValueLabel,
  type ProfileSort,
} from './profileLogic.ts';
import type { ProfilePayload, ProfileResult } from '../protocol/rpc.ts';

export interface ProfilePanelDeps {
  /** 触发一次全量画像（宿主侧流式扫描，耗时可取消）。 */
  scan(): Promise<ProfilePayload>;
  /** 是否已有扫描在途（防并发第二次）。 */
  isScanning(): boolean;
  /** 用某个字段开一条过滤条件（跳回列表看这些记录）。 */
  onFilterField(key: string): void;
  notify(message: string): void;
}

export interface ProfilePanelController {
  root: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** 扫描进度（只改文案，不重建按钮 —— 否则「取消」按钮会每次回调都闪烁）。 */
  setProgress(processedBytes: number, totalBytes: number): void;
  dispose(): void;
}

export function createProfilePanel(deps: ProfilePanelDeps): ProfilePanelController {
  let opened = false;
  let current: ProfileResult | undefined;
  let sortMode: ProfileSort = 'presence';
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const backdrop = document.createElement('div');
  backdrop.className = 'jlv-bad-backdrop';
  backdrop.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'jlv-bad jlv-prof';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', '数据画像');

  /* ---------------- 头部 ---------------- */
  const head = document.createElement('div');
  head.className = 'jlv-edit-head';
  const title = document.createElement('div');
  title.className = 'jlv-edit-title';
  title.textContent = '数据画像';

  const sortSel = document.createElement('select');
  sortSel.title = '排序方式';
  for (const [text, val] of [
    ['按出现次数', 'presence'],
    ['按缺失最多', 'missing'],
  ]) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = text;
    sortSel.appendChild(o);
  }
  sortSel.addEventListener('change', () => {
    sortMode = sortSel.value === 'missing' ? 'missing' : 'presence';
    if (current) render(current);
  });

  const scanBtn = document.createElement('button');
  scanBtn.type = 'button';
  scanBtn.className = 'jlv-btn';
  scanBtn.textContent = '开始扫描';
  scanBtn.title = '扫描整个文件统计字段分布（耗时操作，可取消）';
  scanBtn.addEventListener('click', () => void runScan());

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'jlv-btn';
  closeBtn.textContent = '关闭';
  closeBtn.addEventListener('click', () => close());

  const headActions = document.createElement('div');
  headActions.className = 'jlv-edit-head-actions';
  headActions.append(sortSel, scanBtn, closeBtn);
  head.append(title, headActions);

  /* ---------------- 状态 + 列表 ---------------- */
  const status = document.createElement('div');
  status.className = 'jlv-bad-status';
  status.textContent = '尚未扫描。画像会读取整个文件，比抽样更准也更慢。';

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
    scanBtn.textContent = busy ? '扫描中…' : '重新扫描';
  }

  function renderEmpty(message: string): void {
    list.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'jlv-bad-empty';
    empty.textContent = message;
    list.append(empty);
  }

  function render(res: ProfileResult): void {
    current = res;
    setBusy(deps.isScanning());
    list.textContent = '';

    status.textContent = profileHeadline(res);
    status.classList.toggle('warn', !!res.cancelled);
    // 中断的结果必须自曝：加一条醒目提示，而不是只体现在抬头的一句话里。
    note.hidden = !res.cancelled;
    if (res.cancelled) {
      note.textContent = '⚠ 扫描被中断，以下只是已扫过部分的统计，不代表整个文件。';
    }

    if (res.fields.length === 0) {
      renderEmpty('没有可统计的字段（可能记录全是标量，或文件里没有合法 JSON 记录）。');
      return;
    }

    for (const f of sortFieldsForDisplay(res.fields, sortMode)) {
      const row = document.createElement('div');
      row.className = 'jlv-prof-row';
      if (fieldHasQualityIssue(f, res.parsed)) row.classList.add('has-issue');

      const main = document.createElement('div');
      main.className = 'jlv-prof-main';
      const key = document.createElement('span');
      key.className = 'jlv-prof-key';
      key.textContent = f.key;
      key.title = f.key;
      const meta = document.createElement('span');
      meta.className = 'jlv-prof-meta';
      meta.textContent = fieldSummaryLine(f, res.parsed);
      main.append(key, meta);

      const top = document.createElement('div');
      top.className = 'jlv-prof-top';
      top.textContent = f.top.length > 0 ? f.top.map(topValueLabel).join(' · ') : '（无取值）';
      if (f.valuesTruncated) {
        const more = document.createElement('span');
        more.className = 'jlv-prof-more';
        more.textContent = ' 取值未列尽';
        more.title = '该字段的互异取值超过了统计容量，此处只列出出现最多的若干';
        top.appendChild(more);
      }

      const act = document.createElement('button');
      act.type = 'button';
      act.className = 'jlv-btn';
      act.textContent = '筛选';
      act.title = `用「${f.key} 存在」作为过滤条件`;
      act.addEventListener('click', () => deps.onFilterField(f.key));

      row.append(main, top, act);
      list.append(row);
    }
  }

  async function runScan(): Promise<void> {
    if (deps.isScanning()) return;
    setBusy(true);
    status.textContent = '正在扫描整个文件…';
    status.classList.remove('warn');
    try {
      const payload = await deps.scan();
      if (!payload?.ok || !payload.result) {
        status.textContent = `画像失败：${payload?.error ?? '未知错误'}`;
        status.classList.add('warn');
        renderEmpty('未能取得画像。');
        return;
      }
      render(payload.result);
    } catch (e) {
      // 失败必须说出来：留下一屏旧数字会被当成「这次扫描的结果」。
      status.textContent = `画像失败：${e instanceof Error ? e.message : String(e)}`;
      status.classList.add('warn');
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- 开关 ---------------- */

  function open(): void {
    if (opened) return;
    opened = true;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    backdrop.hidden = false;
    // 下一帧再加类，保证过渡生效（与 editPanel / historyPanel / badLinesPanel 一致）。
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
      panel.classList.add('open');
    });
    // 首次打开自动扫一次：用户点「数据画像」就是想看数据长什么样，
    // 再让他点一次「开始扫描」是多余的一道手续。
    if (!current && !deps.isScanning()) void runScan();
    else setBusy(deps.isScanning());
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

  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close();
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  return {
    root: backdrop,
    open,
    close,
    isOpen: () => opened,
    setProgress(processedBytes, totalBytes) {
      if (!opened) return;
      const pct =
        totalBytes > 0 ? Math.min(100, Math.round((processedBytes / totalBytes) * 100)) : 0;
      // 只改文案：进度回调每次重建节点的话，「取消」按钮会跟着闪。
      status.textContent = `正在扫描整个文件… ${pct}%（已读 ${formatBytes(processedBytes)} / ${formatBytes(totalBytes)}）`;
    },
    dispose() {
      if (closeTimer) clearTimeout(closeTimer);
      backdrop.remove();
    },
  };
}
