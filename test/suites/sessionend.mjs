// What a tab does once its session ends: it stays open, other keys do nothing,
// R starts the same session again in place, and Enter closes the tab. Each new
// shell is proven by its PID landing in a file, not by reading the screen.
//
// Covers a local shell, then an SSH session against test/sshd.mjs: the remote
// shell exiting, the server dropping the connection, R while the server is down
// (a failed connect offers the same choice), and R once it is back.
//
// The suite starts its own sshd when 127.0.0.1:2222 is free, so it can kill
// and restart it; with someone else's sshd already there, the drop steps SKIP.
// Run against a fresh launch with a throwaway profile, which the suite reloads
// once to list its fixture session:
//   Electron . --remote-debugging-port=9222 --user-data-dir=<scratch dir>
//   node test/suites/sessionend.mjs
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { connect as netConnect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/** Scratch space for fixtures, ignored by git. */
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.artifacts')
mkdirSync(OUT, { recursive: true })

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
let n = 0
const w = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const r = w.get(m.id)
  if (r) {
    w.delete(m.id)
    r(m)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++n
    w.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails)
    return '__ERR__ ' + r.result.exceptionDetails.exception?.description?.split('\n')[0]
  return r.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const enter = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter' })
}
const run = async (command) => {
  await send('Input.insertText', { text: command })
  await enter()
}
const tabCount = async () => Number(await ev(`document.querySelectorAll('.tab').length`))
const dot = () => ev(`document.querySelector('.tab .dot')?.className ?? ''`)
const pidFile = (name) => `${OUT}/sessionend-${name}.txt`
const readPid = (name) => (existsSync(pidFile(name)) ? readFileSync(pidFile(name), 'utf8').trim() : '')

await new Promise((r) => ws.addEventListener('open', r))

const results = []
const rec = (label, ok, detail = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -> ${detail}` : ''}`)

for (const name of ['first', 'again']) rmSync(pidFile(name), { force: true })

// Clean slate, then one local tab.
await ev(`document.querySelectorAll('.tab .close').forEach(b => b.click()), 'x'`)
await sleep(800)
await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true })), 'x'`)
await sleep(2200)
rec('one local tab open', (await tabCount()) === 1)

await run(`echo $$ > ${pidFile('first')}`)
await sleep(800)
const first = readPid('first')
rec('first shell runs', /^\d+$/.test(first), first)

// ---------- the shell exits ----------
await run('exit')
await sleep(1200)
rec('tab stays open after exit', (await tabCount()) === 1)
rec('tab shows closed', String(await dot()).includes('closed'), String(await dot()))

await send('Input.insertText', { text: 'x' })
await sleep(500)
rec('other keys leave the tab open', (await tabCount()) === 1)

// ---------- R reopens in place ----------
await send('Input.insertText', { text: 'r' })
await sleep(2200)
rec('R keeps the same tab', (await tabCount()) === 1)
rec('tab is live again', String(await dot()).includes('ready'), String(await dot()))

// Enter now belongs to the new shell, not to closing the tab.
await run(`echo $$ > ${pidFile('again')}`)
await sleep(800)
const again = readPid('again')
rec('reopened shell runs', /^\d+$/.test(again), again)
rec('it is a new shell', again !== '' && again !== first, `${first} -> ${again}`)
rec('Enter in a live shell keeps the tab', (await tabCount()) === 1)

// ---------- Enter closes ----------
await run('exit')
await sleep(1200)
rec('tab stays open after second exit', (await tabCount()) === 1)
await enter()
await sleep(800)
rec('Enter closes the ended tab', (await tabCount()) === 0)

for (const name of ['first', 'again']) rmSync(pidFile(name), { force: true })

// ---------- SSH ----------
const HERE = dirname(fileURLToPath(import.meta.url))
const SSHD = resolve(HERE, '..', 'sshd.mjs')
/** Named so cleanup finds its own and never touches a real saved session. */
const SESSION_NAME = 'sessionend-test-session'
const KNOWN_HOSTS = resolve(process.env.HOME, '.ssh', 'known_hosts')
const OURS = '[127.0.0.1]:2222 '
const readKnown = () => (existsSync(KNOWN_HOSTS) ? readFileSync(KNOWN_HOSTS, 'utf8') : '')
const hadHostLine = readKnown().split('\n').some((line) => line.startsWith(OURS))

const portOpen = () =>
  new Promise((res) => {
    const sock = netConnect(2222, '127.0.0.1')
    sock.once('connect', () => (sock.destroy(), res(true)))
    sock.once('error', () => res(false))
  })
const waitPort = async (open) => {
  for (let i = 0; i < 40; i++) {
    if ((await portOpen()) === open) return true
    await sleep(250)
  }
  return false
}
let sshd = null
const startSshd = async () => {
  sshd = spawn(process.execPath, [SSHD], { stdio: 'ignore' })
  return waitPort(true)
}
const stopSshd = async () => {
  sshd?.kill('SIGTERM')
  sshd = null
  return waitPort(false)
}

const ownSshd = !(await portOpen())
if (ownSshd) rec('started test sshd', await startSshd())

const sshPid = (name) => `${OUT}/sessionend-ssh-${name}.txt`
const readSshPid = (name) => (existsSync(sshPid(name)) ? readFileSync(sshPid(name), 'utf8').trim() : '')
for (const name of ['first', 'again', 'back']) rmSync(sshPid(name), { force: true })

const removeFixture = () =>
  ev(`(async () => {
    for (const s of await window.api.sessions.list())
      if (s.name === ${JSON.stringify(SESSION_NAME)}) await window.api.sessions.remove(s.id)
    return 'x'
  })()`)
await removeFixture()
await ev(`window.api.sessions.save(${JSON.stringify({
  name: SESSION_NAME,
  kind: 'ssh',
  folder: '',
  host: '127.0.0.1',
  port: 2222,
  username: 'tester',
  authMethod: 'key',
  privateKeyPath: resolve(HERE, '..', '.artifacts', 'testkey')
})}).then(() => 'x')`)
// The sidebar lists sessions at startup; reload so it shows the fixture.
await ev(`location.reload(), 'x'`)
await sleep(2500)

const clickAt = async (x, y, clickCount = 1) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount })
}
/** Centre of the first match, and whether it is the topmost element there. */
const locate = (find) =>
  ev(`(() => {
    const el = (${find})()
    if (!el) return null
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const top = document.elementFromPoint(x, y)
    return JSON.stringify({ x, y, reachable: el === top || el.contains(top) })
  })()`).then((v) => (v ? JSON.parse(v) : null))

const row = await locate(`() => [...document.querySelectorAll('.session-tree *')]
  .filter(e => (e.textContent || '').trim() === ${JSON.stringify(SESSION_NAME)} && e.children.length <= 1).pop()`)
rec('fixture session row is reachable', Boolean(row?.reachable))
if (row) {
  await clickAt(row.x, row.y, 1)
  await clickAt(row.x, row.y, 2)
}
await sleep(1800)
const trust = await locate(`() => {
  const h = [...document.querySelectorAll('.modal h2')].find(e => e.textContent.trim() === 'Unknown host')
  return h && [...h.closest('.modal').querySelectorAll('button')].find(b => b.textContent.trim() === 'Trust and connect')
}`)
if (trust) {
  rec('unknown-host prompt is reachable', trust.reachable)
  await clickAt(trust.x, trust.y)
}
await sleep(2500)
rec('one SSH tab open', (await tabCount()) === 1)
rec('SSH tab is live', String(await dot()).includes('ready'), String(await dot()))

// Typing goes where a person would put it: a click in the terminal.
const focusTerminal = async () => {
  const pane = await locate(`() => document.querySelector('.terminal-pane:not([hidden]) .xterm-screen')`)
  if (pane) await clickAt(pane.x, pane.y)
  await sleep(300)
}
const sshRuns = async (name) => {
  await focusTerminal()
  await run(`echo $$ > ${sshPid(name)}`)
  await sleep(1000)
  return readSshPid(name)
}

const sshFirst = await sshRuns('first')
rec('remote shell runs', /^\d+$/.test(sshFirst), sshFirst)

// The remote shell exits: the channel closes, the tab waits.
await run('exit')
await sleep(1500)
rec('SSH tab stays open after remote exit', (await tabCount()) === 1)
rec('SSH tab shows closed', String(await dot()).includes('closed'), String(await dot()))

await send('Input.insertText', { text: 'r' })
await sleep(3000)
rec('R reconnects in the same tab', (await tabCount()) === 1)
rec('reconnected tab is live', String(await dot()).includes('ready'), String(await dot()))
const sshAgain = await sshRuns('again')
rec('reconnected remote shell runs', /^\d+$/.test(sshAgain), sshAgain)
rec('it is a new remote shell', sshAgain !== '' && sshAgain !== sshFirst, `${sshFirst} -> ${sshAgain}`)

if (ownSshd) {
  // The server goes away under a live session.
  rec('test sshd stopped', await stopSshd())
  await sleep(1500)
  rec('tab stays open after the connection drops', (await tabCount()) === 1)
  rec('dropped tab shows closed', String(await dot()).includes('closed'), String(await dot()))

  // R with nothing listening: the connect fails and offers the choice again.
  await focusTerminal()
  await send('Input.insertText', { text: 'r' })
  await sleep(2500)
  rec('failed reconnect keeps the tab', (await tabCount()) === 1)
  rec('failed reconnect shows error', String(await dot()).includes('error'), String(await dot()))

  rec('test sshd restarted', await startSshd())
  await send('Input.insertText', { text: 'R' })
  await sleep(3000)
  rec('R after a failure reconnects', String(await dot()).includes('ready'), String(await dot()))
  const sshBack = await sshRuns('back')
  rec('remote shell runs after the server returns', /^\d+$/.test(sshBack) && sshBack !== sshAgain, `${sshAgain} -> ${sshBack}`)
} else {
  results.push('SKIP  connection drop and failed reconnect -> sshd on :2222 is not this suite\'s')
}

await run('exit')
await sleep(1500)
await enter()
await sleep(800)
rec('Enter closes the ended SSH tab', (await tabCount()) === 0)

// ---------- cleanup ----------
await removeFixture()
for (const name of ['first', 'again', 'back']) rmSync(sshPid(name), { force: true })
if (ownSshd) await stopSshd()
// Only this host's line, and only if this run added it: the file holds real hosts.
if (!hadHostLine) {
  const before = readKnown()
  const after = before.split('\n').filter((line) => !line.startsWith(OURS)).join('\n')
  if (after !== before) writeFileSync(KNOWN_HOSTS, after)
}

console.log(results.join('\n'))
ws.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
