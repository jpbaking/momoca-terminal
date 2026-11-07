import { useEffect, useState } from 'react'
import { useEscape } from '../hooks/useEscape'
import {
  RDP_SIZE_PRESETS,
  type AuthMethod,
  type ImportedKey,
  type RdpOptions,
  type SavedSession,
  type SessionKind,
  type ToolId
} from '@shared/types'
import { useExclusive } from '../hooks/useExclusive'
import { SessionTypePicker } from './SessionTypePicker'

/** Which entry of the screen-size picker a saved session's options select. */
function rdpSizeChoice(options?: RdpOptions): string {
  if (options?.fullscreen) return 'fullscreen'
  if (!options?.width || !options.height) return 'default'
  const key = `${options.width}x${options.height}`
  return RDP_SIZE_PRESETS.some((p) => `${p.width}x${p.height}` === key) ? key : 'custom'
}

interface Props {
  initial: SavedSession | null
  onSave: (session: SavedSession, savePassword?: string) => void
  onDelete: (id: string) => void
  onCancel: () => void
  onManageKeys: () => void
  onOpenGuide: (focus?: ToolId) => void
}

const BLANK: SavedSession = {
  id: '',
  name: '',
  kind: 'ssh',
  folder: '',
  host: '',
  port: 22,
  username: '',
  authMethod: 'agent',
  trackCwd: true
}

const DEFAULT_PORT: Partial<Record<SessionKind, number>> = {
  ssh: 22,
  sftp: 22,
  mosh: 22,
  telnet: 23,
  ftp: 21,
  rsh: 514,
  rdp: 3389,
  vnc: 5900,
  browser: 80,
  xdmcp: 177
}

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]

/** Which fields each protocol needs. */
const NEEDS_HOST: SessionKind[] = [
  'ssh',
  'sftp',
  'telnet',
  'mosh',
  'ftp',
  'rsh',
  'rdp',
  'vnc',
  'browser',
  'xdmcp'
]
const NEEDS_USER: SessionKind[] = ['ssh', 'sftp', 'mosh', 'rsh']
const SHOWS_USER: SessionKind[] = [...NEEDS_USER, 'ftp', 'rdp', 'vnc']
const NEEDS_AUTH: SessionKind[] = ['ssh', 'sftp']

/** Explains where a session will actually appear, when it isn't a tab. */
const KIND_NOTE: Partial<Record<SessionKind, string>> = {
  vnc: 'Opens in macOS Screen Sharing — no extra software needed.',
  browser: 'Opens the host in your default browser.',
  rdp: 'Opens in a tab, or in FreeRDP’s own window when it needs sound or a microphone.',
  xdmcp: 'Starts an X server on display :1 via XQuartz and queries the host.',
  ftp: 'Runs the ftp client in a tab. FTP sends credentials in the clear — prefer SFTP.',
  rsh: 'Runs the rsh client in a tab. Unencrypted — only on a trusted network.',
  mosh: 'Runs the mosh client in a tab. Needs mosh on this Mac and on the server.'
}

export function SessionDialog({
  initial,
  onSave,
  onDelete,
  onCancel,
  onManageKeys,
  onOpenGuide
}: Props) {
  useEscape(onCancel)
  const [draft, setDraft] = useState<SavedSession>(initial ?? BLANK)
  const [password, setPassword] = useState('')
  const [keys, setKeys] = useState<ImportedKey[]>([])
  const [ports, setPorts] = useState<{ path: string; label: string }[]>([])
  const { busy: pickerBusy, run: exclusive } = useExclusive()

  useEffect(() => {
    void window.api.keys.list().then(setKeys)
  }, [])

  useEffect(() => {
    if (draft.kind === 'serial') void window.api.serial.list().then(setPorts).catch(() => setPorts([]))
  }, [draft.kind])

  const set = <K extends keyof SavedSession>(key: K, value: SavedSession[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const rdp = draft.rdp ?? {}
  const setRdp = (patch: Partial<RdpOptions>) =>
    setDraft((current) => ({ ...current, rdp: { ...current.rdp, ...patch } }))
  const [sizeChoice, setSizeChoice] = useState(() => rdpSizeChoice(initial?.rdp))
  const engine = rdp.engine ?? 'ironrdp'
  const inTab = engine === 'ironrdp'
  /** Whether FreeRDP (or Windows App) is installed; null until checked. */
  const [freeRdp, setFreeRdp] = useState<boolean | null>(null)

  useEffect(() => {
    if (draft.kind !== 'rdp') return
    void window.api.tools
      .check()
      .then((tools) => setFreeRdp(tools.some((t) => t.id === 'freerdp' && t.available)))
      .catch(() => setFreeRdp(null))
  }, [draft.kind])

  const chooseSize = (choice: string) => {
    setSizeChoice(choice)
    if (choice === 'fullscreen') setRdp({ fullscreen: true, width: undefined, height: undefined })
    else if (choice === 'default') setRdp({ fullscreen: false, width: undefined, height: undefined })
    else if (choice === 'custom') {
      // Start from whatever size was showing, so Custom is a tweak rather than a blank.
      setRdp({ fullscreen: false, width: rdp.width ?? 1920, height: rdp.height ?? 1080 })
    } else {
      const [width, height] = choice.split('x').map(Number)
      setRdp({ fullscreen: false, width, height })
    }
  }

  const changeKind = (kind: SessionKind) =>
    setDraft((current) => ({
      ...current,
      kind,
      // Snap the port to the new protocol's default unless it was customised.
      port:
        current.port && current.port !== DEFAULT_PORT[current.kind]
          ? current.port
          : DEFAULT_PORT[kind]
    }))

  const needsHost = NEEDS_HOST.includes(draft.kind)
  const needsUser = NEEDS_USER.includes(draft.kind)
  const showsUser = SHOWS_USER.includes(draft.kind)
  const needsAuth = NEEDS_AUTH.includes(draft.kind)

  const canSave =
    draft.name.trim() &&
    (!needsHost || draft.host?.trim()) &&
    (!needsUser || draft.username?.trim()) &&
    (draft.kind !== 'serial' || draft.serialPath)

  const pickExternalKey = () =>
    void exclusive(async () => {
      const path = await window.api.dialog.pickPrivateKey()
      if (path) {
        set('privateKeyPath', path)
        set('keyId', undefined)
      }
    })

  return (
    <div className="scrim" onMouseDown={onCancel}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{initial ? 'Edit session' : 'New session'}</h2>

        <SessionTypePicker value={draft.kind} onChange={changeKind} onOpenGuide={onOpenGuide} />

        <div className="field-row">
          <div className="field" style={{ flex: 2 }}>
            <label>Name</label>
            <input
              autoFocus
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="prod-web-01"
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Folder</label>
            <input
              value={draft.folder}
              onChange={(e) => set('folder', e.target.value)}
              placeholder="User sessions"
            />
          </div>
        </div>

        {needsHost && (
          <div className="field-row">
            <div className="field" style={{ flex: 2 }}>
              <label>Host</label>
              <input value={draft.host ?? ''} onChange={(e) => set('host', e.target.value)} />
            </div>
            <div className="field" style={{ width: 92 }}>
              <label>{draft.kind === 'mosh' ? 'SSH port' : 'Port'}</label>
              <input
                type="number"
                value={draft.port ?? DEFAULT_PORT[draft.kind] ?? 22}
                onChange={(e) => set('port', Number(e.target.value) || undefined)}
              />
            </div>
          </div>
        )}

        {showsUser && (
          <div className="field">
            <label>Username{needsUser ? '' : ' (optional)'}</label>
            <input
              value={draft.username ?? ''}
              onChange={(e) => set('username', e.target.value)}
            />
          </div>
        )}

        {KIND_NOTE[draft.kind] && <p className="hint">{KIND_NOTE[draft.kind]}</p>}

        {draft.kind === 'serial' && (
          <div className="field-row">
            <div className="field" style={{ flex: 2 }}>
              <label>Device</label>
              <select
                value={draft.serialPath ?? ''}
                onChange={(e) => set('serialPath', e.target.value)}
              >
                <option value="">
                  {ports.length ? '— select a device —' : 'No serial devices detected'}
                </option>
                {ports.map((port) => (
                  <option key={port.path} value={port.path}>
                    {port.path} {port.label && `· ${port.label}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ width: 120 }}>
              <label>Baud rate</label>
              <select
                value={draft.baudRate ?? 115200}
                onChange={(e) => set('baudRate', Number(e.target.value))}
              >
                {BAUD_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {draft.kind === 'local' && (
          <div className="field">
            <label>Shell</label>
            <input
              value={draft.shell ?? ''}
              onChange={(e) => set('shell', e.target.value)}
              placeholder="Defaults to $SHELL"
            />
          </div>
        )}

        {needsAuth && (
          <>
            <div className="field">
              <label>Authentication</label>
              <select
                value={draft.authMethod ?? 'agent'}
                onChange={(e) => set('authMethod', e.target.value as AuthMethod)}
              >
                <option value="agent">SSH agent</option>
                <option value="key">Private key</option>
                <option value="password">Password</option>
              </select>
            </div>

            {draft.authMethod === 'key' && (
              <div className="inset">
                <div className="field">
                  <label>Imported key</label>
                  <select
                    value={draft.keyId ?? ''}
                    onChange={(e) => {
                      set('keyId', e.target.value || undefined)
                      if (e.target.value) set('privateKeyPath', undefined)
                    }}
                  >
                    <option value="">— use a file on disk —</option>
                    {keys.map((key) => (
                      <option key={key.id} value={key.id}>
                        {key.name} ({key.type})
                      </option>
                    ))}
                  </select>
                </div>

                {!draft.keyId && (
                  <div className="field">
                    <label>Key file</label>
                    <div className="field-row">
                      <input
                        value={draft.privateKeyPath ?? ''}
                        onChange={(e) => set('privateKeyPath', e.target.value)}
                        placeholder="~/.ssh/id_ed25519"
                      />
                      <button className="btn" onClick={pickExternalKey} disabled={pickerBusy}>
                        Browse…
                      </button>
                    </div>
                  </div>
                )}

                <button className="linklike" onClick={onManageKeys}>
                  Import or manage keys…
                </button>
              </div>
            )}

            {draft.authMethod === 'password' && (
              <div className="field">
                <label>Password — stored in the macOS Keychain, optional</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Leave blank to be prompted each time"
                />
              </div>
            )}
          </>
        )}

        {draft.kind === 'rdp' && (
          <div className="field">
            <label>Password — stored in the macOS Keychain, optional</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to be asked when you connect"
            />
          </div>
        )}

        {draft.kind === 'rdp' && (
          <div className="inset">
            <div className="field">
              <label>Opens in</label>
              <select
                value={engine}
                onChange={(e) => {
                  const next = e.target.value as RdpOptions['engine']
                  setRdp({ engine: next })
                  // A tab has no full screen of its own.
                  if (next === 'ironrdp' && sizeChoice === 'fullscreen') chooseSize('default')
                }}
              >
                <option value="ironrdp">A tab (IronRDP)</option>
                <option value="freerdp" disabled={freeRdp === false && engine !== 'freerdp'}>
                  Its own window (FreeRDP){freeRdp === false ? ' — not installed' : ''}
                </option>
              </select>
              {freeRdp === false && (
                <p className="hint">
                  The window adds sound, microphone and full screen.{' '}
                  <button type="button" className="linklike" onClick={() => onOpenGuide('freerdp')}>
                    Install FreeRDP
                  </button>
                </p>
              )}
            </div>

            <div className="field-row">
              <div className="field" style={{ flex: 2 }}>
                <label>Screen size</label>
                <select
                  value={sizeChoice}
                  disabled={inTab && rdp.dynamicResolution === true}
                  onChange={(e) => chooseSize(e.target.value)}
                >
                  <option value="default">
                    {inTab ? 'The tab’s size when it connects' : 'FreeRDP default (1024 × 768)'}
                  </option>
                  {RDP_SIZE_PRESETS.map(({ width, height }) => (
                    <option key={`${width}x${height}`} value={`${width}x${height}`}>
                      {width} × {height}
                    </option>
                  ))}
                  <option value="custom">Custom…</option>
                  {!inTab && <option value="fullscreen">Full screen</option>}
                </select>
              </div>
              {sizeChoice === 'custom' && !(inTab && rdp.dynamicResolution) && (
                <>
                  <div className="field" style={{ width: 92 }}>
                    <label>Width</label>
                    <input
                      type="number"
                      min={200}
                      max={8192}
                      value={rdp.width ?? ''}
                      onChange={(e) => setRdp({ width: Number(e.target.value) || undefined })}
                    />
                  </div>
                  <div className="field" style={{ width: 92 }}>
                    <label>Height</label>
                    <input
                      type="number"
                      min={200}
                      max={8192}
                      value={rdp.height ?? ''}
                      onChange={(e) => setRdp({ height: Number(e.target.value) || undefined })}
                    />
                  </div>
                </>
              )}
            </div>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={rdp.dynamicResolution ?? false}
                onChange={(e) => setRdp({ dynamicResolution: e.target.checked })}
              />
              {inTab
                ? 'Fill the tab, and resize the remote desktop with it'
                : 'Resize the remote desktop with the window'}
            </label>
            {inTab && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={rdp.hiDpi ?? true}
                  onChange={(e) => setRdp({ hiDpi: e.target.checked })}
                />
                Sharp on Retina screens (HiDPI): full resolution, with Windows scaled to match
              </label>
            )}
            {!inTab && (
              <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={rdp.playAudio ?? false}
                onChange={(e) => setRdp({ playAudio: e.target.checked })}
              />
              Play the remote computer&rsquo;s sound on this Mac
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={rdp.microphone ?? false}
                onChange={(e) => setRdp({ microphone: e.target.checked })}
              />
              Use this Mac&rsquo;s microphone in the session
            </label>
              </>
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={rdp.clipboard ?? true}
                onChange={(e) => setRdp({ clipboard: e.target.checked })}
              />
              Share the clipboard both ways
            </label>
            <p className="hint">
              {inTab
                ? 'Sound and the microphone need FreeRDP’s window. HiDPI sends four times the pixels; turn it off on a slow link or an old host. In the tab, ⌘C, ⌘V, ⌘X, ⌘A, ⌘Z, ⌘Y and ⌘S act as Ctrl shortcuts, and ⌘ on its own is the Windows key.'
                : 'Windows App, when it runs the session instead of FreeRDP, uses its own settings.'}
            </p>
          </div>
        )}

        {draft.kind === 'ssh' && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.trackCwd ?? false}
              onChange={(e) => set('trackCwd', e.target.checked)}
            />
            Follow the shell&rsquo;s directory in the file browser
          </label>
        )}

        <div className="modal-actions">
          {initial && (
            <button
              className="btn ghost danger"
              style={{ marginRight: 'auto' }}
              onClick={() => onDelete(initial.id)}
            >
              Delete
            </button>
          )}
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!canSave}
            onClick={() => onSave(draft, password || undefined)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
