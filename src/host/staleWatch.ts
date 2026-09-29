/**
 * staleWatch.ts — 文件变更轮询看门狗（从 `extension.ts` 抽出，O14）。
 *
 * 为何值得单独抽出并测试：它的核心是一条**三态状态机**（正常 → 走样 → 已提示），
 * 而这条状态机里最容易写错、且**完全静默**的一步是「复位」——
 * 若变化消失后不把 `staleSignaled` 复位，用户把文件改回来、之后再改一次，
 * 就再也收不到提示了，而且没有任何报错。
 *
 * 其余两条约定：
 *   · 检测抛错按「没变化」处理（后台轮询；为一次读盘失败弹错误横幅只会打扰用户）；
 *   · 同一段走样状态只提示一次，避免每 5 秒弹一遍横幅。
 */

import { FILE_STALE_POLL_MS } from '../constants.ts';

/**
 * 一次检测的结论。`null` 表示「跳过本轮」（尚无基线，或正在编辑）。
 *
 * 形状与 `DataService.checkStale()` 的返回**逐字段一致**（判别联合）：这样宿主把
 * 真实服务接进来时不需要任何转换层 —— 转换层正是那种「加一个字段忘了同步」的地方。
 *
 * `appended` 分支是 F6 追尾：文件只在尾部增长、索引已增量跟进 —— 这**不是走样**
 * （基线已被更新），走自己的出口（`onAppended`），且要复位 `staleSignaled`
 * （追尾说明文件在动，此前的「已提示」前提已不成立）。
 */
export type StaleCheckLike =
  | { changed: false }
  | { changed: true; deleted: boolean; message: string }
  | { appended: true; totalLines: number; totalRecords: number; totalBytes: number }
  | null;

export interface StaleWatchDeps {
  /** 检测一次：返回 null 表示本轮不判定。 */
  checkStale(): Promise<StaleCheckLike | null>;
  /** 推送 FILE_STALE。形状即 `StaleFilePayload`。 */
  signal(payload: { message: string; deleted: boolean }): void;
  /** 追尾成功：索引已就地扩展，通知前端刷新总行数（可选；F6）。 */
  onAppended?(info: { totalLines: number; totalRecords: number; totalBytes: number }): void;
  /** 轮询间隔（毫秒）；默认 `FILE_STALE_POLL_MS`。测试注入极小值以免等 5 秒。 */
  pollMs?: number;
}

/**
 * 启动轮询，返回定时器句柄（调用方在 teardown 时 `clearInterval`）。
 *
 * 回调整体包在 try 里：`setInterval` 收到 async 回调时，返回的 Promise 若 reject
 * 无人接管 —— 那会变成未处理的 rejection，是扩展宿主进程的隐患。
 */
export function startStaleWatch(deps: StaleWatchDeps): ReturnType<typeof setInterval> {
  const pollMs = deps.pollMs ?? FILE_STALE_POLL_MS;
  let staleSignaled = false;

  return setInterval(() => {
    void (async () => {
      let res: StaleCheckLike | null;
      try {
        res = await deps.checkStale();
      } catch {
        res = null;
      }
      try {
        if (!res) {
          // 复位：变化消失后必须能再次提示，否则「改回正常再改坏」将永远收不到提醒。
          staleSignaled = false;
          return;
        }
        if ('appended' in res) {
          // 追尾成功不是走样：走自己的出口，并复位「已提示」（文件在动，旧提示的前提已变）。
          staleSignaled = false;
          deps.onAppended?.(res);
          return;
        }
        if (!res.changed) {
          staleSignaled = false;
          return;
        }
        if (staleSignaled) return; // 已提示过，避免重复弹横幅
        staleSignaled = true;
        deps.signal({ message: res.message, deleted: res.deleted });
      } catch {
        // 推送失败同样吞掉（后台轮询不该因为一次 post 失败而中断整条定时器）。
      }
    })();
  }, pollMs);
}
