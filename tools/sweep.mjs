// Loads every .vital preset under a folder into one engine (as a reader switching presets would)
// and plays C3 for 1 s: reports presets that fail to parse, render silence, or produce NaN/Inf.
// Usage: node tools/sweep.mjs <folder>
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import createEngine from '../web/engine.mjs'

const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.vital') ? [p] : [] })
const files = walk(process.argv[2])
const m = await createEngine()
const loadPreset = (text) => { const p = m.stringToNewUTF8(text); const ok = m._vs_load_preset(p); m._free(p); return ok }
m.ccall('vs_init', null, ['number'], [44100])
const result = { ok: 0, parseFail: [], silent: [], nonFinite: [], threw: [] }
const versions = {}
const t0 = performance.now()
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  try { const v = JSON.parse(text).synth_version; versions[v] = (versions[v] ?? 0) + 1 } catch {}
  try {
    if (!loadPreset(text)) { result.parseFail.push(f); continue }
    m._vs_note_on(48, 0.7)
    let peak = 0, finite = true
    for (let b = 0; b < 44100 / 128; b++) {
      m._vs_process(128)
      const l = m.HEAPF32.subarray(m._vs_left() >> 2, (m._vs_left() >> 2) + 128)
      for (const x of l) { if (!Number.isFinite(x)) finite = false; else peak = Math.max(peak, Math.abs(x)) }
    }
    m._vs_all_notes_off()
    for (let b = 0; b < 20; b++) m._vs_process(128)
    if (!finite) result.nonFinite.push(f)
    else if (peak < 1e-4) result.silent.push(f)
    else result.ok++
  } catch (e) { result.threw.push(`${f}: ${String(e).slice(0, 80)}`); break }
}
const short = (a) => a.map((f) => f.replace(process.argv[2], ''))
console.log(JSON.stringify({ total: files.length, ok: result.ok, parseFail: short(result.parseFail), silent: short(result.silent), nonFinite: short(result.nonFinite), threw: result.threw, versions, seconds: ((performance.now() - t0) / 1000).toFixed(1) }, null, 1))
