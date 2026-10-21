// Save/load round trip over every preset in a folder: load, save with vs_save_preset, and compare the
// saved file with the original: every control value, the modulation routings and their remap curves
// (line mappings), the LFO shapes, and each wavetable's components and keyframes. Prints only the
// presets that differ.
// Usage: node tools/roundtrip.mjs <folder>
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import createEngine from '../web/engine.mjs'

const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.vital') ? [p] : [] })
const m = await createEngine()
m.ccall('vs_init', null, ['number'], [44100])
const withText = (fn, text) => { const p = m.stringToNewUTF8(text); const r = fn(p); m._free(p); return r }
const close = (a, b) => Math.abs(a - b) < 1e-4
const routes = (mods) => (mods ?? []).filter((x) => x.source && x.destination).map((x) => `${x.source}→${x.destination}`).sort().join(',')
const shape = (l) => JSON.stringify({ n: l.num_points, p: l.points.slice(0, 2 * l.num_points).map((x) => +x.toFixed(4)), w: l.powers.slice(0, l.num_points).map((x) => +x.toFixed(4)) })
const table = (w) => JSON.stringify((w.groups ?? []).map((g) => g.components.map((c) => `${c.type}:${(c.keyframes ?? []).length}`)))

const files = walk(process.argv[2])
let same = 0
const known = new Set(JSON.parse(m.ccall('vs_params_json', 'string', [], [])).map((p) => p.id))
for (const file of files) {
  const orig = JSON.parse(readFileSync(file, 'utf8'))
  if (!withText(m._vs_load_preset, JSON.stringify(orig))) { console.log('load failed', file); continue }
  const saved = JSON.parse(m.UTF8ToString(withText(m._vs_save_preset, '{}')))
  const o = orig.settings, s = saved.settings
  const problems = []
  const controls = Object.keys(o).filter((k) => known.has(k) && typeof o[k] === 'number' && !close(o[k], s[k]))
  if (controls.length) problems.push(`controls ${controls.slice(0, 4).join(' ')}`)
  if (routes(o.modulations) !== routes(s.modulations)) problems.push('routings')
  const curves = (mods) => new Map((mods ?? []).filter((x) => x.source && x.line_mapping).map((x) => [`${x.source}→${x.destination}`, shape(x.line_mapping)]))
  const oc = curves(o.modulations), sc = curves(s.modulations)
  const curveDiff = [...oc].find(([k, v]) => sc.get(k) !== v) ?? [...sc].find(([k]) => !oc.has(k))
  if (curveDiff) problems.push(`remap ${curveDiff[0]}`)
  const lfoDiff = (o.lfos ?? []).findIndex((l, i) => shape(l) !== shape(s.lfos[i]))
  if (lfoDiff >= 0) problems.push(`lfo ${lfoDiff + 1}`)
  const tableDiff = (o.wavetables ?? []).findIndex((w, i) => table(w) !== table(s.wavetables[i]))
  if (tableDiff >= 0) problems.push(`wavetable ${tableDiff + 1}`)
  if (problems.length) console.log(`${file.replace(process.argv[2], '')}: ${problems.join('; ')}`)
  else same++
}
console.log(`${same} of ${files.length} presets survive save → load unchanged`)
