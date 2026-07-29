# Yoinks About Page Design

**Date:** 2026-07-21
**Status:** Approved design, pending written-spec review

## Goal

Add a concise About page at the bottom of Yoinks Settings. It must describe the Scripting adaptation's working capabilities, explain why it cannot fully reproduce the upstream project, link to the upstream Yoinks repository, and provide clear attribution.

## Scope

### Included

- Add a bottom-most `关于` section in Settings with a `关于 Yoinks` row.
- Open a dedicated read-only `关于 Yoinks` page from that row.
- Describe the local script's media-link probe, format selection, online preview where available, download and FFmpeg merge, save to Photos or Files, download history, managed local storage, platform login fallback, and structured diagnostics.
- Explain the runtime limitation: Scripting's Node.js capability is implemented through Swift and JavaScript layers rather than a complete native Node.js runtime. Even with dependencies installed, invoking Node or commands such as `npm run` can fail around `waitUntilExit` compatibility, preventing the upstream project from running intact.
- Explain that the Yoinks name and its focused media-download experience are retained while waiting for future Scripting npm and Node-runtime improvements.
- Provide a user action that opens the upstream repository in Safari:
  `https://github.com/pablostanley/yoinks/tree/main`
- Credit Pablo Stanley and the upstream Yoinks open-source project for its inspiration.

### Excluded

- Changing the script name, version, download implementation, dependencies, installation flow, or network permissions.
- Claiming feature parity with the upstream project.
- Embedding an external web view or collecting user data.

## User Experience

### Settings Entry

The Settings list gains a final section titled `关于`. It contains one row:

- Title: `关于 Yoinks`
- Icon: `info.circle`

Activating the row presents a nested native page titled `关于 Yoinks`.

### About Page Content

The page uses four compact native list sections:

1. `Yoinks`
   - A short statement that this is an iOS Scripting implementation for downloading public media links through a probe-first, format-selectable workflow.

2. `功能与特点`
   - A concise static description of probe-first format selection, online preview when supported, audio/video processing and FFmpeg merge, Photos/Files saving, persisted history and managed originals, login fallback, and optional structured diagnostics.

3. `原版兼容性`
   - The approved explanation of the non-native Node.js runtime and potential `waitUntilExit` failures when executing Node or `npm run`.
   - A statement that the current version keeps the Yoinks identity and core download experience and can be updated when Scripting improves npm and Node support.

4. `致谢`
   - An action titled `打开 Yoinks 开源项目` with an external-link icon. It opens the repository in Safari.
   - A static acknowledgment of Pablo Stanley and the upstream Yoinks project.

The page has no mutable controls, no network request, and no file operation. If Safari cannot open, the existing enclosing action error handling reports the platform error rather than changing application state.

## Code Boundaries

- `index.tsx` owns the Settings entry, the About page view component, and the Safari action.
- No service, preference, history, media, logging, or metadata file changes are required.

## Verification

1. Run project TypeScript diagnostics after the change.
2. Run `scripting-ts project "Yoinks"` to verify the normal UI entry starts successfully.
3. In Scripting on device, open Settings, confirm `关于` is the final section, open `关于 Yoinks`, verify text wrapping under the current text-size setting, and invoke the repository action to confirm it opens the specified GitHub page in Safari.
4. Confirm the About page does not alter download settings, storage settings, history, or debug state.
