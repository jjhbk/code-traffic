# Signal Box Mobile

This is a separate React Native (Expo) interaction surface for the Electron assistant core.

The app owns presentation, explicit foreground or opt-in background location and one-shot battery consent, memory/context controls, connector visibility, and an offline command outbox. It does not open SQLite, run inference, hold provider credentials, or execute browser actions. The Electron core remains authoritative for tasks, memory, permissions, workflows, planning, notifications, and receipts.

Background location is disabled by default. After the user grants the operating-system permissions and enables it from Controls, the app samples balanced location periodically and sends it through the same durable outbox used by other mobile context. The user can disable it from Controls at any time; the Electron core only receives these observations with the `background-location` consent scope.

## Run

```sh
cd mobile
npm install
npm start
```

Enter the `hostUrl` and token returned by Electron's mobile pairing endpoint/desktop pairing surface. The current core transport is loopback-only by default, so a phone cannot reach `127.0.0.1` on the desktop; a secure direct or relay transport must be explicitly enabled before remote pairing is advertised.

For direct LAN access, configure the Electron profile with a non-loopback bind host plus a trusted TLS key/certificate (`mobileBindHost`, `mobileAdvertisedHost`, `mobileTlsKeyPath`, and `mobileTlsCertPath`). The core refuses a non-loopback HTTP bind. Do not use a self-signed certificate in a production mobile build unless the certificate is deliberately pinned/trusted by the app.

The client sends an `Idempotency-Key` for every command, stores network-failed commands in a bounded local outbox, and persists an opaque notification cursor for reconnect-safe synchronization. Queued commands are shown as pending and are only considered accepted after the core acknowledges them.

Run the client contract test from this directory with `npm run test:client`. It exercises offline queueing, replay, idempotency, and notification cursor persistence without requiring a device or live Electron process.

Native release profiles are defined in `eas.json`: use `npx eas build --profile development`, `preview`, or `production` after configuring an Expo/EAS project and push credentials. The repository intentionally does not contain account-specific project IDs or signing secrets.
