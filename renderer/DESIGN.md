# Assistant workspace design

The default destination is Overview: conversation, tasks needing attention, and
follow-ups in progress. Sidebar navigation shows one destination at a time.
Agent sessions have their own toolbar; source setup and settings remain reachable
from the sidebar. Search filters the current task, mail, calendar, or file view
locally. Nothing is sent while typing a query or choosing a conversation starter.

The visual system uses graphite surfaces, mint accents, warm white text, restrained
orbital geometry, and compact, consistent controls. `assistant-design.css` provides
the application theme over legacy component styling. The existing brand asset is
reused. No remote fonts or image requests are required.

Accessibility includes visible keyboard focus, a skip link to the conversation,
dialog focus containment and restoration, labeled inputs, live status text,
reduced motion support, and responsive layouts down to 390px. The Electron app
retains native window decorations.

## Verification

Run `electron scripts/check-assistant-ui.js` from the repository root using the
installed Electron binary. If the shell defines `ELECTRON_RUN_AS_NODE`, unset it
for this command. On Linux:

```sh
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/check-assistant-ui.js
```

This opens an isolated preview window, loads the real renderer with synthetic
account data, checks navigation, sending, pause, search, dialog focus, and horizontal
overflow at 760/620/390px, and captures screenshots to a printed temporary directory.
It does not launch the application host, read credentials, or contact providers.
The preview closes when the check finishes. The normal test suite is `npm test`.
