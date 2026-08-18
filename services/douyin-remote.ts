// douyin-remote.ts — 兼容层（历史导入路径）
//
// 抖音远程解析逻辑已迁移到 recipes/douyin.ts（通用远程解析框架 remote-resolver.ts 的第一个配方）。
// 本文件仅 re-export，保持 verify_douyin_remote*.ts 与历史调用方不受影响。

export {
  DouyinRemoteConfig,
  RemoteDetailResult,
  RemoteQuality,
  extractDetailQualities,
  remoteQualitiesToCandidates,
  resolveDouyinViaRemote,
} from "./recipes/douyin"

export { DEFAULT_ENDPOINT } from "./remote-resolver"
