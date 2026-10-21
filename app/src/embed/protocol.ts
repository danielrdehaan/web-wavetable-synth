// The embedding protocol, version 1: how a page that frames the synth (a lesson in StemShare's knowledge
// base) talks to it. Every message is an object { type: 'synth:…', v: 1, … } sent with postMessage, and
// the synth answers only the page named by its `host` URL parameter, when that origin is allowed (never
// '*'). The full description is docs/embed-protocol.md.

export const PROTOCOL_VERSION = 1

/** A control or section to highlight or lock: a parameter id (filter_1_cutoff), a modulation source
 *  (lfo_1), or an embedded part (filter1). */
export type Target = { param: string } | { source: string } | { part: string }

/** What the synth reports, whenever it changes (at most ~10 times a second). */
export interface SynthState {
  /** Every control, in the engine's own units (cutoff in semitones, levels 0…1, menus as indices). */
  values: Record<string, number>
  /** The modulation routings: `amount` −1…1 of the destination's range, `depth` that in its units. */
  mods: { src: string; dst: string; amount: number; depth: number; bipolar: boolean; stereo: boolean; bypass: boolean }[]
  /** MIDI notes held now (on-screen keys, the computer keyboard, MIDI, or the page's synth:note). */
  held: number[]
  /** The sound is on (the engine started and isn't paused). */
  running: boolean
  /** Each oscillator's wavetable name. */
  tables: string[]
}

/** A lesson's patch: the init patch, then these values and routings. A routing's `remap` is its curve
 *  (points x 0…1, y 0…1 with 1 at the top, a power per point, smooth); `ui` sets interface state such as
 *  the effect order (`fxOrder`) or the matrix row shown (`mxSel`). */
export interface LessonPatch {
  values?: Record<string, number>
  mods?: { src: string; dst: string; amount?: number; bipolar?: boolean; remap?: { points: [number, number][]; powers?: number[]; smooth?: boolean } }[]
  ui?: { fxOrder?: number[]; mxSel?: number }
}

export type HostMessage =
  | { type: 'synth:hello'; v: number }
  | { type: 'synth:get'; v: number }
  | { type: 'synth:set'; v: number; values: Record<string, number> }
  | { type: 'synth:load'; v: number; patch: LessonPatch | { preset: string } }
  | { type: 'synth:highlight'; v: number; targets: Target[] }
  | { type: 'synth:lock'; v: number; targets: Target[] }
  | { type: 'synth:note'; v: number; note: number; on: boolean; velocity?: number }
  | { type: 'synth:pause'; v: number }
  | { type: 'synth:resume'; v: number }

export type SynthMessage =
  | { type: 'synth:ready'; v: number; parts: string[] }
  /** `start`: the first report after a synth:load took effect (where a lesson starts). */
  | { type: 'synth:state'; v: number; state: SynthState; start?: boolean }
  | { type: 'synth:started'; v: number }
  | { type: 'synth:size'; v: number; width: number; height: number }
  | { type: 'synth:error'; v: number; message: string }

/** The pages that may frame and drive the synth: StemShare and its local dev servers, plus any listed
 *  in VITE_EMBED_ORIGINS (comma separated) at build time. Local origins are allowed in dev builds. */
export function allowedOrigin(origin: string | null): boolean {
  if (!origin) return false
  const listed = ((import.meta.env.VITE_EMBED_ORIGINS as string | undefined) ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const defaults = ['https://stems.makethings.audio']
  if ([...defaults, ...listed].includes(origin)) return true
  return !!import.meta.env.DEV && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

/** A target as a CSS selector inside the synth. */
export function targetSelector(t: Target): string | null {
  const safe = (s: string) => /^[\w-]+$/.test(s) ? s : null
  if ('param' in t && safe(t.param)) return `[data-param="${t.param}"]`
  if ('source' in t && safe(t.source)) return `[data-src="${t.source}"]`
  if ('part' in t && safe(t.part)) return `[data-part="${t.part}"]`
  return null
}
