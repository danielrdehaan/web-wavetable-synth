import type { SynthEngine } from '../../../../web/engine-client.js'
import { clmAuthor, clmFadeStyle, readAudioFile } from '../../engine/audioFile'
import type { VitalApi } from './ctx'

// Loading a wavetable file into an oscillator, as OscillatorSection::loadFile and
// WavetableEditSection::loadFile do, shared by the oscillator's display and the wavetable editor.

/** A .vitaltable loads as it is; audio is spliced into frames (loadAudioAsWavetable,
 *  kWavetableSplice), or vocoded (2) / pitch-spliced (4) when `style` asks. `key` is the library
 *  entry it came from, if any. Resolves false when the file can't be read. */
export async function loadTableFile(api: VitalApi, engine: SynthEngine, ctx: BaseAudioContext | null, osc: number,
  file: Blob & { name?: string }, key: string | undefined, name: string, style = 1): Promise<boolean> {
  if (/\.vitaltable$/i.test(file.name ?? '')) {
    try {
      const data = JSON.parse(await file.text()) as Record<string, unknown>
      // WavetableEditSection::loadFile names the table after its file.
      const { ok } = await engine.setWavetable(osc, { ...data, name })
      if (!ok) return false
    } catch { return false }
  } else {
    if (!ctx) return false
    let audio
    try { audio = await readAudioFile(file, ctx) } catch { window.alert(`${file.name ?? name} isn't an audio file this browser can read.`); return false }
    await engine.wavetableFromAudio(osc, audio.channels[0], audio.sampleRate, style, clmFadeStyle(audio.clm), name, clmAuthor(audio.clm))
  }
  tableChanged(api, osc, { [`osc_${osc + 1}_table`]: name, [`osc_${osc + 1}_tableFile`]: key ?? `dropped:${name}` })
  return true
}

/** The engine's table changed under the interface (a file, an edit, a resynthesis): the displays
 *  re-read it and EngineSync leaves it alone (a table file key marks it as already in the engine). */
export function tableChanged(api: VitalApi, osc: number, patch: Record<string, unknown> = {}) {
  const pre = `osc_${osc + 1}`
  api.setUi({
    [`${pre}_tableFile`]: (api.ui[`${pre}_tableFile`] as string | undefined) ?? 'edited',
    [`${pre}_tableRev`]: ((api.ui[`${pre}_tableRev`] as number | undefined) ?? 0) + 1,
    modified: true,
    ...patch,
  })
}
