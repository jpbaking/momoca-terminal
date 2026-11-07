import { useEffect, useRef, useState } from 'react'
import type { RdpTarget, TabState } from '@shared/types'
import { COMMAND_AS_CTRL, SCANCODES, SCAN_CTRL, SCAN_WINDOWS } from '../rdp-keys'
import type { PaneRect } from '../view-state'

/*
 * An RDP session drawn in a tab by IronRDP (WebAssembly). Main hands out a
 * gateway ticket and the credentials (`rdp:open`); IronRDP draws into the
 * canvas and this pane turns DOM input into RDP input.
 */

type Backend = typeof import('@devolutions/iron-remote-desktop-rdp')
type Session = Awaited<ReturnType<InstanceType<Backend['Backend']['SessionBuilder']>['connect']>>

/** What IronRDP passes when the remote clipboard changes. */
interface RemoteClipboard {
  items(): { mimeType(): string; value(): unknown }[]
}

/** The 6 MB WebAssembly module loads on the first RDP tab, not at startup. */
let backend: Promise<Backend> | null = null
function loadBackend(): Promise<Backend> {
  backend ??= import('@devolutions/iron-remote-desktop-rdp').then(async (mod) => {
    await mod.init('WARN')
    return mod
  })
  backend.catch(() => (backend = null))
  return backend
}

/**
 * Windows accepts 200–8192 on a side. Widths go down to a multiple of 4, as
 * mstsc does: xrdp draws rows sheared (each one shifted against the last) when
 * the width is only even. Heights need no alignment, but share the rounding.
 */
const desktopSide = (n: number): number => Math.min(8192, Math.max(200, Math.floor(n / 4) * 4))
const RESIZE_SETTLE_MS = 250

/**
 * Device pixels per CSS pixel: 2 on a Retina screen. The desktop is asked for
 * in device pixels and Windows is told to scale by the same amount (200%), as
 * mstsc does on a HiDPI display, so text is as large as at 1× but sharp
 * instead of stretched. Windows takes 100–500%.
 */
const devicePixels = (): number => Math.min(5, Math.max(1, window.devicePixelRatio || 1))
const scalePercent = (ratio: number): number => Math.round(ratio * 100)

/** Calls `onChange` whenever the window moves to a screen with another pixel ratio. */
function watchPixelRatio(onChange: () => void): () => void {
  let query: MediaQueryList | null = null
  const listen = () => {
    query?.removeEventListener('change', changed)
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    query.addEventListener('change', changed)
  }
  const changed = () => {
    listen()
    onChange()
  }
  listen()
  return () => query?.removeEventListener('change', changed)
}

/** IronErrorKind, as numbered by @devolutions/iron-remote-desktop. */
const ERROR_TEXT: Record<number, string> = {
  1: 'Wrong user name or password',
  2: 'Windows refused the logon',
  3: 'Access denied',
  4: 'Could not reach the server',
  5: 'Could not reach MoMoca’s RDP gateway',
  6: 'The server refused the connection settings (it needs TLS or NLA)'
}

/** A readable sentence from whatever IronRDP threw. */
function describe(err: unknown): string {
  const iron = err as { kind?: () => number; backtrace?: () => string }
  if (typeof iron?.kind === 'function') {
    const kind = iron.kind()
    const detail = iron.backtrace?.().split('\n')[0]?.trim()
    const text = ERROR_TEXT[kind] ?? 'The RDP connection failed'
    return detail && kind !== 1 ? `${text}: ${detail}` : text
  }
  return err instanceof Error ? err.message : String(err)
}

interface Props {
  tab: TabState
  /** Where this pane sits, or null when it isn't on screen. */
  slot: PaneRect | null
  /** True for the tab that receives keyboard focus. */
  focused: boolean
  split: boolean
  /** The session to connect; read once on mount (and on Reconnect). */
  target: RdpTarget
  onFocus: () => void
  onStatus: (tabId: string, status: TabState['status'], error?: string) => void
}

export function RdpPane({ tab, slot, focused, split, target, onFocus, onStatus }: Props) {
  const visible = slot !== null
  const paneRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<Session | null>(null)
  const backendRef = useRef<Backend | null>(null)
  const clipboardOn = useRef(true)
  const dynamicRef = useRef(false)
  /** The session's HiDPI setting; off, every desktop pixel is one CSS pixel. */
  const hiDpiRef = useRef(true)
  const pixelRatio = (): number => (hiDpiRef.current ? devicePixels() : 1)
  /** Last text that crossed the clipboard either way, so it isn't echoed back. */
  const lastClip = useRef<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [message, setMessage] = useState<string | null>('Connecting…')
  const { tabId } = tab

  const report = useRef(onStatus)
  report.current = onStatus

  const send = (events: unknown[]) => {
    const mod = backendRef.current
    const session = sessionRef.current
    if (!mod || !session) return
    const tx = new mod.Backend.InputTransaction()
    for (const event of events) tx.addEvent(event as never)
    session.applyInputs(tx)
  }

  /** This Mac's clipboard to the remote, when it changed since we last saw it. */
  const pushClipboard = async () => {
    const mod = backendRef.current
    const session = sessionRef.current
    if (!mod || !session || !clipboardOn.current) return
    try {
      const text = await navigator.clipboard.readText()
      if (!text || text === lastClip.current) return
      lastClip.current = text
      const data = new mod.Backend.ClipboardData()
      data.addText('text/plain', text)
      await session.onClipboardPaste(data)
    } catch {
      // An unreadable clipboard (empty, or not text) has nothing to send.
    }
  }

  // --- connect --------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current
    const pane = paneRef.current
    if (!canvas || !pane) return
    let cancelled = false
    let session: Session | null = null

    setMessage('Connecting…')
    report.current(tabId, 'connecting')

    void (async () => {
      try {
        const ticket = await window.api.rdp.open(target)
        const mod = await loadBackend()
        if (cancelled) return
        backendRef.current = mod
        const options = ticket.options
        clipboardOn.current = options.clipboard !== false
        dynamicRef.current = options.dynamicResolution === true
        hiDpiRef.current = options.hiDpi !== false

        // Dynamic resolution, or no fixed size, starts at the tab's own size.
        const rect = pane.getBoundingClientRect()
        const fixed = !dynamicRef.current && options.width && options.height
        const ratio = pixelRatio()
        const width = desktopSide((fixed ? options.width! : rect.width || 1024) * ratio)
        const height = desktopSide((fixed ? options.height! : rect.height || 768) * ratio)

        const builder = new mod.Backend.SessionBuilder()
        builder.username(ticket.username)
        builder.serverDomain(ticket.domain)
        builder.password(ticket.password)
        builder.destination(ticket.destination)
        builder.proxyAddress(ticket.proxyAddress)
        builder.authToken(ticket.authToken)
        builder.desktopSize(new mod.Backend.DesktopSize(width, height))
        builder.renderCanvas(canvas)
        builder.setCursorStyleCallbackContext(canvas)
        builder.setCursorStyleCallback((kind: string, data?: string, x?: number, y?: number) => {
          if (kind === 'url' && data) {
            canvas.style.cursor = `url(${data}) ${Math.round(x ?? 0)} ${Math.round(y ?? 0)}, default`
          } else canvas.style.cursor = kind === 'hidden' || kind === 'none' ? 'none' : 'default'
        })
        builder.extension(mod.displayControl(dynamicRef.current))
        if (ratio > 1) builder.extension(mod.desktopScaleFactor(scalePercent(ratio)))
        if (clipboardOn.current) {
          builder.remoteClipboardChangedCallback((data: RemoteClipboard) => {
            const item = data.items().find((i) => i.mimeType() === 'text/plain')
            const text = item?.value()
            if (typeof text === 'string' && text !== lastClip.current) {
              lastClip.current = text
              void navigator.clipboard.writeText(text).catch(() => {})
            }
          })
          builder.forceClipboardUpdateCallback(() => {
            lastClip.current = null
            void pushClipboard()
          })
        }

        session = await builder.connect()
        if (cancelled) {
          session.shutdown()
          return
        }
        sessionRef.current = session
        setMessage(null)
        report.current(tabId, 'ready')
        if (document.activeElement === document.body || focused) canvas.focus({ preventScroll: true })
        void pushClipboard()

        const ended = await session.run()
        if (cancelled) return
        const reason = ended.reason()
        setMessage(`Session ended${reason ? `: ${reason}` : ''}`)
        report.current(tabId, 'closed')
      } catch (err) {
        if (cancelled) return
        const text = describe(err)
        setMessage(text)
        report.current(tabId, 'error', text)
      } finally {
        if (!cancelled) sessionRef.current = null
      }
    })()

    return () => {
      cancelled = true
      try {
        session?.shutdown()
      } catch {
        // Already gone.
      }
      sessionRef.current = null
    }
    // `target` is read once per attempt, like TerminalPane's connect options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, tabId])

  // --- fill the tab ---------------------------------------------------------

  useEffect(() => {
    const pane = paneRef.current
    const canvas = canvasRef.current
    if (!pane || !canvas) return

    /*
     * The canvas holds the desktop in device pixels and is shown at one canvas
     * pixel per device pixel at most, shrunk when the tab is smaller. Only the
     * caps are set here: with width and height left auto, CSS shrinks a canvas
     * to its max-width and max-height keeping its shape, on every layout, so
     * a tab resize needs no script. IronRDP sets the canvas's width and height
     * on connect and on every resize.
     */
    const fitCanvas = () => {
      if (!canvas.width || !canvas.height) return
      const ratio = pixelRatio()
      canvas.style.maxWidth = `min(100%, ${canvas.width / ratio}px)`
      canvas.style.maxHeight = `min(100%, ${canvas.height / ratio}px)`
    }

    // A dynamic desktop follows the tab's size and the screen's pixel ratio.
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = ''
    const follow = () => {
      const width = pane.clientWidth
      const height = pane.clientHeight
      if (!dynamicRef.current || width < 50 || height < 50) return // hidden, or not dynamic
      clearTimeout(timer)
      timer = setTimeout(() => {
        const ratio = pixelRatio()
        const w = desktopSide(width * ratio)
        const h = desktopSide(height * ratio)
        const key = `${w}x${h}@${ratio}`
        if (key === last || !sessionRef.current) return
        last = key
        sessionRef.current.resize(w, h, scalePercent(ratio))
      }, RESIZE_SETTLE_MS)
    }

    const sized = new MutationObserver(fitCanvas)
    sized.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] })
    const observer = new ResizeObserver(follow)
    observer.observe(pane)
    const unwatch = watchPixelRatio(() => {
      fitCanvas()
      follow()
    })
    return () => {
      clearTimeout(timer)
      sized.disconnect()
      observer.disconnect()
      unwatch()
    }
  }, [])

  // Only the focused pane takes the keyboard, as with terminals.
  useEffect(() => {
    if (visible && focused && sessionRef.current) {
      canvasRef.current?.focus({ preventScroll: true })
      void pushClipboard()
    }
  }, [visible, focused])

  // --- input ----------------------------------------------------------------

  /** ⌘ tapped on its own is the Windows key; ⌘ with another key is a shortcut. */
  const commandAlone = useRef(false)

  const onKey = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const mod = backendRef.current
    if (!mod || !sessionRef.current) return
    const down = event.type === 'keydown'
    const { DeviceEvent } = mod.Backend
    const code = event.nativeEvent.code

    if (code === 'MetaLeft' || code === 'MetaRight') {
      if (down) commandAlone.current = true
      else if (commandAlone.current) {
        commandAlone.current = false
        send([DeviceEvent.keyPressed(SCAN_WINDOWS), DeviceEvent.keyReleased(SCAN_WINDOWS)])
      }
      event.preventDefault()
      return
    }

    if (event.metaKey) {
      commandAlone.current = false
      // ⌘C, ⌘V and friends become Ctrl shortcuts inside Windows; anything
      // else is left to bubble up to MoMoca's own shortcuts.
      if (!COMMAND_AS_CTRL.has(code)) return
      event.preventDefault()
      event.stopPropagation()
      if (!down) return
      const key = SCANCODES[code]
      const chord = () =>
        send([
          DeviceEvent.keyPressed(SCAN_CTRL),
          DeviceEvent.keyPressed(key),
          DeviceEvent.keyReleased(key),
          DeviceEvent.keyReleased(SCAN_CTRL)
        ])
      if (code === 'KeyV') void pushClipboard().then(chord)
      else chord()
      return
    }

    const scancode = SCANCODES[code]
    event.preventDefault()
    event.stopPropagation()
    if (scancode === undefined) return
    if (code === 'CapsLock' || code === 'NumLock') syncLocks(event.nativeEvent)
    send([down ? DeviceEvent.keyPressed(scancode) : DeviceEvent.keyReleased(scancode)])
  }

  const syncLocks = (event: KeyboardEvent | MouseEvent) => {
    sessionRef.current?.synchronizeLockKeys(
      event.getModifierState('ScrollLock'),
      event.getModifierState('NumLock'),
      event.getModifierState('CapsLock'),
      false
    )
  }

  const position = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget
    const rect = canvas.getBoundingClientRect()
    const x = Math.round(((event.clientX - rect.left) * canvas.width) / rect.width)
    const y = Math.round(((event.clientY - rect.top) * canvas.height) / rect.height)
    return { x: Math.max(0, Math.min(canvas.width - 1, x)), y: Math.max(0, Math.min(canvas.height - 1, y)) }
  }

  const onMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const mod = backendRef.current
    if (!mod) return
    const { x, y } = position(event)
    send([mod.Backend.DeviceEvent.mouseMove(x, y)])
  }

  const onMouseButton = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const mod = backendRef.current
    if (!mod) return
    event.preventDefault()
    if (event.type === 'mousedown') event.currentTarget.focus({ preventScroll: true })
    const { DeviceEvent } = mod.Backend
    const { x, y } = position(event)
    const button =
      event.type === 'mousedown'
        ? DeviceEvent.mouseButtonPressed(event.button)
        : DeviceEvent.mouseButtonReleased(event.button)
    send([DeviceEvent.mouseMove(x, y), button])
  }

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const mod = backendRef.current
    if (!mod) return
    const vertical = event.deltaY !== 0
    const amount = Math.round(-(vertical ? event.deltaY : event.deltaX))
    if (!amount) return
    // RotationUnit is Pixel 0, Line 1, Page 2: the same numbers as WheelEvent.deltaMode.
    send([mod.Backend.DeviceEvent.wheelRotations(vertical, amount, event.deltaMode as never)])
  }

  const releaseAll = () => sessionRef.current?.releaseAllInputs()

  const connected = message === null

  return (
    <div
      className={`terminal-pane rdp-pane${split ? ' in-split' : ''}${split && focused ? ' focused' : ''}`}
      hidden={!visible}
      style={slot ? { top: slot.top, left: slot.left, width: slot.width, height: slot.height } : undefined}
      onMouseDown={onFocus}
    >
      {split && <div className="pane-label">{tab.title}</div>}
      <div className="rdp-screen" ref={paneRef}>
        <canvas
          ref={canvasRef}
          className="rdp-canvas"
          tabIndex={0}
          hidden={!connected}
          onKeyDown={onKey}
          onKeyUp={onKey}
          onMouseMove={onMouseMove}
          onMouseDown={onMouseButton}
          onMouseUp={onMouseButton}
          onMouseEnter={(e) => syncLocks(e.nativeEvent)}
          onMouseLeave={releaseAll}
          onBlur={releaseAll}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        />
        {!connected && (
          <div className="rdp-status">
            <p>{message}</p>
            {tab.status !== 'connecting' && (
              <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
                Reconnect
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
