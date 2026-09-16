@echo off
REM ============================================================
REM  install.cmd — 安装 JSONL Viewer 并修复 TRAE 的清单缺陷。
REM
REM  用法：
REM    scripts\install.cmd               -> 安装 releases\LATEST 标记的最新版
REM    scripts\install.cmd 1.0.4         -> 安装指定版本 jsonl-viewer-1.0.4.vsix
REM
REM  说明：
REM    1) 依赖 releases\jsonl-viewer-<版本>.vsix（由 scripts\release.mjs 生成）；
REM    2) TRAE 安装器会给清单写入非法 targetPlatform "undefined"，导致其自扫失败、
REM       扩展无法加载。本脚本在安装后把该字段修复为 win32-x64；
REM    3) 建议在完全关闭 TRAE 后运行，装完重启 TRAE 生效。
REM ============================================================

setlocal

set "ROOT=%~dp0.."
set "CLI=%LOCALAPPDATA%\Programs\TRAE SOLO CN\bin\trae-solo-cn.cmd"

if not "%~1"=="" (
  set "VER=%~1"
) else (
  if not exist "%ROOT%\releases\LATEST" ( echo [install] 缺少 releases\LATEST，请先运行 release 脚本 & exit /b 1 )
  set /p VER=<"%ROOT%\releases\LATEST"
)

set "VSIX=%ROOT%\releases\jsonl-viewer-%VER%.vsix"
if not exist "%VSIX%" (
  echo [install] 未找到产物: %VSIX%
  echo [install] 请先用 scripts\release.mjs 发布，或改用 install.cmd 完整版本号。
  exit /b 1
)

echo [1/3] 安装: %VSIX%
call "%CLI%" --install-extension "%VSIX%" >nul 2>&1

echo [2/3] 修复 manifest targetPlatform（TRAE 安装器缺陷 -> win32-x64）...
set "MANIFEST=%USERPROFILE%\.trae-cn\extensions\jsonl-viewer.jsonl-viewer-%VER%\package.json"
if exist "%MANIFEST%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$p='%MANIFEST%'; $c=[IO.File]::ReadAllText($p); $n=[regex]::Replace($c,'\"targetPlatform\"\s*:\s*\"undefined\"','\"targetPlatform\":\"win32-x64\"'); if($n -ne $c){[IO.File]::WriteAllText($p,$n); Write-Host '  已修复'} else {Write-Host '  无需修复'}"
) else (
  echo [2/3] 未找到清单（安装可能失败），跳过修复。
)

echo [3/3] 完成：版本 %VER% 已安装。请完全重启 TRAE 生效。
endlocal