# src/main

## Purpose
The Electron main process: the only code with Node, filesystem, network and child-process access. It creates the window, owns every renderer-callable IPC channel, and runs the OS-facing tools.

## Ownership
Owns everything under `src/main/`. The SSH protocol layer, persistence and terminal backends have their own docs (see Child DOX Index). The renderer-facing API shape is owned jointly with `../preload` and `../shared`.

## Local Contracts
- Every renderer-callable channel is registered in `ipc.ts` through `handle()`, which returns `{ ok: true, value }` or `{ ok: false, error }` so errors reach the renderer as readable rejections. Never call `ipcMain.handle` directly elsewhere. The only other listener is `prompt:respond` in `prompts.ts`.
- Main asks the renderer for user input mid-operation (host keys, passwords, 2FA) only through `prompts.ts`, which must resolve, never leak, the pending promise if the window goes away.
- Pushes to the renderer (`webContents.send`) are for streams and progress only: terminal data, transfer progress, stats, tunnel state, network-tool results.
- No channel returns a stored secret to the renderer. `revealSecret` is called only from main-side code that needs the secret to connect.
- File dialogs are attached to the requesting window (see `ipc.ts`), never parentless: a parentless macOS panel can hide behind another app.
- A GUI app launched from Finder has a minimal `PATH`. Resolve binaries through `external-tools.ts`, which adds the Homebrew prefixes.
- A FreeRDP handoff gets its arguments, password included, on stdin (`/args-from:stdin`), never in argv where `ps` shows them. `tools:launch` re-reads a saved session from the store so a stored password goes only to its saved host. FreeRDP's output goes to `~/Library/Logs/MoMoca/freerdp.log` (not a pipe, so the session outlives the app). An early exit reports FreeRDP's last error. The X11 client (`xfreerdp`) gets XQuartz started and `DISPLAY=:0` set first.
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
- **External tools** — requirement checks, starting XQuartz, launching native clients for RDP, VNC, Browser and XDMCP. Start: `external-tools.ts`.

## Child DOX Index
- ssh/ — ssh2 connections: SSH terminal backend, host keys, SFTP operations, transfer progress, tunnels, SOCKS5, remote stats.
- store/ — on-disk persistence: sessions, macros, imported keys, the credential vault.
- terminals/ — the `TerminalBackend` seam, its registry, and the local, telnet and serial backends.
