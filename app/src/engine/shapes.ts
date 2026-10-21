import type { LineShape } from '../../../web/engine-client.js'
import type { Line } from '../sim/vital/line'

// Translation between the drawing's own shapes and the engine's: wavetables for the oscillator menu's
// built-in tables, and line shapes (the LFO shapes and modulation remap curves) both ways.

const SIZE = 2048 // vital::WaveFrame::kWaveformSize
const LAST_FRAME = 256 // keyframe positions run 0…kNumOscillatorWaveFrames − 1

function base64(frame: Float32Array): string {
  const bytes = new Uint8Array(frame.buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function wave(fn: (ph: number) => number): Float32Array {
  const f = new Float32Array(SIZE)
  for (let i = 0; i < SIZE; i++) f[i] = fn(i / SIZE)
  return f
}

/** A wavetable of one Wave Source, its keyframes crossfaded (Vital's interpolation_style 1). */
function table(name: string, keyframes: [number, Float32Array][]) {
  return {
    name, author: '', version: '1.0.6', remove_all_dc: true, full_normalize: true,
    groups: [{ components: [{ type: 'Wave Source', interpolation_style: 1, interpolation: 1,
      keyframes: keyframes.map(([position, frame]) => ({ position, wave_data: base64(frame) })) }] }],
  }
}

const sine = (ph: number) => Math.sin(2 * Math.PI * ph)
const triangle = (ph: number) => 1 - 4 * Math.abs(((ph + 0.25) % 1) - 0.5)
const square = (ph: number) => (ph < 0.5 ? 1 : -1)
const saw = (ph: number) => 1 - 2 * ph
const pulse = (width: number) => (ph: number) => (ph < width ? 1 : -1)

/** The engine wavetable for a table the oscillator menu offers, or null for one it doesn't know (a
 *  loaded preset's own table, which the engine already holds). 'Init' comes from the engine itself. */
export function builtInTable(name: string, init: unknown): unknown | null {
  switch (name) {
    case 'Init': return init
    case 'Sine': return table('Sine', [[0, wave(sine)]])
    case 'Basic Shapes': return table('Basic Shapes', [[0, wave(sine)], [85, wave(triangle)], [170, wave(square)], [LAST_FRAME, wave(saw)]])
    case 'Pulse': return table('Pulse', Array.from({ length: 16 }, (_, k) => [Math.round((k / 15) * LAST_FRAME), wave(pulse(0.5 - (k / 15) * 0.45))]))
    default: return null
  }
}

/** A line shape (y 1 = top, one power per point) as the engine's LineGenerator JSON (y 0 = top). */
export function lineToEngine(l: Line): LineShape {
  return {
    name: l.name,
    num_points: l.pts.length,
    points: l.pts.flatMap(([x, y]) => [x, 1 - y]),
    powers: l.pts.map((_, i) => l.pw[i] ?? 0),
    smooth: !!l.smooth,
  }
}

/** The engine's LineGenerator JSON as a line shape. */
export function lineFromEngine(e: LineShape): Line {
  const pts: [number, number][] = []
  for (let i = 0; i < e.num_points; i++) pts.push([e.points[2 * i], 1 - e.points[2 * i + 1]])
  return { name: e.name ?? 'Custom', pts, pw: pts.map((_, i) => e.powers[i] ?? 0), smooth: !!e.smooth }
}

/** The engine's remap curve for the Matrix page, or null when it's the plain linear map
 *  (LineGenerator::checkLineIsLinear). */
export function remapFromEngine(e: LineShape): Line | null {
  const l = lineFromEngine(e)
  const linear = !l.smooth && l.pts.length === 2 && l.pts[0][0] === 0 && l.pts[0][1] === 0 && l.pts[1][0] === 1 && l.pts[1][1] === 1 && Math.abs(l.pw[0]) < 1e-6
  return linear ? null : l
}
