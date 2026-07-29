# Clipboard Auto Analysis and Auto Download Design

## Goal

When Yoinks opens on the Download tab, it checks the clipboard once. If it finds a public HTTP or HTTPS media URL, it applies the URL and starts media analysis immediately. A user-controlled setting can then start a download automatically after analysis.

## Scope

- Check the clipboard once when the Download tab first appears during a script launch.
- Reuse the existing URL extraction logic so share text from supported platforms behaves the same as manual paste.
- Start media analysis automatically for a valid clipboard URL.
- Add persistent settings for automatic download and its format strategy.
- Keep manual paste, manual URL entry, history reanalysis, and all existing download paths unchanged.

## Settings

The Settings tab will contain an Automatic Download section.

- `Automatically download after clipboard analysis`: disabled by default.
- `Automatic download format`: a persisted format strategy, defaulting to `Use recommended format`.

Available strategies:

1. `Use recommended format`: use the app's existing recommended choice.
2. `Highest quality video`: choose the highest-resolution video choice, allowing the existing video/audio merge workflow where needed.
3. `Highest quality audio`: choose the best available audio choice.
4. `Preferred container`: choose one of `MP4`, `MKV`, `AVI`, or `WMV`. Select the best direct-playable video choice in that container with audio. If no matching choice exists, fall back to the recommended choice.

The selected container is stored only when the preferred-container strategy is active. Changing to another strategy preserves the selection for later use.

## Launch Flow

1. The Download tab becomes visible.
2. A per-launch guard ensures the clipboard is checked only once and only while no analysis or download is active.
3. If the clipboard has no text or no valid public URL, Yoinks leaves the current state unchanged and does not show an error.
4. If a valid URL is found, Yoinks clears the previous temporary session and result state, sets the URL, and begins analysis using the same path as manual paste.
5. Once analysis yields selectable choices, Yoinks resolves the configured format strategy.
6. If automatic download is enabled and a choice is resolved, Yoinks selects it and starts the existing download flow.
7. If the chosen strategy has no match, Yoinks falls back to the recommended choice. If no downloadable choice exists, it leaves the analyzed result visible and reports the existing analysis state without starting a download.

## Safety and Platform Constraints

- Clipboard access relies on the existing Scripting permission: Settings > Scripting > Paste from Other Apps. Access errors are logged and shown only when the user explicitly requests a manual paste; automatic launch checks remain quiet to avoid a startup error state.
- Automatic downloading is opt-in and disabled by default.
- No additional container conversion or transcoding is introduced. `MKV`, `AVI`, and `WMV` only match formats offered by the source; they do not force a conversion.
- The launch check never overrides an in-progress analysis, download, or a URL supplied through another active user action.

## Logging

Record structured events without raw clipboard contents:

- `clipboard-launch.checked`
- `clipboard-launch.empty`
- `clipboard-launch.invalid`
- `clipboard-launch.accepted` with the normalized source URL and detected platform
- `auto-download.selected` with the strategy, resolved choice ID, and whether fallback was used
- `auto-download.skipped` with a non-sensitive reason

## Validation

- TypeScript diagnostics pass.
- `scripting-ts project "Yoinks"` starts successfully.
- Service-level tests cover strategy resolution for recommended, highest video, highest audio, each preferred container, and fallback behavior.
- Verify a valid clipboard URL starts analysis once per launch.
- Verify the automatic-download switch off never starts a download after launch analysis.
- Verify the switch on starts the selected strategy after analysis.
- Verify denied clipboard access does not leave the Download tab in an error state on launch.
- Verify manual paste continues to show its current permission and invalid-link messages.
