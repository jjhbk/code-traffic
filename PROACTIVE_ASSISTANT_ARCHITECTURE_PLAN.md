# Signal Box: durable proactive assistant migration

Updated: 2026-09-17. Current source baseline: package version 1.0.17.
Status: partially implemented foundations, not a complete proactive assistant. Jobs, workflows, context records, task relations, conversation handling and a parent-dependent background worker exist. Their presence does not establish reliable understanding, independent operation, or autonomous execution. The delivery plan below supersedes the earlier implemented-status claim and the historical phase boundaries later in this document.

## Current delivery plan: the assistant we are building

### Product contract

Signal Box continuously observes sources the user explicitly connects, maintains evidence-backed personal context and unfinished obligations, chooses useful next steps, and executes supported tasks within explicit permission. It asks only when information or authority is missing, verifies external outcomes, and follows up until the obligation is resolved or the user stops it.

“All context” means consented, relevant context, not unrestricted capture. “Automatic” means covered by a standing permission, not unrestricted tool access. Electron is the assistant core: it owns ingestion, memory, inference orchestration, planning and task execution. A separately built React Native mobile app is the primary interaction surface and supplies opt-in precise location and other sensor context. The Electron background runtime must continue with its window closed; its computer must remain running and connected for ongoing assistant work. Machine-off execution is not part of this architecture.

Instinct is a behavioral reference, not an architectural specification. Its [official description](https://instinct.com/) establishes its claimed direction; it does not establish its internal implementation or universal reliability. This plan is based on our code and desired outcomes.

### Source-checked baseline

The following findings come from a targeted source inspection on 2026-09-17, not a fresh test run or live-provider certification.

| Existing implementation | Reuse | Required change |
| --- | --- | --- |
| `host/tasks/extract.js` | Candidate/evidence interface | Regex extraction produces one candidate per observation, infers owner from direction and retains relative date words; introduce multi-obligation structured extraction |
| `host/store/sqlite-store.js` | Tasks, evidence, corrections, context, jobs, workflows, graph relations | Obligation reconciliation must distinguish multiple requests in one thread; relation endpoints currently only accept tasks |
| `host/proactivity/service.js` | Decision interface | Replace a few fixed rules with grounded, bounded next-step planning plus deterministic eligibility checks |
| `host/policy/engine.js` | Capability boundary | It rejects `autonomous: true`; add narrowly scoped standing grants rather than removing the guard |
| `host/workflows/` | Durable records and job runner | Enforce transitions, event freshness, lease fencing, action reconciliation and evidence-backed completion |
| `host/browser/` | Recipe format, bridge, approval consumption | Two Uber recipes exist; step completion currently becomes confirmation without a business postcondition |
| `host/conversation/service.js` | Message persistence and explicit preference commands | Replace regex-only handling with grounded intent handling and shared principal context across channels |
| `host/runtime/background-host-worker.js` | Scheduling shell | Connector jobs call the parent; parent disconnection exits the worker. Move execution ownership into an independent host |

### Architecture and ownership

```text
Consented connectors / conversation / timers
                    ↓
Durable event inbox → context + obligation graph
                    ↓
Decision service → versioned workflow plan
                    ↓
Policy + standing grant / one-time approval
                    ↓
Typed action registry → provider API / browser recipe
                    ↓
Outcome verifier → graph update / event wait / attention
                    ↓
Shared conversation + notification outbox
```

Keep SQLite and existing domain modules in the Electron core. Its background runtime owns authoritative assistant state and execution; mobile is the primary authenticated interaction client, with desktop UI and Telegram as additional surfaces. Inference may use configured local or remote models, but orchestration and authority stay in the Electron core. The model proposes typed changes and plans; trusted code validates evidence, transitions and permissions. Imported text and web pages never confer authority. Do not connect a planner to arbitrary terminal sessions.

The task graph answers what matters and what blocks it. A workflow records how the assistant is working on it. An action attempt records an external effect. A receipt records evidence. These are linked records, not interchangeable statuses: sending a follow-up does not complete the underlying obligation.

### Mobile-first product boundary (2026-09-17 requirement)

Build the React Native application as a separate project with its own build, tests and release lifecycle. Do not embed the Electron renderer or depend on Electron IPC. Exact repository names and mobile framework/tooling choices remain implementation decisions; this plan does not authorize provisioning infrastructure or publishing an app.

| Component | Owns | Boundary |
| --- | --- | --- |
| React Native app | Conversation, attention inbox, approvals, goals, memory controls, precise location/sensor capture with consent, offline cache | Connects to the paired Electron core; no direct SQLite access or independent task execution |
| Electron background core | Ingestion, personal graph, inference, planning, durable workflows, policy, verification, notification outbox | Runs without an open desktop window; requires its host computer to be available |
| Local execution workers/browser bridge | Provider actions and browser recipes under core-issued authority | Depend on required local browser sessions and credentials; report unavailable dependencies |
| Electron desktop UI | Configuration, diagnostics, desktop interaction and existing session board | Uses the same core and state as mobile; not required to stay visible |
| Optional connectivity relay/push gateway | Remote transport and notification routing | No planning, authoritative memory, provider credentials or task execution |

Share versioned API contracts and a small generated or published client package, not desktop UI/runtime code. Separate the Electron core from its renderer lifecycle, not from the Electron product. Keep credentials, graph state and browser execution on the host. For mobile access away from home, choose an authenticated encrypted direct connection or an outbound relay transport after a connectivity spike. A relay is transport only, not a hosted assistant; do not expose existing local control ports publicly.

Electron remains a complete, independently usable first-class client. Feature parity is required for assistant conversation, Today/attention views, task and workflow inspection, approvals, cancellation/pause, memory and preference management, connected-source setup, browser-session controls, diagnostics, export/deletion and existing session-board functionality. The mobile app is the preferred daily surface and contributes mobile context; it is not a reason to remove or permanently hide any Electron capability. Both clients operate on the same authoritative core state and show the same verified workflow outcomes, with surface-specific controls where the device allows them.

Mobile/Electron-core contract:

- Explicit pairing to an Electron profile, per-device credentials, revocable sessions and strict profile isolation. The core authorizes every task, context record, grant and workflow reference. Relay use must not weaken device authentication or payload confidentiality.
- Versioned APIs for conversation, goals/tasks, workflow state, approvals, standing permissions, memory, context ingestion and notification preferences. Use idempotency keys, entity versions and cursor-based reconnect synchronization.
- Persist mobile commands in an offline outbox and show pending versus core-accepted state. Never display an offline approval as executed; revalidate expiry, workflow version and policy after delivery. Show host offline/last-seen status and sync safely when it returns.
- Push notifications point to durable core records; keep sensitive content out of payloads by default. Opening an approval retrieves current state and authenticates the device/user. Duplicate or late notifications cannot authorize stale work. A delivered notification does not prove the core is currently online.
- Precise location events carry observation time, receipt time, accuracy, provenance and consent scope. Support precise coordinates where the user enables them; derive meaningful places/arrival events and limit raw-history retention. Stale or uncertain location is not evidence that the user is currently at a place.
- Add a typed sensor-event contract for explicitly selected signals such as motion/activity or device state, recording units, accuracy, sampling/source metadata and consent. Do not assume every sensor is accessible in the background. Batch and deduplicate uploads, bound offline storage, and apply retention/expiry before replaying events.
- Make each location/sensor source optional, revocable and purpose-specific, with retention/deletion controls and an explanation of each context-triggered suggestion. Validate availability, background delivery, permissions and battery behavior on real iOS/Android devices against current platform documentation during the mobile spike; do not promise uninterrupted phone telemetry.
- Keep provider credentials and model secrets out of the mobile bundle. Separate account connection, context-sharing consent and action authorization; granting location access does not grant permission to book a ride.

Initial mobile experience: a Today/attention view, assistant conversation, active work with next-check status, and a controls area for memory, connected sources and permissions. Show what needs the user, what is being handled and what was verified complete. The graph remains underlying state, not mandatory navigation.

First location-aware scenario: “When I arrive home, remind me about an unresolved pickup/return.” Combine a fresh consented place event with an active obligation, respect cooldowns, and issue one useful nudge. Later combine calendar and location for departure suggestions; add ride execution only under separate explicit constraints and verified recipes. Measure usefulness and interruption cost, not just notification volume.

Delivery tracks:

1. Now: define core API, pairing and identity contracts alongside execution hardening; decouple core operation from the Electron window. Spike secure remote connectivity and push delivery without relocating assistant execution.
2. After the first reviewed workflow: build the separate mobile app for conversation, workflow status, approvals and push against the paired Electron core. The pilot must work with the desktop window closed and the core still running.
3. After policy/recipe gates: expose scoped automatic actions and existing local browser execution through the core. Report host/browser unavailability clearly instead of promising execution.
4. Add precise-location ingestion, selected sensor adapters and the arrival-reminder scenario; validate denied/revoked permissions, delayed/duplicate events, offline delivery, stale-context suppression and battery impact.
5. Before release: test pairing impersonation/replay, device revocation, profile isolation, export/deletion, encrypted secrets/backups, reconnect recovery and remote connectivity. Select relay infrastructure and costs explicitly if needed; it must remain a transport dependency only.

Mobile product acceptance: after installing/running Electron and pairing the phone, the user can perform daily interaction primarily on mobile: discuss goals, inspect/correct memory, approve or revoke authority, supply consented sensor context, receive useful notifications and inspect verified outcomes. Closing either UI must not stop the Electron background core. Sleeping, powering off or disconnecting its host pauses unavailable work; mobile shows that state, queues eligible input and never claims tasks executed. Restart/resume catches up without stale actions or duplicate effects.

### Delivery sequence and acceptance gates

Each batch ends with integrated behavior and tests. A module or passing fixture alone is not a completed capability. Batches 1–6 produce the first bounded automatic assistant; batch 7 separates hosting from the UI; batch 8 expands context coverage. The mobile delivery tracks above run alongside these batches, with service/API design starting immediately rather than after desktop completion.

#### 1. Establish trustworthy persistence and execution contracts

Primary files: `host/store/sqlite-store.js`, `host/workflows/job-runner.js`, `host/workflows/service.js`, `host/mail/*`, `host/browser/service.js`, `host/approvals/service.js`.

- Re-audit historical P0 findings against current code and add behavioral regression tests before declaring them fixed.
- Make observation acceptance + reconciliation enqueue, graph updates + decision enqueue, and authorized intent + execution enqueue transactional.
- Introduce explicit action states: prepared, authorized, dispatched, verifying, confirmed, failed-before-effect, unknown. A transport timeout after dispatch must not become a retryable failure.
- Enforce workflow transition tables, version checks, cancellation semantics, job lease renewal/fencing and handler deadlines. Avoid batch-claiming more jobs than can execute before leases expire.
- Persist source/account identity, event timestamps, bootstrap/change checkpoints and freshness. Ensure pagination, replay, deletion and interrupted synchronization do not silently skip evidence.
- Preserve existing IDs, corrections and receipts through additive migrations; back up before migration and test upgrades from a v1.0.17 database fixture.

Gate: crashes at each persistence/network boundary, duplicate events and simultaneous approval clicks never cause blind repeated effects. Unknown outcomes remain visible and block dependent actions. Existing board/session behavior remains intact.

#### 2. Make the task graph a reliable personal understanding layer

Primary files: `host/tasks/extract.js`, `host/tasks/service.js`, `host/store/sqlite-store.js`; new `host/context/service.js`, `host/tasks/reconcile.js`, and structured model-operation schemas.

- Add validated `extractObligations` and `reconcileObligation` operations, returning multiple obligations with source spans, responsibility, confidence and proposed changes. Keep deterministic fallback conservative.
- Resolve dates against source time and user timezone. Store `dueAt`, timezone, original expression and uncertainty; distinguish deadlines from scheduled appointments.
- Preserve task IDs; replace thread/subject/direction-based identity as the sole merge rule. Track aliases and reviewed merges/splits. Keep two promises in one thread separate.
- Extend context records with typed people, goals, projects, preferences and commitments; add validated entity endpoints and provenance to graph relations.
- Normalize dependency direction (`depends_on` with `blocks` as its inverse), prevent dependency cycles, and reevaluate affected graph neighborhoods when evidence changes.
- Store validity, confidence, confirmation and correction history. User corrections override model inference. Add inspect/edit/forget operations and deletion of derived context.
- Retrieve only relevant context; do not send the entire inbox or memory store to every model call. Apply the privacy gateway recursively and pause remote reasoning if its required protections fail.

Gate: held-out examples cover multiple requests, quotes, changed deadlines, delegation, contradictory evidence, old replies, corrected preferences and deletions. Target at least 90% precision for surfaced obligations; report recall separately. This is a proposed release threshold, not a current result.

#### 3. Deliver one complete reviewed workflow and natural conversation

Primary files: `host/conversation/service.js`, `host/workflows/follow-up.js`, `host/proactivity/service.js`, `host/actions/mail-reply.js`, `main.js`, `telegram.js`.

- Add grounded intents: create goal, explain, clarify, correct, authorize, pause, cancel and inspect memory. Resolve pronouns against persistent references; ask when ambiguous.
- Bind desktop and Telegram to the same authenticated principal and shared task/workflow context. Deduplicate channel message IDs in storage, not a recent-history scan. Preserve explicit legacy session routing.
- Implement the first loop: detect unanswered commitment → check fresh thread state → draft → review → send → verify sent identity → wait for a relevant newer reply → assess whether the obligation was actually resolved.
- Invalidate stale drafts and approvals when the thread or user instructions change. A generic incoming message is not sufficient reply or completion evidence.
- Expose evidence, current step, next check, waiting reason and cancel controls in the existing UI. Conversation replies must describe persisted actions, not merely claim to have scheduled them.

Gate: start on desktop, approve from Telegram, restart during waiting, ingest an out-of-order reply and continue correctly. An unrelated or pre-send message cannot close the task. No natural-language promise without a corresponding durable record.

#### 4. Add bounded planning and scoped automatic execution

Primary files: `host/proactivity/service.js`, `host/policy/engine.js`, `host/approvals/service.js`; new `host/actions/registry.js`, `host/planning/service.js`, `host/policy/standing-grants.js`.

- Registry entries define typed inputs/outputs, effect class, permission requirements, freshness checks, dispatch, verification and reconciliation. Prefer provider APIs where available; use recipes for web-only actions.
- Plans contain a goal/task reference, versioned steps, dependencies, event waits, completion criteria, evidence references, budgets and stop conditions. Begin with bounded workflow templates, not arbitrary generated code.
- Decision types: wait, ask, notify, propose plan, execute authorized step, verify, stop. Validate all model output and use deterministic policy checks outside prompts.
- Add opt-in standing grants with principal/account, capability, recipient/domain/site, recipe version/digest, constraints, expiry, maximum uses, cooldown, per-action cost and aggregate spending limits where relevant.
- Atomically reserve grant usage/budget before dispatch; settle or reconcile it afterward. Concurrent workflows must not independently spend the same remaining budget.
- Recheck grants and live preconditions immediately before a committing action. Revocation stops pending work; in-flight effects must be reconciled and reported.
- Default to automatic reads/local preparation; permit external writes only within explicit standing grants or one-time approval. Keep destructive operations, payments, public posting and new recipients approval-required until individually supported and opted in.
- Apply attention budgets, quiet hours, per-obligation cooldowns, data-freshness checks and bounded inference/action costs. Page/email prompt injection cannot modify grants or register tools.

Gate: a user can authorize a bounded follow-up policy once and observe eligible messages sent without repeated approval. Expired, revoked, recipient-mismatched, over-budget or stale actions stop. The same planner works in shadow, reviewed and authorized-auto modes.

#### 5. Turn browser recipes into verified workflow tools

Primary files: `host/browser/recipes.js`, `host/browser/executor.js`, `host/browser/service.js`, bridge/adapter and extension code; add a recipe registry and domain-verifier tests.

- Version recipes with strict input/output schemas, allowed origins/navigation, login prerequisites, read/prepare/commit boundaries, timeouts, retry policy, rate limits and business postconditions.
- Replace generic string-to-number coercion with schema-specific parsing, including zero values, currency and locale. Validate final price, destination, time and other authorized fields immediately before commitment.
- Persist checkpoints and commit intent. Read-only steps may retry; committing steps require reconciliation after an uncertain outcome. Do not interpret a completed click as a completed booking.
- Add domain receipts: provider confirmation ID, status, relevant details and observation time. Confirm through a domain status page/API or corroborating message when available; otherwise retain uncertainty.
- Scope browser permissions to supported sites. Explicitly handle browser closed, logout, CAPTCHA, MFA, layout drift and session mismatch as waiting/attention states; do not bypass challenges.
- Start with the existing Uber quote recipe as a non-committing integration exercise. Do not certify ride booking until a separately authorized live test verifies the real result.
- Build availability-watch plus reservation recipes on a controlled fixture site, then select and validate one supported live service before advertising it. Unsupported sites produce a clear limitation, not an improvised committing script.

Gate: a goal selects a registered recipe, supplies grounded inputs, waits for availability, checks permission, executes and verifies the domain result. Tests cover changed prices, selector drift, duplicate wake-ups and a timeout after commitment. Live validation is separate from fixture success.

#### 6. Prove proactive behavior with three complete workflows

| Workflow | Behavior | Proof of success |
| --- | --- | --- |
| Commitment follow-up | Notice overdue response, draft/send within a standing permission, watch for relevant reply | Verified send, bounded follow-up count, evidence-backed obligation update |
| Availability watcher | Remember requested dates/options, check a supported site at permitted intervals, reserve within explicit constraints or ask | Durable multi-day wait, rate limits, final constraint check and reservation confirmation |
| Meeting preparation | Detect upcoming event, retrieve relevant consented messages/documents, prepare a sourced brief and deliver at a useful time | Rescheduling/cancellation updates the workflow; brief arrives once with evidence |

- Each workflow must begin from context or a natural-language goal and use the same graph, policy, executor and notification infrastructure.
- Route notifications into needs-your-attention, waiting, and completed outcomes. Batch low-priority updates and explain why an interruption is necessary.
- Keep dependent work blocked until its prerequisite has verified completion. Replan on relevant changes without silently broadening authority.

Gate: integration tests with fake clocks/providers plus a consented pilot demonstrate each full loop. Document which steps are real, simulated or unsupported. Never equate “message sent” with “commitment fulfilled.”

#### 7. Make the assistant independent of the desktop UI

Primary files: `host/runtime/*`, `main.js`, credential adapters, browser bridge, packaging and installer configuration.

- Run an early packaging/credential feasibility spike alongside batches 1–2; deliver host separation after the first integrated workflow is stable.
- Move connector execution, model calls, scheduling, Telegram handling, policy and action ownership out of UI-parent callbacks. The host must start without a renderer or parent IPC requirement.
- Use one host/writer per profile with authenticated, versioned local IPC and explicit client identity. Prevent duplicate connector pollers, browser bridges and action workers.
- Provide opt-in login startup, restart supervision, health, pause, full stop, UI reconnect, sleep/resume catch-up and compatible update/schema handshakes. Validate credential access while locked and after login.
- Distinguish host availability from browser availability: a live host cannot execute a recipe if its required browser/session is unavailable. Show that dependency and resume safely.
- Keep this background host part of the Electron application and local profile. Expose a separately authenticated mobile-facing protocol, validate pairing/remote transport/push, and retain local credentials and browser workers. Independent here means independent of the renderer/window, not a cloud service replacing Electron.
- Certify one platform first, then repeat packaged lifecycle tests for each advertised platform. Preserve PTY/session lifecycle separately.

Gate: closing the UI does not interrupt execution; killing/restarting the host recovers work; reopening starts no duplicate workers; full stop prevents new dispatches. An unattended seven-day pilot completes due checks with downtime visible, no duplicate effects, and every workflow in an explainable state.

#### 8. Expand context and availability without weakening controls

- Extend consented ingestion from Gmail/Calendar and selected Drive content to chosen messaging/work tools and user-selected documents. Track source coverage, last sync and staleness explicitly.
- Add source-specific retention, exclusion and deletion controls. Forget/disconnect invalidates dependent pending plans and grants where appropriate; minimize sensitive content retained in audit records.
- Introduce location, screen or audio context only as separate, explicit opt-ins with visible capture controls. These are not prerequisites for the first useful release.
- Machine-off execution is out of scope: Electron is the execution core. Make host availability visible, support opt-in login startup and safe sleep/resume recovery, and explain that continuous assistance requires an available host. A transport relay cannot execute queued work while that host is offline.
- Phone calls, general computer use and arbitrary websites are later capability tracks with their own consent and verification work, not included in the first browser-recipe release.

### Rollout, measurement and definition of done

Roll out each capability through shadow decisions → suggestions → reviewed actions → narrow standing permissions. Keep independent kill switches for planning, external writes, individual connectors and recipes. Logs should connect observation, decision, workflow, grant, attempt and receipt without exposing secrets.

Required release checks:

- Existing test suite plus behavioral service/transport integration tests; do not use source-string assertions as execution proof.
- Adversarial permissions tests: prompt injection, stale approvals, changed recipe digests, revoked grants, concurrent budget use and cross-account confusion.
- Fault injection around dispatch/receipt persistence, lease expiry, duplicate events, connector gaps and model/provider outages.
- Held-out obligation/decision quality measurements; no evidence-free automatic closures in the release fixtures. Track missed obligations as well as precision.
- Measured notification usefulness, corrections, unnecessary interruptions, workflow success rate, unknown-outcome rate, latency and daily model cost.
- Explicitly authorized live-provider checks and packaged lifecycle tests. Do not send mail, spend money or make bookings merely to validate a build.

The assistant-engine milestone is complete only when all three batch-6 workflows operate through the Electron background core, client controls work, at least one narrowly authorized external action runs without per-action approval, browser outcomes are verified, and the pilot gates pass. The target mobile product additionally requires the separate React Native app, secure pairing/remote connectivity, consented precise-location and selected sensor context, and the mobile acceptance gates above. Broad context capture and arbitrary-site automation remain separate milestones.

### First implementation batch to start next

1. Add failing behavioral tests for an old incoming message waking a new follow-up, browser timeout after commitment, and a long-running job outliving its lease.
2. Implement action outcome states, lease fencing/renewal and fresh-reply matching; wire them through existing services.
3. Add the migrated-database regression fixture and a single end-to-end reviewed follow-up test with restart injection.
4. In parallel, define mobile/core API and pairing contracts, run the Electron background-lifecycle and remote-connectivity spike, and freeze the held-out understanding evaluation dataset.
5. Run the existing suite plus new tests, document results and commit the batch. Do not tag a capability release until its acceptance gate passes.

Implementation estimates should follow this first batch and the host spike; no percentage-to-Instinct or calendar promise is justified by module counts. This document is a plan, not evidence that these capabilities have shipped.

## Historical migration design (retained for reference)

The sections below describe the earlier 1.0.16 migration proposal. Some foundations have since landed; historical findings require revalidation. Where scope differs (especially autonomous writes and independent hosting), the current delivery plan above takes precedence.

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

### Audit status and remaining gaps (updated 2026-09-17)

1. **Calendar authority — implemented locally.** `calendar.update` is registered by policy, approval is required, provider edits use etags, and desktop/mobile dispatch consume the approval. Live Google Calendar conflict and guest-notification behavior still require sandbox validation.
2. **Approval consumption — implemented for supported writes.** Browser, Gmail, and Calendar dispatch claim one execution attempt transactionally before provider work. Gmail and Calendar now share `host/actions/execution-service.js`, which owns preflight validation, claim/transition/receipt sequencing and unknown-outcome retention; unknown outcomes remain reconcilable. Broader action-registry coverage is still needed as new providers are added.
3. **Digest feedback — implemented.** Telegram feedback uses deterministic notification-bound callback IDs and writes through the durable notification feedback store. Other Telegram callback mappings and update offsets remain process-local.
4. **Connector pagination — partially implemented.** Gmail history/bootstrap and Calendar page continuations now use versioned opaque cursors and have restart fixtures. Drive page tokens remain provider cursors and need explicit bootstrap/change checkpoint semantics, deletion handling, and interruption tests.
5. **Observation contract — implemented for current providers.** Calendar structured fields are retained by normalization and observation identity is scoped by adapter/account. New connectors must preserve the same provider/account/version contract.
6. **Send verification — hardened.** Gmail sends carry an attempt marker; reconciliation can require that marker and also checks send time and account identity before falling back to content matching. A provider sandbox test remains required.
7. **Browser execution — bounded verification implemented.** The Uber booking recipe now requires a confirmation postcondition, and missing confirmation fails rather than becoming success. General browser intelligence and live-provider markup/booking validation remain out of scope for fixtures.
8. **Scheduling/model work — partially implemented.** Model ranking is skipped outside an eligible digest slot and JSON model clients have request timeouts. The background worker now owns deterministic proactive eligibility and attention-notification enqueueing, binding delegated execution decisions to task versions; dirty-source scheduling, concurrency budgets, and frontier worker cancellation still need hardening.
9. **Telegram durability — improved, still partial.** Assistant messages, digest feedback, polling offsets, generated callback mappings, and processed update IDs now persist in SQLite with chat scoping, expiry, claim/consume semantics, and restart coverage. Claimed `/assistant` updates recover after a crash while legacy terminal/session commands remain non-replayable; approval/action execution still depends on the Electron-owned provider and terminal bridges.
10. **Privacy boundary — partially implemented.** Nested payloads are recursively sanitized and frontier paths fail closed when local recognition is unavailable. Local regex fallback remains intentionally conservative, not an anonymity guarantee; broader private-operation schemas and deletion audits remain required.

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
