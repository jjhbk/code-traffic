# Code Traffic Demo Video Recording Plan

This checklist covers the source footage for the `code-traffic-demo` video.

## Recording specifications

- Record at 1920×1080, 30 fps if possible.
- Capture clean screen recordings with no microphone audio.
- Hide API keys, tokens, private messages, personal data, repository secrets, and sensitive file paths.
- Use a stable window layout and avoid unrelated notifications.
- Keep the cursor visible when demonstrating an interaction, but move it deliberately.
- Record each segment as a separate video file.
- Leave several seconds of still footage before and after each action.
- Name the files as follows:
  - `segment-01-overview.mp4`
  - `segment-02-statuses.mp4`
  - `segment-03-hooks-terminal-telegram.mp4`
  - `segment-04-final-board.mp4`

## Segment 1 — Many agents, one board

Suggested source length: 20–30 seconds.

Record:

1. Open Signal Box / Code Traffic.
2. Show several Claude Code and/or Codex CLI sessions visible on the board at once.
3. Leave the full board visible while the sessions remain active.
4. If possible, let one or more tiles visibly change state.
5. Slowly move the cursor across the overview, then pause on the complete board.

The strongest moment is a clean wide shot showing multiple sessions in one place.

## Segment 2 — Status at a glance

Suggested source length: 20–30 seconds.

Record the session-state indicators and their meanings:

1. A `Working` session with the green lamp.
2. An `Approval` session with the amber lamp.
3. A `Done` session with the red lamp.
4. An `Idle` session with the unlit lamp.
5. Hold each useful state on screen for at least 3 seconds.
6. Keep the relevant tile large and readable where possible.

If all four states cannot be shown in one continuous take, capture separate takes in
the same file. Avoid loading screens, rapid clicking, and unrelated UI changes.

## Segment 3 — Lifecycle hooks and embedded terminal

Suggested source length: 25–35 seconds before Telegram footage.

Record:

1. Start or use a Claude Code or Codex CLI session.
2. Let Signal Box receive a lifecycle event through its local hooks.
3. Show the corresponding board tile appearing or changing state.
4. Select the session tile.
5. Create or reopen the owned embedded terminal.
6. Run a harmless command such as `pwd` or `echo demo`.
7. Show the terminal responding.

The strongest sequence is the event arriving on the board, followed by the terminal
opening and responding.

## Segment 3 — Optional Telegram remote control

Suggested source length: 15–25 seconds.

Record this only if Telegram remote control is enabled and configured:

1. Open the Telegram conversation with the Signal Box bot.
2. Send one safe, representative remote-control action.
3. Capture the bot response if one appears.
4. Show the corresponding state change or result in Signal Box.
5. Keep account names, chat IDs, private messages, tokens, and unrelated notifications
   out of frame.

Do not invent or stage a command that the integration does not actually support. If
Telegram is not configured, omit this footage; the narration describes it as optional.

## Segment 4 — Final proof moment

Suggested source length: 15–25 seconds.

Record:

1. Return to a clean, uncluttered full-board view.
2. Show one or more sessions in useful, stable states.
3. Leave the board still for 5–8 seconds at the end.
4. If possible, finish with a green `Working` tile or a red `Done` tile.

This footage should be calm enough to hold beneath the closing CTA.

## Before uploading

- Confirm all four files play correctly.
- Check that no credentials or private data are visible.
- Keep the original recordings; do not overwrite them with edited exports.
- Upload or copy the files into the project input directory configured for
  `code-traffic-demo`.
- Tell the video workflow which file corresponds to each segment.

