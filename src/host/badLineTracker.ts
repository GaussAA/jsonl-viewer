/**
 * badLineTracker.ts — 坏行集合与「是否已是权威全量」的标记（从 dataService 抽出）。
 *
 * 为何值得独立成模块：
 *   1. 它是**纯状态集合**——只有「哪些行是坏的」「是否已全量扫过」两件事，不含任何 IO，
 *      与 `EditHistory` 同性质（同属"从 DataService 抽出的状态机"，不违背
 *      `ARCHITECTURE_REVIEW.md` 的 B2「不拆 Service」决策）；
 *   2. **行号位移**是本模块最容易出错的地方：单行增删、批量删除各有各的位移规则，
 *      而位移算错的表现是「红标指向了别的行」——用户据此删行会删错。独立成模块后
 *      可以脱离文件系统直接把这些规则钉死在测试里。
 *
 * 两条不可混淆的语义（**勿合并**）：
 *   · `lines` 是「**已发现**的坏行」——只覆盖读过/抽样过的范围，随时可增量累积；
 *   · `complete` 是「**已全量扫过**」的结论——只在 `scanBadLines` 成功后为真，
 *     且一旦文件内容变化（本进程写入 / 重建索引 / 外部改动）立刻降级。
 *   把前者当后者用，在数据清洗场景会得出**相反**的结论（「文件挺干净」）。
 *
 * 降级纪律：内容变化时**只降级 `complete`，不清空 `lines`** —— 已发现的坏行行号
 * 已随位移规则同步维护，贸然清空等于把用户的排查进度丢掉。
 */

export class BadLineTracker {
  private readonly lines = new Set<number>();
  private complete = false;

  /** 已发现的坏行数。 */
  get size(): number {
    return this.lines.size;
  }

  /** 是否已是全文件权威结论（最近一次全量扫描成功、且之后内容未变）。 */
  get isComplete(): boolean {
    return this.complete;
  }

  has(line: number): boolean {
    return this.lines.has(line);
  }

  add(line: number): void {
    this.lines.add(line);
  }

  addMany(lines: Iterable<number>): void {
    for (const l of lines) this.lines.add(l);
  }

  delete(line: number): void {
    this.lines.delete(line);
  }

  deleteMany(lines: Iterable<number>): void {
    for (const l of lines) this.lines.delete(l);
  }

  /**
   * 全量扫描成功：**整体替换**为权威结果并置 `complete`。
   *
   * 必须替换而非合并：合并会让「已被改好的行」永远留在列表里 —— 用户改好一行后
   * 重新扫描，看到它仍在坏行列表里，会以为修改没生效。
   */
  replaceAll(lines: Iterable<number>): void {
    this.lines.clear();
    for (const l of lines) this.lines.add(l);
    this.complete = true;
  }

  /** 文件内容已变：「全量」结论失去依据 → 只降级标记，**保留**已发现列表。 */
  invalidate(): void {
    this.complete = false;
  }

  /** 整体作废（reload / dispose / 重建索引：行号与内容都已面目全非）。 */
  reset(): void {
    this.lines.clear();
    this.complete = false;
  }

  /** 删除第 `removedLine` 行之后：其后所有行号**前移一位**，该行本身丢弃。 */
  shiftAfterDelete(removedLine: number): void {
    const next = new Set<number>();
    for (const l of this.lines) {
      if (l < removedLine) next.add(l);
      else if (l > removedLine) next.add(l - 1);
      // l === removedLine：该行已不存在，丢弃
    }
    this.lines.clear();
    for (const l of next) this.lines.add(l);
  }

  /** 在第 `at` 行**之前**插入一行之后：`at` 及其后所有行号**后移一位**。 */
  shiftAfterInsert(at: number): void {
    const next = new Set<number>();
    for (const l of this.lines) next.add(l >= at ? l + 1 : l);
    this.lines.clear();
    for (const l of next) this.lines.add(l);
  }

  /**
   * 批量删除后重映射行号。
   *
   * 逐次调用 `shiftAfterDelete` 是 O(删除数 × 坏行数)；此处对每个坏行二分统计
   * 「它之前被删了几行」，降到 O((坏行数 + 删除数) log 删除数)。
   */
  remapAfterDeletes(deleted: ReadonlySet<number>): void {
    if (this.lines.size === 0) return;
    const sorted = [...deleted].toSorted((a, b) => a - b);
    const next = new Set<number>();
    for (const l of this.lines) {
      if (deleted.has(l)) continue; // 该行已删除，丢弃
      next.add(l - countLessThan(sorted, l));
    }
    this.lines.clear();
    for (const l of next) this.lines.add(l);
  }

  /** 升序快照（对外载荷用；返回副本，调用方改动不影响内部状态）。 */
  toSortedArray(): number[] {
    return [...this.lines].toSorted((a, b) => a - b);
  }
}

/**
 * 有序数组中严格小于 `x` 的元素个数（二分）。
 *
 * 与 `dataService.ts` 内的同名工具算法一致，但**刻意不复用**：让本模块保持零依赖，
 * 不被任何上层实现细节牵动。
 */
function countLessThan(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
