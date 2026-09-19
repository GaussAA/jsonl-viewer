# 发布说明（VSIX 发布流程）

本文档说明如何把 **jsonl-viewer** 打包成 `.vsix` 并安装使用。默认走「本地 VSIX 安装」路径（无需云端账号）；如需发布到 VS Code Marketplace，见[发布到 Marketplace](#发布到-marketplace)。

---

## 1. 前置要求

- **VS Code ≥ 1.100**（或 TRAE 内置 VS Code 1.100+）。扩展宿主（extension host）入口采用 **ESM**，VS Code 1.100 (April 2025) 起正式支持 ESM 扩展入口，低于此版本无法加载扩展。
- **Node.js ≥ 22.18**。本项目全局 `"type": "module"`，`pnpm test` 用 `node --test` 直跑 `.ts` 也依赖 Node 22.18+ 的类型擦除；低于此版本测试会失败。包管理器使用 **pnpm**（本项目统一用 pnpm，不用 npm 安装依赖）。
- 先在项目根目录安装依赖：

  ```bash
  pnpm install
  ```

- `@vscode/vsce` 已列为 devDependency，无需全局安装。

---

## 2. 发布流程（一条龙）

版本号必须以 `package.json` 的 `version` 为**单一事实来源**。整体流程：`改版本号 → typecheck → 构建 → 打包 → 生成校验和 → 打 tag`。

### 2.1 升级版本号

编辑 `package.json`：

```json
"version": "1.0.9"
```

> 约束：每次 `release` 的版本号必须与 `package.json` 一致，否则脚本会报版本不一致并退出。
> 建议：不要为了单个小改动频繁发版——积累一批功能再统一发一个版本。

### 2.2 一键打包

项目提供两个等价脚本（`release` 与 `vsix`），内部调用 `scripts/release.mjs`：

```bash
pnpm release          # 使用 package.json 当前 version
pnpm release 1.0.9    # 显式指定版本（须与 package.json 一致）
```

该脚本依次执行：

| 步骤 | 命令 | 说明 |
|------|------|------|
| 类型检查 | `pnpm typecheck` | `tsc --noEmit`，报错即中断 |
| 构建 | `pnpm build` | `node build.mjs --minify`，产出 `dist/webview.js` 与 `dist/extension.js` |
| 打包 | `npx vsce package` | 生成 VSIX |
| 校验 | `node:sha256` | 写入 `<版本>.vsix.sha256` |
| 版本记录 | — | 更新 `releases/LATEST` |
| 打 tag | `git tag v<版本>` | 打上 `v1.0.x` 标签 |

### 2.3 产物清单

打包完成后，`releases/` 目录下产出：

| 文件 | 说明 |
|------|------|
| `jsonl-viewer-<版本>.vsix` | 可直接安装的 VSIX 安装包 |
| `jsonl-viewer-<版本>.vsix.sha256` | SHA-256 校验和（可追溯产物完整性） |
| `LATEST` | 最新版本号记录 |

> 提示：脚本打包**前**会提示「工作区有未提交改动」并建议先 commit，否则 tag 不会指向本次代码。请先提交代码再打包。

### 2.4 提交与推送

```bash
git add package.json src  # 按实际改动
git commit -m "release: v1.0.9"
git push origin main
git push origin tags/v1.0.6 tags/v1.0.7 tags/v1.0.8 tags/v1.0.9  # 补推/推新 tag
```

---

## 3. 安装 VSIX（本地发布）

### 3.1 手动安装（VS Code）

1. VS Code → 左侧扩展栏（`Ctrl+Shift+X`）。
2. 右上角 `...` → **从 VSIX 安装（Install from VSIX）**。
3. 选择 `releases/jsonl-viewer-<版本>.vsix` → 安装完成。
4. 打开任意 `.jsonl` / `.ndjson` / `.jsonlines` 文件，即进入 JSONL Viewer。

### 3.2 命令行安装

```bash
code --install-extension releases/jsonl-viewer-1.0.9.vsix
```

### 3.3 校验完整性

```powershell
Get-FileHash releases/jsonl-viewer-1.0.9.vsix -Algorithm SHA256
```

核对输出是否与对应 `.sha256` 文件一致（一致可确保安装包未被篡改）。

> 注意（TRAE）：运行中的 TRAE 会锁定扩展目录文件，更新扩展前请**完全退出 TRAE**，否则可能因文件占用导致安装/覆盖失败。

---

## 4. 发布到 Marketplace

VS Code Marketplace 需要拥有 publisher（`jsonl-viewer`）的 **Azure DevOps PAT**，且 PAT 需勾选 **Marketplace → Manage** 权限。

```bash
npx vsce login jsonl-viewer   # 交互式记忆 token
npx vsce publish              # 直接发布当前版本
```

或一次性传入 token：

```bash
npx vsce publish -p <你的PAT>
```

> 若 `verify-pat` 报 `TF400813 not authorized`，说明当前 token 不能代表该 publisher，请重新生成有效 PAT 后重试。

---

## 常见问题

**脚本报「版本不一致」**
`release` 传入的版本与 `package.json` 不一致。先改 `package.json` 的 `version`。

**`releases/<版本>.vsix` 已存在**
脚本拒绝覆盖。删除该文件（及 `.sha256`）后重新运行。

**打包报错 / 目录被占用**
退出 TRAE/VS Code 释放文件锁后重试。