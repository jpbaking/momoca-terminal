import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { SavedSession, TabState } from '@shared/types'
import { clampSidebar, SIDEBAR_DEFAULT, SIDEBAR_MIN, viewActions, type SidebarSide } from '../view-state'
import { FileBrowser } from './FileBrowser'
import { IconChevron, IconFiles, IconSessions } from './Icons'
import { SessionSidebar } from './SessionSidebar'

export type PanelTab = 'sessions' | 'sftp'

interface Props {
  sessions: SavedSession[]
  activeTab: TabState | null
  panel: PanelTab
  onPanel: (panel: PanelTab) => void
  onOpen: (session: SavedSession) => void
  onEdit: (session: SavedSession) => void
  onNew: () => void
  onQuickConnect: (target: string) => void
  /** Folded down to the rail. Hovering the rail floats the panel out over the terminals. */
  collapsed: boolean
  side: SidebarSide
  /** Docked width in px; the panel's inner edge drags it. */
  width: number
}

/** How long the pointer rests on the rail before the panel floats out. */
const PEEK_OPEN_MS = 150
/** Grace period after the pointer leaves, so a slip past the edge does not snap it shut. */
const PEEK_CLOSE_MS = 350
/** One arrow-key press on the resize handle. */
const KEY_STEP = 16

export function LeftPanel({
  sessions,
  activeTab,
  panel,
  onPanel,
  onOpen,
  onEdit,
  onNew,
  onQuickConnect,
  collapsed,
  side,
  width
}: Props) {
  const [quick, setQuick] = useState('')
  const [peek, setPeek] = useState(false)
  /** Live width while the handle is being dragged; committed to view state on release. */
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dock = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout>>()
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()

  const sftpReady = Boolean(activeTab?.sftp) && activeTab?.status !== 'closed'
  // Fall back to the tree when the active tab can't offer a file browser.
  const showing: PanelTab = panel === 'sftp' && sftpReady ? 'sftp' : 'sessions'

  const clearTimers = () => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    openTimer.current = undefined
  }

  // Docking (or undocking) ends any peek in progress.
  useEffect(() => {
    clearTimers()
    setPeek(false)
  }, [collapsed])

  useEffect(() => clearTimers, [])

  /**
   * Folds the floating panel away once the pointer has left — unless the user
   * is still busy in it: typing in a field, or in a context menu that hangs
   * past the panel's edge. Then it waits and asks again.
   */
  const scheduleClose = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      const el = dock.current
      const focused = document.activeElement
      const typing =
        el && focused && el.contains(focused) && focused.matches('input, textarea, select')
      if (el && (typing || el.querySelector('.ctx-menu') || drag.current)) {
        scheduleClose()
      } else {
        setPeek(false)
      }
    }, PEEK_CLOSE_MS)
  }

  /**
   * Pointer movement over the rail (or the floating panel), not mouseenter: a
   * click on the fold chevron leaves the pointer "inside" the dock as far as
   * the browser knows, so the next trip to the rail would never enter it.
   */
  const onMove = () => {
    if (!collapsed) return
    clearTimeout(closeTimer.current)
    if (peek || openTimer.current !== undefined) return
    openTimer.current = setTimeout(() => {
      openTimer.current = undefined
      setPeek(true)
    }, PEEK_OPEN_MS)
  }

  const onLeave = () => {
    if (!collapsed) return
    clearTimeout(openTimer.current)
    openTimer.current = undefined
    if (peek) scheduleClose()
  }

  const showPanel = (next: PanelTab) => {
    onPanel(next)
    clearTimers()
    setPeek(true)
  }

  // --- resizing -------------------------------------------------------------

  // Dragging toward the terminals widens the panel, whichever side it is on.
  const towardMain = side === 'left' ? 1 : -1

  const onResizeDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, width: dragWidth ?? width }
    document.body.classList.add('resizing-sidebar')
  }

  const onResizeMove = (e: PointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (!start) return
    setDragWidth(clampSidebar(start.width + (e.clientX - start.x) * towardMain))
  }

  const onResizeUp = () => {
    if (!drag.current) return
    drag.current = null
    document.body.classList.remove('resizing-sidebar')
    if (dragWidth !== null) viewActions.setSidebarWidth(dragWidth)
    setDragWidth(null)
  }

  const onResizeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? KEY_STEP : e.key === 'ArrowLeft' ? -KEY_STEP : 0
    if (!step) return
    e.preventDefault()
    viewActions.setSidebarWidth(width + step * towardMain)
  }

  // The toggle's chevron points the way the panel will go: toward the window
  // edge to fold it, away from it to dock it again.
  const chevronOut = (side === 'left') === collapsed

  return (
    <div
      ref={dock}
      className={`sidebar-dock${collapsed ? ' collapsed' : ''}${peek ? ' peek' : ''}`}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      {collapsed && (
        <div className="sidebar-rail">
          <button
            className={`icon-btn rail-btn${chevronOut ? ' flip' : ''}`}
            onClick={() => viewActions.setSidebarCollapsed(false)}
            title="Dock the sidebar (⌘B)"
            aria-label="Dock the sidebar"
          >
            <IconChevron />
          </button>
          <button
            className={`icon-btn rail-btn${showing === 'sessions' ? ' active' : ''}`}
            onClick={() => showPanel('sessions')}
            title="Sessions"
            aria-label="Sessions"
          >
            <IconSessions size={16} />
          </button>
          <button
            className={`icon-btn rail-btn${showing === 'sftp' ? ' active' : ''}`}
            onClick={() => showPanel('sftp')}
            disabled={!sftpReady}
            title={sftpReady ? 'Browse files over SFTP' : 'Open an SSH session to browse files'}
            aria-label="SFTP"
          >
            <IconFiles size={16} />
          </button>
        </div>
      )}

      <aside
        className="sidebar"
        style={{ width: dragWidth ?? width }}
        aria-hidden={collapsed && !peek ? true : undefined}
      >
        {/* Empty strip: the macOS traffic lights sit here, so nothing else can. */}
        <div className="sidebar-head" />

        <form
          className="quick-connect"
          onSubmit={(e) => {
            e.preventDefault()
            const target = quick.trim()
            if (!target) return
            onQuickConnect(target)
            setQuick('')
          }}
        >
          <input
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            placeholder="Quick connect…"
            title="user@host or user@host:port, then Enter"
            spellCheck={false}
          />
        </form>

        <div className="panel-tabs">
          <button
            className={`panel-tab${showing === 'sessions' ? ' active' : ''}`}
            onClick={() => onPanel('sessions')}
          >
            Sessions
          </button>
          <button
            className={`panel-tab${showing === 'sftp' ? ' active' : ''}`}
            onClick={() => onPanel('sftp')}
            disabled={!sftpReady}
            title={sftpReady ? 'Browse files over SFTP' : 'Open an SSH session to browse files'}
          >
            SFTP
          </button>
          <button
            className={`icon-btn sidebar-toggle${chevronOut ? ' flip' : ''}`}
            onClick={() => viewActions.setSidebarCollapsed(!collapsed)}
            title={collapsed ? 'Keep the sidebar docked (⌘B)' : 'Collapse the sidebar (⌘B)'}
            aria-label={collapsed ? 'Keep the sidebar docked' : 'Collapse the sidebar'}
          >
            <IconChevron />
          </button>
        </div>

        {showing === 'sftp' && activeTab ? (
          // Keyed by tab so switching sessions resets the browser's state.
          <FileBrowser key={activeTab.tabId} tabId={activeTab.tabId} cwd={activeTab.cwd} />
        ) : (
          <SessionSidebar sessions={sessions} onOpen={onOpen} onEdit={onEdit} onNew={onNew} />
        )}

        <div className="sidebar-actions">
          <button className="btn primary" onClick={onNew}>
            New Session
          </button>
        </div>

        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the sidebar"
          aria-valuemin={SIDEBAR_MIN}
          aria-valuenow={dragWidth ?? width}
          tabIndex={0}
          title="Drag to resize; double-click for the default width"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          onDoubleClick={() => viewActions.setSidebarWidth(SIDEBAR_DEFAULT)}
          onKeyDown={onResizeKey}
        />
      </aside>
    </div>
  )
}
