# 错误台账（error_ledger）

> 格式：`[现象] → [根因] → [正解]`。凡连续 ≥2 次调试的顽固 Bug、或「发布/破坏性链路」
> 上的一次性事故，均在此沉淀。修复前先查此文件，禁盲写。

---

## [发布半途失败：vsce 拒绝打包] → [@types/vscode 版本漂移超出 engines.vscode] → [锁类型包回引擎版本，而非抬引擎线]

- **现象**：`node scripts/release.mjs` 在 `vsce package` 一步失败：
  `@types/vscode ^1.138.0 greater than engines.vscode ^1.100.0`。typecheck/tsc 全绿，
  问题只在打包时暴露。
- **根因**：依赖漂移。某次「同步依赖声明与实际安装版本」把 @types/vscode 一并升到
  1.138；tsc 不校验「类型包与引擎声明的一致性」，于是平时毫无症状。
- **正解**：`pnpm add -D @types/vscode@~1.100.0` 锁回引擎版本。**不要升 engines.vscode**
  —— `^1.100` 是 ESM 扩展入口的最低要求（RELEASE.md §1），抬高会无谓排除旧宿主用户；
  类型包降级反而更安全（不允许引用运行时可能不存在的 API）。降级后 tsc 全绿即佐证。
- **预防**：release.mjs 每次都会走 vsce，但依赖升级后若不发布就发现不了。可考虑在
  CI 加一步 `npx vsce ls`（不打包、只校验清单一致性），让漂移在提交时就暴露。
  （2026-09-24，v1.8.0 发布时）

---

## [发布在最后一步失败：spawnSync cmd.exe EBUSY] → [Windows 瞬时资源占用打断 git status] → [核对产物完整性后手动补 tag]

- **现象**：release.mjs 跑完 typecheck/test/build/vsce/sha256/LATEST 后，在
  `git status --porcelain`（58 行）抛 `spawnSync cmd.exe EBUSY (errno -4082)`，
  退出码 1 —— **tag 还没打**。
- **根因**：Windows 下 cmd.exe 被瞬时占用（常为杀软/索引服务扫描刚生成的大文件，
  此刻恰是 5MB vsix 落盘后一秒内）。脚本对这一步无重试。
- **正解**：产物本身已完整（vsix + sha256 + LATEST 都在），只差 tag。核对
  `ls releases/ | grep <ver>` 与 `cat releases/LATEST` 后，手动 `git tag v<version>`
  并 `sha256sum -c` 校验即可；不必重跑整个发布（重跑会因「vsix 已存在」被脚本拒绝）。
- **预防**：~~遇到 release.mjs 中途失败，先核对产物清单再决定重跑还是续尾~~
  **已治本（2026-09-25）**：`release.mjs` 的所有命令执行统一走 `execWithRetry`——
  EBUSY 自动等 1 秒重试（至多 3 次），非 EBUSY 错误照常抛出。三个版本连续在同一
  位置手工续尾后，不能再靠人肉兜底。（2026-09-24 首记，2026-09-25 修复）
