import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { app, shell } from 'electron'
import type { RdpOptions, SavedSession, ToolCheck, ToolId } from '@shared/types'

const run = promisify(execFile)

/** Resolve a binary on PATH, including the Homebrew prefixes a GUI app misses. */
async function which(binary: string): Promise<string | null> {
  const env = {
    ...process.env,
    PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin:/opt/X11/bin`
  }
  try {
    const { stdout } = await run('/usr/bin/which', [binary], { env })
    const path = stdout.trim()
    return path || null
  } catch {
    return null
  }
}

function firstExistingApp(names: string[]): string | null {
  for (const name of names) {
    const path = `/Applications/${name}`
    if (existsSync(path)) return path
    const utility = `/Applications/Utilities/${name}`
    if (existsSync(utility)) return utility
  }
  return null
}

interface ToolDef {
  id: ToolId
  name: string
  purpose: string
  detect: () => Promise<{ available: boolean; detail?: string }>
  install?: ToolCheck['install']
}

const TOOLS: ToolDef[] = [
  {
    id: 'vnc',
    name: 'Screen Sharing',
    purpose: 'VNC sessions',
    detect: async () => ({ available: true, detail: 'Built into macOS' })
  },
  {
    id: 'browser',
    name: 'Default browser',
    purpose: 'Browser sessions',
    detect: async () => ({ available: true, detail: 'Your default browser' })
  },
  {
    id: 'mosh',
    name: 'Mosh',
    purpose: 'Mosh sessions',
    detect: async () => {
      const path = await which('mosh')
      return { available: Boolean(path), detail: path ?? undefined }
    },
    install: {
      summary: 'Mosh must be installed on this Mac *and* on the server.',
      steps: [
        { label: 'Install locally with Homebrew', command: 'brew install mosh' },
        { label: 'On a Debian/Ubuntu server', command: 'sudo apt install mosh' },
        { label: 'On a RHEL/Fedora server', command: 'sudo dnf install mosh' },
        { label: 'Open UDP 60000–61000 to the server in its firewall' }
      ],
      url: 'https://mosh.org/#getting'
    }
  },
  {
    id: 'freerdp',
    name: 'FreeRDP or Windows App',
    purpose: 'RDP in its own window (sound, microphone, full screen)',
    detect: async () => {
      const binary = await which('xfreerdp3') ?? await which('xfreerdp')
      if (binary) return { available: true, detail: binary }
      const app = firstExistingApp(['Windows App.app', 'Microsoft Remote Desktop.app'])
      return { available: Boolean(app), detail: app ?? undefined }
    },
    install: {
      summary:
        'RDP opens in a tab without this. A session set to open in its own window needs FreeRDP, which adds sound, the microphone and full screen.',
      steps: [
        { label: 'Command-line client (opens its own window)', command: 'brew install freerdp' },
        { label: 'Or install Windows App from the Mac App Store' }
      ],
      url: 'https://apps.apple.com/app/windows-app/id1295203466'
    }
  },
  {
    id: 'xquartz',
    name: 'XQuartz',
    purpose: 'XDMCP sessions and X11 forwarding',
    detect: async () => {
      const app = firstExistingApp(['XQuartz.app'])
      const binary = existsSync('/opt/X11/bin/X') ? '/opt/X11/bin/X' : null
      return { available: Boolean(app || binary), detail: binary ?? app ?? undefined }
    },
    install: {
      summary: 'XQuartz provides the X server macOS no longer ships.',
      steps: [
        { label: 'Install with Homebrew', command: 'brew install --cask xquartz' },
        { label: 'Log out and back in so /opt/X11 is on your PATH' },
        { label: 'It also enables SSH X11 forwarding (ssh -X)' }
      ],
      url: 'https://www.xquartz.org'
    }
  },
  {
    id: 'ftp',
    name: 'ftp client',
    purpose: 'FTP sessions',
    detect: async () => {
      const path = await which('ftp')
      return { available: Boolean(path), detail: path ?? undefined }
    },
    install: {
      summary: 'macOS removed the bundled ftp client in Catalina.',
      steps: [
        { label: 'Install it with Homebrew', command: 'brew install inetutils' },
        { label: 'Prefer SFTP where you can — FTP sends credentials in the clear' }
      ]
    }
  },
  {
    id: 'rsh',
    name: 'rsh client',
    purpose: 'Rsh sessions',
    detect: async () => {
      const path = await which('rsh')
      return { available: Boolean(path), detail: path ?? undefined }
    },
    install: {
      summary:
        'Rsh is unencrypted and removed from modern systems. Only use it on an isolated network.',
      steps: [
        { label: 'Install it with Homebrew', command: 'brew install inetutils' },
        { label: 'Use SSH instead wherever possible' }
      ]
    }
  }
]

export async function checkTools(): Promise<ToolCheck[]> {
  return Promise.all(
    TOOLS.map(async (tool) => {
      const { available, detail } = await tool.detect()
      return {
        id: tool.id,
        name: tool.name,
        purpose: tool.purpose,
        available,
        detail,
        install: tool.install
      }
    })
  )
}

export async function checkTool(id: ToolId): Promise<ToolCheck | null> {
  return (await checkTools()).find((tool) => tool.id === id) ?? null
}

/**
 * X server ▸ Start X server. macOS has no X server of its own, so this starts
 * XQuartz and lets it own the display; a missing XQuartz sends the caller to
 * the requirements guide rather than failing silently.
 */
export async function startXServer(): Promise<{
  launched: boolean
  message: string
  tool?: ToolId
}> {
  const tool = await checkTool('xquartz')
  if (!tool?.available) {
    return { launched: false, message: 'XQuartz is not installed', tool: 'xquartz' }
  }
  spawn('/usr/bin/open', ['-a', 'XQuartz'], { detached: true, stdio: 'ignore' }).unref()
  return { launched: true, message: 'Started XQuartz — X11 clients can use $DISPLAY' }
}

type LaunchResult = { launched: boolean; message: string; tool?: ToolId }

/** How a handoff gets a password without the renderer ever holding a stored one. */
export interface ExternalCredentials {
  /** The secret stored under a vault id, or null. */
  lookupSecret: (vaultId: string) => Promise<string | null>
  /** Ask the user. Null means they cancelled. */
  askPassword: (title: string, prompt: string) => Promise<string | null>
}

/** XQuartz's socket for display :0. */
const X_SOCKET = '/tmp/.X11-unix/X0'
const X_START_TIMEOUT_MS = 15_000

/**
 * FreeRDP's X11 client needs a display, and an app started from Finder has no
 * `$DISPLAY`. Start XQuartz if it isn't running and wait for :0 to appear.
 */
async function ensureXDisplay(): Promise<string | null> {
  if (existsSync(X_SOCKET)) return ':0'
  if (!(await checkTool('xquartz'))?.available) return null
  spawn('/usr/bin/open', ['-a', 'XQuartz'], { detached: true, stdio: 'ignore' }).unref()
  for (let waited = 0; waited < X_START_TIMEOUT_MS; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    if (existsSync(X_SOCKET)) return ':0'
  }
  return null
}

/** The X11 builds are named xfreerdp; the SDL build draws its own native window. */
const needsXServer = (binary: string): boolean => /\/xfreerdp3?$/.test(binary)

/** A FreeRDP that is still running after this long has got past connecting and logging in. */
const EARLY_EXIT_MS = 5_000
const LOG_ROTATE_BYTES = 1024 * 1024

/** FreeRDP refuses a size outside roughly this range; out-of-range values fall back to its default. */
const RDP_MIN_SIDE = 200
const RDP_MAX_SIDE = 8192

const validSide = (n: number | undefined): n is number =>
  Number.isInteger(n) && n! >= RDP_MIN_SIDE && n! <= RDP_MAX_SIDE

/** The session dialog's RDP options as FreeRDP arguments. Audio uses the macOS backend. */
function rdpOptionArgs(options: RdpOptions = {}): string[] {
  const args: string[] = []
  if (options.fullscreen) args.push('+f')
  else if (validSide(options.width) && validSide(options.height)) {
    args.push(`/size:${options.width}x${options.height}`)
  }
  if (options.dynamicResolution) args.push('+dynamic-resolution')
  if (options.playAudio) args.push('/sound:sys:mac')
  if (options.microphone) args.push('/microphone:sys:mac')
  args.push(options.clipboard === false ? '-clipboard' : '/clipboard')
  return args
}

/** The last `[ERROR]` FreeRDP wrote since `from`, without its timestamp and source prefix. */
function lastFreeRdpError(logPath: string, from: number): string | null {
  try {
    const lines = readFileSync(logPath).subarray(from).toString('utf8').split('\n')
    const error = lines.reverse().find((line) => line.includes('[ERROR]'))
    return error ? error.replace(/^.*\]: /, '').trim() : null
  } catch {
    return null
  }
}

/**
 * Run FreeRDP against a session, with its password.
 *
 * Arguments go in on stdin (`/args-from:stdin`, one per line), so the password
 * never appears in argv, where `ps` shows it to every user on this Mac. Output
 * goes to a log file rather than a pipe: the session must outlive this app,
 * and a pipe would close when the app quits. A FreeRDP that dies within a few
 * seconds reports its own error instead of failing silently.
 */
async function launchFreeRdp(
  binary: string,
  session: SavedSession,
  credentials: ExternalCredentials
): Promise<LaunchResult> {
  const host = session.host ?? ''
  const port = session.port ?? 3389
  const env = { ...process.env }

  if (needsXServer(binary)) {
    const display = await ensureXDisplay()
    if (!display) {
      return { launched: false, message: 'FreeRDP needs XQuartz, which did not start', tool: 'xquartz' }
    }
    env.DISPLAY = display
  }

  const label = session.username ? `${session.username}@${host}` : host
  const stored = session.id ? await credentials.lookupSecret(session.id) : null
  const password = stored ?? (await credentials.askPassword(label, `RDP password for ${label}:`))
  // Without a password FreeRDP asks for one on a terminal that a handoff does
  // not have, and waits there for ever.
  if (!password) return { launched: false, message: 'RDP connection cancelled — no password given' }
  if (/[\r\n]/.test(password)) {
    return { launched: false, message: 'FreeRDP cannot take a password containing a line break' }
  }

  const args = [`/v:${host}:${port}`, '/cert:ignore', ...rdpOptionArgs(session.rdp)]
  if (session.username) args.push(`/u:${session.username}`)
  args.push(`/p:${password}`)

  const logPath = join(app.getPath('logs'), 'freerdp.log')
  mkdirSync(dirname(logPath), { recursive: true })
  const size = existsSync(logPath) ? statSync(logPath).size : 0
  const from = size > LOG_ROTATE_BYTES ? 0 : size
  const log = openSync(logPath, from === 0 ? 'w' : 'a', 0o600)

  const child = spawn(binary, ['/args-from:stdin'], {
    env,
    detached: true,
    stdio: ['pipe', log, log]
  })
  closeSync(log)
  child.stdin?.on('error', () => {}) // FreeRDP exiting before reading stdin is reported below.
  child.stdin?.end(`${args.join('\n')}\n`)
  child.unref()

  const exit = await new Promise<number | 'running'>((resolve) => {
    const timer = setTimeout(() => resolve('running'), EARLY_EXIT_MS)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code ?? -1)
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve(-1)
    })
  })

  if (exit === 'running') return { launched: true, message: `Started FreeRDP against ${host}` }
  if (exit === 0) return { launched: true, message: `FreeRDP session to ${host} ended` }
  const reason = lastFreeRdpError(logPath, from) ?? `exit code ${exit}`
  return { launched: false, message: `FreeRDP could not connect to ${host}: ${reason}` }
}

/**
 * Session kinds that hand off to another application rather than opening a tab.
 * Returns a human-readable outcome for the UI to show.
 */
export async function launchExternal(
  session: SavedSession,
  credentials: ExternalCredentials
): Promise<LaunchResult> {
  const host = session.host ?? ''
  const user = session.username

  switch (session.kind) {
    case 'vnc': {
      const port = session.port && session.port !== 5900 ? `:${session.port}` : ''
      const auth = user ? `${encodeURIComponent(user)}@` : ''
      await shell.openExternal(`vnc://${auth}${host}${port}`)
      return { launched: true, message: `Opened Screen Sharing to ${host}` }
    }

    case 'browser': {
      const scheme = session.port === 443 ? 'https' : 'http'
      const port = session.port && session.port !== 80 && session.port !== 443 ? `:${session.port}` : ''
      await shell.openExternal(`${scheme}://${host}${port}`)
      return { launched: true, message: `Opened ${host} in your browser` }
    }

    case 'rdp': {
      const tool = await checkTool('freerdp')
      if (!tool?.available) {
        return { launched: false, message: 'No RDP client found', tool: 'freerdp' }
      }
      if (tool.detail?.endsWith('.app')) {
        await shell.openExternal(`rdp://full%20address=s:${host}:${session.port ?? 3389}`)
        return { launched: true, message: `Handed ${host} to ${tool.detail.split('/').pop()}` }
      }
      return launchFreeRdp(tool.detail!, session, credentials)
    }

    case 'xdmcp': {
      const tool = await checkTool('xquartz')
      if (!tool?.available) {
        return { launched: false, message: 'XQuartz is not installed', tool: 'xquartz' }
      }
      // XDMCP asks the remote display manager for a login session on :1.
      spawn('/opt/X11/bin/X', ['-query', host, ':1'], { detached: true, stdio: 'ignore' }).unref()
      return { launched: true, message: `Requested an XDMCP session from ${host} on display :1` }
    }

    default:
      return { launched: false, message: `${session.kind} is not an external session type` }
  }
}
