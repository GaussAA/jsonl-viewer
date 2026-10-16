# Changelog

All notable changes to the JSONL Viewer extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.11.1] - 2026-10-16

### Fixed

- **Critical**: CSS 必须内联进 webview.js，修复 v1.11.0 界面无样式问题
  - 原因：esbuild 默认 CSS loader 将样式抽成独立文件，webview 未加载
  - 解决：build.mjs 添加 `loader: { '.css': 'text' }` 强制内联
  - 守卫：dist-product.test.ts 静态检查防止回归
- 历史 ID 改用单调递增序列，避免同毫秒编辑产生重复 ID

### Changed

- 解耦 lineIndex.ts ↔ jsonParser.ts 循环依赖，提取 ByteReader 到 types.ts
- 修复 dataService.ts 变量 shadowing 警告
- Release workflow 添加产物验证步骤

### Updated

- @types/node: 26.6.4 → 26.6.5
- prettier: 3.9.9 → 3.9.10
- oxlint: 1.87.0 → 1.88.0

## [1.11.0] - 2026-10-13

### Fixed

- toolbar 测试用例改用真实定时器，避免 CI 事件循环提前退出
- focusTrap 排除 `tabindex="-1"` 元素，修复焦点陷阱选择器缺陷
- 覆盖率脚本补充 CSS loader 支持

### Added

- detailTree 键盘导航测试用例（方向键/Home/End/Enter/Space）
- focusTrap 完整单元测试（11 个用例，100% 覆盖率）

### Changed

- CSS 抽离为独立文件并配置 stylelint（后在 1.11.1 回退为内联）

## [1.10.1] - 2026-10-12

### Added

- 浅色主题完整适配，替换所有硬编码颜色值
- 右键菜单 ARIA 化和键盘导航支持
- 树导航和抽屉可访问性增强

### Fixed

- 样式缺陷修复并增强可访问性
- PanelCoordinator 时序导致的焦点管理测试失败

### Performance

- LineIndex.build 性能优化（3 次迭代）
  - Iteration 2: 紧凑 4x 展开字符串跳过循环
  - Iteration 3: 表驱动外层跳过非结构字节（1.499 → 1.616）
  - Iteration 5: 对齐 Uint32 haszero 字循环（1.623 → 1.82）

### Refactored

- 提取 PanelCoordinator（部分完成）
- 合并 BadLineTracker 到 DataService
- DataService 迁移使用 EditSession 接口
- 扩展 EditHistory 为 EditSession 风格接口

### Added

- 「跟随末尾」开关与自动滚动功能

## [1.10.0] - 2026-09-30

### Added

- 虚拟滚动支持，可处理 GB 级大文件
- 稀疏检查点索引（每 1024 行一个检查点）
- 按需惰性解析，仅解析可视区域记录
- JSON 树形视图，支持折叠/展开
- 全文搜索功能
- 字段分析和 Profile 视图
- 记录编辑功能（添加、删除、修改）
- 撤销/重做支持
- 备份与恢复机制

### Technical

- TypeScript 严格模式
- 测试覆盖率 > 96%
- Node.js 原生测试框架
- esbuild 构建工具链

## [Unreleased]

### Planned

- VS Code Marketplace 发布（需配置 VSCE_PAT）
- 性能监控和优化
- 更多键盘快捷键
- 导出功能增强

---

## 版本号说明

- **Major (x.0.0)**: 破坏性变更或重大架构调整
- **Minor (1.x.0)**: 新功能添加，向后兼容
- **Patch (1.11.x)**: Bug 修复和小改进

[1.11.1]: https://github.com/GaussAA/jsonl-viewer/compare/v1.11.0...v1.11.1
[1.11.0]: https://github.com/GaussAA/jsonl-viewer/compare/v1.10.1...v1.11.0
[1.10.1]: https://github.com/GaussAA/jsonl-viewer/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/GaussAA/jsonl-viewer/releases/tag/v1.10.0
