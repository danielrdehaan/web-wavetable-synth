import { powerCurve } from './draw'

// A line shape as Vital's LineGenerator holds it (line_generator.cpp): the LFO shapes and the
// modulation remap curves are both one. Points run x 0…1 and y 0…1 with 1 at the top (the engine's
// y runs the other way; shapes.ts flips it); `pw` has one power per point, the segment from that
// point to the next (for a looping LFO the last one wraps to the first point one cycle on).

export interface Line { name: string; pts: [number, number][]; pw: number[]; smooth: boolean }

/** LineGenerator::kMaxPoints. */
export const MAX_POINTS = 100
/** vital::SynthLfo::kMaxPower. */
export const MAX_POWER = 20

const line = (name: string, pts: [number, number][], smooth = false): Line => ({ name, pts, pw: pts.map(() => 0), smooth })

/** LineGenerator's own shapes (initLinear, initTriangle, …), the starting points the selectors step
 *  through: Vital's ‹ › browse the LFO files on disk, which a browser build doesn't have. */
export const LINEAR = line('Linear', [[0, 0], [1, 1]])
export const LINE_SHAPES: Line[] = [
  line('Triangle', [[0, 0], [0.5, 1], [1, 0]]),
  line('Sin', [[0, 0], [0.5, 1], [1, 0]], true),
  line('Square', [[0, 0], [0, 1], [0.5, 1], [0.5, 0], [1, 0]]),
  line('Saw Up', [[0, 0], [1, 1], [1, 0]]),
  line('Saw Down', [[0, 1], [1, 0], [1, 1]]),
  LINEAR,
]

export const copyLine = (l: Line): Line => ({ ...l, pts: l.pts.map((p) => [p[0], p[1]] as [number, number]), pw: l.pts.map((_, i) => l.pw[i] ?? 0) })

/** LineGenerator::smoothTransition. */
export const smoothTransition = (t: number) => 0.5 * Math.sin((t - 0.5) * Math.PI) + 0.5

/** LineGenerator::getValueBetweenPoints / getValueAtPhase: y at x, between the points either side. */
export function valueAt(l: Line, x: number): number {
  const p = l.pts
  for (let i = 0; i < p.length - 1; i++) {
    if (p[i][0] <= x && p[i + 1][0] >= x) {
      const width = p[i + 1][0] - p[i][0]
      if (width <= 0) return p[i + 1][1]
      let t = (x - p[i][0]) / width
      if (l.smooth) t = smoothTransition(t)
      t = Math.max(0, Math.min(1, powerCurve(t, l.pw[i] ?? 0)))
      return p[i][1] + t * (p[i + 1][1] - p[i][1])
    }
  }
  return p[p.length - 1][1]
}

/** LineGenerator::render, then valueAtPhase: the curve as the engine plays it, sampled at
 *  `resolution` points (a looping line starts from the last point one cycle back). */
export function renderLine(l: Line, loop: boolean, resolution = 2048): Float32Array {
  const p = l.pts, n = p.length
  const out = new Float32Array(resolution)
  let index = 0
  let last: [number, number] = loop ? [p[n - 1][0] - 1, p[n - 1][1]] : p[0]
  let power = loop ? l.pw[n - 1] ?? 0 : 0
  let current: [number, number] = p[0]
  for (let i = 0; i < resolution; i++) {
    const x = i / (resolution - 1)
    let t = 1
    if (current[0] > last[0]) t = (x - last[0]) / (current[0] - last[0])
    if (l.smooth) t = smoothTransition(t)
    t = Math.max(0, Math.min(1, powerCurve(t, power)))
    out[i] = last[1] + t * (current[1] - last[1])
    while (x > current[0] && index < n) {
      power = l.pw[index % n] ?? 0
      index++
      last = current
      current = p[index % n]
      if (index >= n) { current = [current[0] + 1, current[1]]; break }
    }
  }
  return out
}

/** LineGenerator::flipHorizontal. */
export function flipHorizontal(l: Line): Line {
  const r = copyLine(l), n = r.pts.length
  for (let i = 0; i < Math.floor((n + 1) / 2); i++) {
    const a = r.pts[i], b = r.pts[n - i - 1]
    const ax = 1 - a[0], ay = a[1]
    r.pts[i] = [1 - b[0], b[1]]
    r.pts[n - i - 1] = [ax, ay]
  }
  for (let i = 0; i < Math.floor(n / 2); i++) {
    const tmp = r.pw[i]
    r.pw[i] = -r.pw[n - i - 2]
    r.pw[n - i - 2] = -tmp
  }
  return r
}

/** LineGenerator::flipVertical. */
export function flipVertical(l: Line): Line {
  const r = copyLine(l)
  r.pts = r.pts.map(([x, y]) => [x, 1 - y])
  return r
}

/** Paint patterns (LfoSection::getPaintPattern): Step, Half, Down, Up, Tri, as (t, level) pairs. */
export const PAINT_SHAPES: [number, number][][] = [
  [[0, 1], [1, 1]],
  [[0, 1], [0.5, 1], [0.5, 0], [1, 0]],
  [[0, 1], [1, 0]],
  [[0, 0], [1, 1]],
  [[0, 0], [0.5, 1], [1, 0]],
]
