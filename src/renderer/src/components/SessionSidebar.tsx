import type { SavedSession } from '@shared/types'
import { IconFolderSmall } from './Icons'
import { DEFAULT_PORT } from './SessionDialog'
import { KIND_LABEL } from './SessionTypePicker'

interface Props {
  sessions: SavedSession[]
  onOpen: (session: SavedSession) => void
  onEdit: (session: SavedSession) => void
  onNew: () => void
}

/** Groups sessions under their folder label, MobaXterm's sidebar tree in miniature. */
function groupByFolder(sessions: SavedSession[]): [string, SavedSession[]][] {
  const groups = new Map<string, SavedSession[]>()
  for (const session of sessions) {
    const key = session.folder || 'User sessions'
    const bucket = groups.get(key)
    if (bucket) bucket.push(session)
    else groups.set(key, [session])
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
}

/** Short "where" for the row's right edge: host (and a non-standard port), device, or "local". */
function sessionTarget(session: SavedSession): string {
  if (session.kind === 'local') return 'local'
  if (session.kind === 'serial') return session.serialPath?.replace(/^\/dev\//, '') ?? ''
  const host = session.host ?? ''
  const port = session.port
  return host && port && port !== DEFAULT_PORT[session.kind] ? `${host}:${port}` : host
}

/** Hover text: the type and the full address it connects to. */
function sessionTooltip(session: SavedSession): string {
  const hint = 'double-click to open, right-click to edit'
  if (session.kind === 'local') return `Local shell${session.shell ? ` (${session.shell})` : ''} — ${hint}`
  if (session.kind === 'serial') {
    const baud = session.baudRate ? ` at ${session.baudRate} baud` : ''
    return `Serial ${session.serialPath ?? ''}${baud} — ${hint}`
  }
  const user = session.username ? `${session.username}@` : ''
  const port = session.port ?? DEFAULT_PORT[session.kind]
  return `${KIND_LABEL[session.kind]} ${user}${session.host ?? ''}${port ? `:${port}` : ''} — ${hint}`
}

export function SessionSidebar({ sessions, onOpen, onEdit, onNew }: Props) {
  const groups = groupByFolder(sessions)

  return (
    <div className="session-tree">
      {!sessions.length && (
        <div className="muted-row">
          No saved sessions yet.
          <br />
          <button className="linklike" onClick={onNew}>
            Create one
          </button>
        </div>
      )}

      {groups.map(([folder, items]) => (
        <div key={folder} className="tree-group">
          <div className="tree-folder">
            <IconFolderSmall />
            <span>{folder}</span>
          </div>
          {items.map((session) => (
            <button
              key={session.id}
              className="session-row"
              // Double-click only: a single click must not connect. Enter is the
              // keyboard equivalent, since a focused button never sees dblclick.
              onDoubleClick={() => onOpen(session)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.repeat) {
                  e.preventDefault()
                  onOpen(session)
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                onEdit(session)
              }}
              title={sessionTooltip(session)}
            >
              <span className={`kind-dot ${session.kind}`} />
              <span className="sname">{session.name}</span>
              <span className="meta">{sessionTarget(session)}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
