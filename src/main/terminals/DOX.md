# src/main/terminals

## Purpose
The `TerminalBackend` seam and everything behind it: the registry that creates backends per tab and streams their data, plus the local pty, telnet and serial backends.

## Ownership
Owns code under `src/main/terminals/`. The SSH backend lives in `../ssh/ssh-terminal.ts` but must satisfy the interface defined here.

## Local Contracts
- `TerminalBackend` (`backend.ts`) is the seam: `write`, `resize`, `sftp`, `dispose`, emitting `data`, `exit` and `error`. Every session type is one more implementation of it.
- `createBackend` in `registry.ts` is the only place that branches on session kind. The IPC layer and the renderer never switch on protocol.
- Mosh, Rsh, FTP and RDP run their native client as a `LocalTerminal` with a command override. A missing client or X display is a connect-time error shown in the tab, never a silent exit. Add a new kind here, not in `ipc.ts`.
- Output is coalesced before it is sent as `term:data` (`FLUSH_MS` 4ms, `FLUSH_BYTES` 64 KiB). Keep sends batched; one message per chunk floods the renderer.
- Local shells are login shells (`-l`) so the user's normal `PATH` and Homebrew setup apply.
- Telnet answers option negotiation itself so IAC bytes never reach the terminal.
- Per-tab remote stats pollers are owned by the registry and torn down with their terminal.

## Feature Map
- **Backend registry** — create, write, resize, dispose per tab; data coalescing; per-tab stats pollers. Start: `registry.ts`. Files: `backend.ts`.
- **Local shell** — node-pty login shell, or a command such as `mosh`. Start: `local.ts`.
- **Telnet** — raw socket with RFC 854 / 1073 negotiation. Start: `telnet.ts`.
- **Serial console** — serialport backend and device listing for the session dialog. Start: `serial.ts`.

## Child DOX Index
- (none)
