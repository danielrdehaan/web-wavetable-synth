// The math behind the Vital drawing's displays: wavetable frames and their warps, filter responses,
// envelope and LFO shapes. These are drawings, not Vital's DSP: each is the textbook shape of what the
// control does, close enough that the display moves the way Vital's does when the control moves. They
// draw only until the engine runs; then the oscillator screens are the engine's own (WaveDisplay).

const TAU = Math.PI * 2
const frac = (x: number) => x - Math.floor(x)
const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x))

/** The wavetables the oscillator menu offers (the engine's Init saw plus three engine/shapes.ts
 *  generates). */
export const WAVETABLES = ['Init', 'Basic Shapes', 'Sine', 'Pulse'] as const

function baseWave(table: string, frame: number, ph: number): number {
  const saw = ph < 0.5 ? -2 * ph : 2 - 2 * ph
  switch (table) {
    case 'Sine': return Math.sin(TAU * ph)
    case 'Pulse': return frac(ph) < 0.5 - frame * 0.45 ? 1 : -1
    case 'Basic Shapes': {
      // sine → triangle → square → saw across the frames
      const shapes = [Math.sin(TAU * ph), 1 - 4 * Math.abs(frac(ph + 0.25) - 0.5), ph < 0.5 ? 1 : -1, saw]
      const f = clamp(frame) * 3, i = Math.min(2, Math.floor(f)), t = f - i
      return shapes[i] * (1 - t) + shapes[i + 1] * t
    }
    default: return saw
  }
}

/** Oscillator warp (Vital's "distortion" types) applied to the read phase or the sample. */
function warpPhase(type: number, amt: number, ph: number): number {
  switch (type) {
    case 1: return frac(ph * (1 + amt * 7)) // Sync
    case 2: return Math.min(1, ph * (1 + amt * 5)) // Formant: the cycle squeezed into the start
    case 4: { const k = Math.pow(2, (amt - 0.5) * 4); return ph < 0.5 ? 0.5 * Math.pow(2 * ph, k) : 1 - 0.5 * Math.pow(2 * (1 - ph), k) } // Bend
    case 5: { const k = 1 + amt * 5; return ph < 0.5 ? 0.5 * Math.pow(2 * ph, k) : 1 - 0.5 * Math.pow(2 * (1 - ph), k) } // Squeeze
    case 6: return Math.min(1, ph / Math.max(0.05, 1 - amt * 0.95)) // Pulse
    case 7: case 8: case 9: return frac(ph + amt * 0.25 * Math.sin(TAU * ph * 2)) // FM
    default: return ph
  }
}

/** One frame of an oscillator, N samples in −1…1, with its warp and frequency-domain morph drawn. */
export function oscFrame(table: string, frame: number, warp: number, warpAmt: number, morph: number, morphAmt: number, n = 128): number[] {
  let s = Array.from({ length: n }, (_, i) => {
    const ph = i / (n - 1)
    let y = baseWave(table, frame, warpPhase(warp, warpAmt, ph))
    if (warp === 3) { const lv = 2 + Math.round((1 - warpAmt) * 24); y = Math.round(y * lv) / lv } // Quantize
    if (warp >= 10) y *= (1 - warpAmt) + warpAmt * Math.sin(TAU * ph * 3) // RM
    return y
  })
  if (morph === 7 || morph === 5 || morph === 8) {
    const k = Math.max(1, Math.round(morphAmt * 14))
    const sm = s.map((_, i) => { let a = 0; for (let j = -k; j <= k; j++) a += s[(i + j + n) % n]; return a / (2 * k + 1) })
    s = morph === 8 ? s.map((y, i) => (y - sm[i]) * 1.6) : sm
  }
  return s
}

/** Harmonic magnitudes (1…h) of a frame, for the spectrum ("SP") view. */
export function spectrum(s: number[], h = 48): number[] {
  const n = s.length
  return Array.from({ length: h }, (_, k) => {
    let re = 0, im = 0
    for (let i = 0; i < n; i++) { re += s[i] * Math.cos(TAU * (k + 1) * i / n); im += s[i] * Math.sin(TAU * (k + 1) * i / n) }
    return Math.hypot(re, im) / (n / 2)
  })
}

/** Filter magnitude in dB at MIDI note `f` for Vital's models and styles (a two-pole state-variable
 *  shape, squared for 24 dB; blend crossfades low → band → high pass). */
export function filterDb(model: number, style: number, cutoff: number, res: number, blend: number, f: number, extra: { formantX?: number; formantY?: number; transpose?: number } = {}): number {
  const w = Math.pow(2, (f - cutoff) / 12)
  const q = 0.6 + res * res * 4.5
  const den = { re: 1 - w * w, im: w / q }
  const dm = Math.hypot(den.re, den.im)
  const lp = 1 / dm, bp = (w / q) / dm, hp = (w * w) / dm
  const notch = Math.abs(1 - w * w) / dm
  const mix3 = (a: number, b: number, c: number) => (blend <= 1 ? a * (1 - blend) + b * blend : b * (2 - blend) + c * (blend - 1))
  let mag: number
  switch (model) {
    case 4: // Diode: Low Shelf / Low Cut
      mag = style === 1 ? hp * mix3(lp, 1, 1) : mix3(lp, bp, hp) + 0.3
      break
    case 5: { // Formant: three vowel peaks placed by X/Y
      const fx = extra.formantX ?? 0.5, fy = extra.formantY ?? 0.5, t = extra.transpose ?? 0
      const peaks = [55 + fx * 18 + t, 70 + fy * 22 + t, 88 + fx * 8 + fy * 6 + t]
      mag = peaks.reduce((a, p) => a + 1 / Math.hypot(1 - Math.pow(2, (f - p) / 12) ** 2, Math.pow(2, (f - p) / 12) / (2 + res * 8)) * 0.35, 0.02)
      break
    }
    case 6: { // Comb: peaks at the cutoff's harmonics
      const hz = 440 * Math.pow(2, (f - 69) / 12), c = 440 * Math.pow(2, (cutoff - 69) / 12)
      const g = 0.4 + res * 0.55
      const ph = TAU * hz / c
      mag = 1 / Math.hypot(1 - g * Math.cos(ph), g * Math.sin(ph)) * (1 - g) * (style % 3 === 2 ? 0.8 : 1)
      if (style >= 3) mag *= bp * 2 + 0.05
      break
    }
    case 7: { // Phaser: notches around the centre
      const n1 = Math.abs(1 - w * w) / Math.hypot(1 - w * w, w / (0.4 + res))
      const w2 = w * 2, n2 = Math.abs(1 - w2 * w2) / Math.hypot(1 - w2 * w2, w2 / (0.4 + res))
      mag = 0.5 + 0.5 * n1 * n2 * (1 + res * 0.4)
      break
    }
    default:
      if (style === 2) mag = blend <= 1 ? lp * (1 - blend) + notch * blend : notch * (2 - blend) + hp * (blend - 1) // Notch Blend
      else if (style === 3) { const sp = Math.pow(2, (blend - 1) * 0.6); const w1 = w / sp, w2 = w * sp; mag = (Math.abs(1 - w1 * w1) / Math.hypot(1 - w1 * w1, w1 / q)) * (Math.abs(1 - w2 * w2) / Math.hypot(1 - w2 * w2, w2 / q)) } // Notch Spread
      else if (style === 4) mag = blend <= 1 ? bp * (1 - blend) + Math.max(bp, notch * 0.5 + bp) * blend : bp * (2 - blend) + notch * (blend - 1) // B/P/N
      else mag = mix3(lp, bp, hp)
      if (style === 1) mag = mag * mag // 24 dB
  }
  return 20 * Math.log10(Math.max(mag, 1e-5))
}

/** Vital's envelope/LFO curve power: 0 = straight, + bows one way, − the other. */
export function powerCurve(t: number, power: number): number {
  if (Math.abs(power) < 0.01) return t
  return (Math.exp(power * t) - 1) / (Math.exp(power) - 1)
}
