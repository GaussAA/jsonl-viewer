/**
 * appState.ts — 前端应用状态的定义与初始工厂（从 webviewEntry 抽出）。
 *
 * 为何先把它独立出来：
 *   1. 它是**多域共享**的单一状态对象；定义嵌在 1700 行的装配层里，任何想按域拆分
 *      的模块都拿不到类型，只能把逻辑留在 main() 内 —— 这是装配层无法变小的根因；
 *   2. 独立成模块后，「状态长什么样」与「谁在改它」解耦，各域模块只需声明自己读写
 *      哪几个字段（沿用 persistence / queryActions 已有的「子集接口」风格）；
 *   3. 它是后续引入 store（不可变更新 + subscribe）的地基 —— 届时只需改本文件的
 *      访问方式，调用方不必重写。
 *
 * 契约（**勿破坏**）：
 *   - `cache` 是有界 LRU，逐出即释放底层值对象（内存只与可视区成正比）；
 *   - `filterMap` 为 null = 全量视图；非 null 时它是「展示位 → 真实行号」的映射；
 *   - `detailRaw` 是磁盘原文，字段级编辑与乐观锁都依赖它。
 */

import { LRUCache } from './logic.ts';
import type { FieldLike } from './logic.ts';
import type { RecordEntry } from './virtualScroll.ts';
import type { Condition, FieldLayout } from './queryLogic.ts';
import type { OverviewPayload } from '../protocol/rpc.ts';

/** 渲染用的记录形状（与 LRUCache 值一致）。 */
export type CachedRecord = RecordEntry & { value?: unknown };

/** 记录缓存容量上限（可视区 + overscan 的常数倍；逐出即释放内存）。 */
export const CACHE_MAX_ENTRIES = 600;

export interface AppState {
  overview: OverviewPayload | null;
  /** 行号 -> 记录（LRU，容量受限，逐出即释放底层值对象）。 */
  cache: LRUCache<number, CachedRecord>;
  /** 正被在途请求覆盖的行号，避免对同一缺失窗口重复发射。 */
  pending: Set<number>;
  /** 当前在途 readRecords 的 supersede 标记。 */
  inFlight: { rid: string; superseded: boolean } | null;
  fields: readonly FieldLike[] | null;
  /** 字段显示定制布局（驱动摘要卡片）。 */
  fieldLayout: FieldLayout;
  /** 已解析到的最大行号（概要栏「已解析」）。 */
  maxLoaded: number;
  selectedLine: number | undefined;
  /** 当前在途 readRecord（详情）请求的 supersede 标记，切换选中行时取消。 */
  detailInFlight: { rid: string } | null;
  /**
   * 当前详情所展示行的**磁盘原文**与字节数。
   *
   * 字段级编辑必须在原文里定位并只替换目标值那一段（不能用解析后的值重新序列化 ——
   * 那会重排用户的键序与空白）。`bytes` 同时用作编辑请求的乐观锁断言。
   */
  detailRaw: { text: string; bytes: number } | null;

  /* 搜索 / 过滤 / 持久化 */
  searchQuery: string;
  /** 最近一次搜索结果匹配的真实行号（升序）。 */
  searchMatches: number[];
  /** 是否因 host 截断尚有未列出的匹配（不影响 ±1 导航，仅提示）。 */
  searchTruncated: boolean;
  searchInFlight: { rid: string; superseded: boolean } | null;
  /** 过滤态：展示位 -> 真实行号；null = 全量。 */
  filterMap: number[] | null;
  filterCond: Condition | null;
  filterInFlight: { rid: string; superseded: boolean } | null;
  /** 偏好持久化键（jsonlViewer.state.<uri>）；init 后赋值。 */
  persistKey: string | null;
  persistTimer: ReturnType<typeof setTimeout> | undefined;
}

/** 初始状态（每次挂载一个全新实例 —— 状态绝不跨实例共享）。 */
export function createAppState(): AppState {
  return {
    overview: null,
    cache: new LRUCache<number, CachedRecord>(CACHE_MAX_ENTRIES),
    pending: new Set(),
    inFlight: null,
    fields: null,
    fieldLayout: { pinned: [], order: [], hidden: [], maxKeys: 4 },
    maxLoaded: 0,
    selectedLine: undefined,
    detailInFlight: null,
    detailRaw: null,
    searchQuery: '',
    searchMatches: [],
    searchTruncated: false,
    searchInFlight: null,
    filterMap: null,
    filterCond: null,
    filterInFlight: null,
    persistKey: null,
    persistTimer: undefined,
  };
}

/**
 * 乐观锁的「调用方一侧」载荷：本视图当前看到的行数。
 *
 * 为什么必须由调用方给出：宿主侧的 size/mtime 冲突检测只能发现**外部程序**改了文件；
 * 而「同一个文件被两个视图打开」时，A 视图写完后宿主基线会刷新，B 视图的界面却仍是
 * 旧行号 —— 在宿主看来文件一切正常，B 视图发来的行号却已经不是它以为的那一行。
 * 把「我看到多少行」随写请求一起送过去，宿主就能拒掉这类陈旧视图的写入（宁可让用户
 * 重新加载，也不要改错行）。没有概览（尚未加载完）时不带该字段：不阻塞正常编辑。
 */
export function viewBaseline(state: Pick<AppState, 'overview'>): { expectedTotalLines?: number } {
  const n = state.overview?.totalLines;
  return n == null ? {} : { expectedTotalLines: n };
}
