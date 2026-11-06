// The sidebar: its inner edge drags it wider or narrower (clamped, persisted,
// double-click to reset), it folds to a rail and docks again (toggle and ⌘B),
// and hovering the rail floats it out over the terminals without resizing them,
// on either side of the window. Same rules as the other suites — real
// coordinates, reachability first, assert on layout and stored state.
//
// It rewrites the view settings, so run it against a throwaway profile:
//
//   npm run build
//   ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . \
//     --remote-debugging-port=9222 --user-data-dir=/tmp/momoca-sidebar
//   node test/suites/sidebartest.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

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
    setTimeout(() => {
      if (w.delete(id)) res({ timedOut: true })
    }, 8000)
  })
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails)
    return '__ERR__ ' + r.result.exceptionDetails.exception?.description?.split('\n')[0]
  return r.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'))
  else console.error(`(no screenshot for ${name} — is the window occluded?)`)
}
await new Promise((r) => ws.addEventListener('open', r))

const results = []
const rec = (label, ok, detail = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -> ${detail}` : ''}`)

/** Where an element is, and whether a click there would actually reach it. */
const probe = async (selector) =>
  JSON.parse(
    String(
      await ev(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)})
          if (!el) return JSON.stringify({ found: false })
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) return JSON.stringify({ found: true, visible: false })
          const x = Math.round(r.left + r.width / 2)
          const y = Math.round(r.top + r.height / 2)
          const top = document.elementFromPoint(x, y)
          const reachable = el === top || el.contains(top) || (top && top.contains(el))
          return JSON.stringify({
            found: true, visible: true, x, y, reachable,
            blockedBy: reachable ? null : top ? top.className || top.tagName : 'nothing'
          })
        })()
      `)
    )
  )

const mouse = (type, x, y, clickCount = 1) =>
  send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mouseReleased' ? 0 : type === 'mousePressed' ? 1 : 0,
    clickCount
  })

const moveTo = async (x, y) => {
  await mouse('mouseMoved', x, y)
  await sleep(120)
}

const clickAt = async (x, y) => {
  await moveTo(x, y)
  await mouse('mousePressed', x, y)
  await mouse('mouseReleased', x, y)
  await sleep(250)
}

/** Clicks a selector at its centre, after asserting a person could reach it. */
const click = async (selector, label = selector) => {
  const p = await probe(selector)
  if (!p.found) return rec(`click ${label}`, false, 'not found'), null
  if (!p.visible) return rec(`click ${label}`, false, 'zero size'), null
  if (!p.reachable) return rec(`click ${label}`, false, `covered by .${p.blockedBy}`), null
  await clickAt(p.x, p.y)
  return p
}

/** Presses and drags with the left button held, the way a hand would. */
const drag = async (x, y, dx) => {
  await moveTo(x, y)
  await mouse('mousePressed', x, y)
  for (let i = 1; i <= 8; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: x + Math.round((dx * i) / 8),
      y,
      button: 'left',
      buttons: 1
    })
    await sleep(16)
  }
  await mouse('mouseReleased', x + dx, y)
  await sleep(250)
}

const cmdB = async () => {
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type,
      key: 'b',
      code: 'KeyB',
      windowsVirtualKeyCode: 66,
      modifiers: 4
    })
  }
  await sleep(300)
}

const layout = async () =>
  JSON.parse(
    String(
      await ev(`
        (() => {
          const box = (s) => {
            const el = document.querySelector(s)
            if (!el) return null
            const r = el.getBoundingClientRect()
            return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }
          }
          const view = JSON.parse(localStorage.getItem('mobaclone.view') ?? '{}')
          const dock = document.querySelector('.sidebar-dock')
          return JSON.stringify({
            sidebar: box('.sidebar'),
            main: box('.main'),
            rail: box('.sidebar-rail'),
            visible: getComputedStyle(document.querySelector('.sidebar')).visibility === 'visible',
            collapsed: dock?.classList.contains('collapsed') ?? null,
            peek: dock?.classList.contains('peek') ?? null,
            stored: { width: view.sidebarWidth, collapsed: view.sidebarCollapsed },
            winW: window.innerWidth
          })
        })()
      `)
    )
  )

const near = (a, b, slack = 3) => Math.abs(a - b) <= slack

/** Starts from a docked, default-width sidebar on the given side. */
const resetView = async (side) => {
  await ev(`
    (() => {
      const saved = JSON.parse(localStorage.getItem('mobaclone.view') ?? '{}')
      localStorage.setItem('mobaclone.view', JSON.stringify({
        ...saved, menuBar: true, buttonsBar: true, compact: false,
        sidebarSide: ${JSON.stringify(side)}, sidebarCollapsed: false, sidebarWidth: 236
      }))
      return 'ok'
    })()
  `)
  // The view store is read at startup.
  await ev(`location.reload(), 'x'`)
  await sleep(2500)
}

// ---------- resizing, sidebar on the left ----------
await resetView('left')
let l = await layout()
rec('starts docked at 236px', !l.collapsed && near(l.sidebar.width, 236), JSON.stringify(l.sidebar))

let handle = await probe('.sidebar-resizer')
rec('resize handle is reachable at its centre', handle.reachable, handle.blockedBy ?? '')
await drag(handle.x, handle.y, 120)
l = await layout()
rec('dragging the edge right widens the sidebar', near(l.sidebar.width, 356), JSON.stringify(l.sidebar))
rec('the terminals give up the room', near(l.main.left, l.sidebar.right, 1), JSON.stringify(l.main))
rec('the new width is stored', near(l.stored.width, 356), JSON.stringify(l.stored))

handle = await probe('.sidebar-resizer')
await drag(handle.x, handle.y, -400)
l = await layout()
rec('it stops at the 180px minimum', near(l.sidebar.width, 180), JSON.stringify(l.sidebar))

handle = await probe('.sidebar-resizer')
await drag(handle.x, handle.y, 2000)
l = await layout()
const maxW = Math.min(640, l.winW - 320)
rec('it stops short of crowding the terminals out', near(l.sidebar.width, maxW), `${l.sidebar.width} vs ${maxW}`)

handle = await probe('.sidebar-resizer')
await moveTo(handle.x, handle.y)
await mouse('mousePressed', handle.x, handle.y, 1)
await mouse('mouseReleased', handle.x, handle.y, 1)
await mouse('mousePressed', handle.x, handle.y, 2)
await mouse('mouseReleased', handle.x, handle.y, 2)
await sleep(300)
l = await layout()
rec('double-clicking the edge resets to 236px', near(l.sidebar.width, 236), JSON.stringify(l.sidebar))

// ---------- collapse to the rail ----------
await click('.sidebar-toggle', 'the collapse chevron')
l = await layout()
rec('collapsing leaves only the rail', l.collapsed && !l.visible && l.rail && near(l.main.left, l.rail.right, 1), JSON.stringify(l))
rec('collapsed state is stored', l.stored.collapsed === true)
const mainCollapsed = l.main
await shot('sidebartest-rail')

// Where the panel used to be is now the terminals, not a hidden panel.
const under = await ev(`
  (() => {
    const el = document.elementFromPoint(120, 300)
    return el?.closest('.sidebar') ? 'sidebar' : 'other'
  })()
`)
rec('nothing of the folded panel catches clicks', under === 'other', under)

for (const [i, name] of [[1, 'dock'], [2, 'Sessions']]) {
  const p = await probe(`.sidebar-rail .rail-btn:nth-child(${i})`)
  rec(`rail ${name} button is reachable`, p.reachable, p.blockedBy ?? '')
}

// ---------- hover to peek ----------
const rail = await probe('.sidebar-rail')
await moveTo(rail.x, rail.y + 120)
await sleep(400)
l = await layout()
rec('hovering the rail floats the panel out', l.peek && l.visible && near(l.sidebar.left, 0, 1), JSON.stringify(l))
rec('a peek does not resize the terminals', near(l.main.left, mainCollapsed.left, 1) && near(l.main.width, mainCollapsed.width, 1))
const quick = await probe('.quick-connect input')
rec('the floating panel is usable (quick connect reachable)', quick.reachable, quick.blockedBy ?? '')
await shot('sidebartest-peek')

await moveTo(l.winW - 80, 300)
await sleep(800)
l = await layout()
rec('leaving the panel folds it away again', !l.peek && !l.visible, JSON.stringify(l))

// Typing in the floating panel keeps it out after the pointer wanders off.
await moveTo(rail.x, rail.y + 120)
await sleep(400)
await click('.quick-connect input', 'quick connect in the peek')
await moveTo(l.winW - 80, 300)
await sleep(900)
l = await layout()
rec('a focused field keeps the peek open', l.peek && l.visible)
await ev(`document.activeElement?.blur(), 'x'`)
await sleep(900)
l = await layout()
rec('…and it folds once the field lets go', !l.peek)

// The chevron in a peek docks the panel.
await moveTo(rail.x, rail.y + 120)
await sleep(400)
await click('.sidebar-toggle', 'the dock chevron in the peek')
l = await layout()
rec('the chevron in a peek docks the sidebar', !l.collapsed && near(l.main.left, l.sidebar.right, 1), JSON.stringify(l))

// ---------- ⌘B ----------
await moveTo(l.winW - 80, 300)
await cmdB()
l = await layout()
rec('⌘B folds the sidebar', l.collapsed === true)
await cmdB()
l = await layout()
rec('⌘B docks it again', l.collapsed === false && l.visible)

// The rail's own dock button.
await cmdB()
await click('.sidebar-rail .rail-btn:nth-child(1)', 'the rail dock button')
l = await layout()
rec('the rail button docks the sidebar', l.collapsed === false)

// ---------- sidebar on the right ----------
await resetView('right')
l = await layout()
rec('right-hand sidebar sits at the window edge', near(l.sidebar.right, l.winW, 1), JSON.stringify(l.sidebar))
handle = await probe('.sidebar-resizer')
rec('right-hand resize handle is reachable', handle.reachable, handle.blockedBy ?? '')
await drag(handle.x, handle.y, -100)
l = await layout()
rec('dragging its edge left widens it', near(l.sidebar.width, 336), JSON.stringify(l.sidebar))

await click('.sidebar-toggle', 'the right-hand collapse chevron')
l = await layout()
rec('right-hand rail sits at the window edge', l.collapsed && near(l.rail.right, l.winW, 1), JSON.stringify(l.rail))
const rightRail = await probe('.sidebar-rail')
await moveTo(rightRail.x, rightRail.y + 120)
await sleep(400)
l = await layout()
rec('right-hand peek floats out from the right edge', l.peek && near(l.sidebar.right, l.winW, 1) && near(l.sidebar.width, 336), JSON.stringify(l.sidebar))
await shot('sidebartest-peek-right')
await moveTo(200, 300)
await sleep(800)

// Leave the profile as it started.
await resetView('left')

console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
ws.close()
process.exit(failed ? 1 : 0)
