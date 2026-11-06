# src/renderer

## Purpose
The React UI in the Electron window: app shell, menus and ribbon, session sidebar, terminal panes, SFTP browser, dialogs, and the tool panels. `index.html` is the entry; the code lives in `src/`.

## Ownership
Owns everything under `src/renderer/`, including `src/components/tools/` and `src/hooks/`, which follow these rules and have no docs of their own. All system access goes through `window.api` from `../preload`.

## Local Contracts
- No Node, no Electron imports. Talk to the system only through `window.api`. Import shared types from `@shared/types`; renderer modules import each other by relative path.
- A `TerminalPane` mounts once per tab and is never re-parented or remounted: remounting drops the session. Split layouts position panes over the terminal area instead of moving them between subtrees. Code that needs a tab's live xterm uses `terminal-registry.ts`; values the terminal reads after construction go through `view-state.ts`.
- An RDP tab is an `RdpPane`, which follows the same mount-once, positioned-over-its-slot rule as `TerminalPane`; unmounting it shuts the session down. It loads `@devolutions/iron-remote-desktop-rdp` with a dynamic `import()`, so the 6 MB WebAssembly chunk loads with the first RDP tab, not at startup. That module fetches its WebAssembly from a `data:` URL and connects to the gateway on `ws://127.0.0.1`, which is why the CSP in `index.html` allows both in `connect-src`. RDP tabs are left out of MultiExec's targets.
- `main.tsx` deliberately does not use `StrictMode`: its double-invoked effects would open two backends and two SSH logins per tab.
- High-frequency data stays out of React state. Diagnostics metrics live in `stats-store.ts` so a tick re-renders only the bar.
- Menus are data in `menus.ts`. The menu bar and the ribbon's buttons both render from it. Change a label or command there, not in a component.
- Destructive or dialog-opening actions run through `useExclusive` (`hooks/useExclusive.ts`), which drops re-entrant clicks and the clicks queued behind a closing modal.
- Escape closes only the top dialog: register with `useEscape` (`hooks/useEscape.ts`), never a bare `keydown` listener on the window.
- Electron has no `window.prompt`. Ask for text with `usePrompt` (`components/InputDialog.tsx`).
- Every control must be reachable by a real click at its centre: nothing may sit under a scrim or overlay while it is meant to be used. The test suites assert this with `elementFromPoint`.
- Both themes (`theme.ts`) apply to the app chrome and to live terminals. All styling is in `src/styles.css`.

## Work Guidance
- Saved session rows open on double-click only; a single click must not connect (a single-click open was irksome to the maintainer). Enter is the keyboard equivalent. `test/suites/sftpui.mjs` asserts all three.
- File lists follow Finder's rules: click selects, ⌘-click toggles, Shift-click takes a range, ⌘A takes everything, double-click opens. Right-clicking inside a selection acts on all of it; outside one, it reselects that row.
- Every bar or mode that can hide itself keeps a way back (a shortcut and a visible control). A mode with no exit is a trap.
- MultiExec is off at launch and never persisted.
- In an RDP tab, ⌘C ⌘V ⌘X ⌘A ⌘Z ⌘Y ⌘S go to Windows as Ctrl shortcuts (`COMMAND_AS_CTRL` in `rdp-keys.ts`), ⌘ tapped alone is the Windows key, and every other ⌘ shortcut still reaches MoMoca. `test/suites/rdptest.mjs` asserts that ⌘T still opens a tab and a plain key does not.

## Verification
- `npm run typecheck`, then the relevant CDP suite in `test/suites/` against a fresh app launch.

## Feature Map
- **App shell and tabs** — tab lifecycle, quick connect, backend events, layout, keyboard shortcuts. Start: `src/App.tsx`. Files: `src/components/TabBar.tsx`, `src/components/StatusBar.tsx`, `src/components/WelcomeTab.tsx`, `src/main.tsx`.
- **RDP pane** — IronRDP session on a canvas: connect through `rdp:open`, fill-the-tab resizing, keyboard (scancodes, ⌘ mapping), mouse, cursor, clipboard text, Reconnect. Start: `src/components/RdpPane.tsx`. Files: `src/rdp-keys.ts`.
- **Terminal pane** — xterm with WebGL, scrollback, search, the "lines below" chip, split positioning. Start: `src/components/TerminalPane.tsx`. Files: `src/terminal-registry.ts`, `src/view-state.ts`, `src/theme.ts`.
- **Menus and ribbon** — the menu bar and buttons bar from shared definitions, View options, compact mode. Start: `src/menus.ts`. Files: `src/components/MenuBar.tsx`, `src/components/Ribbon.tsx`, `src/components/ContextMenu.tsx`, `src/components/SettingsDialog.tsx`, `src/components/AboutDialog.tsx`.
- **Session sidebar and dialog** — the folder tree of saved sessions, the session editor, and the session-type strip. Start: `src/components/SessionSidebar.tsx`. Files: `src/components/LeftPanel.tsx`, `src/components/SessionDialog.tsx`, `src/components/SessionTypePicker.tsx`, `src/components/SessionTypeIcons.tsx`, `src/components/ToolGuide.tsx`.
- **SFTP pane** — listing, multi-select, toolbar, context menu, auto-refresh, transfer bar, download dialog with exclusions, properties and the embedded editor. Start: `src/components/FileBrowser.tsx`. Files: `src/components/TransferBar.tsx`, `src/components/DownloadDialog.tsx`, `src/components/FileProperties.tsx`, `src/components/RemoteEditor.tsx`.
- **Connect-time prompts** — host-key, password and 2FA modals driven by main. Start: `src/components/PromptOverlay.tsx`.
- **Macros UI** — recorder, manager, step editor, recording bar, multi-terminal run. Start: `src/macro-recorder.ts`. Files: `src/components/MacroManager.tsx`, `src/components/MacroEditor.tsx`, `src/components/RecordingBar.tsx`.
- **Diagnostics bar** — meters and hover detail. Start: `src/components/StatsBar.tsx`. Files: `src/components/StatsDetailPopover.tsx`, `src/stats-store.ts`.
- **Tunnels UI** — tunnel manager and the which-end-is-which explainer. Start: `src/components/TunnelManager.tsx`. Files: `src/components/TunnelExplainer.tsx`.
- **Vault and keys UI** — unlock and master-password dialog, key import and listing. Start: `src/components/VaultDialog.tsx`. Files: `src/components/KeyManager.tsx`.
- **Tools workspace** — the System, Office and Network tool panels. Start: `src/components/tools/ToolsPanel.tsx`. Files: `src/components/tools/`, `src/components/NetworkTools.tsx`, `src/components/UnixTools.tsx`.
- **Shared UI pieces** — text prompt, icons, Escape stack, click exclusivity. Start: `src/components/InputDialog.tsx`. Files: `src/components/Icons.tsx`, `src/hooks/`.

## Child DOX Index
- (none)
