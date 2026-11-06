# test

## Purpose
End-to-end verification. Each suite in `suites/` drives the built, running app over the Chrome DevTools Protocol and prints a PASS/FAIL list. `sshd.mjs` is a throwaway SSH server, so SSH, SFTP and tunnels can be tested without a real host. `README.md` covers how to run them and the rules they follow.

## Ownership
Owns `sshd.mjs`, `README.md`, `suites/` (no doc of its own), and the gitignored `.artifacts/` they generate. The product code under test belongs to `../src`.

## Local Contracts
- How to run: `node test/sshd.mjs` in one shell; `npm run build`, then launch Electron with `--remote-debugging-port=9222`; then `node test/suites/<suite>.mjs`. A suite exits non-zero on any failure. Some suites (for example `esctest.mjs`) want a throwaway `--user-data-dir`; each suite's header comment says how to run it.
- Click at real coordinates, and first assert the target is the topmost element at its own centre (`elementFromPoint`). Never `.focus()` or `.click()` past the UI to reach a control a person could not reach. The one allowed use of `.focus()` is to put keyboard focus on an already-reachable control before sending a real key event.
- Assert on side effects, not the screen. WebGL terminal text never reaches the DOM, so prove a command ran by having the shell write a file and checking it from Node.
- This machine's stores hold the maintainer's real data. A suite touches only its own fixtures, found by name: its own saved sessions, its own `known_hosts` line (`[127.0.0.1]:2222`), and its own folders under `.artifacts/`. Never delete or restore those stores wholesale.
- Suites assume a freshly launched app. Restart the app between runs; leftover panel or tab state from an earlier run causes false failures.
- `rdptest.mjs` starts Homebrew FreeRDP's `sfreerdp-server` with `--local-only` (a Unix socket) and reaches it through its own loopback relay, so no test server listens on the network. That server has no Display Control channel, so the suite reports dynamic resize as SKIP; check it against a Windows host.
- `sshd.mjs` accepts one generated key, serves a real `/bin/sh`, implements enough SFTP for the file browser (with `lstat` in readdir so symlinks report as symlinks), honours `direct-tcpip`, and answers the stats probe as if it were Linux.

## Verification
- A change is verified when the suites that cover it pass in full against a fresh launch. Each suite's header comment says what it covers.

## Feature Map
- **Test SSH server** — auth, shell, SFTP, `direct-tcpip`, a fake Linux stats probe. Start: `sshd.mjs`.
- **UI reachability and macro flow** — Start: `suites/humantest.mjs`.
- **Scrolling** — Start: `suites/scrolltest.mjs`.
- **Views, splits, MultiExec, zoom** — Start: `suites/viewtest.mjs`.
- **Menus** — Start: `suites/menutest.mjs`.
- **Sidebar resize, fold and hover peek** — wants a throwaway `--user-data-dir`. Start: `suites/sidebartest.mjs`.
- **Escape stack** — Start: `suites/esctest.mjs`.
- **Macro editing and multi-terminal runs** — Start: `suites/macroedit.mjs`.
- **Tools, network tools, Unix catalogue** — Start: `suites/toolstest.mjs`.
- **SFTP selection UI and session opening** — Start: `suites/sftpui.mjs`.
- **SFTP selection on disk** — Start: `suites/sftpselect.mjs`.
- **SFTP transfers** — Start: `suites/sftptransfer.mjs`.
- **RDP in a tab and its gateway tickets** — against FreeRDP's sample server on a Unix socket. Start: `suites/rdptest.mjs`.

## Child DOX Index
- (none)
