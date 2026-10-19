/**
 * badLineTracker.ts — 坏行集合追踪（DataService 内部使用）。
 *
 * 从 dataService.ts 拆出：它只维护一个行号集合与「是否全量」标记，不依赖 DataService 的其他状态。
 */

import { countLessThan } from './dataServiceHelpers.ts';

/**
 * 坏行集合与「是否已是权威全量」的标记（DataService 私有内部类）。
 *
 * 两条不可混淆的语义（**勿合并**）：
 *   · `lines` 是「**已发现**的坏行」——只覆盖读过/抽样过的范围，随时可增量累积；
 *   · `complete` 是「**已全量扫过**」的结论——只有显式 scanBadLines 成功才置为真，
 *     且文件内容一变就失效（invalidate）。二者必须在前端可区分（BadLinesPayload.partial）。
 */
export class BadLineTracker {
  private readonly lines = new Set<number>();
  private complete = false;

  get size(): number {
    return this.lines.size;
  }
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

  /** 单行插入后的行号平移（在 `at` 行前插入一行，其后所有行 +1）。 */
  shiftAfterInsert(at: number): void {
    const sorted = [...this.lines].toSorted((a, b) => b - a);
    for (const l of sorted) {
      if (l >= at) {
        this.lines.delete(l);
        this.lines.add(l + 1);
      }
    }
  }

  /** 单行删除后的行号平移（删除 `line` 行，其后所有行 -1，被删行本身移除）。 */
  shiftAfterDelete(line: number): void {
    const sorted = [...this.lines].toSorted((a, b) => b - a);
    for (const l of sorted) {
      if (l === line) this.lines.delete(l);
      else if (l > line) {
        this.lines.delete(l);
        this.lines.add(l - 1);
      }
    }
  }

  /** 批量删除后的行号重映射（deleteMany 专用：入参是**删前**行号的已删集合）。 */
  remapAfterDeletes(deleted: ReadonlySet<number>): void {
    const sorted = [...deleted].toSorted((a, b) => a - b);
    const next = new Set<number>();
    for (const l of this.lines) {
      if (deleted.has(l)) continue;
      next.add(l - countLessThan(sorted, l));
    }
    this.lines.clear();
    for (const l of next) this.lines.add(l);
  }

  /** 升序快照（对外载荷用；返回副本，调用方改动不影响内部状态）。 */
  toSortedArray(): number[] {
    return [...this.lines].toSorted((a, b) => a - b);
  }

  /** 清空所有坏行记录并重置完整性标记（reload/dispose 专用）。 */
  reset(): void {
    this.lines.clear();
    this.complete = false;
  }
}
