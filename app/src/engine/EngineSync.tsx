import { useEffect, useRef } from 'react'
import type { EngineMod } from '../../../web/engine-client.js'
import { remapKey } from '../sim/vital/MatrixPage'
import { LINE_SHAPES, LINEAR, type Line } from '../sim/vital/line'
import { useVital, type Mod, type Ui } from '../sim/vital/ctx'
import { DEFAULT_ORDER } from '../sim/vital/fxMath'
import { useEngine } from './EngineContext'
import { fromMidi } from './midi'
import { encodeOrder } from './effectOrder'
import { builtInTable, lineToEngine } from './shapes'
import { watchLive } from './status'
import { DEFAULT_VELOCITY, noteVelocity } from './velocity'

// Plays the drawing: keeps the engine matching the Vital store. Parameter values go over as diffs,
// the modulation list as a whole (the worklet reconciles routings) with each routing's remap curve,
// the effect chain order, each oscillator's wavetable when
// its menu changes (built-in tables only: a loaded preset's tables are already in the engine), each
// LFO's shape when it's edited, and held notes as note on/off. When the reader initialises the patch,
// the engine is reset first, so the sample (state the store doesn't hold) goes back to Init too.
// Renders nothing.


const toEngine = (mods: Mod[]): EngineMod[] =>
  mods.map(({ src, dst, amt, bipolar, stereo, bypass, power }) => ({ src, dst, amt, bipolar, stereo, bypass, power }))

const OSCS = [0, 1, 2], LFOS = [0, 1, 2, 3, 4, 5, 6, 7]
const tableOf = (ui: Ui, osc: number) => (ui[`osc_${osc + 1}_table`] as string | undefined) ?? 'Init'
/** The drawing keys LFO shapes from 0 (`lfo_0_shape` is LFO 1), like the engine. */
const orderOf = (ui: Ui) => encodeOrder((ui.fxOrder as number[] | undefined) ?? DEFAULT_ORDER)
const remapOf = (ui: Ui, m: Mod) => JSON.stringify((ui[remapKey(m)] as Line | undefined) ?? LINEAR)
const lfoOf = (ui: Ui, lfo: number) => JSON.stringify((ui[`lfo_${lfo}_shape`] as Line | undefined) ?? LINE_SHAPES[0])

export function EngineSync() {
  const { engine } = useEngine()
  const api = useVital()
  const sent = useRef<Record<string, number>>({})
  const sentMods = useRef('')
  const sounding = useRef<Set<number>>(new Set())
  const patchSeen = useRef(api.patch.id)
  const sentTables = useRef(OSCS.map(() => 'Init'))
  const sentLfos = useRef(LFOS.map(() => ''))
  const sentRemaps = useRef(new Map<string, string>())
  const sentOrder = useRef(0)
  const initTable = useRef<unknown>(null)

  // The selected modulation source runs even unconnected, so its display animates (forceShowModulation).
  useEffect(() => {
    const src = api.focusSrc
    if (!engine || !src) return
    engine.forceShow(src, true)
    return () => engine.forceShow(src, false)
  }, [engine, api.focusSrc])

  // The engine's own Init wavetable, so choosing Init in the menu restores exactly that.
  useEffect(() => {
    if (engine) void engine.wavetableJson(0).then((t) => { initTable.current = t })
  }, [engine])

  // Parameter values, routings, wavetables and LFO shapes. The first pass after the engine starts sends everything. The
  // worklet's port is first-in first-out, so a reset needn't be awaited before the values that follow.
  useEffect(() => {
    if (!engine) return
    if (api.patch.id !== patchSeen.current) {
      patchSeen.current = api.patch.id
      if (api.patch.from === 'init') {
        void engine.init()
        sent.current = {}
        sentMods.current = ''
        sentTables.current = OSCS.map(() => 'Init')
        sentLfos.current = LFOS.map(() => '')
        sentRemaps.current.clear()
        sentOrder.current = 0
      } else {
        // A loaded preset: the engine already holds its tables, shapes and remap curves.
        sentTables.current = OSCS.map((o) => tableOf(api.ui, o))
        sentLfos.current = LFOS.map((l) => lfoOf(api.ui, l))
        sentRemaps.current = new Map(api.mods.map((m) => [remapKey(m), remapOf(api.ui, m)]))
        sentOrder.current = orderOf(api.ui)
      }
    }
    const diff: Record<string, number> = {}
    for (const [id, value] of Object.entries(api.v)) {
      if (!engine.byId[id] || sent.current[id] === value) continue
      // A wheel MIDI moved: the engine set it per channel already (MidiManager), so it isn't resent.
      if (fromMidi.get(id) === value) { fromMidi.delete(id); sent.current[id] = value; continue }
      diff[id] = value
      sent.current[id] = value
    }
    if (Object.keys(diff).length) engine.setMany(diff)
    if ('mod_wheel' in diff) engine.modWheel(diff.mod_wheel)
    if ('pitch_wheel' in diff) engine.pitchWheel(diff.pitch_wheel)
    if ('mpe_enabled' in diff) engine.setMpe(diff.mpe_enabled >= 0.5) // SynthBase::setMpeEnabled
    const mods = JSON.stringify(toEngine(api.mods))
    if (mods !== sentMods.current) {
      sentMods.current = mods
      engine.setMods(toEngine(api.mods))
      watchLive(engine, [...new Set(api.mods.filter((m) => !m.bypass).map((m) => m.dst))])
    }
    for (const o of OSCS) {
      const name = tableOf(api.ui, o)
      if (name === sentTables.current[o]) continue
      // A table loaded from a file is in the engine already (whatever it's called).
      const data = api.ui[`osc_${o + 1}_tableFile`] ? null : builtInTable(name, initTable.current)
      if (data) void engine.setWavetable(o, data)
      sentTables.current[o] = name
    }
    // Remap curves after the routings (the port keeps the order): a new or re-made routing always gets
    // its curve, linear when it has none, since its engine slot may hold an older one.
    const live = new Set<string>()
    for (const m of api.mods) {
      const key = remapKey(m), curve = remapOf(api.ui, m)
      live.add(key)
      if (sentRemaps.current.get(key) === curve) continue
      void engine.setRemap(m.src, m.dst, lineToEngine(JSON.parse(curve) as Line))
      sentRemaps.current.set(key, curve)
    }
    for (const key of [...sentRemaps.current.keys()]) if (!live.has(key)) sentRemaps.current.delete(key)
    // The effects page's chain order, which Vital keeps as one permutation code.
    const order = orderOf(api.ui)
    if (order !== sentOrder.current) { engine.set('effect_chain_order', order); sentOrder.current = order }
    for (const l of LFOS) {
      const shape = lfoOf(api.ui, l)
      if (shape === sentLfos.current[l]) continue
      void engine.setLfo(l, lineToEngine(JSON.parse(shape) as Line))
      sentLfos.current[l] = shape
    }
  }, [engine, api.v, api.mods, api.ui, api.patch])

  // Held notes (the on-screen keyboard, the computer keyboard and MIDI all write api.notes).
  useEffect(() => {
    if (!engine) return
    for (const n of sounding.current) if (!api.notes.has(n)) { engine.noteOff(n); sounding.current.delete(n) }
    for (const n of api.notes) if (!sounding.current.has(n)) { engine.noteOn(n, noteVelocity.get(n) ?? DEFAULT_VELOCITY); sounding.current.add(n) }
  }, [engine, api.notes])

  return null
}
