# Signal Box Mobile

This is a separate React Native (Expo) interaction surface for the Electron assistant core.

The app owns presentation, explicit location consent, and an offline command outbox. It does not open SQLite, run inference, hold provider credentials, or execute browser actions. The Electron core remains authoritative for tasks, memory, permissions, workflows, planning, and receipts.

## Run

```sh
cd mobile
npm install
npm start
```

Enter the `hostUrl` and token returned by Electron's mobile pairing endpoint/desktop pairing surface. The current core transport is loopback-only by default, so a phone cannot reach `127.0.0.1` on the desktop; a secure direct or relay transport must be explicitly enabled before remote pairing is advertised.

For direct LAN access, configure the Electron profile with a non-loopback bind host plus a trusted TLS key/certificate (`mobileBindHost`, `mobileAdvertisedHost`, `mobileTlsKeyPath`, and `mobileTlsCertPath`). The core refuses a non-loopback HTTP bind. Do not use a self-signed certificate in a production mobile build unless the certificate is deliberately pinned/trusted by the app.

The client sends an `Idempotency-Key` for every command and stores network-failed commands in a bounded local outbox. Queued commands are shown as pending and are only considered accepted after the core acknowledges them.
