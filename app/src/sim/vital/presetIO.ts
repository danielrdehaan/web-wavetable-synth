import type { SynthEngine } from '../../../../web/engine-client.js'
import { decodeOrder } from '../../engine/effectOrder'
import { lineFromEngine, remapFromEngine } from '../../engine/shapes'
import type { Ui, VitalApi } from './ctx'
import { remapKey } from './MatrixPage'

// Loading a .vital preset into the engine and the interface, and Initialize Preset (which loads the
// default preset once one is set, as "Set as Default Preset" asks).

export const DEFAULT_PRESET_KEY = 'vt.defaultPreset'

/** Loads preset text into the engine, then the interface: values, routings, remap curves, wavetable
 *  names, LFO shapes, macro names (the preset's top-level "macro1" … "macro4") and the effect order.
 *  Resolves false when the engine can't read it. */
export async function loadPresetText(api: VitalApi, engine: SynthEngine, text: string, name: string): Promise<boolean> {
  const state = await engine.loadPreset(text)
  if (!state.ok) return false
  const uiPatch: Ui = { preset_name: name, fxOrder: decodeOrder(state.values.effect_chain_order ?? 0), modified: false }
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    for (let m = 0; m < 4; m++) { const macro = json[`macro${m + 1}`]; uiPatch[`macro_${m}_name`] = typeof macro === 'string' && macro ? macro : undefined }
    // SynthBase's save info: the author, comments and style the browser shows and the save box starts from.
    const str = (k: string) => (typeof json[k] === 'string' ? (json[k] as string) : '')
    uiPatch.preset_author = str('author'); uiPatch.preset_comments = str('comments'); uiPatch.preset_style = str('preset_style')
  } catch { /* the engine read it, so it's JSON; nothing to add */ }
  for (const key of Object.keys(api.ui)) if (key.startsWith('mxRemap:')) uiPatch[key] = undefined
  for (const m of state.mods) { const curve = m.remap && remapFromEngine(m.remap); if (curve) uiPatch[remapKey(m)] = curve }
  state.tables?.forEach((table, i) => { uiPatch[`osc_${i + 1}_table`] = table || 'Init'; uiPatch[`osc_${i + 1}_tableFile`] = undefined })
  state.lfos?.forEach((shape, i) => { uiPatch[`lfo_${i}_shape`] = lineFromEngine(shape) })
  api.replace(state.values, state.mods.map(({ remap: _remap, ...m }) => m), uiPatch)
  return true
}

/** The saved default preset's text, if one is set. */
export function defaultPreset(): string | null {
  try { return localStorage.getItem(DEFAULT_PRESET_KEY) } catch { return null }
}

/** Initialize Preset: the default preset when one is set (kept as "Init Preset"), else the init patch. */
export async function initializePreset(api: VitalApi, engine: SynthEngine | null) {
  const text = defaultPreset()
  if (text && engine && (await loadPresetText(api, engine, text, 'Init Preset'))) { api.setUi({ presetFile: undefined, presetExternal: undefined }); return }
  api.init()
}
