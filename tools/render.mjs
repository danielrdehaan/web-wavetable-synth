// Renders a .vital preset the way desktop Vital's `--render` does (SynthBase::renderAudioToFile:
// 44.1 kHz, 1 s of pre-roll, velocity 0.7, note held `length` s plus a 30 % tail) and writes a
// 16-bit stereo WAV, so the two renders can be compared.
// Usage: node tools/render.mjs <preset.vital> <out.wav> [midi=48] [length=6] [bpm=120]
import { readFileSync, writeFileSync } from 'node:fs'
import createEngine from '../web/engine.mjs'

const [preset, outPath, note = 48, length = 6, bpm = 120] = process.argv.slice(2)
const SR = 44100, BLOCK = 64
const m = await createEngine()
const loadPreset = (text) => { const p = m.stringToNewUTF8(text); const ok = m._vs_load_preset(p); m._free(p); return ok }
m.ccall('vs_init', null, ['number'], [SR])
if (!loadPreset(readFileSync(preset, 'utf8'))) throw new Error('preset failed to load')
m._vs_set_bpm(+bpm)
let t = -SR / SR
for (let s = 0; s < SR; s += BLOCK) { m._vs_correct_to_time(t); t += BLOCK / SR; m._vs_process(BLOCK) }
m._vs_note_on(+note, 0.7)
const on = length * SR, total = on + length * SR * 0.3
const L = new Float32Array(total), R = new Float32Array(total)
for (let s = 0; s < total; s += BLOCK) {
  m._vs_correct_to_time(t); t += BLOCK / SR; m._vs_process(BLOCK)
  if (on > s && on <= s + BLOCK) m._vs_note_off(+note)
  const l = m.HEAPF32.subarray(m._vs_left() >> 2), r = m.HEAPF32.subarray(m._vs_right() >> 2)
  for (let i = 0; i < BLOCK && s + i < total; i++) {
    const fade = Math.min((total - s) / 200, 1)
    L[s + i] = fade * l[i]; R[s + i] = fade * r[i]
  }
}
const data = Buffer.alloc(44 + total * 4)
data.write('RIFF', 0); data.writeUInt32LE(36 + total * 4, 4); data.write('WAVEfmt ', 8)
data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(SR, 24)
data.writeUInt32LE(SR * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(total * 4, 40)
for (let i = 0; i < total; i++) {
  data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4)
  data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4)
}
writeFileSync(outPath, data)
console.log('wrote', outPath)
