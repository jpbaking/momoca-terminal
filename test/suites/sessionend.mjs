// What a tab does once its session ends: it stays open, other keys do nothing,
// R starts the same session again in place, and Enter closes the tab. The new
// shell is proven by its PID landing in a file, not by reading the screen.
//
// Run against a fresh launch (see ../README.md). Uses local shells only; SSH
// tabs reconnect through the same path.
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
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

console.log(results.join('\n'))
ws.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
