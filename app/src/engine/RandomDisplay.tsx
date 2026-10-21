import { useEffect, useRef, useState } from 'react'
import { useStatusLanes } from './status'

// A random LFO's display (random_section.cpp RandomViewer): the last kResolution = 64 values of
// random_N scrolling left to right, y = (1 − value) × height, filled to the bottom; the right lane
// (Widget Primary/Secondary 2) under the left (… 1). It moves only while the engine runs the random LFO
// (it's connected and a voice plays); otherwise the screen stays empty, as in Vital.

const RESOLUTION = 64
const SCALE = 1000 / 1440
// RandomLfo skin: Widget Primary 1 / 2, Secondary 1 / 2.
const LEFT = '#1de9b6', RIGHT = '#40c4ff', LEFT_FILL = 'rgba(29,233,182,0.21)', RIGHT_FILL = 'rgba(64,196,255,0.21)'

export function RandomDisplay({ n, w, h }: { n: number; w: number; h: number }) {
  const lanes = useStatusLanes(`random_${n}`)
  const history = useRef<{ l: number[]; r: number[] }>({ l: [], r: [] })
  const [, redraw] = useState(0)
  useEffect(() => {
    const hist = history.current
    const l = lanes?.[0], r = lanes?.[1]
    if (l === undefined || !Number.isFinite(l)) { if (hist.l.length) { hist.l = []; hist.r = []; redraw((k) => k + 1) } return }
    hist.l = [l, ...hist.l].slice(0, RESOLUTION)
    hist.r = [r ?? l, ...hist.r].slice(0, RESOLUTION)
    redraw((k) => k + 1)
  }, [lanes])
  const { l, r } = history.current
  if (!l.length) return null
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (RESOLUTION - 1)) * w).toFixed(2)} ${((1 - v) * h).toFixed(2)}`).join('')
  const filled = (vals: number[]) => `${path(vals)}L${(((vals.length - 1) / (RESOLUTION - 1)) * w).toFixed(2)} ${h}L0 ${h}Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
      <path d={filled(r)} fill={RIGHT_FILL} />
      <path d={path(r)} fill="none" stroke={RIGHT} strokeWidth={2 * SCALE} />
      <path d={filled(l)} fill={LEFT_FILL} />
      <path d={path(l)} fill="none" stroke={LEFT} strokeWidth={2 * SCALE} />
    </svg>
  )
}
