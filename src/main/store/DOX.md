# src/main/store

## Purpose
On-disk persistence under Electron's `userData`: saved sessions, macros, imported SSH keys, and the credential vault.

## Ownership
Owns code under `src/main/store/`. Callers in `../ipc.ts`, `../terminals` and `../ssh` use its exports; record shapes live in `../../shared/types.ts`.

## Local Contracts
- JSON stores go through `JsonFile` (`json-file.ts`): a read-through cache with atomic temp-file-and-rename writes at mode `0600`, so a crash cannot truncate the user's data.
- Imported private keys are parsed before they are stored (a public key or stray file is rejected at import) and copied into the keys directory: `0700` directory, `0600` files.
- Vault modes: `keychain` (Electron `safeStorage`, the default) or `master` (scrypt-derived key, AES-256-GCM per entry, unlocked once per launch and held in memory). Switching modes re-encrypts every entry; it must never orphan one.
- `revealSecret` is for main-process callers only. Never add an IPC channel that returns a secret to the renderer.
- Never read or change secrets on every connection behind a per-read biometric prompt. That design was tried and was unusable.

## Feature Map
- **Saved sessions** — list, get, save, delete. Start: `sessions.ts`. Files: `json-file.ts`.
- **Macros store** — persisted macros. Start: `macros.ts`. Files: `json-file.ts`.
- **Imported key store** — import from file or paste, type and SHA256 fingerprint, passphrase sealed in the vault. Start: `keys.ts`.
- **Credential vault** — store, check, delete and reveal secrets; lock, unlock and master-password management. Start: `secrets.ts`.

## Child DOX Index
- (none)
