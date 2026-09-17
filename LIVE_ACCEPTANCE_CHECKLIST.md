# Signal Box live acceptance checklist

The local implementation and fixtures are green. These checks require credentials, a paired browser, or a physical device and must be run before claiming production readiness.

## Electron and providers

- Connect a test Google account and verify Gmail history/bootstrap, pagination, Calendar `If-Match` conflict handling, Drive changes, token refresh, and account-scoped deletion.
- Use a dedicated test recipient and confirm a Gmail autonomous send appears exactly once, including timeout/restart reconciliation.
- Use a disposable Calendar event and verify approved update, stale-etag rejection, guest behavior, and restart recovery.
- Pair the browser extension to a test profile, run quote and booking recipes against a controlled fixture or explicitly approved live service, and verify markup drift fails safely.
- Close and reopen the Electron window, restart the host, pause/resume it, and confirm queued work is recovered without duplicate external effects.

## Mobile

- Install the exported Android/iOS build on a physical device.
- Pair and revoke a device; verify a second device cannot use its token or replay its commands.
- Validate foreground location, opt-in background location, battery, and one-shot accelerometer motion consent; verify denied/revoked permissions, offline outbox replay, duplicate events, retention, and deletion.
- Configure trusted TLS, push credentials, and reconnect behavior; confirm notifications open current task/approval state and never authorize stale work.
- Run a short battery/background-location soak and record delivery latency, missed samples, and power impact.

Record each result with build version, platform, account/device fixture, timestamp, and evidence. A local fixture pass is not a substitute for these checks.
