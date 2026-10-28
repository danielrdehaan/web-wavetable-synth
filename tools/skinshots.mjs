// Screenshots of every page and overlay in one skin, for checking skins and that the default skin still
// draws as it did: SHOTS=<dir> SKIN=<name> node tools/cdp.mjs "$PWD/tools/skinshots.mjs" with the dev
// server on :5291 (SKIN by name or file name, e.g. make-things-dark; default Default). Turns every
// oscillator, the sampler, both filters and all nine effects on first, so the lit drawing shows.
export default async function ({ evaluate, shot, click, mouse, send, go, sleep }) {
  const skin = process.env.SKIN ?? 'Default'
  await go(`http://localhost:5291/?mute&skin=${encodeURIComponent(skin)}`)
  await sleep(1500)
  const centres = (sel) => evaluate(`return [...document.querySelectorAll(${JSON.stringify(sel)})].map((el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })`)
  const clickAll = async (sel) => { for (const [x, y] of await centres(sel)) { await click(x, y); await sleep(120) } }
  const clickOne = async (sel, i = 0, button = 'left') => { const c = (await centres(sel))[i]; if (!c) throw new Error(`no ${sel}`); await click(c[0], c[1], button); await sleep(500) }
  const key = async (k) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k }); await sleep(400) }
  const tab = async (name) => {
    const i = await evaluate(`return [...document.querySelectorAll('.vt-tab')].findIndex((b) => b.textContent.trim().toUpperCase() === ${JSON.stringify(name)})`)
    await clickOne('.vt-tab', i)
  }

  // Everything on.
  await clickAll('.vt-osc:not(.on) .vt-dot, .vt-filter:not(.on) .vt-dot')
  await mouse('mouseMoved', 5, 995)
  await sleep(600)
  await shot('voice')
  await tab('EFFECTS')
  await clickAll('.vfx-tile:not(.on) .vfx-tdot')
  await mouse('mouseMoved', 5, 995)
  await sleep(600)
  await shot('effects')
  await tab('MATRIX'); await shot('matrix')
  await tab('ADVANCED'); await sleep(400); await shot('advanced')
  await tab('VOICE')

  // Overlays.
  await clickOne('.vt-preset .nm'); await shot('presets'); await clickOne('.vt-preset .nm')
  await clickOne('.vt-tname .nm'); await shot('wtbrowser'); await key('Escape')
  await clickOne('.vt-pencil'); await sleep(600); await shot('wteditor'); await key('Escape')
  await go(`http://localhost:5291/?mute&skin=${encodeURIComponent(skin)}`); await sleep(1500)
  await clickOne('.vt-logo'); await shot('about'); await click(5, 5); await sleep(300)
  await clickOne('.vt-knob', 0, 'right'); await shot('menu'); await key('Escape')
}
