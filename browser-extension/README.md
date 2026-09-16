# Signal Box Browser Bridge

This Manifest V3 extension is the browser side of Signal Box recipes. It is intentionally restricted to explicitly allowlisted origins and `data-signal-box-target` elements. The host recipe executor remains responsible for policy, approval, input binding, preconditions, and receipts.

The bridge polls Signal Box's authenticated loopback `/browser/next` endpoint and returns results to `/browser/result`. Configure `signalBoxToken` in extension storage during development; production onboarding must provide that value through an explicit pairing flow rather than hard-coding it. Requests carry IDs, expiry, origin, and session binding. Before every non-navigation step, the extension checks that the active tab is still on the recipe origin and fails the request if the page changed.

The extension options page stores the pairing token, browser session ID, and Signal Box host URL. The host URL must remain an HTTP loopback URL; this supports installations using a custom `SIGNAL_BOX_PORT`. Selector fallbacks cover common Uber accessibility labels, while explicit `data-signal-box-target` attributes remain preferred for controlled test pages.

## Install

From Signal Box, click **Install browser bridge**. Signal Box opens the packaged extension folder and Chrome's extension manager, and copies the local pairing token to the clipboard. In Chrome, enable **Developer mode**, choose **Load unpacked**, and select the opened `browser-extension` folder. Then open the extension's **Extension options** page, paste the copied token, and enter the session ID shown by Signal Box. Chrome requires this one-time confirmation for unpacked extensions; Signal Box cannot install one silently.
