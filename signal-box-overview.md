# Signal Box: Overview

*A proactive personal agent that asks before it acts, and finishes what it starts. Draft 2.*

```
ingest        mail · calendar · files · sites · coding agents · payments
   ↓
notice        commitments, deadlines, dropped threads, stalled agents
   ↓
decide        what matters now, and what it would take to finish it
   ↓
ask           Telegram: the real question, its real options, one tap
   ↓
act           within standing limits, through recipes, agents, or payments
   ↓
receipt       what was done, on whose authority, and why
```

Signal Box is an always-on personal agent that runs on the user's own machine. It watches the few services a person actually uses, keeps a durable record of what they owe and are owed, decides what deserves attention now, and comes to them on Telegram when something needs a human. When it acts, it acts inside limits the user set in advance, and it writes down what it did.

It is built boundary-first. The autonomy is real — it books, pays, replies, and drives coding agents — but every capability is reached through an authority check that exists before the capability does.

## Contents

1. [The problem](#the-problem)
2. [The idea](#the-idea)
3. [A day](#a-day)
4. [What exists today](#what-exists-today)
5. [The approval primitive](#the-approval-primitive)
6. [Where work comes from](#where-work-comes-from)
7. [What the cloud is allowed to see](#what-the-cloud-is-allowed-to-see)
8. [The task graph](#the-task-graph)
9. [Proactivity is a budget](#proactivity-is-a-budget)
10. [Why not the alternatives](#why-not-the-alternatives)
11. [What stays with the user](#what-stays-with-the-user)
12. [Risks](#risks)
13. [Related work](#related-work)
14. [Plan](#plan)
15. [Open questions](#open-questions)

## The problem

Two failures, and they turn out to be the same failure.

**Nothing watches your commitments.** A day generates obligations across half a dozen services — a reply you owe, a deadline you agreed to, an order that never shipped, a thread that went quiet waiting on you. Each one lives in a different app, none of them know about each other, and the only thing tracking them is the user's memory. The common outcome is not a dropped ball but a late one, discovered by accident.

**Nothing watches your agents.** Coding agents already run for long stretches unsupervised. They stop for permission or an ambiguous choice and then wait, silently, in a pane nobody is looking at. The more capable the agent, the longer it runs between questions and the more consequential each one is.

Both are the same shape: *something is blocked on a human, and the human does not know.* One is blocked on the user's attention, the other on the user's authority. A system that solves either has most of what it needs to solve both.

The current answer to the second problem is to stop asking. Assistants that push through confirmations are faster and genuinely more useful, and they are also how an agent sends an email nobody sanctioned, keeps data after being disconnected, or acts on an instruction it read in a web page. Removing the question does not remove the decision. It removes the human from it.

## The idea

Signal Box is a local process that does four things.

**It ingests.** Official APIs where they exist — mail, calendar, files. Recorded API recipes for sites that have no sanctioned interface. Lifecycle events from coding agents. Settlement events from payments. Every source is an adapter posting to one local endpoint.

**It remembers.** Everything it notices becomes a task in a durable graph: what it is, who it is blocked on, when it is due, and — always — which message or event created it. Provenance is not optional, because a task the user cannot trace is a task they cannot correct.

**It decides.** A prioritizer ranks the graph by deadline, staleness, and cross-source context. Most of the graph is never surfaced. The output is not a list; it is an answer to "what, if anything, is worth interrupting for right now."

**It acts, within limits.** Reading is free. Reversible actions are logged. Anything that spends money, sends a message, or cannot be undone requires either standing authority the user granted in advance, or a tap.

The surfaces are deliberately few. A desktop **board** shows live state at a glance — agent sessions, pending approvals, what is blocked. **Telegram** is the remote surface and the primary one: it carries questions out and decisions back, and it is where proactive nudges arrive. Both are views over the same state.

## A day

Not aspiration — this is the loop the components are designed to produce.

Morning. One digest: three things due today, one thread where someone has been waiting four days, one agent left amber overnight. Nothing else.

Mid-morning. A coding agent hits a migration that drops columns. The board goes amber; the phone buzzes with the agent's actual question and its actual options. One tap. The agent resumes.

Afternoon. A reply arrives that answers an open question on a task. The task moves from `blocked` to `active` on its own. No notification — nothing is needed from the user.

Evening. A reorder the user set up as a standing intent comes due. It is under the spend limit and the merchant is on the allowed list, so it runs and a receipt appears. No question, because the authority was granted in advance rather than asked for in the moment.

Late. Something unusual: a price forty percent above the last confirmation. That breaks the standing authority, so it becomes a question instead of an action.

The shape to notice: interruptions are rare, and each one is a decision only a human can make. Everything else either runs inside prior authority or waits quietly.

## What exists today

Signal Box is a working application, not a proposal. Being honest about the line matters, because the built part is the hard half of the approval loop and the rest is scaffolding around it.

| Area | State |
|---|---|
| Board, lamp states, persisted sessions | Built |
| Local event server on `127.0.0.1:4747` | Built |
| Claude Code hooks, auto-installed at startup | Built |
| Codex CLI notification adapter, auto-installed | Built |
| Owned PTY sessions, embedded terminal, resume after restart | Built |
| External session discovery (Linux/WSL) | Built |
| Telegram: session picker, prompt, tail, history, interrupt | Built |
| **Telegram: structured questions rendered as inline option buttons** | **Built** |
| Pending question re-sent after restart; stale commands discarded | Built |
| Read-only local history API | Built |
| One-line install, six platform/arch targets | Built |
| Staleness detection for silent agent loops | Built; per-session tuning remains open |
| Event server authentication; keychain secret storage | Authenticated hooks and generalized `/event` built; OS-protected credentials built |
| Ingest connectors (mail, calendar, files) | Gmail with spam/bulk detection, editable Calendar, and selected Drive files built |
| Privacy vault and pseudonymization | Deterministic detectors, persistent encrypted vault, and local entity recognition built |
| Task graph, prioritizer, digest | Deterministic task graph, scheduled digest, and optional local/frontier ranking built; frontier ranking waits for local privacy processing |
| Browser recipe primitives; standing authority; payments | Recipe validation/execution primitives and an allowlisted extension skeleton built with an Uber-style approval example; standing authority and payments excluded |
| Audit log | Redacted append-only lifecycle records cover events, connectors, approvals, execution, notifications, and browser actions |

The bolded row is load-bearing. A question with its real options, delivered to a phone, answered with one tap, returned to the right session — that is the primitive everything else in this document plugs into, and it works today.

## The approval primitive

One object underlies the whole system:

> **An actor wants to take an action it may not take unsupervised. The action, its options, and its consequences are carried to a human, who decides out of band, and the decision returns to the actor with a receipt.**

A coding agent asking which migration strategy to use, a booking flow asking to confirm a fare, a payment about to exceed its cap, and a draft reply awaiting send are the same object with different payloads. Each carries what it wants to do, what it would cost or break, and an enumerated set of options.

Three properties make it safe, and all three are constraints rather than features:

**The actor enumerates the options.** A decision is an option ID, never free text. There is nothing to misinterpret on the way back.

**The actor cannot approve itself.** There is no path from anything an agent reads or produces to an approval. This is the entire prompt-injection defence: hostile content can make an agent *ask* for anything, and can never make it *answer*.

**Requests expire.** Fares move, prices move, branches move. An expired request is re-asked, never assumed.

Building this first — before the autonomy that needs it — is the design choice that separates Signal Box from every assistant that added a confirmation dialog after an incident.

## Where work comes from

Not all sources are equal, and the tier a service falls into should be settled before any code is written for it.

| Tier | What it is | How Signal Box reaches it | Risk |
|---|---|---|---|
| 0 | Official API exists | OAuth, documented endpoints | None; use this always |
| 1 | No API; plain internal calls accepting session cookies | Recorded recipe, replayed in the user's browser | ToS; low volume, low risk |
| 2 | No API; calls signed by the site's own JavaScript | Recipe replayed inside the site's page so its code signs | ToS; account flagging |
| 3 | Heavy bot detection, or mobile-only features | Manual, or UI automation fallback | Out of scope |

**Tier 0 is not a fallback, it is the rule.** Mail, calendar, and files all have official APIs. Recording their internal traffic would be strictly worse on every axis — it breaks without notice, it risks the account, and it buys nothing.

This matters beyond engineering taste. It concentrates ban exposure onto two or three commerce services instead of spreading it across the user's entire digital life, and the tier-0 services are where the most valuable signal lives anyway.

Coding agents are their own category: they report their own state through hooks, so nothing is recorded or inferred.

## What the cloud is allowed to see

Prioritization needs a frontier model. Frontier models are not local. That tension is resolved structurally rather than by promising to be careful.

Sensitive values never leave the machine in plain form. A local vault replaces them with stable pseudonyms before anything is sent: `PERSON_7`, `VENDOR_3`, `PROJECT_2`, `ADDRESS_1`. The mapping is local, persistent, and never transmitted. Responses are rehydrated on arrival.

This works because **ranking needs structure, not identity.** "PERSON_7 has been waiting four days on a deliverable tied to PROJECT_2, which is due Friday" contains everything needed to prioritize. The model never needs to know it is Priya.

Two things make this a real guarantee rather than a hopeful one. Detection is deterministic wherever it can be — emails, phone numbers, addresses, account IDs, and card fragments are pattern-matched, not judged. And where a model is required, it does entity *recognition*, which is a far narrower and more verifiable task than a local model exercising judgment about what counts as sensitive.

The failure mode to design against is pseudonym instability. If a person is `PERSON_7` today and `PERSON_2` tomorrow, all cross-session reasoning silently collapses. Assignment must be stable for the life of the vault.

## The task graph

The graph is the product. Connectors are ingest, recipes are plumbing, the board is a view — the graph is the thing that compounds and the thing a user would lose by leaving.

Every task carries:

| Field | Why |
|---|---|
| `state` | `pending`, `active`, `blocked`, `done`, `dropped` |
| `blocked_on` | Party and since-when. This is the field that generates nudges |
| `due` | Explicit, inferred, or absent |
| `provenance` | Source, message ID, thread, timestamp, extracted span |
| `confidence` | How sure the extractor was |
| `corrections` | What the user changed, and when |

`blocked` with a named party is the most important state in the system, because "someone has been waiting on you since Friday" is the single most useful thing an assistant can say, and no individual app can say it.

Provenance is what makes the system correctable. A task with no traceable origin cannot be verified or fixed; the user can only delete it and lose a little trust. With provenance, a wrong task is one tap to correct — and corrections are the signal that improves extraction.

A six-month accurate record of what you owe whom, with provenance and correction history, is not replicable by a competitor with better integrations. It is the only part of this system that cannot be copied.

## Proactivity is a budget

Proactivity is the feature and the failure mode. An assistant that speaks up unprompted at the right moment feels like a colleague. The same assistant at the wrong moment gets muted, and muted is permanent.

So the interruption budget is a hard constraint enforced in code, never a guideline:

- A **priority floor** below which nothing sends, at all.
- A **daily cap** on non-approval messages.
- **Batching** into one digest at a chosen hour, with interrupts reserved for genuine urgency.
- **Quiet hours**, with approval requests optionally exempt.
- A **"not useful" button** on every proactive message that suppresses that class going forward.

Precision over recall, always. A task Signal Box fails to surface costs almost nothing the user notices. A wrong message at seven in the morning costs the user permanently. The system should be tuned to say nothing when unsure.

## Why not the alternatives

| | Cloud assistant | Self-hosted chat assistant | Signal Box |
|---|---|---|---|
| Setup | Text a number; nothing to run | Install, config, keys, 24/7 machine | Install; connect what you use |
| Where data lives | Vendor's servers | Your machine | Your machine; pseudonymized before any API call |
| Authority model | Broad standing authority, few gates | Per-tool, ad hoc | Explicit limits, enumerated options, expiry, receipts |
| Proactivity | Yes, model-driven | Cron | Priority floor and enforced interruption budget |
| Coding agents | No | As a tool | Native; lifecycle events, not scraped output |
| Reading many states | Messages | Messages | One glance at a board |
| Audit | Vendor's | None | Append-only, reconstructable |

The honest reading: the cloud assistant wins decisively on onboarding, and that advantage is real and large. Signal Box's counter is not breadth of integration — that race goes to whoever ships fastest. It is that the authority layer exists before the autonomy, which is exactly the gap that produces unapproved sends, retained data, and successful injections.

## What stays with the user

> **Some decisions should never be made by the system, and the design should make routing around them awkward rather than convenient.**

**Login and identity.** Passwords, one-time codes, and two-factor prompts are always manual. Signal Box detects an expired session and asks; it never automates authentication.

**Payment authorization.** Bank confirmations and card or UPI approval stay with the user. Standing spend authority can make small, repeated, in-limit payments automatic; the limits themselves are always set by hand.

**Anything irreversible.** Orders, bookings, cancellations, sends, and destructive operations require explicit approval unless covered by standing authority that names that specific class.

**Anything that changed.** A price or state materially different from what was last confirmed invalidates prior authority and becomes a question.

**Approval itself.** Out of band, always. An agent may request it and can never grant it.

## Risks

### A wrong board is worse than no board

A green tile over a hung agent is a confident lie, delivered precisely when the user has walked away and is relying on it. Silent loops are currently undetected. This is the highest-priority correctness work in the system.

### Extraction precision decides everything

If the task graph fills with junk, no integration saves the product. The failure is subtle: a plausible-looking wrong task is worse than a missing one, because it costs attention and erodes trust in the whole list. Extraction must be tuned for precision, must surface confidence, and must make correction one tap.

### The Telegram token is a remote execution credential

Terminal sessions run shell commands, and Telegram drives them. Anyone holding the token and the chat binding can run commands on the machine. It is currently stored in plaintext in the application data directory.

### Content transits a third party

Prompts, questions, output, and digests pass through Telegram's servers. For proprietary work this is disqualifying, and it must be stated before pairing rather than discovered after.

### Recipes break, and accounts get flagged

Internal APIs are not a contract. Signal Box must detect that a response no longer matches what was recorded, stop before acting, and ask for a re-record. Call rates stay close to human use, and nothing runs in bulk.

### Prompt injection through ingested content

The agent reads mail and web content, all of it untrusted. The enumerated-option decision path is the structural defence: hostile content cannot produce an approval. This holds only as long as free-text approval is never added as a convenience.

### First-party competition

Agent vendors are building remote surfaces for their own agents. Signal Box cannot win as remote control for one vendor's agent. It can win as the one place every agent, every recipe, and every payment reports to — which no vendor will build.

## Related work

Cloud personal agents use a trained model to operate a phone and computer, and lead decisively on onboarding and task completion; their reported failures are authority-boundary failures. Self-hosted assistants offer breadth of messaging channels and plugins, with chat as the only surface. Browser agents operate sites through their interfaces, which is general but slow, expensive, and fragile. Integration-generation projects turn captured traffic into code without an execution or authority model. Terminal multiplexers show sessions and know nothing about agent state.

Signal Box's angle is the combination: local data with pseudonymized escalation, one approval object shared across agents, sites, and payments, a durable task graph with provenance, glance-first supervision alongside a remote surface, and vendor neutrality as the organizing constraint.

## Plan

Each phase ships something usable on its own. Nothing depends on a later phase to be worth running.

| Phase | Goal | Done when |
|---|---|---|
| 0. Correctness | Staleness detection, event-server auth, keychain secrets, verified prompt delivery | A hung agent is visibly not-green within the bound; no plaintext secret on disk |
| 1. Vertical slice | Mail via official API → extraction → task graph → prioritizer → one daily digest → close a task from Telegram | A week of digests where most items are right and wrong ones are correctable in one tap |
| 2. Privacy | Deterministic detectors, local entity recognition, stable vault, rehydration | No unpseudonymized identifier leaves the machine, demonstrably |
| 3. Protocol | Approval request extracted from PTY assumptions; consequences; expiry; single resolution | A non-CLI actor gets a decision through the same path |
| 4. Policy and receipts | Standing authority, desk-only classes, append-only audit log | A destructive action cannot be approved from a phone; a month of approvals is reconstructable |
| 5. Reach | Calendar and files; browser recipes for read-only lookups | An agent answers order-status questions without opening a site |
| 6. Acting | Reversible writes, then committing actions with confirmation and duplicate protection | One real task completed end to end with one approval |
| 7. Spend | Standing spend authority with per-transaction and period caps, receipts | A recurring purchase runs in-limit; an out-of-limit one becomes a question |
| 8. Multi-user | Shared board, shared queue, per-user identity on decisions | Two people supervise one set of actors with no double-resolution |

## Open questions

**What is extraction precision on real mail?** Everything downstream is worthless if the graph is wrong, and this is knowable in two weeks rather than argued about.

**Is the board or the phone the product?** If remote approval is what people cannot live without, the board is a feature and the framing inverts.

**How much standing authority will anyone actually grant?** The design assumes people will set spend and action limits in advance. If they will not, every action needs a tap and the proactive half is much weaker.

**Where does the desk/phone line fall?** Some approvals should require a keyboard. The rule needs an owner and a written home.

**How much history should leave the machine?** Completion messages and digests carry content, which is what makes them useful and what makes the transit boundary consequential.

**Personal tool or product?** A product raises the stakes on terms of service, on support for many sites, and on holding other people's task graphs.

---

*See the companion technical document for the event model, vault design, task schema, approval protocol, and execution model.*
