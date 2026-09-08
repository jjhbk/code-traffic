# Signal Box — Implementation Plan

A build brief for Claude Code. Six phases, each independently verifiable. Do not
start a phase until the previous one's checks pass — the later phases depend on
earlier ones being genuinely working, not just written.

Read `OVERVIEW.md` first for the product reasoning.

---

## Stack

- **Electron** — desktop shell. Needed for embedded terminals and a real window.
- **node-pty** — spawns Claude Code in a pseudo-terminal. Native module.
- **@xterm/xterm** + **@xterm/addon-fit** — renders the terminal.
- No framework, no bundler, no CSS library. The UI is a grid of tiles and one
  terminal view; plain HTML, CSS and DOM are sufficient and keep the whole thing
  readable.

**Node 18+.** Target macOS and Linux first; Windows uses ConPTY through node-pty
and should be tested but not blocked on.

### File layout

```
signal-box/
  package.json
  main.js            Electron main: window, board server, PTY manager
  preload.js         contextBridge IPC surface
  board.js           session state + hook HTTP server (no Electron imports)
  hooks.js           installs/removes hooks in ~/.claude/settings.json
  renderer/
    index.html
    app.js           tile grid, terminal view, routing
    audio.js         earcons
    styles.css
  test/
    board.test.js    plain node, no test framework needed
  README.md
```

`board.js` and `hooks.js` must not import Electron. They are testable with plain
`node`, and that is what makes phases 1 and 2 verifiable before any GUI exists.

---

## Phase 1 — Hooks installer

Build `hooks.js` as a standalone CLI: `--install`, `--uninstall`, `--print`.

It edits `~/.claude/settings.json`. This is the user's real config file, so:

- Back it up to `settings.json.backup` before writing.
- Merge — never replace. Other hooks and all non-hook settings must survive.
- Be idempotent. Running `--install` twice must not duplicate handlers.
- `--uninstall` must leave the file exactly as it was before install.
- If the file exists but isn't valid JSON, fail with a clear message and change
  nothing.

Identify our own handlers by looking for `127.0.0.1:<port>/hook?state=` in the
command string.

### The hook config

Every handler is a `command` hook shelling out to curl, with `|| true` so a
failure never surfaces in Claude Code when the app isn't running. Use shell form
(no `args`) so `$SIGNAL_TILE` expands.

```json
{
  "hooks": {
    "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "async": true, "command": "<CURL state=working>" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "async": true, "command": "<CURL state=approval>" }] }],
    "Notification": [{
      "matcher": "permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog",
      "hooks": [{ "type": "command", "async": true, "command": "<CURL state=approval>" }]
    }],
    "Stop":        [{ "hooks": [{ "type": "command", "async": true, "command": "<CURL state=done>" }] }],
    "StopFailure": [{ "hooks": [{ "type": "command", "async": true, "command": "<CURL state=done>" }] }],
    "SessionEnd":  [{ "hooks": [{ "type": "command", "async": true, "command": "<CURL state=closed>" }] }]
  }
}
```

Where `<CURL state=X>` is:

```
curl -sS -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:4747/hook?state=X&tile=$SIGNAL_TILE" >/dev/null 2>&1 || true
```

Claude Code sends the hook payload as JSON on stdin, which `--data-binary @-`
forwards as the POST body. Hook processes inherit the parent environment, which
is how `$SIGNAL_TILE` gets back to us.

**Done when:** install into a settings file that already contains an unrelated
`PostToolUse` hook and a `permissions` block; confirm both survive, confirm a
second install doesn't duplicate, confirm uninstall restores the original.

---

## Phase 2 — Board and hook server

Build `board.js`. It owns all session state and the HTTP endpoint.

### Session record

```js
{
  key,        // tile id if we spawned it, else session_id
  tile,       // SIGNAL_TILE value, or null
  sessionId,  // from the hook payload
  project,    // basename of cwd
  path,       // cwd with home collapsed to ~
  cwd,
  state,      // 'working' | 'approval' | 'done' | null
  since,      // ms timestamp of the last state change — drives the tile's clock
  created,    // ms timestamp, used for stable ordering
  owned       // true if the app spawned it
}
```

### Endpoint

`POST /hook?state=<state>&tile=<id>` on `127.0.0.1:4747`.

- Reply `200` with an empty body and no delay. That is what Claude Code reads as
  "hook ran, no opinion". Reply *before* processing so a slow board never slows a
  session down.
- A malformed or absent body must not throw — hooks sometimes send nothing.
- Reject anything that isn't `POST /hook` with a 404.
- Bind to `127.0.0.1` only, never `0.0.0.0`.

### Correlation

Key on `tile` when present, otherwise `session_id`. `$SIGNAL_TILE` expands to an
empty string for sessions we didn't spawn, so treat empty as absent.

### State transitions

`state=closed` removes an unowned session entirely; for an owned session it just
sets `state` to `null`, because the tile belongs to a terminal we're still
hosting. Everything else sets the state directly and, if it changed, resets
`since` to now.

Emit a `change` event carrying `{ key, state }` when the state actually changed,
and a bare `change` otherwise. The renderer uses the difference to decide whether
to play a sound.

**Done when:** `test/board.test.js` passes, covering — a session created by hook
alone; tile correlation preferred over session_id; `done` → `working` on the next
`UserPromptSubmit`; `closed` removing an unowned session but not an owned one;
malformed JSON body handled; `since` only moving on a real change. Also verify by
hand with curl while the server runs.

---

## Phase 3 — Electron shell and tile grid

Now the window. `main.js` creates a `BrowserWindow` with `contextIsolation: true`
and `nodeIntegration: false`, starts the board on port 4747, and pushes changes to
the renderer.

### IPC surface

Define it in `preload.js` and keep it to exactly this:

| Channel | Direction | Payload |
| --- | --- | --- |
| `sessions:list` | invoke | → array of session records |
| `sessions:changed` | main → renderer | `{ sessions, changed }` |
| `session:create` | invoke | `{ cwd }` → tile id |
| `session:close` | invoke | `{ tile }` |
| `folder:pick` | invoke | → path or null |
| `pty:data` | main → renderer | `{ tile, data }` |
| `pty:write` | renderer → main | `{ tile, data }` |
| `pty:resize` | renderer → main | `{ tile, cols, rows }` |

### The grid

A responsive grid of tiles, `minmax(220px, 1fr)`. Each tile shows:

- A lamp — a filled circle in the state colour, or a dim ring when unlit
- Project name, prominent
- The path below it, smaller and dimmer
- Time since the state last changed, as `12s` / `4:31` / `1h 20m`

Sort so tiles needing you come first: approval, then done, then working, then
unlit; within a group, longest-waiting first. Tiles the app doesn't own get a
quiet visual marker and no click affordance.

Colours: green `#2fbe6e`, amber `#f2a63c`, red `#e8534a`, unlit `#1b212a` on a
`#10141a` background. Dark only in v1.

An empty grid should say what to do, not sit blank.

**Done when:** the window opens, and firing the phase-2 curl commands by hand
makes tiles appear, change colour, re-sort and update their clocks live.

---

## Phase 4 — Spawning and the terminal view

The part that makes tiles clickable.

### Spawning

`session:create` picks a folder via `dialog.showOpenDialog`, generates a tile id
(`crypto.randomUUID()`), then spawns through node-pty:

```js
pty.spawn(claudeBin, [], {
  name: 'xterm-256color',
  cols, rows, cwd,
  env: { ...process.env, SIGNAL_TILE: tileId }
});
```

Resolve `claudeBin` by looking for `claude` on `PATH`; if it isn't there, show a
clear error naming the problem rather than failing silently. Call
`board.register(tileId, cwd)` immediately so the tile appears before the first
hook fires.

### The terminal view

Clicking a tile swaps the grid for a full-window xterm bound to that PTY. An
Escape key and a visible back control return to the grid. The PTY keeps running
in the background either way — leaving the view must never kill the session.

Wire `FitAddon` to the window resize and send the resulting cols/rows through
`pty:resize`, or Claude Code's TUI will render at the wrong width.

Closing a session kills the PTY and removes the tile. Ask first.

### Degradation

If `require('node-pty')` throws, catch it and run in board-only mode: tiles still
work, spawning is disabled with an explanation. A failed native build should
leave a working app, not a broken one.

**Done when:** you can spawn two sessions in different folders, watch both tiles
go green, click into one, type a prompt, escape back to the grid, and see the
other tile change state independently.

---

## Phase 5 — Sound

`renderer/audio.js`, using WebAudio. No audio files.

- **approval** — two rising tones, 660 → 880 Hz
- **done** — two falling tones, 784 → 523 Hz
- **working** — one quiet 440 Hz note, noticeably softer than the other two

Short (~150ms per tone), sine wave, with an exponential gain ramp so nothing
clicks. Play only when `changed` is truthy, so a repeated event is silent.

Audio needs a user gesture, so keep a persistent "turn on sound" control that
creates the `AudioContext` on click and plays one tone to confirm. Persist the
on/off choice to `localStorage`.

**Done when:** you can identify which of the three things happened with the
window minimised, without looking.

---

## Phase 6 — Finishing

- Remember window size and position between launches.
- `npm start` runs the app; document `npm run install-hooks` in the README.
- `postinstall` runs `electron-rebuild -f -w node-pty`, and must not fail the
  install if it errors — phase 4's degradation covers that case.
- Handle port 4747 already being in use with a message that says what to do.
- Confirm the app quits cleanly, killing every PTY it owns.

---

## Known risks

**node-pty is a native module.** It needs a compiler toolchain and must be
rebuilt against Electron's ABI. This is the most likely thing to go wrong on a
fresh machine. The phase 4 degradation path exists specifically for this — build
it, don't skip it.

**Hook errors are silent by design.** The `|| true` means a broken hook config
looks identical to a working one with no sessions running. When tiles don't
appear, check `node hooks.js --print` against `~/.claude/settings.json` and run
the curl command manually.

**Existing sessions won't have `SIGNAL_TILE`.** Only sessions spawned by the app
get it. Sessions already running when you install the hooks will appear as
unowned tiles on their next turn, which is correct behaviour, not a bug.

**Port collision.** 4747 is arbitrary. Make it configurable via
`SIGNAL_BOX_PORT`, read by both `main.js` and `hooks.js`, since the port is baked
into the installed hook commands.

---

## The first thing to add afterwards

Escalating re-announcement. A tile in approval or done re-plays its tone and
speaks the project name at 90 seconds, 5 minutes, and 15 minutes. It is roughly
fifteen lines in the renderer, and it is the only feature that addresses the
original problem — forgetting a session exists — rather than the easier one of
noticing a change while you're watching.
