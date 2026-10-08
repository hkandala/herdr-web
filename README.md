# herdr-web

A minimal, dark web UI for [herdr](https://herdr.dev). It shows your herdr sessions, workspaces, tabs, split panes and agent status, and renders live terminals in the browser with [ghostty-web](https://github.com/coder/ghostty-web) (Ghostty's VT engine, libghostty-vt, compiled to WASM).

```
browser (React + ghostty-web)  ⇄  /ws  ⇄  herdr-web bridge (Node)  ⇄  herdr socket API + `herdr terminal session …`
```

## Run

Requires Node 24+ and a running herdr (any version with protocol 22, e.g. 0.9.3).

```bash
npm install
npm run build
npm start                      # http://127.0.0.1:7681
```

For development, `npm run dev` runs the bridge (port 7681, auto-restarting) and Vite with HMR (port 5173, proxying `/ws`). Open the Vite URL.

Options (flag or environment variable):

| flag | env | default |
| --- | --- | --- |
| `--port` | `HERDR_WEB_PORT` | `7681` |
| `--host` | `HERDR_WEB_HOST` | `127.0.0.1` |
| `--token` | `HERDR_WEB_TOKEN` | none on loopback; random otherwise |
| | `HERDR_BIN` | `~/.local/bin/herdr`, else `herdr` on `PATH` |
| | `HERDR_CONFIG_DIR` | `$XDG_CONFIG_HOME/herdr` or `~/.config/herdr` |

`?session=<name>` in the URL selects a herdr session on load; the session menu in the sidebar switches sessions afterwards.

### Security

The UI can type into real shells, so:

- It binds to loopback by default and accepts only `localhost`, `127.0.0.1`, `::1` or this machine's hostname in the `Host` header. That blocks DNS rebinding.
- WebSocket upgrades must carry an `Origin` that matches the page. That blocks cross-site WebSocket hijacking.
- Binding to any other address requires a token. Open the printed `…/?token=…` URL once; the token is swapped for an HttpOnly cookie. For remote access, prefer an SSH tunnel or Tailscale over exposing the port.

## Using it

- **Sidebar:** session picker, workspaces (with aggregated agent status), and an **Agents** list sorted by what needs attention (blocked, then done, then working). Click an agent to jump to its pane.
- **Tabs:** click to switch, double-click to rename, `+` for a new tab, `×` to close.
- **Panes:** the `⋯` menu splits right/down, renames, or closes a pane. Maximize shows one pane on its own (web-only zoom; herdr isn't touched).
- **Mirror / Fit** (top right): both show the tab's split layout the way herdr lays it out. They differ only in how each pane attaches.
  - **Mirror** (default) observes each pane at its real size and scales the font to fit its box. It never resizes anything, so it's safe to use alongside the herdr TUI, and any number of browsers can watch.
  - **Fit** attaches to every visible pane as herdr's controller and resizes each one to its box in the browser. The herdr TUI sees those sizes too. Only one client can control a pane; if another holds it, the pane offers **Take over**. The `−`/`+` buttons set the font size.
  - Recently viewed tabs (the last 8) stay mounted while hidden. Switching back is instant and doesn't reattach, so in Fit mode panes don't get resized back and forth under the TUI. Maximize enlarges one pane's box without detaching the others.
- Typing goes to the pane you clicked. In Fit mode, clicks and drags are forwarded to the app (herdr encodes them for its mouse mode, or drops them if it has none); hold Shift to make a local selection instead. The mouse wheel scrolls herdr's scrollback, or reaches the app as wheel events in Fit mode. Selecting text copies it. Paste into an agent pane is sent as a bracketed paste. Browser shortcuts (Cmd+R, Cmd+T, …) keep working. On macOS, Cmd+←/→/⌫ map to line start, line end and kill line.

Selections in the web UI are local: clicking around never moves focus in the herdr TUI. Create actions pass `focus: false` for the same reason.

## How it talks to herdr

Notes on herdr 0.9.3's API, much of it learned by probing. [devswha/herdr-web-ui](https://github.com/devswha/herdr-web-ui) was a useful reference.

**RPC.** This is newline-delimited JSON over `~/.config/herdr/herdr.sock`; named sessions use `~/.config/herdr/sessions/<name>/herdr.sock`. You send `{"id","method","params"}` and get back one line, `{"id","result"}` or `{"id","error":{code,message}}`. Herdr then closes the connection, so the bridge opens one connection per call. The bridge uses `session.snapshot` (workspaces, tabs, panes, agents and layouts in one call), plus the `workspace.*`, `tab.*` and `pane.*` mutations, `pane.send_text`, `pane.send_keys`, `pane.get` and `pane.scroll`.

**Change notifications.** `events.subscribe` keeps its connection open. Subscription quirks:

- **Structural events:** one connection carries the workspace/tab/pane/layout events.
- **Agent status:** `pane.agent_status_changed` needs one entry per pane on a second connection. Herdr rejects the whole subscribe if any pane id is unknown, and ignores a second subscribe on an open connection, so the bridge rebuilds this connection whenever the pane set changes.
- **Coalescing and backstop:** any event triggers a debounced `session.snapshot`. A 2.5 s poll catches changes that emit no event, such as terminal titles and cwd.

**Live terminal output.** Live output comes from `herdr terminal session observe|control <terminal_id> --cols C --rows R`, with `HERDR_SOCKET_PATH` set to the session's socket. The CLI resolves terminals against that variable, not the default session. Its stdout is NDJSON:

```json
{"type":"terminal.frame","seq":3,"full":false,"width":120,"height":40,"encoding":"ansi","bytes":"<base64>"}
{"type":"terminal.closed","reason":"detached"}
```

Frames are herdr's own rendering of the pane surface. The first frame, and the first after every resize, is a full repaint; later frames are cursor-addressed deltas wrapped in synchronized output (`CSI ?2026 h/l`). The bridge passes the base64 straight through, and the browser feeds the bytes into ghostty-web.

- **observe** renders at any requested size without affecting the pane. The bridge restarts it when the pane's size changes.
- **control** takes these commands on stdin: `{"type":"terminal.input","text"}`, `{"type":"terminal.resize","cols","rows"}` and `{"type":"terminal.scroll","direction","lines"}`. It resizes the real terminal, and herdr allows only one controller per terminal unless you pass `--takeover`.

This is simpler than the reference project's approach of running `herdr terminal attach` under a node-pty sidecar: no PTY and no native modules.

**Pane size.** The API doesn't report a terminal's columns. Rows come from `scroll.viewport_rows`. The layout rect includes herdr's border when a TUI is attached (inner = rect − 2 on each axis), so `rect.height − viewport_rows` gives the border used to derive columns. While one of our own control streams has resized a terminal, mirrors use the controller's size instead.

**Mouse.** In Fit mode, clicks go to the control stream as `{"type":"terminal.mouse","action":"down|up|drag|move","button":"left|middle|right","column","row","modifiers"}`. Coordinates are 0-based cells and modifiers are crossterm bits (1 shift, 2 ctrl, 4 alt). Herdr encodes them for the app's mouse mode (verified as SGR `CSI < b;x;y M/m`) and drops them when the app hasn't enabled one.

**Input.** Frames carry none of the inner app's terminal modes: no application cursor keys, kitty keyboard protocol, bracketed paste or mouse modes. A browser-side key encoder would therefore guess wrong, so the browser sends:

- special keys and modifier chords as herdr logical keys via `pane.send_keys` (`enter`, `shift+enter`, `ctrl+c`, `alt+b`, `shift+tab`, `f5`, …), which herdr encodes for whatever the app negotiated,
- Home/End/PgUp/PgDn/Insert/Delete as xterm CSI sequences through `pane.send_text`, because `send_keys` has no names for them,
- everything else as plain text via `pane.send_text`, which writes bytes unmodified.

The bridge serializes input per pane and coalesces bursts of typing.

## Layout

```
server/index.ts           HTTP + /ws, static files, Host/Origin/token checks
server/connection.ts      one browser: streams, input queues, RPC allow-list
server/session-hub.ts     per-session snapshot cache + event subscriptions
server/terminal-stream.ts wraps `herdr terminal session observe|control`
server/herdr.ts           socket RPC/subscribe client, session discovery
shared/protocol.ts        herdr types + browser⇄bridge messages
src/lib/bridge.ts         WebSocket client store (reconnects, reopens streams)
src/lib/keys.ts           KeyboardEvent → herdr input
src/components/           Sidebar, WorkspaceView (tabs, pane grid), TerminalView (ghostty-web)
```

## Limitations

- Mirror mode is observe-only for the mouse: herdr's API has no way to send clicks without a control attachment, and the wheel scrolls herdr's host scrollback, which every viewer sees. Use Fit mode for mouse-driven apps.
- Nerd Font icons come from the bundled Symbols Nerd Font Mono (`public/fonts`, MIT licensed).
- Fit mode resizes panes the first time you view them, and again when you leave Fit mode or close the page. Hidden tabs keep their attachment, so switching tabs doesn't resize anything.
- Column count in Mirror mode is derived (see above). If an unknown client has resized a pane, it can be off by a column or two.

## License

MIT. The bundled Symbols Nerd Font is MIT licensed too (`public/fonts/SymbolsNerdFont-LICENSE`).
