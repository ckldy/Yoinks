# UMP 组件检测与一键安装 — 设计（2026-08-03）

## 背景

1.6.10 的 YouTube UMP 优先下载依赖 `yt-dlp-ytse==0.4.3` + `protobug==1.0.0`（AppGroup site-packages），
且需要 6 处兼容补丁（yt-dlp 2026.07.04 API 变化 + 稳定 `-ump` 后缀 + 插件导出）。
补丁在 site-packages 内，不在仓库，用户从 GitHub 安装发布版后 UMP 功能不完整且无提示。

## 目标（用户已确认）

设置页「工具与登录」新增 **UMP 组件** 状态行 + 安装/修复按钮，对齐 yt-dlp 现有模式：

- 状态：`UMP 组件 0.4.3 · 就绪` / `UMP 组件：未安装` / `UMP 组件：补丁缺失`
- 未安装 →「安装」：pip 装 yt-dlp-ytse==0.4.3 + protobug==1.0.0（--trusted-host）→ 自动打补丁 → 重新检测
- 已装缺补丁 →「修复补丁」：只补缺失项（幂等）
- 「检查下载引擎」同时刷新 yt-dlp 与 UMP 组件

## 补丁清单（site-packages/yt_dlp_plugins/extractor/）

| 文件 | 补丁 | 检测标记 |
|---|---|---|
| ytse.py | PO_TOKEN 别名（_video 块内 INITIAL→FETCH_GVS + 别名行） | `STREAMING_DATA_FETCH_GVS_PO_TOKEN` + 别名行 |
| ytse.py | `_list_formats` 5→4 值（调用处/解包/return 三处） | `live_status, formats, _ = self._list_formats` + 4 值 return |
| ytse.py | UMP 副本稳定 `-ump` 后缀 | `format_copy['format_id'] = f"{f.get('format_id')}-ump"` |
| ytse.py | 插件导出 `__all__ = ['YTSE']; YTSE = _YTSE` | `__all__ = ['YTSE']` |
| _ytse/sabr.py | `traverse_obj` import 改 `yt_dlp.utils` | `from yt_dlp.utils import traverse_obj` |
| _ytse/downloader/ump.py | 同上 | 同上 |

## 实现

1. **`python/patch_ytse.py`**（新文件，随仓库发布）：`check`（JSON 状态）/ `patch`（幂等）。
   保守失败：替换不匹配（版本升级/形态变化）→ 输出 error，不写文件。
2. **`services/media.ts`**：`ToolStatus` 扩展 `ytseVersion/ytsePatched/ytseMissing`；
   `getToolStatus()` 追加 `python3 patch_ytse.py check` 解析；新增 `installYtseComponent()`
   （pip install + patch + check 验证，日志 tools.* 对齐现有事件）。
3. **`index.tsx`**：设置页「工具与登录」新增 HStack 状态行 + 按钮（复用 installing 模式）；
   UMP 优先开关下补提示文案（组件未就绪时显示「需先安装 UMP 组件」）。

## 验证

- patch_ytse.py：临时副本「撤销补丁→patch→check 全绿→再 patch 幂等」测试
- 真实环境 check 输出；TypeScript 项目诊断；`scripting-ts project "Yoinks"` 启动回归
- 真机：设置页状态行/安装按钮点验

## 非目标

- 不改下载链路（UMP 失败回退普通 yt-dlp 已有兜底）
- 不做自动更新/升级检查
