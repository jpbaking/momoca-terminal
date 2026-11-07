/**
 * RDP in a tab: IronRDP through MoMoca's loopback RDCleanPath gateway.
 *
 * Needs Homebrew FreeRDP (`brew install freerdp`) for its sample server,
 * `sfreerdp-server`, which this suite starts on a Unix socket (`--local-only`)
 * and reaches through a loopback relay, so nothing listens beyond this Mac.
 * Run it against a throwaway profile:
 *
 *   npm run build
 *   ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
 *     test/suites/rdptest.mjs --user-data-dir=/tmp/momoca-rdp
 *
 * A main-process suite, like esctest.mjs: it needs sendInputEvent for real
 * clicks and keys, and capturePage to see what the canvas drew.
 */
import { app, BrowserWindow } from 'electron'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const here = dirname(fileURLToPath(import.meta.url))
const artifacts = join(here, '..', '.artifacts', 'rdp')

const results = []
const check = (ok, label) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}`)

// --- the RDP server -----------------------------------------------------------

const SERVER_PORT = 3391 + Math.floor(Math.random() * 500)
const socketPath = join(tmpdir(), `tfreerdp-server.${SERVER_PORT}`)

function startServer() {
  mkdirSync(artifacts, { recursive: true })
  const key = join(artifacts, 'server.key')
  const crt = join(artifacts, 'server.crt')
  if (!existsSync(crt)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
      '-out', crt, '-days', '30', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  }
  const binary = ['/opt/homebrew/bin/sfreerdp-server', '/usr/local/bin/sfreerdp-server'].find(existsSync)
  if (!binary) throw new Error('sfreerdp-server not found: brew install freerdp')
  return spawn(binary, ['--local-only', `--port=${SERVER_PORT}`, `--cert=${crt}`, `--key=${key}`], {
    stdio: 'ignore'
  })
}

/** 127.0.0.1:<port> to the server's Unix socket. */
function startRelay() {
  return new Promise((resolve) => {
    const relay = net.createServer((client) => {
      const upstream = net.connect(socketPath)
      client.pipe(upstream)
      upstream.pipe(client)
      const end = () => { client.destroy(); upstream.destroy() }
      for (const s of [client, upstream]) { s.on('error', end); s.on('close', end) }
    })
    relay.listen(0, '127.0.0.1', () => resolve(relay))
  })
}

// --- the fixture session, seeded before the app reads its store -----------------

const userData = process.argv.find((a) => a.startsWith('--user-data-dir='))?.split('=')[1]
if (!userData || !userData.startsWith('/tmp/')) {
  console.error('Run with a throwaway --user-data-dir under /tmp (see the header).')
  process.exit(2)
}

const server = startServer()
const relay = await startRelay()
const relayPort = relay.address().port
for (let i = 0; i < 40 && !existsSync(socketPath); i++) await sleep(100)

rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })
const FIXTURE = 'rdptest fixture'
const LOWRES = 'rdptest lowres'
writeFileSync(join(userData, 'sessions.json'), JSON.stringify({
  version: 1,
  sessions: [{
    id: 'rdptest-fixture',
    name: FIXTURE,
    kind: 'rdp',
    folder: '',
    host: '127.0.0.1',
    port: relayPort,
    username: 'tester',
    rdp: { engine: 'ironrdp', dynamicResolution: true }
  }, {
    id: 'rdptest-lowres',
    name: LOWRES,
    kind: 'rdp',
    folder: '',
    host: '127.0.0.1',
    port: relayPort,
    username: 'tester',
    rdp: { engine: 'ironrdp', dynamicResolution: true, hiDpi: false }
  }]
}))

require('../../out/main/index.js')

// --- helpers --------------------------------------------------------------------

async function main() {
  await app.whenReady(); await sleep(2500)
  const win = BrowserWindow.getAllWindows()[0]
  win.setSize(1200, 800); win.center(); win.focus(); await sleep(500)
  const js = (code) => win.webContents.executeJavaScript(code, true)

  /** Centre of the first element matching, if it is the topmost thing there. */
  const reach = (selector, text) => js(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => !${JSON.stringify(text ?? '')} || e.innerText.includes(${JSON.stringify(text ?? '')}))
    if (!el) return null
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const top = document.elementFromPoint(x, y)
    return top && (top === el || el.contains(top)) ? { x: Math.round(x), y: Math.round(y) } : null
  })()`)

  const click = async (at, clickCount = 1) => {
    for (let n = 1; n <= clickCount; n++) {
      win.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: n })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: n })
    }
    await sleep(400)
  }
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(300)
  }
  const type = async (text) => {
    for (const ch of text) win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    await sleep(200)
  }
  const submitPrompt = async () => {
    const button = await reach('.scrim .modal .btn.primary', 'Continue')
    if (button) await click(button)
  }
  const tabs = () => js(`[...document.querySelectorAll('.tabbar .tab')].map((t) => t.innerText.trim())`)

  // 1. Double-click opens the session in a tab, asking for its password.
  const row = await reach('.session-row', FIXTURE)
  check(Boolean(row), 'fixture row is reachable in the sidebar')
  if (!row) return finish()
  await click(row, 2)
  await sleep(800)
  const promptInput = await reach('.scrim .modal input')
  check(Boolean(promptInput), 'the password prompt appears')
  if (promptInput) {
    await type('secret')
    await submitPrompt()
  }
  check((await tabs()).some((t) => t.includes(FIXTURE)), 'the session opened as a tab, not a window')

  // 2. The canvas connects and fills the tab, in device pixels (2× on Retina).
  let state = null
  for (let i = 0; i < 60; i++) {
    state = await js(`(() => {
      const c = document.querySelector('.rdp-canvas')
      const screen = document.querySelector('.rdp-screen')
      if (!c || c.hidden) return { status: document.querySelector('.rdp-status')?.innerText ?? '' }
      const r = c.getBoundingClientRect(), s = screen.getBoundingClientRect()
      return { width: c.width, height: c.height, cssW: r.width, cssH: r.height, screenW: s.width, screenH: s.height,
        left: r.left, top: r.top, ratio: devicePixelRatio }
    })()`)
    if (state?.width) break
    await sleep(250)
  }
  check(Boolean(state?.width), `IronRDP connected through the gateway${state?.width ? '' : ` (${state?.status})`}`)
  if (!state?.width) return finish()
  const fills = (s) => Math.abs(s.width - s.screenW * s.ratio) < 4 * s.ratio && Math.abs(s.height - s.screenH * s.ratio) < 4 * s.ratio
  check(fills(state), `the desktop fills the tab (${state.width}x${state.height} in ${Math.round(state.screenW)}x${Math.round(state.screenH)} at ${state.ratio}×)`)
  // One canvas pixel per screen pixel: nothing is stretched, so nothing blurs.
  const sharp = Math.abs(state.cssW * state.ratio - state.width) < 1 && Math.abs(state.cssH * state.ratio - state.height) < 1
  check(sharp, `the canvas is drawn 1:1 with screen pixels (${Math.round(state.cssW)}x${Math.round(state.cssH)} CSS px for ${state.width}x${state.height})`)

  // 3. The server's picture reached the canvas: more than one colour on screen.
  await sleep(1500)
  const shot = await win.webContents.capturePage({
    x: Math.round(state.left), y: Math.round(state.top),
    width: Math.round(state.cssW), height: Math.round(state.cssH)
  })
  const bitmap = shot.toBitmap()
  const colours = new Set()
  for (let i = 0; i < bitmap.length; i += 4 * 97) colours.add(bitmap.readUInt32LE(i))
  writeFileSync(join(artifacts, 'rdp-tab.png'), shot.toPNG())
  check(colours.size > 4, `the canvas shows the remote desktop (${colours.size} sampled colours; see .artifacts/rdp/rdp-tab.png)`)

  // 4. Typing goes to the remote, but ⌘ shortcuts stay MoMoca's.
  const canvasAt = await reach('.rdp-canvas')
  if (canvasAt) await click(canvasAt)
  const before = (await tabs()).length
  await key('T')
  check((await tabs()).length === before, 'a plain key in the RDP tab does not reach MoMoca’s shortcuts')
  await key('T', ['meta'])
  await sleep(600)
  check((await tabs()).length === before + 1, '⌘T in the RDP tab still opens a new tab')
  // Back to the RDP tab.
  const rdpTab = await reach('.tabbar .tab', FIXTURE)
  if (rdpTab) await click(rdpTab)

  // 5. Resizing the window resizes the remote desktop with it.
  win.setSize(1000, 700); await sleep(2500)
  const resized = await js(`(() => {
    const c = document.querySelector('.rdp-canvas'), s = document.querySelector('.rdp-screen').getBoundingClientRect()
    return { width: c.width, height: c.height, screenW: s.width, screenH: s.height, ratio: devicePixelRatio }
  })()`)
  // FreeRDP's sample server has no Display Control channel, so it keeps its
  // size; a Windows host resizes. Either way the desktop must stay in the tab.
  const size = `${resized.width}x${resized.height} in ${Math.round(resized.screenW)}x${Math.round(resized.screenH)}`
  if (fills(resized)) check(true, `after a resize the desktop still fills the tab (${size})`)
  else results.push(`SKIP  the server did not resize (no Display Control in the sample server) (${size})`)
  const inside = await js(`(() => {
    const c = document.querySelector('.rdp-canvas').getBoundingClientRect(), s = document.querySelector('.rdp-screen').getBoundingClientRect()
    return c.width <= s.width + 1 && c.height <= s.height + 1 && Math.abs(c.width / c.height - ${resized.width} / ${resized.height}) < 0.02
  })()`)
  check(inside, 'after a resize the whole desktop is still visible in the tab, in proportion')

  // 6. The gateway: a ticket opens one connection to its own host, once.
  const WebSocket = require('ws')
  // No stored password, so rdp:open asks for one; answer the prompt, then collect the ticket.
  await js(`window.__rdpTicket = window.api.rdp.open({ sessionId: 'rdptest-fixture' }).catch(() => null); 0`)
  await sleep(800)
  if (await reach('.scrim .modal input')) { await type('secret'); await submitPrompt() }
  const ticket = await js(`window.__rdpTicket`)
  const x224 = Buffer.from('030000130ee000000000000100080003000000', 'hex')
  const der = (tag, body) => {
    const len = body.length < 128 ? Buffer.from([body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 255])
    return Buffer.concat([Buffer.from([tag]), len, body])
  }
  const request = (token) => der(0x30, Buffer.concat([
    der(0xa0, der(0x02, Buffer.from([0x0d, 0x3e]))),
    der(0xa2, der(0x0c, Buffer.from('anywhere.example:3389'))),
    der(0xa3, der(0x0c, Buffer.from(token))),
    der(0xa6, der(0x04, x224))
  ]))
  const exchange = (address, token) => new Promise((resolve) => {
    const ws = new WebSocket(address)
    const timer = setTimeout(() => { ws.terminate(); resolve(null) }, 8000)
    ws.on('open', () => ws.send(request(token)))
    ws.on('message', (data) => { clearTimeout(timer); ws.close(); resolve(Buffer.from(data)) })
    ws.on('error', () => { clearTimeout(timer); resolve(null) })
  })
  /** The context tags ([0], [1], …) of a response PDU's top-level fields. */
  const fields = (pdu) => {
    const tags = []
    const lengthAt = (at) => (pdu[at] & 0x80 ? [pdu.readUIntBE(at + 1, pdu[at] & 0x7f), at + 1 + (pdu[at] & 0x7f)] : [pdu[at], at + 1])
    const [outer, start] = lengthAt(1)
    for (let at = start; at < start + outer; ) {
      tags.push(pdu[at] & 0x1f)
      const [len, body] = lengthAt(at + 1)
      at = body + len
    }
    return tags
  }
  const isError = (pdu) => Boolean(pdu) && fields(pdu).includes(1)
  if (ticket) {
    const first = await exchange(ticket.proxyAddress, ticket.authToken)
    check(Boolean(first) && !isError(first) && fields(first).includes(7),
      'a fresh ticket gets the server’s X.224 reply and certificate chain (the destination it named is ignored)')
    const again = await exchange(ticket.proxyAddress, ticket.authToken)
    check(isError(again), 'the same ticket is refused the second time')
    const forged = await exchange(ticket.proxyAddress, 'not-a-ticket')
    check(isError(forged), 'a made-up ticket is refused')
  } else check(false, 'rdp:open returned a ticket')

  // 7. HiDPI off: the desktop has the tab's size in points, stretched to the screen.
  const lowRow = await reach('.session-row', LOWRES)
  if (lowRow) {
    await click(lowRow, 2)
    await sleep(800)
    if (await reach('.scrim .modal input')) { await type('secret'); await submitPrompt() }
    let low = null
    for (let i = 0; i < 60; i++) {
      low = await js(`(() => {
        const pane = [...document.querySelectorAll('.rdp-pane')].find((p) => !p.hidden)
        const c = pane?.querySelector('.rdp-canvas')
        if (!c || c.hidden) return null
        const r = c.getBoundingClientRect(), s = pane.querySelector('.rdp-screen').getBoundingClientRect()
        return { width: c.width, height: c.height, cssW: r.width, screenW: s.width, screenH: s.height, ratio: devicePixelRatio }
      })()`)
      if (low?.width) break
      await sleep(250)
    }
    const size = low?.width ? `${low.width}x${low.height} in ${Math.round(low.screenW)}x${Math.round(low.screenH)} at ${low.ratio}×` : 'did not connect'
    check(Boolean(low?.width) && Math.abs(low.width - low.screenW) < 4 && Math.abs(low.height - low.screenH) < 4,
      `with HiDPI off the desktop is the tab’s size in points (${size})`)
    if (low?.width && low.ratio > 1) check(Math.abs(low.cssW - low.width) < 1, 'with HiDPI off one canvas pixel is one CSS pixel')
  } else check(false, 'the HiDPI-off fixture row is reachable in the sidebar')

  finish()

  function finish() {
    console.log(results.join('\n'))
    const counted = results.filter((r) => !r.startsWith('SKIP'))
    console.log(`\n${counted.filter((r) => r.startsWith('PASS')).length}/${counted.length} passed`)
    server.kill(); relay.close()
    app.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
  }
}

main().catch((e) => { console.error(e); server.kill(); relay.close(); app.exit(1) })
