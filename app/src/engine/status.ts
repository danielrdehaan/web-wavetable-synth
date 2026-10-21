import { useEffect, useRef, useState } from 'react'
import type { SynthEngine } from '../../../web/engine-client.js'

// The engine's status outputs (what Vital's displays read) and the live values of modulated controls
// (what its knob meters read), streamed ~30 times a second. Values sit in plain maps outside React; a
// display subscribes to the names it draws and re-renders once per animation frame while they change.

/** Every LFO's phase (voice + 0.9 × phase, utils::encodePhaseAndVoice) and frequency; every envelope's phase (stage + progress: 1 delay, 2 attack, 3 hold,
 *  4 decay/sustain, 5 release, 6 kill) and level; the voice count and output peak; what the effect
 *  displays read (compressor band levels as mean squares, chorus delay frequencies, phaser cutoff,
 *  flanger delay frequency); every modulation source's value; and each routing slot's source value
 *  and scaled amount (modulation_source_N / modulation_amount_N: the remap input and matrix meters). */
export const WATCHED = [
  ...Array.from({ length: 8 }, (_, i) => [`lfo_${i + 1}_phase`, `lfo_${i + 1}_frequency`]).flat(),
  ...Array.from({ length: 6 }, (_, i) => [`env_${i + 1}_phase`, `env_${i + 1}`]).flat(),
  'num_voices', 'peak_meter',
  ...['low', 'band', 'high'].flatMap((b) => [`compressor_${b}_input`, `compressor_${b}_output`]),
  ...[1, 2, 3, 4].map((i) => `chorus_delays${i}`),
  'phaser_cutoff', 'flanger_delay_frequency',
  // Modulation sources' own values (the source meters, the random displays, the drag ghost).
  ...Array.from({ length: 8 }, (_, i) => `lfo_${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => `random_${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => `macro_control_${i + 1}`),
  'note', 'velocity', 'lift', 'note_in_octave', 'aftertouch', 'slide', 'stereo', 'random', 'mod_wheel', 'pitch_wheel',
  'sample_phase', 'peak_meter_memory',
  ...Array.from({ length: 64 }, (_, i) => [`modulation_source_${i + 1}`, `modulation_amount_${i + 1}`]).flat(),
]

/** StatusOutput::kClearValue: the output has no voice to report. */
const CLEAR = -2e9

const values = new Map<string, number>()
const lanes = new Map<string, number[]>()
const live = new Map<string, number>()
const liveLanes = new Map<string, [number, number]>()
const listeners = new Set<() => void>()
let slots = new Map<string, number>()

export function startStatus(engine: SynthEngine) {
  engine.onStatus = (read, names, totals, totalNames) => {
    const n = engine.lanes
    names.forEach((name, i) => {
      const all = Array.from(read.subarray(i * n, (i + 1) * n), (x) => (x <= CLEAR ? NaN : x))
      lanes.set(name, all)
      values.set(name, all[0])
    })
    live.clear(); liveLanes.clear()
    totalNames.forEach((name, i) => { live.set(name, totals[2 * i]); liveLanes.set(name, [totals[2 * i], totals[2 * i + 1]]) })
    for (const l of listeners) l()
  }
  engine.onSlots = (map) => { slots = new Map(map); for (const l of listeners) l() }
  engine.watch(WATCHED)
}

/** A status output's lanes right now, for displays that draw on their own clock (canvas editors). */
export function statusLanes(name: string): number[] | null {
  return lanes.get(name) ?? null
}

/** The engine slot (1-based) of the routing from `src` to `dst`, or null when the engine has none. */
export function routeSlot(src: string, dst: string): number | null {
  return slots.get(`${src}>${dst}`) ?? null
}

/** A modulated control's live left and right values right now, or null. */
export function liveLanesValue(control: string): [number, number] | null {
  return liveLanes.get(control) ?? null
}

/** A modulated control's live left and right values (Vital's lanes 0 and 1), or null. */
export function useLiveLanes(control: string): [number, number] | null {
  return useSubscribed(() => liveLanes.get(control) ?? null, (a, b) => a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]))
}

/** A control's left and right values as Vital's displays read them (getOutputsTotal): the engine's
 *  modulated lanes while it reports them, else `base` in both. */
export function useLanesOr(control: string, base: number): [number, number] {
  const lanes = useLiveLanes(control)
  return lanes ?? [base, base]
}

/** A modulated control's live value right now (see useLive), for displays on their own clock. */
export function liveValue(control: string): number | null {
  return live.get(control) ?? null
}

/** Calls `fn` on every status packet; returns the unsubscribe. */
export function onStatusPacket(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Streams the live values of these modulated controls (call when the routings change). */
export function watchLive(engine: SynthEngine, controls: string[]) {
  engine.watchTotals(controls)
}

const sameLanes = (a: number[] | null, b: number[] | null) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i])))

function useSubscribed<T>(read: () => T, same: (a: T, b: T) => boolean = Object.is): T {
  const [value, setValue] = useState(read)
  const reader = useRef(read)
  useEffect(() => { reader.current = read })
  useEffect(() => {
    let raf = 0
    const changed = () => {
      if (raf) return
      raf = requestAnimationFrame(() => { raf = 0; const next = reader.current(); setValue((old) => (same(old, next) ? old : next)) })
    }
    listeners.add(changed)
    return () => { listeners.delete(changed); cancelAnimationFrame(raf) }
  }, [])
  return value
}

/** A modulated control's live value in its own units while the engine reports one, else null. */
export function useLive(control: string): number | null {
  return useSubscribed(() => live.get(control) ?? null)
}

/** A status output's latest value, NaN while it has nothing to report, null before the engine runs. */
export function useStatus(name: string): number | null {
  return useSubscribed(() => values.get(name) ?? null)
}

/** Every lane of a status output (lane 0/1 = left/right; the chorus delays use all four), or null. */
export function useStatusLanes(name: string): number[] | null {
  return useSubscribed(() => lanes.get(name) ?? null, sameLanes)
}

/** A routing's live source value ('source', what its remap reads) or scaled amount ('amount', the
 *  matrix meter), every lane, or null when the routing has no engine slot. */
export function useRouteLanes(src: string, dst: string, kind: 'source' | 'amount'): number[] | null {
  return useSubscribed(() => {
    const slot = slots.get(`${src}>${dst}`)
    return slot ? lanes.get(`modulation_${kind}_${slot}`) ?? null : null
  }, sameLanes)
}
