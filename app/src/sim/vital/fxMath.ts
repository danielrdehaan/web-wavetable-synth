// The EFFECTS page's drawing maths (EffectsPage.tsx, fxPanels.tsx): the curves each effect's display
// draws from its parameters. No sound is made; these are shapes that move the way Vital's displays
// move (approximations of the real responses, not Vital's DSP).

/** The nine effects, in Vital's default chain order, with each one's skin colour (sampled from the capture). */
export const FX = [
  { key: 'chorus', name: 'Chorus', label: 'CHORUS', on: 'chorus_on', color: '#aa88ff' },
  { key: 'compressor', name: 'Compressor', label: 'COMPRESSOR', on: 'compressor_on', color: '#1de9b6' },
  { key: 'delay', name: 'Delay', label: 'DELAY', on: 'delay_on', color: '#ff99e9' },
  { key: 'distortion', name: 'Distortion', label: 'DISTORTION', on: 'distortion_on', color: '#ff5252' },
  { key: 'eq', name: 'Equalizer', label: 'EQUALIZER', on: 'eq_on', color: '#fff6e1' },
  { key: 'filter', name: 'Filter', label: 'FILTER', on: 'filter_fx_on', color: '#ffb74d' },
  { key: 'flanger', name: 'Flanger', label: 'FLANGER', on: 'flanger_on', color: '#ffd740' },
  { key: 'phaser', name: 'Phaser', label: 'PHASER', on: 'phaser_on', color: '#40c4ff' },
  { key: 'reverb', name: 'Reverb', label: 'REVERB', on: 'reverb_on', color: '#8fa0ff' },
] as const

export const DEFAULT_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8]

/** Capture geometry (2000-wide frame): the tile list and the panel column. */
export const TILE_PITCH = 115.3, TILE_H = 106.3
export const PANEL_PITCH = 199.32, PANEL_H = 193.8
export const VIEW_TOP = 107.6, VIEW_H = 1032.7
/** A panel's left edge in the frame (child positions are given in frame x, minus this). */
export const PX = 344.4

/** "#rrggbb" at `a` over Vital's display background (#1d2125). */
export function over(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const b = [0x1d, 0x21, 0x25]
  return `rgb(${c.map((v, i) => Math.round(v * a + b[i] * (1 - a))).join(',')})`
}

const hz = (semi: number) => 440 * Math.pow(2, (semi - 69) / 12)


const db = (m: number) => 20 * Math.log10(Math.max(m, 1e-5))


/** Distortion's transfer curve: output for input `x` (−1…1). */
export function distort(type: number, driveDb: number, mix: number, x: number): number {
  const g = Math.pow(10, driveDb / 20)
  const u = g * x
  let y: number
  switch (Math.round(type)) {
    case 1: y = Math.max(-1, Math.min(1, u)); break
    case 2: { const m = (((u + 1) % 4) + 4) % 4; y = 1 - Math.abs(m - 2); break }
    case 3: y = Math.sin((u * Math.PI) / 2); break
    case 4: { const lv = Math.max(1, Math.round(Math.pow(2, 1 + ((30 - driveDb) / 60) * 5))); y = Math.round(Math.max(-1, Math.min(1, x)) * lv) / lv; break }
    case 5: y = x; break
    default: y = Math.tanh(u)
  }
  return mix * y + (1 - mix) * x
}

/** Equalizer response (dB) at `f` semitones: low shelf / high pass, band peak / notch, high shelf / low pass. */
export function eqDb(f: number, v: (k: string) => number): number {
  const q = (r: number) => 0.5 + r * 3.5
  const lowC = v('eq_low_cutoff'), bandC = v('eq_band_cutoff'), highC = v('eq_high_cutoff')
  let d = 0
  if (Math.round(v('eq_low_mode')) === 1) {
    const w = Math.pow(2, (f - lowC) / 12), Q = q(v('eq_low_resonance') ** 2)
    d += db((w * w) / Math.hypot(1 - w * w, w / Q))
  } else d += v('eq_low_gain') / (1 + Math.pow(2, (f - lowC) / 5))
  const br = v('eq_band_resonance') ** 2
  if (Math.round(v('eq_band_mode')) === 1) {
    const w = Math.pow(2, (f - bandC) / 12), Q = q(br)
    d += db(Math.abs(1 - w * w) / Math.hypot(1 - w * w, w / Q))
  } else { const bw = 4 + (1 - br) * 18; d += v('eq_band_gain') * Math.exp(-(((f - bandC) / bw) ** 2)) }
  if (Math.round(v('eq_high_mode')) === 1) {
    const w = Math.pow(2, (f - highC) / 12), Q = q(v('eq_high_resonance') ** 2)
    d += db(1 / Math.hypot(1 - w * w, w / Q))
  } else d += v('eq_high_gain') / (1 + Math.pow(2, (highC - f) / 5))
  return d
}

/** Reverb's shelving EQ (dB) at `f` semitones (0…128 across its display). */
export function reverbEqDb(f: number, lowC: number, lowG: number, highC: number, highG: number): number {
  return lowG / (1 + Math.pow(2, (f - lowC) / 4)) + highG / (1 + Math.pow(2, (highC - f) / 4))
}

/** Flanger: a feedback comb tuned to `center` semitones, mixed with the dry signal. */
export function flangerDb(f: number, center: number, feedback: number, mix: number): number {
  const T = 1 / hz(center), ph = 2 * Math.PI * hz(f) * T
  const g = Math.max(-0.95, Math.min(0.95, feedback))
  const den = Math.hypot(1 - g * Math.cos(ph), g * Math.sin(ph))
  const wet = { re: (1 - g * Math.cos(ph)) / (den * den), im: (-g * Math.sin(ph)) / (den * den) }
  const re = (1 - mix) + mix * wet.re, im = mix * wet.im
  return db(Math.hypot(re, im))
}

/** Phaser: eight all-pass stages around `center`, with feedback, blended with the dry signal. */
export function phaserDb(f: number, center: number, feedback: number, mix: number, blend: number): number {
  const w = Math.pow(2, (f - center) / 12)
  const ph = -8 * 2 * Math.atan(w)
  const g = Math.max(0, Math.min(0.95, feedback))
  const ac = Math.cos(ph), as = Math.sin(ph)
  const dre = 1 - g * ac, dim = -g * as, dd = dre * dre + dim * dim
  const wre = (ac * dre + as * dim) / dd * (1 - g), wim = (as * dre - ac * dim) / dd * (1 - g)
  const s = blend <= 1 ? blend : 2 - blend, pol = blend <= 1 ? 1 : -1
  const re = 1 + pol * s * wre * 1, im = pol * s * wim
  const m = Math.hypot(re, im) / (1 + s * 0.5)
  return db((1 - mix) + mix * m)
}

export { hz }
