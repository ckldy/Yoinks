# Local Douyin Login Format Experiment

## Goal

Add an on-device Douyin QR-code login to YoinksRemote and measure whether a logged-in local WebView receives multiple local video formats. This is an experiment, not a guarantee of higher quality.

## Scope

- Add Douyin to the local platform-login capability.
- Open only a persistent local `WebViewController` at `https://www.douyin.com/` for QR-code login.
- Reuse that local WebView session for local Douyin extraction.
- Log safe aggregate evidence for each local extraction: whether a local Douyin session exists, captcha state, detail-response availability, `video.bit_rate` count, local desktop candidate count, and final local choice count.
- Display any locally captured `bit_rate` entries as separate local candidates.
- Provide a Douyin-specific clear-login action that deletes only Douyin-domain cookies.

## Isolation Rules

- Douyin cookies stay in the local Scripting WebView cookie store.
- No Douyin cookie, cookie value, cookie file, header, or account identifier is written to logs, preferences, project files, or remote requests.
- `resolveDouyinViaRemote` accepts only remote endpoint, remote token, and page URL. It does not receive a local session or cookie data.
- Existing remote parsing behavior remains unchanged: only the explicit remote setting enables it.

## Flow

1. The user selects `Login Douyin` in Settings and completes QR-code login in the presented local WebView.
2. The app confirms the presence of at least one `.douyin.com` cookie without exposing its value.
3. Local extraction uses the shared persistent WebView session. It attempts desktop mode, then mobile fallback as before.
4. The extraction logs aggregate format evidence. If the local detail response contains `bit_rate`, the existing local candidate builder expands those entries.
5. The user can clear only the local Douyin session from Settings.

## Errors

- If login closes without a Douyin cookie, report that no local session was detected.
- If local extraction still hits captcha or contains no `bit_rate`, retain the normal local fallback and log the measured result.
- Remote parsing failures remain independent and fall back to the local result.

## Verification

- Static: the local session type may not be passed into the remote resolver.
- Runtime: `scripting-ts project "YoinksRemote"` completes.
- Device: compare the same public Douyin video before and after local login with remote parsing disabled; inspect aggregate runtime events and the displayed local candidate count.
- Device: enable remote parsing after local login and confirm remote behavior does not depend on local login state.
