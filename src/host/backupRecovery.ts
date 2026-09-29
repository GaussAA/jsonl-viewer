/**
 * backupRecovery.ts — 中断编辑遗留备份的**检测与恢复**（O8）。
 *
 * 背景：变长替换在搬移前会把「被编辑行起点 → EOF」的原始字节备份到
 * `${path}${TAIL_BACKUP_SUFFIX}`，并在搬移前写下元数据旁车 `${path}${TAIL_BACKUP_META_SUFFIX}`
 * （见 fileWriter）。进程崩溃 / 被强杀恰好落在搬移窗口内时，磁盘上会留下一个孤儿备份
 * 加一个改了一半的文件 —— 而查看器此前对它一字不提：用户看见一个不明文件，
 * 既不知道它是什么，也没有任何恢复手段。
 *
 * 三条设计原则（写在代码里，而不只是文档里）：
 *
 *   1. **不自动恢复**。备份可能属于另一个会话、或已被后续外部写入覆盖 —— 保持
 *      「告知 + 显式授权」，与本项目对破坏性操作的一贯态度一致。
 *   2. **不假装能恢复**。恢复要求元数据齐备且与磁盘现状自洽（备份字节数对得上、
 *      当前文件没有比备份起点更短）；任何一项不符就明说「无法自动恢复」，只提供丢弃 ——
 *      半吊子恢复（拼出一个看似正常的坏文件）比不恢复危险得多。
 *   3. 恢复走**与取消回滚同一份**字节搬运实现（`copyRangeFromFile`），不另写一套：
 *      这条路径已经在取消场景下被反复验证过。
 *
 * 仅依赖 `node:fs/promises` 与 fileWriter 的原语，不依赖 `vscode`，可直接用临时文件单测。
 */

import { open, readFile, rm, stat } from 'node:fs/promises';
import { WRITE_BLOCK_SIZE, TAIL_BACKUP_SUFFIX } from '../constants.ts';
import { copyRangeFromFile, tailBackupMetaPath } from './fileWriter.ts';
import type { TailBackupMeta } from './fileWriter.ts';

/** 孤儿备份的检测结果。 */
export interface OrphanBackup {
  /** 备份文件路径（备份内容 = 数据文件自 meta.backupStart 起的原始字节）。 */
  backupPath: string;
  /** 备份文件字节数。 */
  backupBytes: number;
  /** 元数据；缺失或损坏时为 null。 */
  meta: TailBackupMeta | null;
  /** 是否可以自动恢复。 */
  recoverable: boolean;
  /** 不可恢复的原因（可直接展示给用户）；可恢复时缺省。 */
  reason?: string;
}

/** 备份文件路径。 */
export function tailBackupPath(path: string): string {
  return path + TAIL_BACKUP_SUFFIX;
}

/** 元数据字段校验：非负整数且自洽，任何一项不对就当作「没有元数据」。 */
function parseMeta(raw: unknown): TailBackupMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (r.version !== 1) return null;
  if (!num(r.backupStart) || !num(r.backupLen) || !num(r.fileSize)) return null;
  if (r.backupLen === 0) return null;
  // 自洽性：备份区间必须落在原文件之内。
  if (r.backupStart + r.backupLen > r.fileSize) return null;
  return {
    version: 1,
    backupStart: r.backupStart,
    backupLen: r.backupLen,
    fileSize: r.fileSize,
    at: num(r.at) ? r.at : 0,
  };
}

/**
 * 检测是否有中断编辑留下的孤儿备份。
 *
 * @returns null 表示没有（这是绝大多数情况，调用方据此什么都不做）。
 */
export async function inspectOrphanBackup(path: string): Promise<OrphanBackup | null> {
  const backupPath = tailBackupPath(path);
  const info = await stat(backupPath).catch(() => null);
  if (!info || !info.isFile()) return null;
  const backupBytes = info.size;

  let meta: TailBackupMeta | null = null;
  try {
    meta = parseMeta(JSON.parse(await readFile(tailBackupMetaPath(path), 'utf8')));
  } catch {
    meta = null; // 元数据缺失 / 不是 JSON / 字段非法：降级为「只能丢弃」
  }

  if (!meta) {
    return {
      backupPath,
      backupBytes,
      meta: null,
      recoverable: false,
      reason: '缺少（或无法解析）备份元数据，无法确定它从文件的哪个偏移拼回，只能丢弃。',
    };
  }
  if (backupBytes !== meta.backupLen) {
    return {
      backupPath,
      backupBytes,
      meta,
      recoverable: false,
      reason: `备份文件大小（${backupBytes}）与元数据记录（${meta.backupLen}）不符，说明备份本身已被改动，拒绝据此恢复。`,
    };
  }
  const target = await stat(path).catch(() => null);
  if (!target) {
    return {
      backupPath,
      backupBytes,
      meta,
      recoverable: false,
      reason: '目标文件已不存在，无法就地恢复（备份内容仍可用，但需要人工处理）。',
    };
  }
  if (target.size < meta.backupStart) {
    return {
      backupPath,
      backupBytes,
      meta,
      recoverable: false,
      reason: `目标文件当前 ${target.size} 字节，短于备份起点 ${meta.backupStart}，文件已被外部改动，拒绝恢复。`,
    };
  }

  return { backupPath, backupBytes, meta, recoverable: true };
}

/**
 * 就地恢复：把备份字节写回 `[backupStart, backupStart+backupLen)`，并把文件截断回编辑前大小。
 *
 * 之所以能一次到位：备份区间**含被编辑的那一行**（自 range.start 起），所以
 * 「尾部 + 那一行」都在备份里 —— 这是 fileWriter 把备份起点从 `range.end` 前移到
 * `range.start` 的原因。
 */
export async function restoreOrphanBackup(
  path: string
): Promise<{ ok: boolean; error?: string; restoredBytes?: number }> {
  const info = await inspectOrphanBackup(path);
  if (!info) return { ok: false, error: '没有发现可恢复的备份。' };
  if (!info.recoverable || !info.meta) return { ok: false, error: info.reason ?? '无法自动恢复。' };
  const meta = info.meta;

  let fh;
  try {
    fh = await open(path, 'r+');
  } catch (e) {
    return { ok: false, error: `无法打开目标文件：${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    await copyRangeFromFile(
      info.backupPath,
      fh,
      meta.backupStart,
      meta.backupLen,
      WRITE_BLOCK_SIZE
    );
    // 崩溃可能停在「尾部已搬移、截断尚未执行」，文件因此比原大小更长 —— 必须截回。
    await fh.truncate(meta.fileSize);
    // 先落盘再删备份：反过来的话，一旦这里失败就永久失去了原始字节。
    await fh.sync().catch(() => {});
  } catch (e) {
    // 恢复失败：**保留**备份（用户仍可人工处理），并如实告知 —— 绝不假装已恢复。
    return { ok: false, error: `恢复失败：${e instanceof Error ? e.message : String(e)}` };
  } finally {
    await fh.close().catch(() => {});
  }

  await discardOrphanBackup(path);
  return { ok: true, restoredBytes: meta.backupLen };
}

/** 丢弃备份与其元数据（用户显式选择「不用它」）。 */
export async function discardOrphanBackup(path: string): Promise<void> {
  await rm(tailBackupPath(path), { force: true }).catch(() => {});
  await rm(tailBackupMetaPath(path), { force: true }).catch(() => {});
}
