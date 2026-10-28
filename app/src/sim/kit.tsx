import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Tag } from './tags'
import { justDragged, useSim } from './simContext'

// The synth sims' shared kit (In Your Synth, Foundations of Synthesis): each real synth is redrawn
// from the 2026-10-19 deep captures (~/Documents/DAW-Reference/synths/<synth>/) as a fixed-size
// stage, scaled to the column. A drawing marks its parts with <Region tags> (which of the six
// questions each part answers); the widget asks the reader to find each one by clicking it. The
// connection task (LFO 1 → cutoff, the synth's own way) is the drawing's to detect: it calls
// `mechDone` when the reader has made it.

/** A part of the drawing that answers one or more of the questions. Clicking it answers the current
 *  one if it's among `tags`; once found, it stays outlined while that question is shown. */
/** `skin`: the Vital skin section whose overrides apply inside (data-skin, vital/skin.tsx). */
export function Region({ tags, className = '', style, children, label, skin }: { tags: Tag[]; className?: string; style?: CSSProperties; children?: ReactNode; label?: string; skin?: string }) {
  const { asking, found, pick } = useSim()
  const lit = asking !== null && tags.includes(asking) && found.has(asking)
  return (
    <div className={`ss-region${lit ? ' lit' : ''} ${className}`} style={style} data-tags={tags.join(' ')} aria-label={label} data-skin={skin}
      onClick={(e) => { e.stopPropagation(); if (!justDragged()) pick(tags) }}>
      {children}
    </div>
  )
}

/** A knob drawn the way most synths draw them: a track arc, a value arc and a pointer. */
export function Knob({ value = 0.5, size = 34, color = 'var(--ss-accent)', track = 'var(--ss-track)', bipolar = false }: { value?: number; size?: number; color?: string; track?: string; bipolar?: boolean }) {
  const r = size / 2 - 3, c = size / 2
  const a0 = 135, sweep = 270
  const ang = (v: number) => ((a0 + sweep * v) * Math.PI) / 180
  const pt = (v: number, rr = r) => [c + rr * Math.cos(ang(v)), c + rr * Math.sin(ang(v))]
  const arc = (v1: number, v2: number) => {
    const [x1, y1] = pt(Math.min(v1, v2)), [x2, y2] = pt(Math.max(v1, v2))
    return `M ${x1} ${y1} A ${r} ${r} 0 ${Math.abs(v2 - v1) * sweep > 180 ? 1 : 0} 1 ${x2} ${y2}`
  }
  const [px, py] = pt(value, r * 0.62)
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <path d={arc(0, 1)} fill="none" stroke={track} strokeWidth={3} strokeLinecap="round" />
      {Math.abs(value - (bipolar ? 0.5 : 0)) > 0.005 && <path d={arc(bipolar ? 0.5 : 0, value)} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" />}
      <line x1={c} y1={c} x2={px} y2={py} stroke="var(--ss-pointer)" strokeWidth={2} strokeLinecap="round" />
    </svg>
  )
}

/** A synth's window at its own size (w × h CSS px), scaled to fit the width it's given (at most
 *  1.25×) and centred when that leaves it narrower than the widget. Pointer positions inside stay
 *  correct (the transform is on the stage; hit tests use the DOM). */
export function Stage({ w, h, className = '', maxScale = 1.25, children }: { w: number; h: number; className?: string; maxScale?: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ scale: 1, left: 0 })
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => {
      const scale = Math.min(maxScale, el.clientWidth / w)
      setFit({ scale, left: Math.max(0, (el.clientWidth - w * scale) / 2) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [w, maxScale])
  return (
    <div ref={box} className="ss-stagebox" style={{ height: h * fit.scale }}>
      <div className={`ss-stage ${className}`} style={{ width: w, height: h, left: fit.left, transform: `scale(${fit.scale})` }}>{children}</div>
    </div>
  )
}

