# src/main/ssh

## Purpose
Everything that speaks SSH through `ssh2`: the SSH terminal backend, host-key verification, SFTP operations and their progress, port forwarding, and the remote metrics probe.

## Ownership
Owns code under `src/main/ssh/`. The backend interface it implements belongs to `../terminals`. Secrets come from `../store/secrets.ts`. User prompts go through `../prompts.ts`.

## Local Contracts
- Host keys: unknown hosts prompt with a SHA256 fingerprint. A changed key is reported as a possible MITM and is never written to `~/.ssh/known_hosts`. Hashed entries and `[host]:port` must keep parsing.
- SFTP shares the terminal's connection as a second channel. Do not open a second login for it.
- Tree walks (download, upload, delete, counting) skip symlinks rather than follow them, detect cycles by resolved path, and stop at `MAX_ENTRIES` (50,000 examined entries) and `MAX_DEPTH` (32). Excluded folders are pruned, never listed.
- Transfers count bytes with their own chunked pipe, not the `fastGet`/`fastPut` step callback. Run up to `TRANSFER_CONCURRENCY` (4) files at once per operation and retry a failed file up to `TRANSFER_ATTEMPTS` (3). One failed file never stops the rest of the batch; the finish summary names it.
- Cancellation is polled between chunks. A stopped transfer unwinds with the cancellation error and is not reported as a failure.
- Downloads to a case-insensitive destination must not overwrite a file that differs only by case. Disambiguate the name and say so in the summary.
- Progress events are throttled (`EMIT_INTERVAL_MS`, 80ms) and speed is averaged over `SPEED_WINDOW_MS` (3s).
- Files over `MAX_INLINE_EDIT_BYTES` (4 MiB) are refused by the embedded editor.
- Each tunnel runs on its own connection so it outlives terminal tabs. SOCKS5 is no-auth, CONNECT only.
- The remote probe is one exec per tick with section markers. A host without `/proc` (BSD, macOS) omits those sections instead of failing.
- The OSC 7 cwd hook prints a one-shot random marker; `pushData` swallows the echoed setup line up to that marker.

## Verification
- `test/suites/sftpui.mjs`, `sftpselect.mjs` and `sftptransfer.mjs` against `test/sshd.mjs` cover SFTP selection, transfers and guards.

## Feature Map
- **SSH terminal backend** — connect, auth (agent, key, password, keyboard-interactive), shell channel, cwd tracking. Start: `ssh-terminal.ts`.
- **Host-key verification** — `known_hosts` lookup, including hashed entries. Start: `known-hosts.ts`.
- **SFTP operations** — list, stat, read and write for the editor, chmod, rename, mkdir, recursive delete, bulk upload and download with exclusions. Start: `sftp-ops.ts`. Files: `transfer-progress.ts`.
- **Port forwarding** — local, remote and dynamic tunnels with live state and connection counts. Start: `tunnels.ts`. Files: `socks5.ts`.
- **Remote metrics** — the server-side probe behind the diagnostics bar and its hover detail. Start: `remote-stats.ts`.

## Child DOX Index
- (none)
