# Contributing to JSONL Viewer

感谢你对 JSONL Viewer 的关注！本文档说明如何参与项目开发。

## 开发环境

### 前置要求

- **Node.js**: >= 22.18 (推荐使用 Node 22 LTS)
- **pnpm**: >= 9.0.0
- **VS Code**: >= 1.100.0

### 安装依赖

```bash
git clone https://github.com/GaussAA/jsonl-viewer.git
cd jsonl-viewer
pnpm install
```

## 开发流程

### 1. 本地开发

```bash
# 监视模式（自动重新编译）
pnpm watch

# 在 VS Code 中按 F5 启动 Extension Development Host
# 打开任意 .jsonl 文件测试
```

### 2. 运行测试

```bash
# 单元测试
pnpm test

# 类型检查
pnpm typecheck

# 测试覆盖率
pnpm test:coverage

# 代码规范检查
pnpm lint

# 代码格式检查
pnpm format:check
```

### 3. 构建

```bash
# 开发构建（含 sourcemap）
pnpm compile

# 生产构建（minified）
pnpm build
```

### 4. 打包

```bash
# 生成 .vsix 文件
pnpm package
```

## 代码规范

### 代码风格

- 使用 **Prettier** 格式化（自动在 pre-commit 钩子运行）
- 使用 **oxlint** 做静态检查
- 遵循项目现有的 TypeScript 编码风格

### 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Type**:

- `feat`: 新功能
- `fix`: Bug 修复
- `refactor`: 重构（既不修复 bug 也不增加功能）
- `test`: 测试相关
- `chore`: 构建工具、依赖更新等
- `docs`: 文档更新
- `perf`: 性能优化

**示例**:

```
feat(webview): 添加键盘快捷键支持

- Ctrl+F: 打开搜索
- Ctrl+E: 编辑当前记录
- Esc: 关闭面板

Closes #42
```

### 分支策略

- `main`: 主分支，保持稳定
- `feature/*`: 功能分支
- `fix/*`: Bug 修复分支
- `release/*`: 发布分支

## 测试要求

### 新功能

- 必须包含单元测试
- 覆盖率目标：行 > 95%，分支 > 85%，函数 > 90%
- 关键路径必须包含集成测试

### Bug 修复

- 添加回归测试防止问题再次出现
- 在测试中复现 bug，然后修复

### 测试文件位置

- 单元测试：`src/**/__tests__/*.test.ts`
- 集成测试：`src/**/__tests__/*.integration.test.ts`

## 架构概览

```
src/
├── extension.ts          # VS Code 扩展入口
├── host/                 # 宿主（Node.js）侧逻辑
│   ├── dataService.ts    # 数据服务（CRUD、历史管理）
│   ├── indexHost.ts      # 索引管理
│   ├── searchEngine.ts   # 全文搜索
│   └── profileEngine.ts  # 字段分析
├── webview/              # Webview（浏览器）侧 UI
│   ├── webviewEntry.ts   # Webview 入口
│   ├── toolbar.ts        # 工具栏
│   ├── recordList.ts     # 记录列表（虚拟滚动）
│   └── detailTree.ts     # JSON 树视图
├── indexer/              # 索引构建
│   └── lineIndex.ts      # 稀疏检查点索引
├── parser/               # JSON 解析
│   ├── jsonParser.ts     # 按需解析
│   └── types.ts          # 共享类型
├── protocol/             # RPC 协议
│   └── rpc.ts            # Host ↔ Webview 通信
└── core/                 # 核心工具
    └── jsonSpan.ts       # JSON 路径定位
```

### 关键设计原则

1. **按需加载**: 只解析可见区域的记录（虚拟滚动）
2. **稀疏索引**: 每 1024 行一个检查点，支持大文件（GB 级）
3. **RPC 通信**: Host 和 Webview 通过消息传递（见 `protocol/rpc.ts`）
4. **不可变历史**: 操作历史基于快照和 delta，支持撤销/重做

## 常见问题

### Q: 如何调试 Webview？

A: 在 Extension Development Host 中，打开 JSONL 文件后：

1. 按 `Ctrl+Shift+P`
2. 运行 "Developer: Open Webview Developer Tools"

### Q: 如何调试 Extension Host？

A: VS Code 自动附加调试器，直接在 `.ts` 文件打断点即可。

### Q: 如何测试大文件性能？

A: 使用 `samples/generate_samples.py` 生成测试数据：

```bash
python samples/generate_samples.py --lines 1000000 --output test.jsonl
```

### Q: Pre-commit 钩子失败怎么办？

A: 先运行 `pnpm format` 修复格式问题，再重新提交。

## 发布流程（维护者）

1. 更新版本号：`package.json`
2. 提交：`git commit -m "chore: bump version to x.y.z"`
3. 打标签：`git tag vx.y.z`
4. 推送：`git push && git push origin vx.y.z`
5. Release workflow 自动构建并上传 VSIX 到 GitHub Actions artifacts
6. （可选）配置 `VSCE_PAT` secret 后自动发布到 VS Code Marketplace

## 获取帮助

- 提 Issue: https://github.com/GaussAA/jsonl-viewer/issues
- 查看现有 PR 了解贡献方式

## License

本项目使用 ISC License。提交代码即表示你同意将代码以该协议授权。
