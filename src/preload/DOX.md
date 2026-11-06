# src/preload

## Purpose
The bridge between renderer and main: exposes one typed object, `window.api`, through `contextBridge`. The renderer has no Node access, so this is its whole view of the system.

## Ownership
Owns `index.ts` (the API) and `index.d.ts` (the `Window.api` declaration the renderer's tsconfig includes). Channel handlers belong to `../main/ipc.ts`; payload types belong to `../shared/types.ts`.

## Local Contracts
- Calls go through `invoke()`, which unwraps main's `{ ok, value | error }` envelope into a normal resolved value or rejected `Error`. Never call `ipcRenderer.invoke` raw. The one exception is `prompts.respond`, a fire-and-forget `send` on `prompt:respond`.
- Main-to-renderer streams go through `subscribe()`, which returns an unsubscribe function. Every subscription must be removable.
- The API is grouped by namespace (`sessions`, `vault`, `secrets`, `keys`, `term`, `sftp`, `tools`, `tunnels`, `stats`, `net`, `macros`, `unix`, `toolbox`, `window`, `serial`, `dialog`, `prompts`). Put a new call in the namespace that matches its `ipc.ts` section.
- Expose operations, never raw `ipcRenderer`, Node modules or secrets. `secrets` may store, check and delete; it must not read a secret back.
- A channel name added here must match the one registered in `ipc.ts` exactly. The `Api` type is inferred from this object, so the renderer sees changes without a separate declaration.

## Verification
- `npm run typecheck` checks both sides of the bridge: `tsconfig.node.json` covers this folder, and `tsconfig.web.json` covers its `index.d.ts`.

## Child DOX Index
- (none)
