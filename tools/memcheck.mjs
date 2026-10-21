// Loads one preset N times and prints heap use after each, to tell a leak from a big preset.
import { readFileSync } from 'node:fs'
import createEngine from '../web/engine.mjs'
const [file, n = 5] = process.argv.slice(2)
const m = await createEngine({ print: () => {}, printErr: () => {} })
m.ccall('vs_init', null, ['number'], [44100])
const text = readFileSync(file, 'utf8')
const sbrk = () => (m._vs_heap_used?.() ?? 0)
for (let i = 0; i < +n; i++) {
  const p = m.stringToNewUTF8(text); const ok = m._vs_load_preset(p); m._free(p)
  console.log(i, ok, (sbrk() / 1048576).toFixed(1) + ' MB')
}
