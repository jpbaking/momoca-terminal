# src/main

## Purpose
The Electron main process: the only code with Node, filesystem, network and child-process access. It creates the window, owns every renderer-callable IPC channel, and runs the OS-facing tools.

## Ownership
Owns everything under `src/main/`. The SSH protocol layer, persistence and terminal backends have their own docs (see Child DOX Index). The renderer-facing API shape is owned jointly with `../preload` and `../shared`.

## Local Contracts
- Every renderer-callable channel is registered in `ipc.ts` through `handle()`, which returns `{ ok: true, value }` or `{ ok: false, error }` so errors reach the renderer as readable rejections. Never call `ipcMain.handle` directly elsewhere. The only other listener is `prompt:respond` in `prompts.ts`.
- Main asks the renderer for user input mid-operation (host keys, passwords, 2FA) only through `prompts.ts`, which must resolve, never leak, the pending promise if the window goes away.
- Pushes to the renderer (`webContents.send`) are for streams and progress only: terminal data, transfer progress, stats, tunnel state, network-tool results.
- No channel returns a stored secret to the renderer, with one exception: `rdp:open` returns an RDP session's stored password, because IronRDP runs CredSSP in the renderer. It reads the session from the store by id (never one the renderer describes), and returns the password only together with a ticket for that session's own host. Add no other exception. `revealSecret` is otherwise called only from main-side code that needs the secret to connect.
- The RDP gateway (`rdp-gateway.ts`) listens on 127.0.0.1 only. A connection reaches a server only with a ticket from `rdp:open`: random, single-use, expiring after a minute, and bound to one host and port. The client's own `destination` is ignored. RDP servers' self-signed certificates are accepted, as the FreeRDP handoff's `/cert:ignore` does. Electron's BoringSSL also rejects a certificate whose Key Usage lacks digitalSignature (Windows' own RDP certificate) on TLS 1.3 and ECDHE handshakes; on that one error (`ERR_SSL_KEY_USAGE_BIT_INCORRECT`) the gateway reconnects with TLS capped at 1.2, where Windows picks RSA key exchange. Other TLS failures are logged to the console with their real code and reported to the client as alert 40. The gateway changes one thing in the client's stream: it sets `INFO_AUTOLOGON` in the Client Info PDU, which IronRDP's web build never sets, so servers that log on from that PDU (xrdp, Windows without NLA) use the password instead of showing their login screen. Everything else is relayed byte for byte.
- File dialogs are attached to the requesting window (see `ipc.ts`), never parentless: a parentless macOS panel can hide behind another app.
- A GUI app launched from Finder has a minimal `PATH`. Resolve binaries through `external-tools.ts`, which adds the Homebrew prefixes.
- A FreeRDP handoff gets its arguments, password included, on stdin (`/args-from:stdin`), never in argv where `ps` shows them. `tools:launch` re-reads a saved session from the store so a stored password goes only to its saved host. FreeRDP's output goes to `~/Library/Logs/MoMoca/freerdp.log` (not a pipe, so the session outlives the app). An early exit reports FreeRDP's last error. The X11 client (`xfreerdp`) gets XQuartz started and `DISPLAY=:0` set first. When the handoff itself started XQuartz, `closeStartupClient` then closes the client XQuartz opened on start (its `app_to_run` preference, an xterm by default): only processes with exactly that command line that appeared after the start, so the user's own xterms stay. The Start X server menu item keeps that xterm; the user asked for X there.
- A session's RDP options (`SavedSession.rdp`) become FreeRDP arguments in `rdpOptionArgs` only. macOS attributes FreeRDP's microphone use to MoMoca, so the app keeps `com.apple.security.device.audio-input` in `build/entitlements.mac.plist` and `NSMicrophoneUsageDescription` in `package.json` `build.mac.extendInfo`. Removing either one silently mutes the mic.
- Repeating probes use `execFile`, not `exec`, and do sorting and trimming in JS (see `system-stats.ts`).
- User-triggered jobs that can grow (scans, sweeps) are cancellable and have hard ceilings that refuse absurd input with a reason (see `net-tools.ts`).
- Stats polling costs nothing while the diagnostics bar is hidden: `stats-poll.ts` polls only what the renderer has declared it needs.
- `index.ts` copies (never moves) the old MobaClone store into `userData` on first launch after the rename, so a bad migration loses nothing.
- Window security: `contextIsolation: true`, `nodeIntegration: false`. Do not weaken these.

## Feature Map
- **App startup and store migration** — creates the window and carries the store across the MobaClone → MoMoca rename. Start: `index.ts`.
- **IPC registry** — every channel, grouped by area, with error wrapping and window-attached file dialogs. Start: `ipc.ts`.
- **Main-driven prompts** — ask the renderer for a modal answer and await it. Start: `prompts.ts`.
- **Diagnostics polling** — local metrics, and the switch between local and per-tab remote polling. Start: `stats-poll.ts`. Files: `system-stats.ts`. Remote probe in ./ssh.
- **Network tools** — ping, port scan, subnet discovery with reverse DNS and ARP. Start: `net-tools.ts`.
- **Toolbox backend** — processes, hardware, listening ports, Wake-on-LAN, key generation, local text and diff, Homebrew. Start: `tools.ts`.
- **Unix command catalogue** — installed tools and BSD-versus-GNU differences. Start: `unix-tools.ts`.
- **External tools** — requirement checks, starting XQuartz, launching native clients for VNC, Browser, XDMCP and RDP on the FreeRDP engine. Start: `external-tools.ts`.
- **RDP gateway** — the RDCleanPath WebSocket an IronRDP tab connects through: tickets, X.224 relay, TLS to the server, then a byte relay. Start: `rdp-gateway.ts`.

## Child DOX Index
- ssh/ — ssh2 connections: SSH terminal backend, host keys, SFTP operations, transfer progress, tunnels, SOCKS5, remote stats.
- store/ — on-disk persistence: sessions, macros, imported keys, the credential vault.
- terminals/ — the `TerminalBackend` seam, its registry, and the local, telnet and serial backends.
