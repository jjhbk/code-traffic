# Signal Box: durable proactive assistant migration

Date: 2026-09-16. Baseline: package version 1.0.16.
Status: implementation plan; no application changes made by this audit.

## Objective and boundaries

Evolve the existing application from sync → extract → rank → notify into observe → reconcile understanding → decide → act within permission → verify → follow up.

The existing task/evidence graph becomes the shared representation of unfinished work. Durable workflows coordinate progress; Electron and Telegram expose conversation, review, and control. Keep SQLite, existing session control, connectors, privacy machinery, and approvals. No microservices, graph database, or proprietary model training is required for this migration.

First product outcome: identify an unfinished Gmail commitment, connect it to a deadline or dependency, prepare a useful follow-up, obtain approval, send it once, watch for a response, and update the obligation with evidence. Calendar supplies structured timing context. Broader planning follows this proven workflow; payments, autonomous external writes, phone calls, and general desktop operation are outside this release.

## Audit evidence and limits

Reviewed the host domain modules and their main.js/Telegram/renderer wiring, store schema and transitions, connector implementations, model/privacy boundary, browser execution/extension transport, application shutdown, packaging configuration, and relevant tests. This is an architectural source audit, not a line-by-line security certification or live-account acceptance test.

Validation: `npm test` passed all 35 test files. Two isolated in-memory probes confirmed the Calendar policy mismatch and repeated browser execution described below. No live email, calendar edit, booking, or other external action was performed. Packaged cross-platform behavior and model quality were not validated.

| Area | Implemented baseline | Consequence for the migration |
| --- | --- | --- |
| Composition | main.js constructs storage, models, sync, scheduling, actions, Telegram, board and UI | Extract runtime services incrementally; preserve PTY/session behavior |
| Persistence | SQLite migrations, observations, events, task evidence/history, approvals, decisions, attempts, receipts, notification outbox | Extend existing tables/repositories; do not create a competing store |
| Task graph | sqlite-store.js `taskGraph()` projects task and observation nodes with evidence edges | Preserve and expand this graph; it currently lacks task dependencies and persistent people/goals |
| Task extraction | Regex candidates; identity is observation plus extractor version; processAll rescans observations | Introduce stable obligation identity and incremental reconciliation |
| Models | Local/frontier ranking and entity recognition; ranking explicitly forbids proposing actions/state changes | Add separate validated reasoning operations, not an unrestricted ranking prompt |
| Privacy | Encrypted entity vault, protected credentials, pseudonymization | Entity tokens are not personal memory; nested reasoning payloads need explicit protection |
| Notifications | Cadence, quiet hours, caps, suppression, durable outbox and feedback storage | Generalize existing infrastructure to nudges and approvals; no second scheduler |
| Gmail | Inbox/sent ingestion, cursor recovery, reviewed reply dispatch, unknown-send reconciliation | Reuse executor after strengthening freshness, identity and recovery |
| Calendar | Read/update/delete provider methods and desktop edit handlers | UI edit preparation currently blocked by missing policy capability |
| Drive | File metadata/description/link listing normalized as observations | Not full document-content ingestion or complete change tracking |
| Browser | Validated recipes, paired bridge, origin checks, receipts; Uber-oriented extension | Bounded execution support, not general browser intelligence or proven live booking |
| Conversation | Telegram selected-session routing, task commands and callbacks | Add a distinct assistant conversation without silently changing session commands |
| Availability | Timers owned by Electron; non-macOS window closure quits app | Background hosting is a lifecycle/packaging migration, not merely hiding a window |

### Gaps to address before increasing autonomy

1. **Calendar capability mismatch — confirmed.** main.js requests `calendar.update`; host/policy/engine.js does not register it. The policy rejects the request. Provider methods alone do not establish a working end-to-end feature.
2. **Approval resolution is not execution consumption — confirmed.** BrowserActionService.executeApproved accepts an already resolved allow decision repeatedly and creates new attempts. A fixture executed twice from one approval. Add a transactionally consumed execution grant; enforce identity, capability, expiry, policy and preconditions at dispatch.
3. **Digest feedback wiring — source finding.** main.js supplies recordDigestFeedback; TelegramControl does not accept/store it, while the callback uses optional chaining. Storage tests do not cover this constructor-to-callback path.
4. **Connector completeness — source findings.** Gmail history handling does not follow nextPageToken; initial bounded inbox/sent scanning advances to a later profile cursor. Calendar bounded pagination does not persist an unfinished page continuation. Drive treats listing page tokens as cursors; MailSync ignores null cursor updates. Design separate bootstrap/page/change checkpoints and test interruption, deletion, new arrivals and completion before relying on absence of a reply.
5. **Observation contract — source finding.** Calendar start/end/location fields emitted by the provider are dropped by generic mail normalization. Observation IDs omit provider/account identity. Preserve structured source fields and scope identities before cross-source graph reconciliation.
6. **Send verification — source finding.** Gmail reconciliation matches recipient/subject/body substring in a thread; an older similar message could match. Preserve RFC message references, scope to the sending account/attempt, and add time/provider identity checks. Keep inconclusive outcomes unknown.
7. **Execution semantics — source finding.** Browser exceptions become failed even after a possible committing click; completing recipe steps is treated as confirmed without a domain postcondition. Separate transport completion from verified business outcome.
8. **Scheduling/model work — source finding.** main.js ranks every scheduler tick before checking whether a digest is due; model completion requests lack explicit deadlines. Schedule only dirty/due work and bound model latency/concurrency.
9. **Telegram durability — source finding.** Callback mappings and offsets are in memory; startup skips queued messages except a latest /start. Preserve legacy stale-command protection, but durably ingest new assistant messages and bind review buttons to persistent requests.
10. **Privacy degradation — source finding.** Recognizer errors are swallowed into regex-only pseudonymization, and prepareRemotePayload does not recursively protect objects. New private-text operations must use explicit schemas and a fail-closed remote boundary when required recognition fails. Pseudonymization is not a guarantee of anonymity.

## Target module boundaries

```text
main.js / preload.js / renderer      UI and legacy PTY/session integration
telegram.js                         Authenticated transport and legacy commands
host/runtime/assistant.js            Composition, lifecycle, service interfaces
host/ingestion/                      Durable input acceptance and provider checkpoints
host/context/                       People, preferences, goals, bounded retrieval
host/tasks/                         Existing tasks/evidence plus graph reconciliation
host/proactivity/                   Eligibility, prioritization, next-step proposals
host/workflows/                     Durable jobs, workflows, event waits, recovery
host/conversation/                  Messages, intent handling, task/workflow references
host/actions/                       Typed registry, dispatch, verification/reconciliation
host/approvals/ + host/policy/        Existing authority boundary, extended grants
host/scheduling/                    Shared budgets, cooldowns, notification outbox
host/store/                         Single SQLite database and scoped repositories
host/privacy/ + host/models/         Validated operations and outbound data boundary
```

Services initially run in the Electron main process behind injected interfaces. Move that composition into an independent host only after the first workflow is reliable. Do not tie assistant lifetime to a CLI session. Do not automatically route model proposals into arbitrary PTYs.

## Data model and contracts

### Extend tasks and the graph, preserving existing IDs

- Keep tasks, task_evidence and task_history. Add obligation version, account/source scope, responsibility, dueAt/timeZone/date basis, lastMeaningfulUpdateAt and nextEvaluationAt. Existing task IDs remain valid; new obligation IDs must not depend on extraction version.
- Keep UI lifecycle (`active`, `snoozed`, `done`, `dismissed`) separate from responsibility (`self`, `other`, `uncertain`) and workflow execution. Initially project richer state through the existing task API for compatibility.
- Add extraction_runs with observation/model/schema versions and evidence-backed proposed changes. Preserve user-corrected fields; reprocessing is not authority to overwrite them.
- Add people/projects/goals and typed task relations such as depends_on, belongs_to and waiting_on. Use relational foreign keys or validated endpoint tables. Relations carry provenance, confidence, validity and confirmation state.
- Reject self-dependencies and cycles for depends_on. Do not merge two obligations just because they share a thread or similar text. Record explicit supersession/merge history and preserve aliases where a reviewed merge occurs.
- Add context facts/preferences with source, confidence, confirmedByUser, validity/expiry and corrections. Expose inspect/edit/delete controls. Store private values through the chosen local protection boundary; never use entity-vault token existence as evidence of a relationship.
- Expand taskGraph() and its renderer with typed edges and bounded neighborhood queries. The planner reads graph repositories, not SVG output.

### Durable coordination

- jobs: type, payload reference, dueAt, status, attempts, lease owner/expiry, dedupe key, input version, last error.
- workflows/workflow_steps: task/goal reference, workflow type/version, step state, next wake, input version, pending approval/action and outcome evidence.
- input_receipts/checkpoints: source event identity, accepted timestamp, processing status and provider continuation state.
- conversations/messages: principal, channel message identity, ordered messages, workflow/task references and clarification state.
- action grants: exact approved action digest, principal, surface, policy version, expiry, freshness preconditions, consumption state and attempt reference.

Transaction boundaries: accept observation + enqueue reconciliation together; apply graph changes + enqueue affected decisions together; record decision/grant + enqueue execution together. Claim jobs with leases and optimistic task versions. Never hold a database transaction across a model or network call.

Execution is at-least-once job delivery with guarded effects, not a promise of exactly-once external operations. Read-only work may retry; ambiguous external writes wait for reconciliation. Persist each action intent before dispatch. A lease expiring does not prove a network operation failed.

## Delivery phases

### P0 — Correct baseline integration and add regression coverage

Files: main.js, telegram.js, host/mail/*, host/policy/engine.js, host/browser/service.js, host/store/sqlite-store.js, host/models/*, host/privacy/gateway.js.

Resolve the ten audit findings above in focused changes. Add connector-specific observations and namespaced identity with a compatibility mapping for existing evidence. Introduce reliable message references and freshness checks. Bound model calls and avoid overlapping sync/ranking work. Verify provider pagination contracts against official documentation during implementation.

Acceptance: calendar preparation reaches approval; Telegram useful/not-useful persists through actual transport wiring; a resolved browser approval cannot dispatch twice; unknown commit outcomes remain unknown; paginated changes survive restart without skipping work; structured Calendar fields survive normalization; private nested payload tests cover recognizer failure.

### P1 — Extract runtime and reliable scheduling

Depends on P0 action/ingestion contracts. Create AssistantRuntime with start/stop/health and commands/subscriptions. Inject clock, providers, store, credentials, model client and transports. Move sync, digest delivery and action business logic out of main.js; leave desktop dialogs and PTYs there.

Add jobs and durable observation acceptance. Use per-account sync serialization and per-obligation evaluation serialization. Persist next wake times and recover abandoned jobs. Drain the existing notification outbox independently of new digest creation. When storage is unavailable, keep board functionality but explicitly pause assistant workflows.

Acceptance: headless fixture startup runs sync/digest; crash/restart replays pending work; a failing connector does not stall all connectors; session-board regression tests remain green.

### P2 — Evolve the task graph and personal context

Depends on P1 storage/job foundation. Introduce schema additions above, incremental extraction and reconciliation, explicit correction precedence, context retrieval and graph queries.

Start with local-only structured extraction; use reviewed fixture data to evaluate changes. Resolve relative dates against source timestamps and user timezone, including DST and all-day events. Keep uncertainty explicit. Evaluate incoming requests and outgoing promises separately rather than inferring responsibility from direction alone.

Acceptance: five related messages update one obligation when appropriate; two requests in one thread stay distinct; old quotes do not recreate promises; corrected/dismissed work is not silently resurrected; graph dependencies update affected deadlines; deleted source data is removed from derived context and queued jobs.

### P3 — Add bounded reasoning and proactive decisions

Depends on P2. Add separate schema-validated model operations: extractObligations, reconcileObligation, proposeNextStep, draftReply and assessOutcome. Ground outputs in source IDs/spans, retrieve only relevant graph neighborhoods, and validate every proposed state transition in trusted code.

Decision output: wait, digest, clarify, draft_follow_up or suggest_resolution, with reason, evidence, confidence and nextEvaluationAt. Approved action types come from the registry, not message content. Initial plans use bounded templates and finite steps; general plan generation can follow measured success.

Apply shared quiet hours, notification budgets, per-task cooldown, deadline policy and connector freshness. Explicit preferences take precedence. Store feedback for evaluation before allowing learned policies to change behavior. Cap steps, model calls, wall time and daily inference usage; surface exhausted budgets as paused work.

Acceptance: shadow-mode decisions are explainable; repeated sync produces no repeated nudge; delayed connector data suppresses stale follow-ups; prompt injection fixtures cannot change permissions or invoke tools; model outage degrades to waiting/deterministic reminders.

### P4 — Durable workflow execution and outcome verification

Depends on P1/P3 and P0 grant fixes. Build the follow-up workflow with states ready, evaluating, awaiting_input, awaiting_approval, executing, waiting_event, verifying, completed, cancelled and needs_attention. Unknown external outcomes live in the action attempt and block dependent progress.

Wrap existing Gmail, Calendar and browser services behind a registry defining input schema, effect class, preconditions, dispatch and verification. Recheck task/thread versions immediately before action. Invalidate old drafts/approvals when a reply arrives, the user edits the draft, or the underlying obligation changes. Do not hold an old approval indefinitely after resolution.

Gmail first: draft → review → send → verify provider outcome → wait for relevant response → reconcile obligation. Sending is not obligation completion. Bound follow-up frequency/count; cancellation stops pending jobs and invalidates unused grants but cannot undo a sent message. For already in-flight operations, reconcile and report the actual outcome.

Acceptance: crash before dispatch, after dispatch, and before receipt persistence; simultaneous approval clicks; out-of-order replies; sender-identical old messages; provider timeouts; revoked account; new reply arriving before send; cancellation while sending. No blind resend and no evidence-free completion.

### P5 — Unified assistant conversation and actionable UI

Depends on P2/P4; message persistence can be developed alongside P3. Add one logical assistant conversation accessible from desktop and Telegram with authenticated channel bindings. Support new request, explain, clarify, edit, snooze, cancel and inspect-memory intents.

Add an explicit assistant mode/command; retain /use and selected-session routing. Persist assistant update IDs before acknowledging processing, with deduplication and age/freshness checks. Do not replay stale legacy shell/session commands on restart. Persist assistant callback references to approval/task/workflow records; regenerate expired review controls with current state.

Display why a nudge happened, supporting graph evidence, waiting state, next check and last verified result. Extend existing graph and Activity views rather than building a disconnected dashboard. Add pause assistant, per-workflow cancel, preference correction and clear-data controls.

Acceptance: start on desktop and continue via Telegram without losing task reference; ambiguous "cancel that" asks which task; stale buttons cannot act; offline assistant messages are recovered without replaying old terminal commands.

### P6 — Independent background host and packaging

Depends on a functioning P4/P5 pilot. First establish one long-lived host per user profile, then make UI startup attach to it. Host owns assistant database writes, schedules, Telegram polling and action dispatch; UI communicates through a versioned authenticated local protocol. Preserve legacy board/hook ports or provide a compatibility route without creating two competing servers.

Run a packaging spike before selecting the launcher. Current constraints: node:sqlite is required despite package.json advertising Node >=18; credentials depend on Electron safeStorage; forge disables RunAsNode; browser bridge and PTY ownership currently sit in the app. Do not assume a plain Node child or a UI-owned child will provide independent operation. Choose a supported packaged host process and credential interface after platform validation; an Electron-based background entry is a candidate, not a settled implementation.

Provide opt-in login startup, UI reconnect, health status, pause/quit semantics, controlled shutdown, update/version handshake, single-instance fencing and crash recovery. Start with one validated platform and release other platforms only after equivalent checks. Preserve agent terminal lifecycle explicitly during host/UI separation.

Acceptance: closing UI leaves monitoring active; reopening does not start duplicate polling; full quit stops host; restart recovers due work; sleep/resume catches up; locked credential store pauses affected actions; upgrade coordinates schema/process versions. Machine-off availability remains out of scope.

## Migration and rollout

1. Add feature flags for shadow decisions, proactive suggestions, reviewed execution and background host. Keep existing digest behavior until replacement is verified; designate exactly one scheduler as notification owner.
2. Back up the database before schema changes. Use additive, transactional migrations, preserve task IDs/evidence/corrections and build new indexes. Compare old/new read projections before switching writers. Retain legacy aliases for namespaced observation IDs.
3. Version queued jobs/workflows and support existing versions across upgrades or pause them for explicit migration. Run one workflow writer at a time. Use lease fencing to reject old workers after restart.
4. Extend export/deletion to every new context, conversation, graph, job and workflow record, including derived evidence. Invalidate pending actions on deletion/disconnection. Do not leave deleted content embedded in queued prompts or notification bodies.
5. Roll back behavior using flags while retaining additive data. Do not run an older binary against an incompatible migrated database; restore a pre-upgrade backup only with an explicit recovery procedure that reconciles external effects.

## Validation and release gates

Preserve the current 35-file suite and add tests at real service/transport boundaries, not merely source-string checks. Browser fixture tests remain fixtures; perform separate sandbox/live acceptance before claiming domain success.

- Unit/contract: schemas, dates, responsibility, graph cycles, correction precedence, privacy and capability checks.
- Integration: persisted acceptance → graph update → decision → approval → execution → receipt → response reconciliation; use fake providers, model outputs and clocks.
- Fault injection: crash around each transaction/network boundary, duplicate deliveries, pagination interruptions, stale leases, expired grants, notification ambiguity and provider revocation.
- Quality evaluation: freeze held-out synthetic conversation sets before tuning. Suggested pilot gate: at least 90% precision on surfaced obligations and follow-up suggestions, with recall separately reported; zero false automatic closures in the release fixture set. These are targets, not current measured results or guarantees.
- Reliability gate: zero repeated external effects in duplicate/restart scenarios, all stale approvals rejected, all ambiguous send cases retained for reconciliation, evidence available for every proposed completion.
- Pilot: shadow → suggestions → reviewed actions → independent host. Measure user dismissals/edits, usefulness, unnecessary interruptions, missed obligations, time-to-resolution and model usage. No autonomous external-write rollout is implied by pilot success.

## First implementation batch

Start with P0 regression tests/fixes and the P1 runtime shell. Then introduce durable jobs and extend the existing task graph before adding planning. The first reviewable product demonstration must complete one follow-up loop, not just render a richer graph or emit a more fluent digest.

This plan governs the next assistant architecture cycle. SIGNAL_BOX_IMPLEMENTATION_PLAN.md remains historical context; its implemented-status claims should not override the audited gaps above.
