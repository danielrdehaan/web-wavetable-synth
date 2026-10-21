import { useEffect, useRef } from 'react'
import { useStatus } from './status'

// A modulation source's meter slot (ModulationButton::getMeterBounds) with Vital's live meter in it
// (ModulationManager::renderSourceMeters): while the source is connected and the engine reports a value,
// a pill spans from the value to a smoothed copy of it (kModSmoothDecay 0.25 per 60 Hz frame), so it
// trails as the value moves. Values are 0 … 1 from the bottom of the slot to the top.

const SMOOTH_DECAY = 0.25
const MIN_RADIUS = 1.2 // px either side, kModSourceMinRadius in the drawing's scale

export function SourceSlot({ src, used }: { src: string; used: boolean }) {
  const value = useStatus(src)
  const smooth = useRef<number | null>(null)
  const last = useRef(performance.now())
  const live = used && value !== null && Number.isFinite(value)
  const v = live ? Math.max(0, Math.min(1, value)) : 0
  useEffect(() => {
    const now = performance.now()
    const decay = Math.min(1, Math.max(0, SMOOTH_DECAY * ((now - last.current) / 1000) * 60))
    last.current = now
    if (!live) { smooth.current = null; return }
    smooth.current = smooth.current === null ? v : smooth.current + (v - smooth.current) * decay
  })
  const s = smooth.current ?? v
  return (
    <i className={`vt-slot${used ? ' used' : ''}`}>
      {live && <b className="vt-slotmeter" style={{ top: `calc(${(1 - Math.max(v, s)) * 100}% - ${MIN_RADIUS}px)`, height: `calc(${Math.abs(v - s) * 100}% + ${2 * MIN_RADIUS}px)` }} />}
    </i>
  )
}
