/**
 * editHistory.ts — 会话编辑历史（单一光标模型）。
 *
 * 从 `dataService.ts` 抽出的独立模块，理由：
 *   1. 历史是**纯状态机**（入栈 / 光标 / 裁剪 / 快照），与「读写磁盘」没有耦合；
 *      混在 DataService 里让它既是 IO 编排者又是状态机，两边的变化会互相牵连；
 *   2. 上限策略（条数 + 总体积）与「丢弃后如实标记」是独立可测的规则，
 *      独立成模块后无需构造临时文件即可完整覆盖；
 *   3. DataService 已 2200+ 行，抽出这一块能把它拉回「编排层」的定位。
 *
 * 核心语义（**不可动摇**）：
 *   - 单一光标：`cursor` 之前为「已应用」，之后为「已撤销」。撤销/重做/Ctrl+Z/
 *     历史面板回退全部走这一个光标 —— 两套光标必然各说各话。
 *   - 上限裁剪从**最旧**一端丢弃，并同步回退光标；丢弃必须留下 `dropped` 标记，
 *     否则用户会以为看到的是完整历史。
 */

import type { DeletedRange, HistoryPayload, ReplaceChange } from '../protocol/rpc.ts';
import { MAX_HISTORY_BYTES, MAX_HISTORY_ENTRIES } from '../constants.ts';

/**
 * 一次可撤销的写操作。
 *
 * 每条都能**双向**执行：`forward` 是用户当初做的操作，反向即回退 —— 这正是
 * 「Ctrl+Z 单步撤销」与「历史面板回退到某点」能共用同一份数据的原因。
 */
export type HistoryOp =
  | { kind: 'edit'; line: number; before: string; after: string }
  | { kind: 'insert'; line: number; text: string }
  | { kind: 'delete'; line: number; before: string }
  | { kind: 'deleteMany'; ranges: DeletedRange[] }
  | { kind: 'replaceAll'; changes: ReplaceChange[] };

/** 历史条目（含回退数据，仅供宿主内部使用）。 */
export interface HistoryEntry {
  id: string;
  op: HistoryOp;
  label: string;
  /** 影响的行数。 */
  lines: number;
  bytesDelta: number;
  at: number;
  /** 该条目占用的近似字节数（用于总体积上限）。 */
  bytes: number;
}

/** 单步 / 多步历史操作的结果。 */
export interface HistoryStepResult {
  ok: boolean;
  /** 本次实际执行的步数（回退跨多条时为多步）。 */
  steps: number;
  /** 执行后的光标位置。 */
  cursor: number;
  total: number;
  /** 被操作条目的描述（单步时给出）。 */
  label?: string;
  /** 失败原因（中途失败时 steps 表示已成功的步数，便于如实告知）。 */
  error?: string;
}

/** 历史条目占用的近似字节数（正向与反向数据都要留着才能双向执行）。 */
function historyOpBytes(op: HistoryOp): number {
  switch (op.kind) {
    case 'edit':
      return op.before.length + op.after.length;
    case 'insert':
      return op.text.length;
    case 'delete':
      return op.before.length;
    case 'deleteMany':
      return op.ranges.reduce((a, r) => a + r.content.length, 0);
    case 'replaceAll':
      return op.changes.reduce((a, c) => a + c.before.length + c.after.length, 0);
  }
}

/** 由操作推出「描述 + 影响行数」。 */
export function historyLabel(op: HistoryOp): { label: string; lines: number } {
  switch (op.kind) {
    case 'edit':
      return { label: `编辑第 ${op.line + 1} 行`, lines: 1 };
    case 'insert':
      return { label: `在第 ${op.line + 1} 行前插入`, lines: 1 };
    case 'delete':
      return { label: `删除第 ${op.line + 1} 行`, lines: 1 };
    case 'deleteMany': {
      const n = op.ranges.reduce((a, r) => a + r.lines.length, 0);
      return { label: `删除 ${n} 行`, lines: n };
    }
    case 'replaceAll':
      return { label: `替换 ${op.changes.length} 行`, lines: op.changes.length };
  }
}

/**
 * 会话编辑历史。
 *
 * 只负责「记录与光标」，**不负责执行**：回退要把操作真正写回磁盘，
 * 那件事由 DataService 完成（它才持有索引与文件句柄）。
 */
export class EditHistory {
  private readonly entries: HistoryEntry[] = [];
  private cursor = 0;
  private seq = 0;
  private dropped = false;
  private readonly maxEntries = MAX_HISTORY_ENTRIES;
  private readonly maxBytes = MAX_HISTORY_BYTES;

  /**
   * 正在执行历史回退：期间的写操作**不再入栈**（否则撤销会生成新记录，
   * 撤销栈无限增长且语义崩溃）。
   */
  applying = false;

  /** 已应用条数（= 光标位置）。 */
  get cursorPos(): number {
    return this.cursor;
  }

  /** 总条数。 */
  get total(): number {
    return this.entries.length;
  }

  /** 光标处的条目（下一步要重做的那条）。 */
  entryAt(index: number): HistoryEntry | undefined {
    return this.entries[index];
  }

  /** 光标前一条（下一步要撤销的那条）。 */
  prevEntry(): HistoryEntry | undefined {
    return this.cursor > 0 ? this.entries[this.cursor - 1] : undefined;
  }

  /** 按 id 定位（历史面板「回退到此处」）。返回下标，不存在为 -1。 */
  indexOfId(id: string): number {
    return this.entries.findIndex((e) => e.id === id);
  }

  /**
   * 记入一步操作。
   *
   * 两条铁律：
   *   1. 新操作会**截断**光标之后的「已撤销」分支（标准撤销栈语义）；
   *   2. 回退执行期间不入栈（`applying` 为真时整体忽略）—— 否则撤销会生成新记录。
   */
  push(op: HistoryOp, bytesDelta: number): void {
    if (this.applying) return;
    // 在「已撤销」状态下做了新操作 → 其后的重做分支作废。
    if (this.cursor < this.entries.length) {
      this.entries.length = this.cursor;
    }
    const { label, lines } = historyLabel(op);
    this.entries.push({
      id: `h${++this.seq}`,
      op,
      label,
      lines,
      bytesDelta,
      at: Date.now(),
      bytes: historyOpBytes(op),
    });
    this.cursor = this.entries.length;
    this.trim();
  }

  /**
   * 从**最旧**的一端丢弃，直到条数与总体积都在上限内（丢弃即同步回退光标）。
   *
   * 保留「至少一条」：否则一条就超限的巨型操作会被自己的上限立刻丢掉 ——
   * 那等于刚做的事无法撤销。
   */
  private trim(): void {
    let bytes = this.entries.reduce((a, e) => a + e.bytes, 0);
    while (
      this.entries.length > MAX_HISTORY_ENTRIES ||
      (bytes > MAX_HISTORY_BYTES && this.entries.length > 1)
    ) {
      const gone = this.entries.shift();
      if (!gone) break;
      bytes -= gone.bytes;
      if (this.cursor > 0) this.cursor--;
      this.dropped = true;
    }
  }

  /** 光标前移一格（撤销一步成功后调用）。 */
  stepBack(): void {
    if (this.cursor > 0) this.cursor--;
  }

  /** 光标后移一格（重做一步成功后调用）。 */
  stepForward(): void {
    if (this.cursor < this.entries.length) this.cursor++;
  }

  /**
   * 执行新编辑命令并入栈（新接口，自动清理 redo 栈）。
   *
   * 这是推荐的入口：调用方无需手动调用 clearAfterCursor()，避免遗漏。
   * 旧的 push() + 手动清理模式仍保留（向后兼容），但标记为 deprecated。
   *
   * 注意：此方法接受完整的 HistoryEntry（已包含 label、lines、bytes 等），
   * 而旧的 push() 接受 HistoryOp + bytesDelta 并自动计算其他字段。
   */
  execute(entry: HistoryEntry): void {
    if (this.applying) return;
    // 清理 cursor 后的所有条目（即 redo 栈）
    if (this.cursor < this.entries.length) {
      this.entries.splice(this.cursor);
    }
    // 入栈新命令（直接使用传入的完整 entry）
    this.entries.push(entry);
    this.cursor = this.entries.length;
    this.trim();
  }

  /**
   * 撤销一步（返回要撤销的命令，不执行 IO）。
   *
   * 返回 null 表示无可撤销内容。调用方负责应用返回的命令到磁盘。
   * 状态机已自动后退游标。
   */
  undo(): HistoryEntry | null {
    if (this.cursor === 0) return null;
    this.cursor--;
    return this.entries[this.cursor];
  }

  /**
   * 重做一步（返回要重做的命令，不执行 IO）。
   *
   * 返回 null 表示无可重做内容。调用方负责应用返回的命令到磁盘。
   * 状态机已自动前进游标。
   */
  redo(): HistoryEntry | null {
    if (this.cursor >= this.entries.length) return null;
    const entry = this.entries[this.cursor];
    this.cursor++;
    return entry;
  }

  /**
   * 查询当前状态（用于 UI 更新或调试）。
   *
   * 返回快照，修改返回对象不影响内部状态。
   */
  getState(): { canUndo: boolean; canRedo: boolean; position: number; dropped: boolean } {
    return {
      canUndo: this.cursor > 0,
      canRedo: this.cursor < this.entries.length,
      position: this.cursor,
      dropped: this.dropped,
    };
  }

  /**
   * 检查新命令是否会超出容量限制。
   *
   * 用于"先查询再决定"模式：调用方可根据返回值决定是否提示用户、降级、或继续。
   * 不影响内部状态。
   */
  wouldExceedLimit(entry: HistoryEntry): boolean {
    // 检查总字节数上限
    const currentBytes = this.entries.slice(0, this.cursor).reduce((sum, e) => sum + e.bytes, 0);
    const newBytes = entry.bytes;
    if (currentBytes + newBytes > this.maxBytes) {
      return true;
    }

    // 检查条目数上限（execute() 会先清理 redo 栈，所以新长度 = cursor + 1）
    const afterPush = this.cursor + 1;
    if (afterPush > this.maxEntries) {
      return true;
    }

    return false;
  }

  /** 整体清空（reload / dispose：行号与偏移已整体失效，旧历史不可再应用）。 */
  clear(): void {
    this.entries.length = 0;
    this.cursor = 0;
    this.dropped = false;
  }

  /** 对外视图快照（**不含**回退数据 —— 那是宿主内部事务）。 */
  snapshot(): HistoryPayload {
    return {
      entries: this.entries.map((e) => ({
        id: e.id,
        kind: e.op.kind,
        label: e.label,
        lines: e.lines,
        bytesDelta: e.bytesDelta,
        at: e.at,
      })),
      cursor: this.cursor,
      dropped: this.dropped,
    };
  }
}
