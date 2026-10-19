/**
 * types.ts — 共享类型定义，避免循环依赖。
 *
 * 提取位置：parser/jsonParser.ts 与 indexer/lineIndex.ts 互相依赖的类型。
 */

/** 对一行的任意字节区间做随机读的抽象（底层可为文件句柄或内存缓冲区）。 */
export interface ByteReader {
  readBytes(start: number, length: number): Promise<Buffer>;
  close?(): Promise<void>;
}
