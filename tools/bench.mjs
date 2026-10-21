// Renders notes through the WASM build and reports realtime factor per voice count.
import createEngine from '../web/engine.mjs'
const m = await createEngine()
const call = (n, r, a, v) => m.ccall(n, r, a, v)
call('vs_init', null, ['number'], [48000])
const params = JSON.parse(call('vs_params_json', 'string', [], []))
console.log('controls exposed:', params.length)
for (const voices of [1, 4, 8]) {
  call('vs_all_notes_off', null, [], [])
  for (let i = 0; i < voices; i++) call('vs_note_on', null, ['number', 'number'], [48 + i * 3, 0.8])
  const blocks = 48000 * 4 / 128, t0 = performance.now()
  let peak = 0
  for (let b = 0; b < blocks; b++) {
    m._vs_process(128)
    const L = new Float32Array(m.HEAPF32.buffer, m._vs_left(), 128)
    for (const x of L) peak = Math.max(peak, Math.abs(x))
  }
  const ms = performance.now() - t0
  console.log(`${voices} voice(s): 4 s rendered in ${ms.toFixed(0)} ms → ${(4000 / ms).toFixed(1)}x realtime, peak ${peak.toFixed(3)}, active ${call('vs_active_voices','number',[],[])}`)
}
// unison 16 x 8 voices: heavy-preset stress
call('vs_all_notes_off', null, [], [])
call('vs_set_param', 'number', ['string', 'number'], ['osc_1_unison_voices', 16])
for (let i = 0; i < 8; i++) call('vs_note_on', null, ['number', 'number'], [48 + i * 3, 0.8])
let t0 = performance.now()
for (let b = 0; b < 48000 * 4 / 128; b++) m._vs_process(128)
console.log(`8 voices × 16 unison: ${(4000 / (performance.now() - t0)).toFixed(1)}x realtime`)
