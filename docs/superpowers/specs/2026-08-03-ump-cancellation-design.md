# YouTube UMP 取消与会话失效修复设计

## 目标

用户取消 YouTube UMP 下载后，Python 驱动应在当前网络读写边界尽快退出，不再继续后续回退；宿主消息通道失效不得误报为 YouTube 网络限流。

## 最小方案

1. TypeScript 将当前下载任务的 `cancelPath` 通过 `--cancel-file` 传给 UMP v2 驱动。
2. Python 在 player 请求前、SABR 启动前及每次写入分片前检查取消文件；取消时删除输出并返回退出码 130。
3. TypeScript 在 UMP 命令返回或抛错后再次检查 cancel flag，统一抛出“下载已取消”，阻止完整 GET 和网络限流提示。
4. 识别 `message channel not found` / `no callback found`，单独抛出“下载任务会话已失效”，不映射为网络限流。
5. 不新增全局锁；真机若仍能复现跨实例重叠，再单独设计跨实例互斥。

## 验证

- 静态回归验证 cancel 参数、Python 检查点、取消后的短路及会话错误分类。
- Python 语法诊断。
- TypeScript 项目诊断与 Yoinks 启动回归。
- 真机：进入 UMP 后点击取消，确认一个当前网络超时窗口内结束，且不会产生旧任务的后续失败日志。
