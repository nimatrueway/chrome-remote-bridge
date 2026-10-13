# Chrome Remote Bridge

A dependency-free VS Code extension for attaching the built-in JavaScript debugger
to Chrome's approval-based remote debugging server, using your existing browser
profile, tabs, and logins.

## Install

Download the `.vsix` from [Releases](https://github.com/nimatrueway/chrome-remote-bridge/releases).
In VS Code, run **Extensions: Install from VSIX...**, then **Developer: Reload Window**.
Alternatively:

```sh
code --install-extension chrome-remote-bridge-0.0.3.vsix
```

This is a locally installable extension, not a Marketplace publication.

## Attach

1. Open `chrome://inspect/#remote-debugging` in Chrome or Chromium.
2. Enable **Allow remote debugging for this browser instance** and note the port.
3. Add this configuration to `.vscode/launch.json`, replacing `62883` with that port:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Attach to Chrome",
      "type": "chrome-remote-bridge",
      "request": "attach",
      "address": "127.0.0.1",
      "port": 62883,
      "webRoot": "${workspaceFolder}",
      "targetSelection": "pick"
    }
  ]
}
```

Press F5, approve Chrome's prompt, then select a tab in VS Code. If only one tab
matches, VS Code attaches directly. `targetSelection` defaults to `pick`.
An optional `urlFilter` can narrow the choices using `*` wildcards.

Update `port` when Chrome's server port changes. No separate bridge process or
browser launch flags are needed.

## Source maps

The extension forwards Chrome debugger settings to VS Code's built-in debugger,
including `webRoot`, `sourceMaps`, and `sourceMapPathOverrides`. Source maps are
enabled by default. For a webpack app whose local sources live under `client/`:

```json
"webRoot": "${workspaceFolder}/client",
"sourceMapPathOverrides": {
  "webpack-internal:///*": "${workspaceFolder}/client/*",
  "../packages/*": "${workspaceFolder}/client/packages/*"
}
```

Adjust these mappings to your app's actual source-map paths. Source maps must be
accessible and match the running code. Solid red breakpoints are bound; hover over
hollow breakpoints for diagnostics. Without source maps, use **Loaded Scripts**
to debug the JavaScript running in the browser.

## Requirements and limits

- Desktop VS Code 1.90+ with its built-in JavaScript debugger enabled.
- A Chrome-family browser with the approval-based remote debugging feature.
- Local browser connections only (`127.0.0.1` or `localhost`).
- macOS automatically discovers `DevToolsActivePort` in standard Chromium,
  Chrome, Chrome Beta, Chrome Canary, Brave, and Edge user-data directories.
- For custom profiles or other operating systems, set `devToolsActivePort` to
  the absolute path of the browser's `DevToolsActivePort` file.
- Live connectivity has been checked with Chromium 152 on macOS; other browsers
  and operating systems have not been verified.

## How it works

The new Chrome server does not provide `/json/version`, which VS Code expects.
The extension reads `DevToolsActivePort` and obtains an approved browser WebSocket
connection before starting the debugger. This avoids VS Code's two-second
WebSocket handshake timeout repeatedly triggering Chrome's approval prompt.

A temporary loopback server provides discovery and forwards WebSocket traffic
to that approved connection. VS Code's built-in debugger handles tab selection,
breakpoints, stepping, and source maps. The bridge closes on disconnect, debug
session termination, or extension shutdown.

Chrome's approval grants browser-wide access even when you select one tab to
debug. This extension does not bypass consent. Use only with trusted local tools;
the loopback endpoint is not an authentication boundary against local processes.
Browser-origin requests and non-local Host headers are rejected.

For troubleshooting, open **Output -> Chrome Remote Bridge**.

## Development

No runtime dependencies or compilation:

```sh
npm test
npx @vscode/vsce package --no-dependencies
```

Tests cover endpoint parsing, delayed approval, discovery, transport forwarding,
cancellation, configuration passthrough, and disposal.
