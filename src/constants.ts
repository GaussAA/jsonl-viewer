/**
 * constants.ts — 全库统一常量。
 *
 * 把散落在各模块的硬编码数字集中到此，方便调优和文档化。
 * 分四类：宿主 IO、协议超时、webview 交互、索引行为。
 */

/* ---------------------- 宿主 IO / 解析 ---------------------- */

/** lineIndex.build 流式读取的 chunk 大小（每次从磁盘读多少字节）。1MB。 */
export const INDEX_CHUNK_SIZE = 1024 * 1024;

/** 稀疏检查点索引：每多少行记录一个 {line, offset} 检查点（默认 1024）。
 *  索引内存从全量「8B/行」降到约「16B/检查点」，极短行（数千万行）场景也能装下。 */
export const INDEX_CHECKPOINT_INTERVAL = 1024;

/** scan 顺序扫描时每次从磁盘补读的字节块大小（1MB）。 */
export const SCAN_CHUNK_SIZE = 1024 * 1024;

/** lineIndex.build 进度报告间隔（多少字节打印一次构建进度）。4MB。 */
export const INDEX_REPORT_INTERVAL = 4 * 1024 * 1024;

/** 单行最大字节数保护阈值——超过即拒绝（防止 OOM 被单行大 JSON 打爆）。默认 16MB。 */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** 列表态（readRecords）内联完整值的字节阈值；超过则截断为「有界摘要 + truncated」，
 *  完整值仍由 readRecord 按详情需求拉取。默认 256KB——典型可视窗口（≤600 行）即便全为
 *  临界行也仅 ~150MB 瞬时峰值，且 webview 缓存只持有有界摘要，不再整条巨物驻留。 */
export const RECORD_INLINE_MAX_BYTES = 256 * 1024;

/* ---------------------- 就地写入（编辑能力） ---------------------- */

/** 就地写入时，尾部搬移与尾部备份的分块大小（4MB）—— 保证搬移期内存恒定有界。 */
export const WRITE_BLOCK_SIZE = 4 * 1024 * 1024;

/** 变长替换（Δ ≠ 0）时可备份的尾部字节上限（64MB）。
 *  搬移前会把尾部数据备份到 sidecar；超过该值则拒绝执行（不以 GB 级备份换安全）。 */
export const MAX_TAIL_BACKUP_BYTES = 64 * 1024 * 1024;

/** 尾部备份 sidecar 的后缀（搬移成功即删除；失败时保留以供恢复）。 */
export const TAIL_BACKUP_SUFFIX = '.jlv-tail-bak';

/**
 * 批量重写（查找替换）的文件大小上限：1GB。
 *
 * 批量替换走「写同目录临时文件 + 原子 rename」，临时空间需求**等于文件大小**。
 * 超过此值拒绝执行并提示改用单行编辑 —— 为一次替换索要 GB 级临时空间不是合理的默认行为。
 * （不做逐行倒序搬移的降级路径：那需要 N 次随机搬移，成本 Σ(改动点距 EOF)，
 *  命中行分散时反而远慢于一次顺序重写，且丧失原子性。）
 */
export const MAX_BATCH_REWRITE_BYTES = 1024 * 1024 * 1024;

/** 批量重写临时文件后缀。必须与原文件**同目录**——跨分区 rename 不具原子性。 */
export const REWRITE_TEMP_SUFFIX = '.jlv-rewrite-tmp';

/**
 * 写操作进度上报的节流间隔（毫秒）。
 *
 * 底层按 4MB 分块回调，1GB 文件会产生 250 次 —— 每次都 postMessage 是没有意义的
 * IPC 压力（webview 渲染不过来，用户也看不出差别）。终态（processed === total）不节流，
 * 保证进度条能走到 100%。
 */
export const PROGRESS_THROTTLE_MS = 100;

/** 批量重写的估算有效吞吐（字节/毫秒），用于给用户预估耗时。100MB/s。 */
export const REWRITE_THROUGHPUT_BYTES_PER_MS = (100 * 1024 * 1024) / 1000;

/**
 * 「全部替换」纳入撤销栈的上限：2000 行 / 8MB。
 *
 * 撤销栈要保存每一行的前后文本，超大替换会把宿主内存与 webview 消息通道一起撑爆。
 * 超限时替换照常执行，但**如实告知用户「本次未纳入撤销栈」**——
 * 静默丢弃撤销能力比不做撤销更危险。
 */
export const MAX_REPLACE_UNDO_LINES = 2_000;
export const MAX_REPLACE_UNDO_BYTES = 8 * 1024 * 1024;

/* ---------------------- 协议 & 搜索 ---------------------- */

/** webview → host RPC 默认超时（轻量请求：偏好读写、跳转源码等）。 */
export const RPC_TIMEOUT_MS = 15_000;

/**
 * 重活请求超时：会**等待索引构建**或**全文件流式扫描**的请求
 * （getOverview / readRecords / readRecord / getSampleFields / reload / search / filter）。
 *
 * 为何必须与轻量请求分开：实测索引构建约 1ms/MB，10GB 文件约 11s，慢盘可再慢数倍。
 * 若沿用 15s，用户会在**一切正常**的情况下收到「请求超时」，把正常误报成故障。
 * 这些请求均可被 supersede 取消，故放大上限不会造成不可中断的卡死。
 */
export const RPC_HEAVY_TIMEOUT_MS = 120_000;

/** 文件陈旧（被改/被删）检测的轮询间隔。 */
export const FILE_STALE_POLL_MS = 5_000;

/** 全文/字段搜索每扫描多少行 yield 一次，避免阻塞事件循环。 */
export const SEARCH_SCAN_EVERY = 256;

/** 搜索 / 过滤结果硬上限（超过即截断并标记 truncated=true）。 */
export const SEARCH_MAX_RESULTS = 50_000;

/** 过滤结果硬上限——与搜索相同（统一 5 万阈值）。 */
export const FILTER_MAX_RESULTS = 50_000;

/** 单次 readRecords 的行数硬上限（协议层防护）。
 *  webview 正常只请求一页（PAGE_SIZE=20）；此上限用于防御**异常输入或未来改动**
 *  一次拉取整个文件——那会让宿主一次性解析并 postMessage 序列化数十万行，打满内存。 */
export const RECORDS_MAX_COUNT = 2_000;

/* ---------------------- webview 交互 ---------------------- */

/** 宿主 INIT 消息超时未收到，提示用户"连接中…"超时降级。 */
export const INIT_TIMEOUT_MS = 8_000;

/** 分页每页条目数。 */
export const PAGE_SIZE = 20;

/** 字段抽样推断的默认扫描行数（可被 `jsonlViewer.sampleLines` 配置或调用方参数覆盖）。 */
export const SAMPLE_SCAN_LINES = 200;

/** 统计芯片 maxKeys 默认值（卡片式摘要默认展示多少个字段）。 */
export const DEFAULT_MAX_KEYS = 4;

/* ---------------------- 页面尺寸 ---------------------- */

/** 窄屏断点——左右两栏布局自动切成纵向堆叠。 */
export const NARROW_BREAKPOINT_PX = 700;
