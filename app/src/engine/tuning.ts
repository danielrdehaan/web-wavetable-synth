import { useSyncExternalStore } from 'react'
import type { SynthEngine } from '../../../web/engine-client.js'
import limit7 from '../../../vital-src/tunings/7 Limit.scl?raw'
import limit5 from '../../../vital-src/tunings/5 Limit.scl?raw'
import pythagorean from '../../../vital-src/tunings/Pythagorean.scl?raw'

// The synth's tuning (SynthBase's Tuning, global rather than part of a preset): TuningSelector's four
// choices (Default, and the three Scala scales Vital ships in its source) and Load Tuning File (.scl,
// .kbm, .tun), read by the engine (vs_tuning_load).

export const TUNING_NAMES = ['Default', 'Just - 7 Limit', 'Just - 5 Limit', 'Pythagorean'] as const
const SCALES = [null, limit7, limit5, pythagorean]

let state = { name: '', isDefault: true }
const listeners = new Set<() => void>()
const set = (next: { name: string; isDefault: boolean }) => { state = next; for (const l of listeners) l() }

/** TuningSelector::loadTuning: named first, then the scale read (Default clears the name). */
export async function loadBuiltinTuning(engine: SynthEngine, i: number) {
  const scale = SCALES[i]
  set(scale ? await engine.loadTuning(0, scale, '', TUNING_NAMES[i]) : await engine.clearTuning())
}

/** SynthBase::loadTuningFile: the file's extension picks the reader; unknown ones are ignored. */
export async function loadTuningFile(engine: SynthEngine, file: File) {
  const ext = file.name.toLowerCase().match(/\.(scl|kbm|tun)$/)?.[1]
  if (!ext) return
  const kind = ext === 'scl' ? 0 : ext === 'kbm' ? 1 : 2
  set(await engine.loadTuning(kind, await file.text(), file.name.replace(/\.[^.]+$/, '')))
}

export async function clearTuning(engine: SynthEngine) {
  set(await engine.clearTuning())
}

/** Opens the browser's file picker for a tuning file. */
export function pickTuningFile(engine: SynthEngine) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.scl,.kbm,.tun'
  input.onchange = () => { const f = input.files?.[0]; if (f) void loadTuningFile(engine, f) }
  input.click()
}

export function useTuning() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => state)
}
