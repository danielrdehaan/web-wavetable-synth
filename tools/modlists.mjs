// Writes app/src/sim/vital/modLists.json from the engine: the modulation sources and the destinations a
// modulation can reach (with Vital's display names and local descriptions), so the interface's menus and
// drop targets match the engine before it has started. Rerun after an engine change.
// Usage: node tools/modlists.mjs
import { writeFileSync } from 'node:fs'
import createEngine from '../web/engine.mjs'

const m = await createEngine()
m.ccall('vs_init', null, ['number'], [44100])
const lists = JSON.parse(m.ccall('vs_modulation_lists_json', 'string', [], []))
const out = new URL('../app/src/sim/vital/modLists.json', import.meta.url)
writeFileSync(out, JSON.stringify(lists, null, 0) + '\n')
console.log(`${lists.sources.length} sources, ${lists.destinations.length} destinations`)
