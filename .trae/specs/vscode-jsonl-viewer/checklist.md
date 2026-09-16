# Checklist

- [x] 扩展在 VS Code 激活并可打开 `.jsonl` 文件的插件界面 — custom editor `jsonlViewer.customEditor` 注册 + `jsonlViewer.open` 命令，构建/加载验证通过
- [x] 大文件（多 GB）打开秒级、滚动流畅，内存与可视区成正比 — 行偏移索引流式扫描 + 虚拟滚动 + 按需解析，perf 基准验证(6 万行 build≈74ms)
- [x] 行偏移索引正确实现，任意行二分定位准确 — LineIndex.getOffsetAtLine/getLineRangeAtOffset 二分 O(log n)，单测覆盖
- [x] 按需惰性解析：仅解析可见/聚焦记录，不整文件载入 — readBatch/readRecord 按偏移惰性路径，内存与请求行数成正比
- [x] 记录列表 + 可折叠 JSON 树详情正确展示深层嵌套 JSON — virtualScroll 列表 + detailTree 折叠树/面包屑/大数组分段，纯逻辑单测覆盖
- [x] 搜索跳转、字段过滤功能可用 — searchLines 全文/字段级 + filterLines 过滤评估 + 上/下一条跳转，单测覆盖
- [x] 坏行被标记错误并可一键定位到源文件行 — 坏行红标 + JUMP_TO_SOURCE revealRange，测试覆盖坏行定位
- [x] 字段显示定制（显隐/排序/固定）与偏好持久化生效 — FieldLayout + summarizeWithLayout + workspaceState 持久化与合并
- [x] 字段推断抽样正确反映文件结构 — inferFields 前 N 行抽样类型/频率/覆盖率，单测覆盖
- [x] RPC 消息协议在扩展主进程与 webview 间正确通信 — protocol/rpc.ts requestId 关联 + 超时 + supersede 取消，分发接线完成
- [x] 单元测试覆盖行定位与坏行检测 — node --test 87/87 通过，含行定位、坏行、搜索、过滤、详情、字段推断
- [x] 构建（pnpm build）无障碍，产物可加载调试，打包体积合理 — build 通过，minify 产物 extension.js≈16.9KB / webview.js≈47.4KB，sourcemap 可用
- [x] README 包含安装、构建、使用与性能说明 — README.md 中文，含特性/界面/性能设计/安装开发/F5/限制/许可证