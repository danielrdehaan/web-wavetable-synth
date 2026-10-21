// OpenGlLineRenderer's boost (open_gl_line_renderer.cpp), shared by the canvas displays that animate a
// playhead along their line (the LFO and remap editors, the sample viewer): each point carries a boost
// 0–1 that widens the line there (radius × (1 + line boost × b)) and brightens its fill (alpha ×
// (1 + fill boost × b)); a playhead raises the points it passed since the last frame and every boost
// decays toward 0 between frames.

/** One lane's boosts plus the direction its last boost ran (boostRange's last_negative_boost_). */
export interface BoostLane { boosts: Float32Array; negative: boolean }

export function boostLane(points: number): BoostLane {
  return { boosts: new Float32Array(points), negative: false }
}

/** boostRange: raises the points from `start` to `end` (0–1 of the active points, the ones between
 *  `bufferVertices` padding points at each end) to a ramp from `min` up to 1, the last point by the
 *  square of how far past it `end` lies; a short backward step boosts backward. */
export function boostRange(lane: BoostLane, start: number, end: number, bufferVertices: number, min: number) {
  const boosts = lane.boosts
  const total = boosts.length
  const activePoints = total - 2 * bufferVertices
  let startIndex = Math.max(Math.ceil(start * (activePoints - 1)), 0)
  const endPosition = end * (activePoints - 1)
  let endIndex = Math.max(Math.ceil(endPosition), 0)
  let progress = endPosition - Math.trunc(endPosition)
  startIndex %= activePoints; endIndex %= activePoints
  let num = endIndex - startIndex, direction = 1
  if ((num < 0 && num > -total / 2) || (num === 0 && lane.negative)) { num = -num; direction = -1 }
  else if (num > total / 2) { num -= activePoints; num = -num; direction = -1 }
  lane.negative = direction < 0
  if (lane.negative) {
    startIndex = Math.max(Math.floor(start * (activePoints - 1)), 0) % activePoints
    endIndex = Math.max(Math.floor(endPosition), 0) % activePoints
    num = startIndex - endIndex
    progress = 1 - progress
  }
  const delta = (1 - min) / num
  let val = min
  for (let i = startIndex; i !== endIndex; i = (i + activePoints + direction) % activePoints) {
    val = Math.min(1, val + delta)
    boosts[i + bufferVertices] = Math.max(boosts[i + bufferVertices], val)
  }
  boosts[endIndex + bufferVertices] = Math.max(boosts[endIndex + bufferVertices], progress * progress)
}

/** decayBoosts: every boost × `mult`. */
export function decayBoosts(lane: BoostLane, mult: number) {
  const b = lane.boosts
  for (let i = 0; i < b.length; i++) b[i] *= mult
}

export function anyBoost(lane: BoostLane): boolean {
  return lane.boosts.some((b) => b > 0.0001)
}

const rgba = (c: string) => {
  if (c.startsWith('#')) return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 1]
  const m = c.match(/[\d.]+/g)!.map(Number)
  return [m[0], m[1], m[2], m[3] ?? 1]
}

/** kFillFragmentShader's colour for a fill `color` (Widget Secondary): `fade` (Widget Fill Fade) less
 *  alpha at the fill centre `yCenter` than at `yEdge`, a straight blend between, every alpha ×
 *  (1 + `boost`), capped at 1 as the framebuffer caps it. */
export function fillGradient(g: CanvasRenderingContext2D, color: string, fade: number, yEdge: number, yCenter: number, boost = 0) {
  const [r, gr, b, a] = rgba(color)
  const at = (alpha: number) => `rgba(${r},${gr},${b},${Math.min(1, alpha * (1 + boost)).toFixed(4)})`
  const grad = g.createLinearGradient(0, yEdge, 0, yCenter)
  grad.addColorStop(0, at(a))
  grad.addColorStop(1, at(a * (1 - fade)))
  return grad
}
