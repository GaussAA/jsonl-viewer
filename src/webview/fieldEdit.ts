/**
 * fieldEdit.ts — 字段级编辑域（详情树上点字段值 / 双击原地编辑 / 批量按字段替换）。
 *
 * 抽出的理由：这是「编辑能力」在详情侧的另一半，与外层的整行编辑（editOps）**对称**：
 *   · 整行编辑：用户在浮层里写完整一行 JSON；
 *   · 字段编辑：用户只改某个路径下的值，由 `jsonSpan` 在**磁盘原文**里精确定位那一段
 *     字节并替换，键序、空白、其余字段的转义风格逐字节不变。
 * 二者最终都走同一条落盘链路（`EDIT_RECORD` / `REPLACE_FIELD`），差别只在「新文本怎么算出来」。
 *
 * 三条不变式（**勿破坏**）：
 *   1. **复用整行编辑的落盘链路**，不为字段编辑另开写路径 —— 冲突检测、乐观锁、索引增量、
 *      撤销栈、自写基线同步这五件事已经在那里做对了，复制一份必然漂移；
 *   2. **必须基于磁盘原文定位**（`state.detailRaw`）；拿不到原文就明确拒绝，
 *      而不是拿重新序列化的值去改（那会重排用户的格式，且乐观锁会失准）；
 *   3. 保存成功后**后台**重拉详情（fire-and-forget）：`await` 它会让保存显得卡住，
 *      且重拉失败会被误当成保存失败 —— 两件事必须分开。
 */

import { viewBaseline } from './appState.ts';
import type { AppState } from './appState.ts';
import type { RpcBus } from './rpc.ts';
import type { DetailTreeNavHandlers } from './detailTree.ts';
import { createFieldPanel } from './fieldPanel.ts';
import { pathToString, toPathParts } from './detailLogic.ts';
import type { PathSeg } from './detailLogic.ts';
import { replaceValueAtPath } from '../core/jsonSpan.ts';
import { describeEditFailure, fieldReplaceConfirmText } from './editLogic.ts';
import { describeReplaceOutcome } from '../core/replaceLogic.ts';
import { HostEndpoint } from '../protocol/rpc.ts';
import type { EditResultPayload, ReplaceResultPayload } from '../protocol/rpc.ts';
import { RPC_HEAVY_TIMEOUT_MS } from '../constants.ts';

export interface FieldEditDeps {
  state: AppState;
  bus: RpcBus;
  list: { refresh(): void };
  banner: {
    show(text: string, actionLabel?: string, onAction?: () => void): void;
  };
  /** 详情树导航回调（本模块填充 onEditField / onInlineEdit）。 */
  navHandlers: DetailTreeNavHandlers;
  showDetailForLine: (line: number) => unknown;
  updateToolbar: () => void;
  scheduleBadLinesRefresh: () => void;
  /** 记录在途的批量字段替换（进度推送据此渲染、取消据此发 CANCEL）。 */
  setActiveFieldReplace: (rid: string | null) => void;
}

export interface FieldEdit {
  /** 字段编辑浮层根节点（调用方挂载）。 */
  root: HTMLElement;
  /** 浮层是否打开（Esc 分层处理要用）。 */
  isOpen: () => boolean;
  dispose: () => void;
}

export function createFieldEdit(deps: FieldEditDeps): FieldEdit {
  const {
    state,
    bus,
    list,
    banner,
    navHandlers,
    showDetailForLine,
    updateToolbar,
    scheduleBadLinesRefresh,
    setActiveFieldReplace,
  } = deps;

  const fieldPanel = createFieldPanel({
    submit: (segs, next, extra) =>
      extra?.applyAll ? commitFieldReplaceAll(segs, extra.from, next) : commitFieldEdit(segs, next),
    notify: (message) => banner.show(message, undefined),
  });

  /**
   * 提交字段编辑：**定位 → 外科式替换 → 走已有的整行编辑链路**。
   *
   * 之所以复用 `EDIT_RECORD` 而不为字段编辑新开一条写入路径：冲突检测、乐观锁、
   * 索引增量、撤销栈、自写基线同步这五件事已经在那里做对了，复制一份必然漂移。
   * 字段级编辑与整行编辑的差别只在「新文本怎么算出来」——那由 jsonSpan 负责。
   */
  async function commitFieldEdit(
    segs: readonly PathSeg[],
    next: unknown
  ): Promise<{ ok: boolean; error?: string }> {
    const line = state.selectedLine;
    const raw = state.detailRaw;
    if (line === undefined) return { ok: false, error: '没有选中的记录。' };
    if (!raw) return { ok: false, error: '该行的原文不可用，请重新载入该记录后再编辑。' };

    // ① 只在原文里替换目标值那一段字节 —— 键序、空白、其余字段的转义风格逐字节不变。
    const replaced = replaceValueAtPath(raw.text, toPathParts(segs), next);
    if (!replaced.ok) return { ok: false, error: replaced.error };

    // ② 走整行编辑：`expectedBytes` 用宿主回传的原文字节数做乐观锁（外部改动即拒绝）。
    let res: EditResultPayload | null = null;
    try {
      res = await bus.request<EditResultPayload>(
        HostEndpoint.EDIT_RECORD,
        { line, text: replaced.text, expectedBytes: raw.bytes },
        { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
      ).promise;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!res?.ok) return { ok: false, error: describeEditFailure(res ?? {}) };

    // ③ 落盘成功：该行缓存失效 → 重绘卡片 → **后台**重拉详情。
    //    重拉必须 fire-and-forget：它要等宿主回执，若 await 它，保存就会显得卡住，
    //    而且重拉失败还会被误当成保存失败（两者是两回事）。
    //    重拉仍然必要 —— 详情树的原文会随之更新，否则下一次字段编辑会基于过期原文定位。
    state.cache.delete(line);
    list.refresh();
    updateToolbar();
    void showDetailForLine(line);
    scheduleBadLinesRefresh();
    return { ok: true };
  }

  /**
   * 批量字段级替换：先横幅二次确认，再走 `REPLACE_FIELD`。
   *
   * 与整行批量替换**同一套交互**（确认 → 进度 → 取消 → 结果）—— 同类危险操作的交互
   * 必须长一个样，用户学一次就会用。差别只在确认文案说的是「该路径下值相同的字段」。
   *
   * 注意浮层在批量提交时已自行关闭（为确认横幅让路），故结果只能走横幅反馈。
   */
  function commitFieldReplaceAll(
    segs: readonly PathSeg[],
    from: unknown,
    to: unknown
  ): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const totalBytes = state.overview?.totalBytes ?? 0;
      const pathText = pathToString([...segs]) || '$';
      banner.show(fieldReplaceConfirmText(pathText, totalBytes), '确认替换', () => {
        void (async () => {
          try {
            const { requestId, promise } = bus.request<ReplaceResultPayload>(
              HostEndpoint.REPLACE_FIELD,
              { path: toPathParts(segs), from, to, ...viewBaseline(state) },
              { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
            );
            // 记下 requestId：进度推送据此渲染横幅文字，取消据此发 CANCEL。
            // 取消**只发 CANCEL、不 settle 本地 Promise** —— 要等宿主回执才能如实
            // 说「文件未被修改」，与整行批量替换同一纪律。
            setActiveFieldReplace(requestId);
            banner.show('正在替换…', '取消', () => {
              bus.post(HostEndpoint.CANCEL, { requestId });
            });
            const res = await promise;
            if (res?.cancelled) {
              banner.show('已取消：文件未被修改。', undefined);
              resolve({ ok: false, error: '已取消' });
              return;
            }
            if (!res?.ok) {
              banner.show(res?.error ?? '批量替换失败', undefined);
              resolve({ ok: false, error: res?.error ?? '批量替换失败' });
              return;
            }
            // 改动可能散落全文件，无法逐行失效 —— 整体清空缓存并按需重拉。
            state.cache.clear();
            list.refresh();
            updateToolbar();
            scheduleBadLinesRefresh();
            if (state.selectedLine !== undefined) void showDetailForLine(state.selectedLine);
            banner.show(describeReplaceOutcome(res), undefined);
            resolve({ ok: true });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            banner.show(msg, undefined);
            resolve({ ok: false, error: msg });
          } finally {
            setActiveFieldReplace(null);
          }
        })();
      });
    });
  }

  /* ---------------- 详情树的接线 ---------------- */

  navHandlers.onEditField = (segs, value) => {
    // 入口侧已按「原文是否可用」判定过，此处再防一层：拿不到原文就无法安全定位，
    // 与其让用户改完才发现失败，不如当场说清。
    if (!state.detailRaw) {
      banner.show('该行的原文不可用，请重新载入该记录后再编辑。', undefined);
      return;
    }
    fieldPanel.open(segs, value);
  };

  // 原地编辑（双击字段值）：与浮层共用同一条提交链路（jsonSpan 定位 → 整行编辑）。
  // 失败原因由编辑态红框显示；成功后 commitFieldEdit 内部会重建详情树。
  navHandlers.onInlineEdit = (segs, _from, to) => {
    if (!state.detailRaw) {
      return { ok: false, error: '该记录的原文不可用，无法定位字段。' };
    }
    return commitFieldEdit(segs, to);
  };

  return {
    root: fieldPanel.root,
    isOpen: () => fieldPanel.isOpen(),
    dispose: () => fieldPanel.dispose(),
  };
}
