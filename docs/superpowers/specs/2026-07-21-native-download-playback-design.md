# Native Download Playback Design

## Scope

Replace only the completed-download action labelled "预览已下载文件" with "播放". Online format preview remains on the existing HTML5 WebView path.

## Design

`index.tsx` will add a small native playback page backed by Scripting's `AVPlayerView` and an `AVPlayer` whose source is the completed local file path. The page will:

- configure the shared audio session for playback and activate it before presentation;
- retain its player with `useMemo` for the page lifetime;
- set the local source and begin playback after the player becomes ready;
- enable system controls, Picture in Picture, automatic inline-to-PiP continuation, and Now Playing updates;
- dismiss through the navigation close action and dispose the player in the effect cleanup;
- report a local, user-facing error when the file is missing, cannot be configured, or the native player reports an error.

The existing `presentHTML5Player` remains responsible only for online preview URLs. The successful download result button calls a new local-player presenter.

## Verification

- TypeScript diagnostics for `index.tsx`.
- `scripting-ts run index.tsx` startup regression.
- Device validation: complete a local download, tap "播放", verify native controls, audio/video, dismiss, and PiP where available.

## Non-goals

- No change to online preview, yt-dlp download, FFmpeg merge, saved-file history, or remote media handling.
