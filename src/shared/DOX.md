# src/shared

## Purpose
Types and small constant maps used by main, preload and renderer alike, imported as `@shared/types`.

## Ownership
Owns `types.ts`. Every process may import it. It imports nothing.

## Local Contracts
- Keep `types.ts` dependency-free: no imports from Node, Electron, React or any package, and no runtime code beyond plain constant data. Both tsconfigs compile it, so anything else breaks one process or the other.
- `KIND_REQUIREMENT` is the single map from session kind to the external tool it needs. The session-type picker and the launcher both read it, so they can never disagree. Never duplicate that mapping elsewhere.
- `EXTERNAL_KINDS` lists the kinds that always hand off to another app instead of opening a tab. RDP is not in it: `RdpOptions.engine` decides (unset or `ironrdp` is a tab, `freerdp` a handoff), so RDP has no entry in `KIND_REQUIREMENT` either; the session dialog checks for FreeRDP itself.
- An IPC payload that crosses the bridge gets its type here, not in main or the renderer.

## Feature Map
- **Session model** — `SessionKind`, `SavedSession`, `RdpOptions`, `ConnectOptions`, `EXTERNAL_KINDS`, `KIND_REQUIREMENT`. Start: `types.ts`.
- **Payload types** — RDP tab targets and gateway tickets (`RdpTarget`, `RdpTicket`), SFTP entries and transfer progress, stats, tunnels, network-tool results, macros (`MACRO_SPEEDS`), vault status, toolbox records. Start: `types.ts`.

## Child DOX Index
- (none)
