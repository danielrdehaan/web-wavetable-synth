import { Box } from './controls'
import { useVital, type MenuItem } from './ctx'
import type { Rect } from './hooks'
import { COMB_STYLES, DIODE_STYLES, FILTER_MODELS, FILTER_STYLES } from './params'

// What filter_section.cpp shows per model and style, shared by FILTER 1 / 2 and the FX filter: the
// model menu's style lists (getNumStyles / getStyleName), which controls a model swaps in
// (showModelKnobs, setLabelText) and the blend bar's end icons (getLeftMorphPath / getRightMorphPath).

const FORMANT = 5, COMB = 6, PHASE = 7, DIODE = 4
const VOCAL_TRACT = 2 // FormantFilter::kVocalTract: a preset can set it; the menu lists only AOIE and AIUO
const DUAL_NOTCH_BAND = 3, BAND_PEAK_NOTCH = 4 // SynthFilter::Style, checked whatever the model

/** The styles the menu lists for a model. */
export function modelStyles(model: number): readonly string[] {
  if (model <= 3) return FILTER_STYLES
  if (model === DIODE) return DIODE_STYLES
  if (model === FORMANT) return ['AOIE', 'AIUO']
  if (model === COMB) return COMB_STYLES
  return ['Positive', 'Negative']
}

/** getStyleName: the style's name in the selector (the formant's third style is "The Mouth"). */
export function styleName(model: number, style: number): string {
  if (model === FORMANT && style === VOCAL_TRACT) return 'The Mouth'
  return modelStyles(model)[style] ?? ''
}

type Icon = 'lowPass' | 'highPass' | 'bandPass' | 'notch' | 'narrowBand' | 'wideBand' | 'phaser1' | 'phaser3' | 'leftArrow' | 'rightArrow'

/** The controls a model shows and the labels and icons around them. */
export function filterMode(model: number, style: number) {
  const formant = model === FORMANT, vocalTract = formant && style === VOCAL_TRACT, comb = model === COMB
  const bandNotch = style === DUAL_NOTCH_BAND || style === BAND_PEAK_NOTCH
  const left: Icon = model === PHASE ? 'phaser1' : formant ? 'leftArrow' : bandNotch ? 'bandPass' : comb && style ? 'narrowBand' : 'lowPass'
  const right: Icon = model === PHASE ? 'phaser3' : formant ? 'rightArrow' : bandNotch ? 'notch' : comb && style ? 'wideBand' : model === DIODE ? 'bandPass' : 'highPass'
  return {
    formant, vocalTract, comb,
    /** formant_x / formant_y replace cutoff / resonance; formant_transpose takes the blend bar (except
     *  the vocal tract, which keeps blend); PEAK and SPREAD replace DRIVE and KEY TRK. */
    showBlend: !formant || vocalTract, showTranspose: formant && !vocalTract,
    /** The comb's CUT (blend_transpose) takes the drive knob's place. */
    firstKnob: formant ? 'formant_resonance' : comb ? 'blend_transpose' : 'drive',
    secondKnob: formant ? 'formant_spread' : 'keytrack',
    label1: formant ? 'PEAK' : comb ? 'CUT' : 'DRIVE',
    label2: formant ? 'SPREAD' : 'KEY TRK',
    left, right,
  }
}

// Paths::lowPass … rightArrow: strokes 0.1 wide in a unit box, scaled to fit the icon's bounds.
const ICONS: Record<Icon, string> = {
  lowPass: 'M1 0.8 L0.7 0.3 L0.5 0.5 L0 0.5',
  highPass: 'M0 0.8 L0.3 0.3 L0.5 0.5 L1 0.5',
  bandPass: 'M0 0.8 L0.3333 0.6 L0.5 0.25 L0.6667 0.6 L1 0.8',
  notch: 'M0 0.4 L0.3333 0.4 L0.5 0.8 L0.6667 0.4 L1 0.4',
  narrowBand: 'M0 0.8 L0.3333 0.8 L0.5 0.4 L0.6667 0.8 L1 0.8',
  wideBand: 'M0 0.8 L0.3333 0.4 L0.6667 0.4 L1 0.8',
  phaser1: 'M0 0.5 L0.3333 0.75 L0.5 0.25 L0.6667 0.75 L1 0.5',
  phaser3: 'M0 0.5' + Array.from({ length: 11 }, (_, i) => ` L${((i + 1) / 12).toFixed(4)} ${i % 2 ? 0.25 : 0.75}`).join('') + ' L1 0.5',
  leftArrow: 'M1 0.5 L0 0.5 M0 0.5 L0.3333 0.1667 M0 0.5 L0.3333 0.8333',
  rightArrow: 'M1 0.5 L0 0.5 M1 0.5 L0.6667 0.1667 M1 0.5 L0.6667 0.8333',
}

export function FilterIcon({ icon, className, style }: { icon: Icon; className: string; style: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="-0.05 0.1 1.1 0.8" aria-hidden="true">
      <path d={ICONS[icon]} stroke="currentColor" fill="none" strokeWidth={0.1} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The model : style selector. ‹ › step through every model's styles; the name opens the dual menu
 *  (models on the left, the hovered model's styles on the right), placed as the section places it:
 *  `menuAt` 'right' opens at the section's right edge (FILTER 1 / 2), 'below' under the selector,
 *  right-aligned (the FX filter). */
export function FilterModelSelector({ pre, at, className, menuAt }: { pre: string; at: Rect; className: string; menuAt: 'right' | 'below' }) {
  const api = useVital()
  const model = Math.round(api.v[`${pre}_model`] ?? 0), style = Math.round(api.v[`${pre}_style`] ?? 0)
  const styles = modelStyles(model)
  const step = (k: number) => (e: React.MouseEvent) => {
    e.stopPropagation(); api.checkpoint()
    let m = model, s = style + k
    if (s < 0) { m = (m + 7) % 8; s = modelStyles(m).length - 1 } else if (s >= styles.length) { m = (m + 1) % 8; s = 0 }
    api.set(`${pre}_model`, m); api.set(`${pre}_style`, s)
  }
  const MENU_W = 120
  // DualPopupSelector: a model shows its styles; a style applies at once and the menu stays open (the
  // current model and style marked), until a double-click on the current style or a click elsewhere.
  const open = (anchor: { clientX: number; clientY: number }, m = model, cur = { model, style }) => {
    const cols: MenuItem[][] = [
      FILTER_MODELS.map((n, i) => ({ label: n, on: i === m, act: () => open(anchor, i, cur) })),
      modelStyles(m).map((n, i) => ({ label: n, on: m === cur.model && i === cur.style, act: () => { api.checkpoint(); api.set(`${pre}_model`, m); api.set(`${pre}_style`, i); open(anchor, m, { model: m, style: i }) } })),
    ]
    api.openMenu({ items: cols[0], cols, w: MENU_W, dual: true }, anchor)
  }
  const openFrom = (e: React.MouseEvent) => {
    e.stopPropagation()
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
    const section = (e.currentTarget.closest('.vt-filter, .vfx-panel') as HTMLElement | null)?.getBoundingClientRect() ?? box
    const s = api.scale()
    if (menuAt === 'right') open({ clientX: section.right, clientY: box.top })
    else open({ clientX: box.right - 2 * MENU_W * s, clientY: box.bottom })
  }
  return (
    <Box at={at} className={className}>
      <span className="arr" onClick={step(-1)}>‹</span>
      <span className="nm" onClick={openFrom}>{FILTER_MODELS[model]}&nbsp;&nbsp;:&nbsp;&nbsp;{styleName(model, style)}</span>
      <span className="arr" onClick={step(1)}>›</span>
    </Box>
  )
}
