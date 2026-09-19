/**
 * constants.ts — 全库统一常量。
 *
 * 把散落在各模块的硬编码数字集中到此，方便调优和文档化。
 * 分四类：宿主 IO、协议超时、webview 交互、索引行为。
 */

/* ---------------------- 宿主 IO / 解析 ---------------------- */

/** lineIndex.build 流式读取的 chunk 大小（每次从磁盘读多少字节）。1MB。 */
export const INDEX_CHUNK_SIZE = 1024 * 1024;

/** lineIndex.build 进度报告间隔（多少字节打印一次构建进度）。4MB。 */
export const INDEX_REPORT_INTERVAL = 4 * 1024 * 1024;

/** 单行最大字节数保护阈值——超过即拒绝（防止 OOM 被单行大 JSON 打爆）。默认 16MB。 */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/* ---------------------- 协议 & 搜索 ---------------------- */

/** webview → host RPC 默认超时。 */
export const RPC_TIMEOUT_MS = 15_000;

/** 文件 stale 检测触发后，自动 reload 的 debounce 窗口。 */
export const FILE_STALE_DEBOUNCE_MS = 1_000;

/** 全文/字段搜索每扫描多少行 yield 一次，避免阻塞事件循环。 */
export const SEARCH_SCAN_EVERY = 256;

/** 搜索 / 过滤结果硬上限（超过即截断并标记 truncated=true）。 */
export const SEARCH_MAX_RESULTS = 50_000;

/** 过滤结果硬上限——与搜索相同（统一 5 万阈值）。 */
export const FILTER_MAX_RESULTS = 50_000;

/* ---------------------- webview 交互 ---------------------- */

/** 宿主 INIT 消息超时未收到，提示用户"连接中…"超时降级。 */
export const INIT_TIMEOUT_MS = 8_000;

/** 分页每页条目数。 */
export const PAGE_SIZE = 20;

/** 字段抽样上限（getSampleFields 扫描前 N 行推断字段集合）。 */
export const SAMPLE_SCAN_LINES = 1_000;

/** 统计芯片 maxKeys 默认值（卡片式摘要默认展示多少个字段）。 */
export const DEFAULT_MAX_KEYS = 4;

/* ---------------------- 页面尺寸 ---------------------- */

/** 窄屏断点——左右两栏布局自动切成纵向堆叠。 */
export const NARROW_BREAKPOINT_PX = 700;
