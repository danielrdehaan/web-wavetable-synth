// A tiny DevTools-protocol driver for headless Chromium, for checking the app when no visible browser is
// painting: SHOTS=<dir> node tools/cdp.mjs <script.mjs>. Uses Playwright's cached chrome-headless-shell.
// The script's default export gets { evaluate, evaluateIn (inside a frame, by origin), shot, click, drag,
// mouse, send, go, sleep }.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const BIN = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const port = 9333
const proc = spawn(BIN, [`--remote-debugging-port=${port}`, '--window-size=1500,1000', '--autoplay-policy=no-user-gesture-required', '--user-data-dir=' + process.env.TMPDIR + '/cdp-profile', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let targets
for (let k = 0; k < 50; k++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break } catch { await sleep(100) } }
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
const logs = []
/** Execution contexts by id, with their frame's origin, so a script can run inside a frame. */
const contexts = new Map()
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data)
  if (msg.method === 'Runtime.executionContextCreated') contexts.set(msg.params.context.id, msg.params.context)
  if (msg.method === 'Runtime.executionContextDestroyed') contexts.delete(msg.params.executionContextId)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  if (msg.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 400))
  if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) logs.push(msg.params.type + ' ' + msg.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300))
})
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 2, mobile: false })
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600))
  return r.result.result.value
}
/** `expr` inside the frame whose origin is `origin` (its default context). */
const evaluateIn = async (origin, expr) => {
  const ctx = [...contexts.values()].reverse().find((c) => c.origin === origin && c.auxData?.isDefault)
  if (!ctx) throw new Error(`no frame at ${origin}`)
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true, contextId: ctx.id })
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600))
  return r.result.result.value
}
const shot = async (name, clip) => {
  const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
  writeFileSync(`${process.env.SHOTS}/${name}.png`, Buffer.from(r.result.data, 'base64'))
}
const mouse = async (type, x, y, button = 'left', clickCount = 1) => send('Input.dispatchMouseEvent', { type, x, y, button, clickCount, buttons: type === 'mouseReleased' ? 0 : button === 'right' ? 2 : 1 })
const click = async (x, y, button = 'left') => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, button); await mouse('mouseReleased', x, y, button) }
const drag = async (x0, y0, x1, y1, steps = 12) => {
  await mouse('mouseMoved', x0, y0); await mouse('mousePressed', x0, y0)
  for (let k = 1; k <= steps; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * k / steps, y: y0 + (y1 - y0) * k / steps, button: 'left', buttons: 1 })
  await mouse('mouseReleased', x1, y1)
}
const go = async (url) => { await send('Page.navigate', { url }); await sleep(2500) }
try {
  const script = (await import(process.argv[2])).default
  await script({ evaluate, evaluateIn, shot, click, drag, mouse, send, go, sleep })
} catch (e) { console.log('ERROR', e.message) }
console.log(logs.join('\n'))
ws.close(); proc.kill()
