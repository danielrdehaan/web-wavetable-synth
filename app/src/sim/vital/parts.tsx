import { createContext, useContext, type ReactNode } from 'react'
import type { Ui } from './ctx'
import { EffectsPage, PANELS } from './EffectsPage'
import { FX, PANEL_H, PX, VIEW_H, VIEW_TOP } from './fxMath'
import { Panel } from './fxPanels'
import { Keyboard, Macros, Volume } from './Frame'
import { R, type Rect } from './hooks'
import { MatrixPage } from './MatrixPage'
import { AdvancedPage } from './AdvancedPage'
import { EnvSection, GlideBox, LfoSection, MidiSources, RandSection, VoiceBox } from './ModColumn'
import { Filter, Osc, Sampler } from './VoicePage'

// The interface's sections as parts that can be shown on their own (an embedded lesson that needs one
// oscillator, one LFO and a filter): each part's bounds in the capture's 2000-wide frame, what it
// draws there, and the interface state it needs (which envelope, LFO or random tab is showing).
// Every part draws at its own frame position inside a shifted container, so the sections are the
// same components as the full interface. Parts that share a section (lfo1 and lfo2) share its tab.

export interface PartSpec {
  rect: Rect
  render: () => ReactNode
  /** Interface state the part shows (applied when the part first appears). */
  ui?: Ui
  label: string
}

const page = (children: ReactNode) => <div className="vt-page" style={R(127, 108, 1131, 1140)}>{children}</div>

/** One effect's panel alone, where the EFFECTS page would draw the first one. */
function FxPart({ i }: { i: number }) {
  const fx = FX[i], P = PANELS[i]
  return page(
    <div className="vfx-page">
      <div className="vfx-view" style={R(PX - 127, VIEW_TOP - 108, 1137 - 127, VIEW_TOP - 108 + VIEW_H)}>
        <div className="vfx-content"><Panel fx={fx} top={0}><P color={fx.color} /></Panel></div>
      </div>
    </div>,
  )
}

const PAGE_RECT: Rect = [127, 108, 1131, 1140]
/** A white key's width on the keyboard, in frame units. */
const KEY = 1859 / 75

export const PARTS: Record<string, PartSpec> = {
  ...Object.fromEntries([0, 1, 2].map((i) => [`osc${i + 1}`, {
    rect: [127, 108 + i * 200, 1131, 298 + i * 200] as Rect, render: () => <Osc i={i} />, label: `Oscillator ${i + 1}`,
  }])),
  sampler: { rect: [127, 708, 1131, 803], render: () => <Sampler />, label: 'Sampler' },
  ...Object.fromEntries([0, 1].map((k) => [`filter${k + 1}`, {
    rect: [127 + k * 502, 813, 127 + k * 502 + 497, 1140] as Rect, render: () => <Filter k={k} />, label: `Filter ${k + 1}`,
  }])),
  ...Object.fromEntries([0, 1, 2].map((i) => [`env${i + 1}`, {
    rect: [1147, 108, 1986, 412] as Rect, render: () => <EnvSection />, ui: { env: i }, label: `Envelope ${i + 1}`,
  }])),
  ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((i) => [`lfo${i + 1}`, {
    rect: [1147, 418, 1986, 830] as Rect, render: () => <LfoSection />, ui: { lfo: i }, label: `LFO ${i + 1}`,
  }])),
  ...Object.fromEntries([0, 1].map((i) => [`random${i + 1}`, {
    rect: [1147, 830, 1583, 1036] as Rect, render: () => <RandSection />, ui: { rand: i }, label: `Random ${i + 1}`,
  }])),
  midi: { rect: [1589, 830, 1986, 1036], render: () => <MidiSources />, label: 'MIDI sources' },
  voice: { rect: [1147, 1040, 1583, 1140], render: () => <VoiceBox />, label: 'Voice' },
  glide: { rect: [1589, 1040, 1986, 1140], render: () => <GlideBox />, label: 'Glide' },
  macros: { rect: [14, 108, 113, 1200], render: () => <Macros />, label: 'Macros and wheels' },
  keyboard: { rect: [127, 1153, 1986, 1206], render: () => <Keyboard />, label: 'Keyboard' },
  // Four octaves of it, MIDI 36 to 84 (the computer keys start at 48): white keys 1859 / 75 wide.
  keys: { rect: [127 + 21 * KEY, 1153, 127 + 50 * KEY, 1206], render: () => <Keyboard />, label: 'Keyboard' },
  effects: { rect: PAGE_RECT, render: () => page(<EffectsPage />), label: 'Effects' },
  // The MATRIX page in two: its routing rows, and the remap editor of the selected row (mxSel).
  modrows: { rect: [127, 108, 1131, 738], render: () => page(<MatrixPage />), label: 'Modulation routings' },
  remap: { rect: [127, 742.6, 1131, 1140], render: () => page(<MatrixPage />), label: 'Modulation remap' },
  // The header's volume and peak meter: where the sound leaves.
  output: { rect: [1446, 0, 1730, 106.5], render: () => <><span className="vt-outlabel" style={R(1446, 4, 1730, 38)}>OUTPUT</span><Volume /></>, label: 'Output' },
  matrix: { rect: PAGE_RECT, render: () => page(<MatrixPage />), label: 'Modulation matrix' },
  advanced: { rect: PAGE_RECT, render: () => page(<AdvancedPage />), label: 'Advanced' },
  ...Object.fromEntries(FX.map((fx, i) => [fx.key === 'filter' ? 'fxfilter' : fx.key, {
    rect: [PX, VIEW_TOP, 1131.2, VIEW_TOP + PANEL_H] as Rect, render: () => <FxPart i={i} />, label: fx.name,
  }])),
}

/** Space between parts, in frame units. */
const GAP = 12

export interface Placed { id: string; spec: PartSpec; x: number; y: number; w: number; h: number }

/** A part entry: its id, and where it goes when written `id@x:y` (frame units, its top-left). */
export function parsePart(entry: string): { id: string; at: [number, number] | null } {
  const m = /^([a-z0-9]+)(?:@(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?))?$/.exec(entry.trim())
  return m ? { id: m[1], at: m[2] !== undefined ? [Number(m[2]), Number(m[3])] : null } : { id: '', at: null }
}

/** Parts stacked down (`column`) or across (`row`), each at its own size, in frame units; a part
 *  written `id@x:y` goes exactly there instead (the rest keep stacking). */
export function layoutParts(entries: string[], layout: 'column' | 'row' = 'column'): { placed: Placed[]; w: number; h: number } {
  const placed: Placed[] = []
  let x = 0, y = 0, w = 0, h = 0
  for (const entry of entries) {
    const { id, at } = parsePart(entry)
    const spec = PARTS[id]
    if (!spec) continue
    const pw = spec.rect[2] - spec.rect[0], ph = spec.rect[3] - spec.rect[1]
    if (at) {
      placed.push({ id, spec, x: at[0], y: at[1], w: pw, h: ph })
      w = Math.max(w, at[0] + pw); h = Math.max(h, at[1] + ph)
      continue
    }
    placed.push({ id, spec, x, y, w: pw, h: ph })
    if (layout === 'row') { x += pw + GAP; w = Math.max(w, x - GAP); h = Math.max(h, ph) }
    else { y += ph + GAP; h = Math.max(h, y - GAP); w = Math.max(w, pw) }
  }
  return { placed, w, h }
}

/** Where a popup given in the full interface's frame lands among the shown parts: moved with the part
 *  that holds `anchor` (the section that opened it), shrunk to fit and kept inside them. */
export interface PartsFrame { w: number; h: number; place: (rect: Rect, anchor?: Rect) => Rect }
export const PartsContext = createContext<PartsFrame | null>(null)
export const usePartsFrame = () => useContext(PartsContext)

export function makePartsFrame(placed: Placed[], w: number, h: number): PartsFrame {
  return {
    w, h,
    place: ([x0, y0, x1, y1], anchor = [x0, y0, x1, y1]) => {
      const p = placed.find(({ spec: { rect } }) => anchor[0] >= rect[0] && anchor[0] < rect[2] && anchor[1] >= rect[1] && anchor[1] < rect[3]) ?? placed[0]
      const k = Math.min(1, w / (x1 - x0), h / (y1 - y0))
      const rw = (x1 - x0) * k, rh = (y1 - y0) * k
      const nx = Math.max(0, Math.min(w - rw, x0 + (p ? p.x - p.spec.rect[0] : 0)))
      const ny = Math.max(0, Math.min(h - rh, y0 + (p ? p.y - p.spec.rect[1] : 0)))
      return [nx, ny, nx + rw, ny + rh]
    },
  }
}
