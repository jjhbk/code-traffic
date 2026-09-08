# Signal Box — Overview

A small desktop app that shows one tile per Claude Code session. Each tile is lit
by what that session is doing right now. Click a tile to land in that session.

## The problem

Running several coding agents at once means you are no longer sitting in front of
any one of them. You give a session a job, switch to something else, and come
back twenty minutes later to find it has been waiting for you for eighteen of
them.

This isn't a notification problem. A notification fires once and then it's your
memory's problem. A forgotten session is a *state* — it stays true until you deal
with it — and only something persistent can represent it. That's why a physical
traffic light on a desk works so well: it's still red an hour later, and checking
it costs nothing.

Signal Box is that light, on screen, one per session.

## The three states

| Lamp | State | Means |
| --- | --- | --- |
| Green | Working | Claude is running. Go do something else. |
| Amber | Needs approval | Blocked on a permission prompt. Nothing progresses until you act. |
| Red | Finished | Turn ended. It's your move. |
| Unlit | — | Session open, nothing happening. |

Three states, deliberately. Every extra state is another thing to learn and
another judgement call at design time about which bucket an event falls into.

Two consequences worth knowing:

**Red clears itself.** Sending the next prompt fires `UserPromptSubmit`, which
sets the session back to green. There is no "acknowledge" button and no way for
the board to drift out of sync with reality.

**Failures are just red.** A turn that died on a rate limit stopped and it's your
move — same signal, same response. It doesn't need its own colour.

## How it knows

Claude Code fires [hooks](https://code.claude.com/docs/en/hooks) at every point in
a session's lifecycle. Five of them matter here, and each one POSTs to a small
HTTP server inside the app:

| Hook event | Sets the tile to |
| --- | --- |
| `UserPromptSubmit` | working |
| `PermissionRequest` | needs approval |
| `Notification` (permission prompts, agent needs input) | needs approval |
| `Stop`, `StopFailure` | finished |
| `SessionEnd` | unlit |

No polling, no parsing terminal output, no guessing. The agent tells us.

## Why the app owns the sessions

Clicking a tile has to actually take you somewhere. Focusing someone else's
terminal window from outside is unreliable across operating systems and terminal
emulators, so instead the app spawns Claude Code itself into an embedded
terminal. Clicking a tile switches to that terminal inside the app.

Sessions started elsewhere still appear as tiles — the hooks are global — they
just aren't clickable. That's the honest trade, and it's visible in the UI rather
than hidden.

The tie between a hook event and a terminal is a single environment variable.
When the app spawns a session it sets `SIGNAL_TILE` to a fresh id; hook processes
inherit the environment, so the hook hands that id back and the event lands on
the right tile. Sessions without it fall back to matching on `session_id`.

## Sound

Each state change plays a short distinct tone, so you can tell what happened
without looking. Rising for needs-approval, falling for finished, one quiet note
for working. Sound only fires on a change, never on a repeat.

Browsers and Electron both require a user gesture before audio will play, so
there's a one-time "turn on sound" action.

## Deliberately not in v1

Each of these was considered and cut, not forgotten:

- **Escalating re-announcement.** The single strongest feature for the original
  problem — a red tile re-announcing at 90s, 5min, 15min. About fifteen lines.
  First thing to add back.
- **Notification channels** (phone push, watch haptics, messaging). The plan is a
  ladder by distance: board at the keyboard, sound in the room, haptics in the
  building, messaging outside it. All four are the same event going to a
  different sink, so the shape of v1 shouldn't need to change to add them.
- **Stuck detection.** An agent looping on the same test fires no hooks, so it
  stays green while burning spend. Needs a duration heuristic, not a hook.
- **Time estimates.** Green tells you it's working, not whether "working" means
  20 seconds or 6 minutes — which is the thing you actually need to plan around.
- **Non-Claude agents.** Codex, opencode and the rest each need an adapter that
  normalises to the same three states. The board should not know which agent it
  is looking at.
- Review surfaces, diffs, deploys, workflows, anything spatial beyond a grid.

## What success looks like

You start three sessions from the app, close the window's terminal view, and go
do something else. When one needs approval you hear it and see it. You click the
amber tile, answer, and you're back out. You never once wonder whether you've
forgotten a session, because they're all on screen.

If it doesn't do that, the extra features won't save it.
