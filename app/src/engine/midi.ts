import { useSyncExternalStore } from 'react'
import type { SynthEngine } from '../../../web/engine-client.js'
import type { MenuItem, VitalApi } from '../sim/vital/ctx'
import { PARAMS } from '../sim/vital/params'
import { routeSlot } from './status'

// MIDI the way Vital's MidiManager takes it: every message from every enabled input goes to the engine
// as raw bytes (vs_midi: notes per channel, pressure, bend, slide, pedals, MPE zones); the page lights
// the keys a keyboard holds and moves the wheels when the engine says the interface follows
// (modWheelMidiChanged / pitchWheelMidiChanged). Controllers also drive MIDI learn: a control armed
// from its menu takes the next controller moved, and mapped controllers set their controls across
// their range (midiInput / valueChangedThroughMidi). The map is kept in the browser, as Vital keeps it
// in its config file. Browsers ask before granting MIDI, so access starts from a button.

export interface MidiInputInfo { id: string; name: string; enabled: boolean }
type Status = 'idle' | 'on' | 'denied' | 'unsupported'

const DISABLED_KEY = 'vt.midiDisabled', MAP_KEY = 'vt.midiMap'
const read = <T,>(key: string, fallback: T): T => { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) as T : fallback } catch { return fallback } }
const write = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ } }

let status: Status = (typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator ? 'idle' : 'unsupported') as Status
let inputs: MidiInputInfo[] = []
let access: MIDIAccess | null = null
const disabled = new Set<string>(read<string[]>(DISABLED_KEY, []))
/** Controller number → the controls it drives. */
let learnMap: Record<string, string[]> = read(MAP_KEY, {})
let armed: string | null = null
const held = new Set<number>()
let heldView: ReadonlySet<number> = new Set()
let snapshot: { status: Status; inputs: MidiInputInfo[] } = { status, inputs }

const listeners = new Set<() => void>()
const emit = () => { snapshot = { status, inputs }; heldView = new Set(held); for (const l of listeners) l() }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** The store and engine the bridge writes to (set by MidiBridge). */
const target: { api: VitalApi | null; engine: SynthEngine | null } = { api: null, engine: null }
export function bindMidi(api: VitalApi, engine: SynthEngine | null) {
  target.api = api
  if (engine && engine !== target.engine) engine.onMidiFollow = follow
  target.engine = engine
}

/** Values the interface takes from MIDI that the engine already has (EngineSync skips sending them). */
export const fromMidi = new Map<string, number>()

function follow({ follow: f, status: st, data1, data2 }: { follow: number; status: number; data1: number; data2: number }) {
  const api = target.api
  if (!api) return
  if (f & 1) { const v = data2 / 127; fromMidi.set('mod_wheel', v); api.set('mod_wheel', v) }
  if (f & 2) { const v = 2 * (((data2 << 7) | data1) / 16383) - 1; fromMidi.set('pitch_wheel', v); api.set('pitch_wheel', v) }
  if (f & 4 && (st & 0xf0) === 0xb0) midiInput(data1, data2)
}

/** MidiManager::midiInput: an armed control takes this controller; mapped controls follow it. */
function midiInput(controller: number, value: number) {
  const api = target.api
  if (!api) return
  if (armed) {
    const list = learnMap[controller] ?? []
    if (!list.includes(armed)) learnMap = { ...learnMap, [controller]: [...list, armed] }
    armed = null
    write(MAP_KEY, learnMap)
  }
  for (const id of learnMap[controller] ?? []) {
    // A connection's amount (modulation_N_amount, −1 … 1) lives with the routing it belongs to.
    const slot = id.match(/^modulation_(\d+)_amount$/)
    if (slot) {
      const i = api.getMods().findIndex((m) => routeSlot(m.src, m.dst) === Number(slot[1]))
      if (i >= 0) api.setMod(i, { amt: (value / 127) * 2 - 1 })
      continue
    }
    const d = PARAMS[id]
    if (!d) continue
    let v = (value / 127) * (d.max - d.min) + d.min
    if (d.scale === 'idx') v = Math.round(v)
    api.set(id, v)
  }
}

export function armMidiLearn(id: string) { armed = id }

/** A control's MIDI learn menu items (SynthSlider::createPopupMenu): Learn, and Clear once mapped. */
export function learnItems(id: string): MenuItem[] {
  return [
    { label: 'Learn MIDI Assignment', act: () => armMidiLearn(id) },
    ...(isMidiMapped(id) ? [{ label: 'Clear MIDI Assignment', act: () => clearMidiLearn(id) }] : []),
  ]
}
export function isMidiMapped(id: string) { return Object.values(learnMap).some((l) => l.includes(id)) }
export function clearMidiLearn(id: string) {
  learnMap = Object.fromEntries(Object.entries(learnMap).map(([k, l]) => [k, l.filter((x) => x !== id)]).filter(([, l]) => l.length))
  write(MAP_KEY, learnMap)
}

function onMessage(this: MIDIInput, e: MIDIMessageEvent) {
  const d = e.data
  if (!d || !d.length || disabled.has(this.id)) return
  const st = d[0]
  if (st >= 0xf0) return
  const a = d[1] ?? 0, b = d[2] ?? 0, kind = st & 0xf0
  target.engine?.midi(st, a, b)
  if (kind === 0x90 && b > 0) { held.add(a); emit() }
  else if (kind === 0x80 || (kind === 0x90 && b === 0)) { if (held.delete(a)) emit() }
  else if (kind === 0xb0 && (a === 0x7b || a === 0x79 || a === 0x78) && held.size) { held.clear(); emit() }
}

function attach() {
  if (!access) return
  const list: MidiInputInfo[] = []
  access.inputs.forEach((input) => {
    input.onmidimessage = onMessage
    list.push({ id: input.id, name: input.name ?? 'MIDI input', enabled: !disabled.has(input.id) })
  })
  inputs = list
  emit()
}

export async function connectMidi() {
  if (status === 'unsupported' || access) return
  try {
    access = await navigator.requestMIDIAccess()
    access.onstatechange = attach
    status = 'on'
    attach()
  } catch {
    status = 'denied'
    emit()
  }
}

/** The About box's MIDI Inputs: an input's dot turns it on or off. */
export function toggleMidiInput(id: string) {
  if (disabled.has(id)) disabled.delete(id); else disabled.add(id)
  write(DISABLED_KEY, [...disabled])
  attach()
}

export function useMidi() {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/** The notes MIDI keyboards are holding (the on-screen keys light up for them). */
export function useMidiNotes(): ReadonlySet<number> {
  return useSyncExternalStore(subscribe, () => heldView)
}
