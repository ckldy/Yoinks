# Yoinks Generic Preview Login Fallback Design

**Date:** 2026-07-21
**Status:** Approved design, pending written-spec review

## Goal

Make Online Preview attempt direct HTML5 playback first, then offer a safe, generic login-assisted retry when playback fails. The feature must work for any valid public source-page domain rather than maintaining a fixed list of platforms.

## Scope

### Included

- Treat actual HTML5 playback as successful only after the player reports a playable state; loading or presenting a WebView alone is not success.
- Keep the first preview attempt unauthenticated and unchanged from the user's perspective.
- Return a structured result from the preview player for success, media failure, presentation failure, and timeout rather than only writing JavaScript events to logs.
- On the first failed remote preview, derive a login candidate exclusively from the user-submitted source-page URL, not the signed media/CDN URL.
- If the source URL is a valid HTTP(S) URL with a safe hostname, show a confirmation dialog:
  - Title: `登录后进行预览`
  - Message: `在线播放失败，可能需要登录 <域名> 后才能访问媒体。是否前往登录？`
  - Actions: `取消` and `前往登录`
- On confirmation, open the original source page in a new ephemeral WebView. The user completes any sign-in interaction and closes the page when finished.
- After the login page closes, verify that the same WebView contains at least one cookie whose domain is the source hostname, a subdomain of it, or a parent domain of it. Do not inspect or expose cookie values.
- Retry the exact selected preview URL once in that same WebView session so the media request can use the sign-in state.
- When the retry fails, the user cancels, no associated cookie is present, login cannot be opened, the source URL cannot safely yield a login candidate, or a local preview fails, show exactly:
  - `临时媒体链接无法稳定在线播放，请下载完后播放`
- Record privacy-safe lifecycle events with a hostname (not a full signed URL), result category, and retry flag. Do not log cookies, account labels, or media URL query values.
- Retain the existing fixed-platform Cookie flow for yt-dlp probing and downloading. The generic preview session does not export cookies to files or modify the download-auth paths.

### Excluded

- Maintaining a new platform registry or adding platform-specific login pages for preview.
- Reusing, persisting, displaying, exporting, uploading, or sharing generic-preview cookies.
- Guaranteeing playback for DRM media, codec-incompatible streams, expired URLs, anti-hotlinking rules, cross-domain CDN restrictions, or services that do not use browser cookies.
- Automatically logging in, bypassing an access control, or trying more than one login/playback retry.
- Changing download format selection, yt-dlp invocation, persistent login settings, or existing platform-auth behavior.

## User Flow

1. The user selects a media format and taps `在线预览`.
2. Yoinks opens an ephemeral player and waits for a playable event, a terminal player failure, or a bounded timeout.
3. If the player starts, normal fullscreen player use continues and no login UI appears.
4. If it fails, Yoinks obtains the hostname from the original entered/shared page URL.
5. If no safe hostname is available, Yoinks shows the download fallback message and stops.
6. Otherwise, Yoinks asks for permission with the approved `登录后进行预览` confirmation dialog.
7. If the user chooses `取消`, Yoinks shows the download fallback message and stops.
8. If the user chooses `前往登录`, Yoinks presents an ephemeral WebView at the original page URL. The user can sign in normally and closes the page afterwards.
9. Yoinks checks only whether the session has a cookie associated with the candidate hostname. If it does not, it shows the download fallback message and stops.
10. Yoinks loads the same player HTML into that same WebView session and waits once more for playback.
11. A successful retry continues in fullscreen. Any second failure shows the download fallback message and ends the flow.

## Architecture and Boundaries

### `index.tsx`

- Owns the preview orchestration invoked by the `在线预览` button.
- Creates the initial player session, shows the confirmation dialog, updates user-facing status, and presents the final fallback alert.
- Uses the source URL held by the current download form as the only login navigation target.
- Disposes every ephemeral WebView unless it remains open as the successful fullscreen player.

### Preview player helper

- Builds the existing HTML5 video page.
- Extends JavaScript bridge messages with a stable outcome category and media error code when available; no URL or cookie data crosses the bridge.
- Resolves a typed result after `playing`, a terminal media error, loading/presentation failure, or timeout.
- Accepts an optional caller-owned WebView for the authenticated retry; it must not create a second WebView when a session is provided.

### Generic session helper

- Parses and normalizes HTTP(S) hostnames.
- Determines cookie association through case-insensitive exact, subdomain, or parent-domain matching. It never treats an unrelated CDN hostname as a login target.
- Opens the original source page in an ephemeral WebView and only returns a reusable session when a related cookie exists.
- Keeps values inside WebKit and exposes only a boolean session result and safe hostname for UI/logging.

### Existing platform authentication

- `services/platform-auth.ts` remains responsible for supported-platform cookies used by yt-dlp probe/download retry.
- Generic preview authentication is separate because its cookies are temporary and WebView-only.

## Error Handling and Privacy

- Playback error classifications are intentionally conservative: they establish that direct playback failed, not that a site definitely requires a cookie.
- The confirmation language says login *may* be needed and requires an explicit user action before opening a sign-in page.
- Every path after an initial failed preview ends with one fallback message if no successful authenticated playback occurs.
- Logs use only an origin hostname, stage (`direct`, `login`, `retry`, `fallback`), boolean retry state, and non-sensitive failure category. Cookie names, values, page titles, account information, complete media URLs, and signed query parameters are excluded.

## Verification

1. Add focused, pure checks for hostname parsing and related-cookie-domain matching, including exact host, parent domain, subdomain, unrelated domain, IP/invalid host, and non-HTTP URL cases.
2. Run project TypeScript diagnostics.
3. Run `scripting-ts project "Yoinks"` to verify the standard UI entry starts.
4. On an iOS Scripting device, verify:
   - A public direct media URL enters playback without a login prompt.
   - A deliberately unavailable/failed preview produces `登录后进行预览` when the original source URL is HTTP(S).
   - Choosing `取消` produces exactly `临时媒体链接无法稳定在线播放，请下载完后播放`.
   - Completing sign-in and closing the original-page WebView with a related cookie causes one retry in the same session.
   - Closing without a related cookie, a login-page failure, and an authenticated retry failure all produce the same fallback message.
   - A local media file failure does not open a web-login prompt.
   - Logs contain no cookie values, account labels, complete signed URLs, or media query strings.
5. Re-run existing probe/download login regression manually for supported fixed platforms to confirm generic preview work did not change yt-dlp Cookie export behavior.
