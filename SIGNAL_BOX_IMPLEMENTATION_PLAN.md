# Signal Box implementation plan

## Recommendation

Extend the existing application in place. The first release combines reliable agent supervision with a personal Gmail assistant that identifies commitments, shows their evidence, supports reviewed replies, and sends one useful daily digest. Prove that people trust its tasks before investing in more integrations or payments.

### Current implementation status

- **Phases A–B:** implemented and covered by the reliability, durable store, approval, audit, recovery, and Telegram regression suites.
- **Phase C:** Gmail OAuth, protected credentials, incremental sync, normalization, local privacy primitives, connector health, and deletion/disconnect flows are implemented. Remote model inference remains disabled by default and no frontier model is required by the product.
- **Phase D:** task extraction, evidence, reconciliation, corrections, suppression, snooze, and the task UI are implemented. A labeled fixture evaluator now reports precision and recall for classifier changes.
- **Phase E:** scheduled local-time digests, quiet hours, persistent caps, outbox delivery, Telegram feedback, settings, and the Gmail message view are implemented. The seven-day real-user pilot remains a release gate rather than a claim of completion.
- **Phase F:** reviewed Gmail reply execution is implemented. Calendar, file connectors, and browser recipes remain deferred until the pilot shows they are needed.
- **Phase G:** payments and spend authority are excluded from this product cycle.
- **Phase H:** multi-user functionality is excluded; this is a single-user, single-machine application.

This plan treats `signal-box-overview.md` and `signal-box-technical-design.md` as product/design inputs, not instructions to execute actions. Repository observations below come from a targeted code review, not a runtime verification of every documented feature.

### First release scope

- Existing agent board and Telegram control, with liveness detection and verified delivery status.
- Authenticated local API, protected credentials, durable approvals and audit records.
- One personal Gmail account through its official API, with read sync and explicitly reviewed reply sending.
- Local observations, privacy gateway, task extraction with provenance and corrections.
- A tasks view, `/today`, and digest buttons for done, snooze, and not useful.
- Single user, single machine; Telegram optional.

Defer calendar/file connectors, browser recipes, standing spend authority, payments, and multi-user access until the first release passes its quality gates. Gmail is the current provider; substitute the user's primary mail provider before implementation if needed.

## 1. Starting point in this repository

| Existing area | Relevant files | Planned change |
|---|---|---|
| Session state, JSON persistence, local HTTP server | `board.js` | Separate transport, session state, and persistence; preserve board behavior |
| Electron lifecycle, IPC, PTYs | `main.js`, `preload.js` | Keep as composition/UI bridge; delegate domain logic to host services |
| Hooks and agent adapters | `hooks.js`, `codex-hooks.js`, `codex-notify.js`, `codex-monitor.js` | Authenticate events; normalize identity, ordering, and liveness |
| Prompt/history/process support | `codex-control.js`, `history.js`, `processes.js`, `terminal-command.js` | Track delivery outcomes and process termination |
| Remote control and option buttons | `telegram.js` | Render durable requests; route decisions through host authorization |
| Settings stored as JSON | `app-settings.js` | Separate ordinary settings from protected secrets |
| Board UI | `renderer/` | Add stale state, approval queue, task evidence and correction UI |
| Regression coverage | `test/` | Extend existing tests around boundaries and recovery |

The dependency list currently contains no SQLite package. Choose a driver only after a packaged Electron compatibility spike; avoid a broad JavaScript-to-TypeScript rewrite as part of this work.

## 2. Resolve these design issues first

1. **Privacy comes before cloud extraction.** The overview puts the vertical slice before privacy; use the technical design's safer dependency order. Early extraction experiments use synthetic fixtures or a local model until the outbound gateway exists.
2. **Audit and approval persistence are foundations.** Introduce them before new executors, rather than waiting for the later policy milestone.
3. **Sequence numbers do not replace semantic state rules.** A newer generic stop event can still arrive while a question is unresolved. Keep pending approvals authoritative and model completion separately.
4. **Do not discard every late event.** Late state events should not regress a tile; unique observations and settlement events must still be retained and reconciled. Add event IDs, producer instance IDs, and durable ordering rules.
5. **Approval must authorize a specific action.** Bind the chosen option to a canonical action digest, target, parameters, preconditions, expiry, and policy version. If these change, ask again. For agent keystroke delivery, document that this guarantee is weaker than for a host-owned executor.
6. **Option buttons are only one part of injection resistance.** Untrusted content must not choose capabilities, change policy, or issue executor grants. Trusted executor code determines actual effects; model output and actor-declared consequences are proposals.
7. **An agent prompt can cause irreversible work.** Do not treat arbitrary `/send` or shell commands as inherently reversible. Preserve explicit user-driven control as a distinct permission; never let extracted mail or model output invoke it automatically.
8. **Use precise privacy claims.** Pseudonymization reduces identifier exposure; detection can miss entities and context can identify someone. Define measured coverage and a local-only fallback rather than promising universal anonymity. Telegram is a separate, explicit disclosure channel.
9. **Clarify secret protection.** A `0600` adapter credential file is intentionally a plaintext credential, so “no plaintext secret on disk” is too broad. Protect bot/OAuth/model credentials with the OS-backed secret store; document the narrower local-token exception and same-user-process threat boundary. Do not silently accept an insecure secret-storage fallback.
10. **Replies are evidence, not automatic resolution.** A reply from the blocking party does not necessarily answer the question. Require task-specific evidence before changing state; date passage alone does not complete work.
11. **Do not filter out the user's promises.** Incoming-only mail filters miss “I'll send this Friday.” Use separate candidate rules for incoming requests, sent commitments, and replies to existing tasks. Filters affect extraction, not whether relevant updates can reconcile existing tasks.

## 3. Target structure and contracts

Retain Electron and the existing renderer. Add small host modules with explicit interfaces; adapters run in child processes. Start with one application deployment, not multiple independently deployed services.

```text
main.js                         Electron startup, IPC, PTY ownership
host/
  store/                        SQLite schema, migrations, repositories
  events/                       Validation, adapter identity, ingestion
  sessions/                     Session state, liveness, delivery tracking
  approvals/                    Requests, decisions, expiry, grants
  policy/                       Capability registry and authorization
  audit/                        Requests, decisions, execution receipts
  privacy/                      Vault, entity mapping, model gateway
  tasks/                        Extraction, reconciliation, corrections
  scheduling/                   Ranking, budgets, quiet hours, outbox
  execution/                    Trusted executors and reconciliation
adapters/
  gmail/                        OAuth, incremental sync, normalization
  agents/                       Wrappers around existing agent integrations
```

### Core boundaries

- **Ingestion:** `ingest(event, adapterIdentity)` validates and durably stores data before acknowledging it. Adapters cannot create decisions or mutate tasks directly.
- **Approvals:** `requestApproval(actionProposal)` produces immutable options. `decide(requestId, optionId, principal)` validates identity, surface, expiry, and current state in one transaction. Identity is derived from the authenticated channel, never trusted from request JSON.
- **Execution:** `execute(actionId, grant)` accepts only a host-issued, single-use authorization tied to an immutable action. Recheck policy, revocation, and preconditions immediately before dispatch.
- **Models:** `extract(observation)` and `rank(tasks)` use one privacy-controlled gateway; their schema-constrained outputs have no execution authority.
- **Notifications:** `schedule(notificationIntent)` is the only path for proactive messages and enforces persisted budgets. Interactive command replies are tracked separately.

### Durable storage

Use SQLite transactions for event ingestion, approval resolution, job claiming, and notification budgeting. Keep the encrypted vault separate from the ordinary database.

| Tables | Purpose |
|---|---|
| `adapters`, `events`, `connector_cursors` | Source identity, deduplication, restart-safe sync |
| `sessions`, `delivery_attempts` | Session state and submitted/acknowledged/unknown outcomes |
| `observations`, `extraction_runs`, `task_candidates` | Original normalized evidence and versioned extraction |
| `tasks`, `task_evidence`, `task_links`, `task_history`, `corrections` | Correctable task graph; potentially multiple sources per task |
| `approval_requests`, `approval_options`, `decisions` | Immutable requests, surface constraints, single resolution |
| `actions`, `execution_attempts`, `receipts` | Exact intended action, outcome, reconciliation |
| `authorities`, `budget_reservations` | Later standing authority and concurrency-safe spend caps |
| `jobs`, `notification_outbox`, `notification_ledger`, `suppressions` | Durable work and interruption controls |
| `audit_entries` | Append-only application history linked to requests and actions |

Migrate existing session/settings data through a versioned, repeat-safe importer. Preserve a pre-migration backup and stable session IDs. Do not dual-write indefinitely. An application append-only log is not tamper-proof against the machine's owner; avoid claiming otherwise.

## 4. Phased implementation

Effort ranges below assume one experienced full-time engineer familiar with this repository. They are planning estimates, not delivery promises; validate them after the foundation spike.

### Phase A — Reliability and local hardening · 1–2 weeks

**Build**

- Add per-source soft/hard liveness limits, owned-process exit detection, and adapter heartbeats where supported. Track transport heartbeat separately from meaningful progress.
- Use monotonic time within a process and revalidate state after restart or machine sleep. Silence means stale/unknown, not proof of a hang.
- Show stale tiles and emit one hard-limit escalation per stale episode; recovery resets the episode. Persist escalation state across restarts.
- Track prompt delivery as submitted, acknowledged, failed, or unknown. Correlate acknowledgement to the session/request where possible; unrelated activity is not proof. Never blindly resubmit on timeout.
- Authenticate `/hook`, `/event`, and history APIs. Update installed hooks together with the server; keep the legacy route and shape, not an unauthenticated bypass.
- Move bot credentials into protected storage with a migration path, redacted diagnostics, and startup handling for unavailable secret storage.
- Restrict Telegram decisions to the configured private chat and user identity. Add a global pause for automated execution and explain Telegram transit before pairing.

**Exit tests**

- Killed processes and silent sessions stop appearing healthy within configured bounds.
- Missing/invalid credentials cannot post events or read history; valid installed hooks still work.
- Lost prompt acknowledgement produces a visible unknown/failure outcome and no duplicate submission.
- A restart neither replays old control commands nor loses pending questions.

### Phase B — Durable host and approval core · 2–3 weeks

**Depends on:** A.

**Build**

- Validate SQLite packaging on target platforms; add versioned migrations and existing-state import.
- Introduce `/event` schemas, registered adapter identities, event IDs, producer epochs, deduplication, and per-type ordering rules. Persist connector cursors only with accepted data.
- Assign adapter credentials ingest-only permissions; decisions use a separate authenticated surface path. A loopback token is not protection against arbitrary malware running as the same OS user.
- Extract durable approvals from Telegram/PTY assumptions, retaining agent-specific submission adapters. Preserve multi-question and multi-select semantics explicitly.
- Add immutable action snapshots, option IDs, expiry, cancellation, policy constraints, transactional single resolution, execution records, and audit entries.
- Implement a minimal policy engine now: explicit user control, desk-only classes, reject unknown capabilities, no autonomous write grants.
- Invalidate buttons on all surfaces after resolution. On reconnection, refresh only requests still valid against current state; reissue stale ones with new IDs.
- Create a fake non-CLI actor for protocol tests before connecting a real executor.

**Exit tests**

- Simultaneous desk/phone answers produce exactly one durable decision and at most one dispatch attempt.
- Unknown options, wrong principals, expired requests, changed payloads, and actor self-approval are rejected.
- Crash/restart preserves requests, decisions, and event deduplication; an uncertain dispatch is reconciled rather than blindly repeated.
- Existing session restore, hook state guards, and Telegram routing regressions pass.

### Phase C — Gmail sync and privacy · 2–3 weeks

**Depends on:** B. Connector normalization and privacy fixtures can be developed independently.

**Build**

- Add user-initiated OAuth pairing with minimum read scopes, protected refresh credentials, disconnect/revoke handling, and visible sync health. Validate provider requirements against official documentation during implementation.
- Start with a bounded history window and selected folders. Ingest incoming and sent messages; normalize quoted text, timestamps, message/thread IDs, and headers. Disable attachment extraction initially.
- Implement resumable incremental sync, provider cursor-expiry recovery, bounded backoff, and observation deduplication.
- Add deterministic candidate filters with separate incoming, outgoing, and existing-task reconciliation paths.
- Implement the encrypted entity vault, stable opaque IDs, conservative alias resolution, local entity recognition, deterministic replacement, and source-offset mapping.
- Route remote inference through an isolated gateway process holding model credentials. Keep raw bodies out of logs and diagnostics. Restrict gateway inputs to approved fields; fail closed when privacy processing fails.
- Treat local-only as disabling remote model inference, not all networking: mail sync and Telegram still require their services. Expose independent controls for these channels.
- Define retention, deletion, backup, and disconnect behavior. Disconnect stops ingestion immediately; the app offers explicit export and deletion of stored source data and explains its impact on evidence links. Vault backup is a separate opt-in recovery decision.

**Exit tests**

- Restart and expired sync cursors do not skip messages or create duplicate observations.
- Outbound capture tests contain none of the sensitive fixture identifiers, including subject/header content; adversarial fixtures measure detector misses.
- Entity IDs remain stable after restart. Rehydration rejects unknown IDs and cannot access unrelated vault entries.
- Evidence offsets map from pseudonymized text to the exact version of the local normalized source.
- Revocation pauses the connector; unavailable privacy processing prevents remote inference.

### Phase D — Trustworthy task graph · 2–3 weeks

**Depends on:** C. Start labeled synthetic/local-only evaluation work during earlier phases.

**Build**

- Extract typed candidates with evidence, confidence, owner, counterparty, due-date basis, and extractor version.
- Represent “who owes the work” separately from “who is blocking progress”; otherwise nudges can reverse the obligation.
- Validate spans and schema locally. A valid span proves traceability, not correctness; unsupported interpretations still require evaluation.
- Reconcile candidates conservatively using thread/message identity and explicit task links. Do not merge tasks solely because their summaries resemble each other.
- Preserve manual corrections, dropped tasks, and completion against subsequent re-extraction. Store date-only deadlines distinctly from timestamp deadlines and record time zones.
- Add the task list, source/evidence detail, date/counterparty edits, done, snooze, and not-useful controls. Keep low-confidence candidates out of proactive views.
- Permit automatic state changes only when evidence addresses the particular obligation; store the transition cause.

**Exit tests**

- Every surfaced task links to its evidence; every change has a cause or correction record.
- Sent commitments and incoming requests are both represented correctly.
- Re-ingestion and re-extraction preserve user decisions and do not resurrect dismissed tasks.
- Proposed release gate: at least 90% precision on proactively eligible tasks in a labeled, representative sample. Report sample size, missed commitments, and error classes alongside precision; do not treat model confidence as a measured probability.

### Phase E — Digest and first release · 1–2 weeks plus a 7-day pilot

**Depends on:** D.

**Build**

- Start with deterministic deadline/blocking-age ranking and explicit reasons. Add model ranking only if evaluation demonstrates an improvement.
- Implement priority floors, a persistent daily cap, timezone-aware digest timing, quiet hours, debouncing, snooze, and suppression controls.
- Start with one digest per day and no immediate task interrupts. Existing approvals and stale-agent escalations remain separate classes with documented limits.
- Reserve notification budget transactionally; use an outbox and delivery ledger. A network timeout can leave delivery unknown, so avoid promising exactly-once Telegram delivery.
- Add `/today` and task buttons using stable IDs, not mutable list indexes. Apply suppression at the class/counterparty level with an undo/settings view.
- Provide notification content settings, connector status, local-only model mode, pause, export, deletion, and recovery guidance.

**Exit tests / pilot gate**

- Seven days of digests without cap or quiet-hour violations, including restarts, daylight-saving fixtures, and failed sends.
- At least 90% of surfaced commitments judged correct as an initial target; separately record how many digest items were useful.
- Wrong tasks are easy to dismiss; dates and counterparties can be corrected without losing evidence.
- No known lost approvals or duplicate action dispatches in recovery tests.

**Release decision:** ship this as the personal-assistant MVP. If extraction precision or digest usefulness fails, improve these before expanding integrations.

### Phase F — Reach and one useful action · approximately 3–5 additional weeks

**Depends on:** successful E pilot; executor foundation from B.

- Add calendar first, then selected files, using the same observation contract and explicit read scopes.
- Implement one host-owned write capability, such as sending a reviewed reply through an official API. Request write permission only when the user enables it.
- Show exact destination, content, attachments, and consequences before approval. Bind them to the grant and verify preconditions at dispatch.
- Track execution as prepared → authorized → dispatched → confirmed/failed/unknown. Use provider idempotency where available; otherwise reconcile before permitting another attempt.
- Add browser recipes only after this official-API action works. The referenced Relay document is not present in the current file listing; obtain or write that specification before estimating its full scope.
- Begin with one manually reviewed read-only recipe, explicit allowed endpoints/parameters, response validation, and a canary. A recipe's self-declared effects class is not sufficient authorization.
- For recipe writes, validate state immediately before the first committing request. Detect expired sessions, challenges, drift, and concurrent account changes; stop for manual handling.

**Exit:** one real task is completed after one approval; changed parameters require a new approval; a timed-out commit remains unknown until reconciled and is not automatically repeated. Retry reversible operations only when their retry safety is explicitly established.

### Phase G — Deferred payments and spend authority

Deferred from the single-user assistant scope. Signal Box will not implement payments, purchasing, standing spend authority, or financial execution in this product cycle.

### Phase H — Removed from scope

Multi-user identity, role-scoped permissions, approval assignment, shared state, and per-user vault isolation are intentionally excluded. Signal Box remains a single-user, single-machine assistant.

## 5. Validation strategy

- Extend the existing Node regression suite for session behavior and routing rather than replacing it.
- Use fake clocks for expiry, liveness, quiet hours, caps, and daylight-saving behavior.
- Test transaction races and process interruption at approval resolution, budget reservation, dispatch, and receipt persistence.
- Use sanitized mail fixtures covering promises, requests, quoted replies, newsletters, ambiguous dates, alias collisions, and hostile instructions.
- Inspect captured outbound model payloads and Telegram payloads separately; they have different disclosure policies.
- Use an opt-in read-only account for connector integration tests. Initial action tests use fake executors; controlled live actions come only after the policy/recovery suite passes.
- Test packaged secret storage, SQLite, PTY operation, and upgrades on supported operating systems. If only Linux/WSL is validated initially, label the new features accordingly.

## 6. Suggested first pull requests

1. **Liveness and delivery outcomes:** stale state, process-exit handling, bounded acknowledgement tracking, renderer/Telegram presentation, focused regression tests.
2. **Local authentication and secrets:** protect existing routes, migrate hooks and bot credentials, pairing disclosure, credential-storage failure behavior.
3. **Durable store and event contract:** SQLite packaging spike, migrations, source identity, deduplication, legacy shim.
4. **Approval service and audit:** transactional decisions, immutable actions, authenticated surface identity, expiry, fake non-CLI actor.
5. **Read-only Gmail connector:** normalized observations, sent/incoming support, checkpointed sync, no remote extraction yet.
6. **Privacy gateway and evaluation corpus:** stable vault, detectors, offset mapping, outbound inspection, local-only behavior.
7. **Tasks and corrections:** extraction, reconciliation, evidence UI, user-edit preservation.
8. **Digest and pilot:** deterministic ranking, persisted budgets, Telegram task actions, quality reporting.

## 7. Effort and decisions

Budget roughly **10–16 engineering weeks plus the 7-day pilot** for A–E with one experienced engineer, before contingency. Provider onboarding, privacy-model packaging, cross-platform secret storage, and extraction quality are the largest uncertainties. A local-only or synthetic-data prototype can demonstrate the flow sooner, but does not meet the release gates above.

Before each dependent implementation begins, settle:

- **Mail provider and launch platform:** assume Gmail and a Linux/WSL pilot; preserve existing platform compatibility.
- **Cloud processing/content settings:** explicitly enable remote model use and separately choose what Telegram may carry.
- **Retention and recovery:** choose observation lifetime and vault backup policy; losing the vault compromises stable identity and rehydration.
- **Approval restrictions:** own a written default policy, including shell control and destructive database operations.
- **Personal tool or distributed product:** provider verification, packaging/support, onboarding, and retention requirements affect product scope and estimates.

The remaining release work is the Phase E pilot: collect a representative labeled sample, run the evaluator, and observe seven days of digest delivery without cap, quiet-hour, duplicate, or approval-recovery violations. After that, only the most useful Phase F connector should be added. Payments and multi-user access remain out of scope.
