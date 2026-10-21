import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { markDragEnd } from '../simContext'
import { useVital } from './ctx'
import { DEFAULT_ORDER, FX, PANEL_H, PANEL_PITCH, PX, TILE_H, TILE_PITCH, VIEW_H, VIEW_TOP } from './fxMath'
import { ChorusPanel, CompressorPanel, DelayPanel, DistortionPanel, EqPanel, FilterPanel, FlangerPanel, Panel, PhaserPanel, ReverbPanel } from './fxPanels'
import { R } from './hooks'
import './effects.css'

// Vital's EFFECTS page (s0b, s6a–c, s3d): the nine effects as tiles on the left (power button, name,
// icon; drag a tile to reorder the chain, live, as DragDropEffectOrder does), and on the right a scrolling column with a panel for each
// effect that's on, in chain order. VitalSim wraps this in the page Region at (127, 108) of the frame;
// positions are frame coordinates minus that corner, halved.

export const PANELS: ComponentType<{ color: string }>[] = [ChorusPanel, CompressorPanel, DelayPanel, DistortionPanel, EqPanel, FilterPanel, FlangerPanel, PhaserPanel, ReverbPanel]

/** Page-relative box from frame coordinates. */
const A = (x0: number, y0: number, x1: number, y1: number) => R(x0 - 127, y0 - 108, x1 - 127, y1 - 108)

/** The tiles' icons, drawn from the capture (a 90 × 70 cell, frame units). */
function FxIcon({ i }: { i: number }) {
  const sw = 3.5
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: sw, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  let body: ReactNode
  switch (i) {
    case 0: { // chorus: a ring with three crescents behind it
      const r = 13.75, cy = 35.5
      const arc = (cx: number) => `M ${cx + r * Math.cos(-1.2)} ${cy + r * Math.sin(-1.2)} A ${r} ${r} 0 1 0 ${cx + r * Math.cos(1.2)} ${cy + r * Math.sin(1.2)}`
      body = <>{[24, 34.8, 45.6].map((x) => <path key={x} d={arc(x)} {...stroke} strokeLinecap="butt" />)}<circle cx={56.5} cy={cy} r={r} {...stroke} /></>
      break
    }
    case 1: // compressor
      body = <>
        <path d="M12 35.5 H67.5" {...stroke} strokeWidth={4} />
        <path d="M19.5 20 Q40 32 60 20" {...stroke} /><path d="M19.5 51 Q40 39 60 51" {...stroke} />
        <path d="M35 16 H45 A5 4 0 0 1 35 16 Z" fill="currentColor" /><path d="M35 54.5 H45 A5 4 0 0 0 35 54.5 Z" fill="currentColor" />
      </>
      break
    case 2: // delay
      body = <>{[[15, 13.75, 57.5], [25, 20, 51.25], [35, 25, 46.25], [45, 28.75, 42.5], [55, 32, 39.5], [65, 33.75, 37.5]].map(([x, a, b]) => <rect key={x} x={x - 1.75} y={a} width={3.5} height={b - a} fill="currentColor" />)}</>
      break
    case 3: // distortion: a broken square
      body = <>
        <path d="M19 15 L50.5 13.5 L60.5 20 L60.5 51 L56 56.5 L17.5 54 Z" fill="currentColor" />
        <path d="M23 33.5 L56 15.5 M23 33.5 L47.5 37 L61 21 M47.5 37 L61 53 M25 38 L37.5 57 M17 41 L25 38" stroke="#3e4245" strokeWidth={3.2} fill="none" className="vfx-iconcut" />
      </>
      break
    case 4: // equalizer: an eye with three dots
      body = <>
        <path d="M8.25 35 H20 C 28 35, 32 18.75, 40 18.75 C 48 18.75, 52 35, 60 35 H 72 M20 35 C 28 35, 32 51.25, 40 51.25 C 48 51.25, 52 35, 60 35" {...stroke} />
        {[32, 40, 48].map((x) => <rect key={x} x={x - 1.75} y={33.25} width={3.5} height={3.5} fill="currentColor" />)}
      </>
      break
    case 5: // filter: low pass with resonance
      body = <path d="M8.75 35 H30 C 40 35, 44 28, 48 21 C 50 17, 52 18, 53 21 L 70 53.75" {...stroke} />
      break
    case 6: // flanger: a comb
      body = <>
        <path d="M12.5 36 V 30 Q 12.5 22.5 20 22.5 H 60 Q 67.5 22.5 67.5 30 V 36 Q 67.5 42 64 46.5 L 60.5 46.5 V 36 H 19.5 V 46.5 L 16 46.5 Q 12.5 42 12.5 36 Z" fill="currentColor" />
        {[24.5, 31.25, 38, 45, 51.75].map((x) => <rect key={x} x={x - 1.75} y={34} width={3.5} height={12.5} rx={1} fill="currentColor" />)}
      </>
      break
    case 7: // phaser
      body = <path d="M8.25 34.25 H20 C 22 34.25, 22 46, 24 46 C 27.5 46, 28 21, 31.25 21 C 34.5 21, 35 46, 38.75 46 C 42.5 46, 43.5 21, 47.5 21 C 51.5 21, 53 46, 57.5 46 C 61 46, 61 34.25, 64 34.25 H 72" {...stroke} />
      break
    default: // reverb: a wire cube
      body = <path d="M17.5 27 L 28 15.5 H 63.5 V 46 L 52 58.75 H 17.5 Z M17.5 27 H 52 V 58.75 M52 27 L 63.5 15.5 M 35 15.5 V 46 M 17.5 46 H 63.5" {...stroke} strokeWidth={3.2} />
  }
  return <svg className="vfx-icon" viewBox="0 0 90 70" aria-hidden="true">{body}</svg>
}

/** One tile (DraggableEffect): power button, name, icon; while hovered, two 3 × 2 grids of grip dots
 *  near its top and bottom edges in Lighten Screen × 1.5. Dragging is the list's. */
function Tile({ i, y, dragging, hover }: { i: number; y: number; dragging: boolean; hover: boolean }) {
  const api = useVital()
  const fx = FX[i]
  const on = (api.v[fx.on] ?? 0) >= 0.5
  const w = (330.6 - 127) / 2, h = TILE_H / 2
  const spacing = w * (1 - 2 * 0.45) / 2, radius = spacing * 0.25, gx = w * 0.45, gy = h * 0.13
  return (
    <div className={`vfx-tile${on ? ' on' : ''}${dragging ? ' drag' : ''}`} style={{ ...A(127, y, 330.6, y + TILE_H), ...(on ? { borderColor: fx.color, color: fx.color } : {}) }}>
      <span className="vt-dot vfx-tdot" style={{ left: 22.2 / 2 - 5.5 - 1, top: 22.3 / 2 - 5.5 - 1, background: on ? fx.color : undefined }}
        onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); api.checkpoint(); api.set(fx.on, on ? 0 : 1) }} title={`${fx.name} on/off`} />
      <span className="vfx-tname">{fx.name}</span>
      <FxIcon i={i} />
      {hover && (
        <svg className="vfx-grip" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
          {[0, 1, 2].flatMap((c) => [0, 1].flatMap((r) => [
            <circle key={`t${c}${r}`} cx={gx + spacing * c} cy={gy + spacing * r} r={radius} />,
            <circle key={`b${c}${r}`} cx={gx + spacing * c} cy={h - gy - spacing * r} r={radius} />,
          ]))}
        </svg>
      )}
    </div>
  )
}

export function EffectsPage() {
  const api = useVital()
  const order = (api.ui.fxOrder as number[] | undefined) ?? DEFAULT_ORDER
  const active = order.filter((i) => (api.v[FX[i].on] ?? 0) >= 0.5)
  const contentH = active.length ? active.length * PANEL_PITCH - (PANEL_PITCH - PANEL_H) : 0
  const maxScroll = Math.max(0, contentH - VIEW_H)
  const scroll = Math.min(maxScroll, Math.max(0, (api.ui.fxScroll as number) ?? 0))
  const setScroll = (s: number) => api.setUi({ fxScroll: Math.max(0, Math.min(maxScroll, s)) })

  // Wheel scrolling (a non-passive listener, so the article doesn't scroll underneath).
  const view = useRef<HTMLDivElement>(null)
  const scrollRef = useRef({ scroll, maxScroll })
  scrollRef.current = { scroll, maxScroll }
  useEffect(() => {
    const el = view.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      const { scroll: s, maxScroll: m } = scrollRef.current
      if (m <= 0) return
      e.preventDefault()
      api.setUi({ fxScroll: Math.max(0, Math.min(m, s + (e.deltaY / api.scale()) * 2)) })
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [api])

  // Reordering (DragDropEffectOrder): pressing anywhere on the list picks up the tile under the
  // pointer; it follows the pointer (clamped to the list) and the order changes as soon as the pointer
  // crosses into another slot, so the engine and the panels follow live; releasing settles the tile into
  // its slot. One undo step per drag.
  const LIST_TOP = VIEW_TOP, LIST_H = 8 * TILE_PITCH + TILE_H
  const slotAt = (y: number) => Math.max(0, Math.min(8, Math.floor((y - LIST_TOP + (TILE_PITCH - TILE_H) / 2) / TILE_PITCH)))
  const [hover, setHover] = useState(-1)
  const [drag, setDrag] = useState<{ fx: number; y: number } | null>(null)
  // The gesture lives in a ref too: pointer events can outrun React's re-render.
  const dragRef = useRef<{ fx: number; slot: number; y0: number; start: number; moved: boolean; order: number[] } | null>(null)
  const listY = (e: { clientY: number }, el: Element) => {
    const r = el.getBoundingClientRect()
    return 108 + ((e.clientY - r.top) / api.scale()) * 2
  }
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const y = listY(e, e.currentTarget), slot = slotAt(y)
    dragRef.current = { fx: order[slot], slot, y0: y, start: LIST_TOP + slot * TILE_PITCH, moved: false, order: [...order] }
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
  }
  const move = (e: React.PointerEvent) => {
    const y = listY(e, e.currentTarget)
    const d = dragRef.current
    if (!d) { setHover(slotAt(y)); return }
    const tileY = Math.max(LIST_TOP, Math.min(LIST_TOP + LIST_H - TILE_H, d.start + y - d.y0))
    if (!d.moved) { d.moved = true; api.checkpoint() }
    const next = slotAt(y)
    if (next !== d.slot) {
      const list = [...d.order]
      const [it] = list.splice(d.slot, 1)
      list.splice(next, 0, it)
      d.order = list; d.slot = next
      api.setUi({ fxOrder: list })
    }
    setDrag({ fx: d.fx, y: tileY })
  }
  const up = () => {
    if (dragRef.current?.moved) markDragEnd()
    dragRef.current = null
    setDrag(null)
  }

  // The scrollbar thumb (shown when the column overflows); drag it to scroll.
  const thumbH = maxScroll > 0 ? (VIEW_H * VIEW_H) / contentH : 0
  const thumbY = maxScroll > 0 ? (scroll / maxScroll) * (VIEW_H - thumbH) : 0
  const thumbRef = useRef<{ y0: number; s0: number } | null>(null)

  return (
    <div className="vfx-page">
      <div className="vfx-tiles" style={A(127, 108, 330.6, 1140.3)} onPointerDown={down} onPointerMove={move} onPointerUp={up}
        onPointerCancel={up} onPointerLeave={() => setHover(-1)}>
        {/* The connector behind the tiles (paintBackground): 10 % of the width, just right of centre. */}
        <i className="vfx-connector" style={{ left: ((330.6 - 127) / 2 + 12.5) / 2 - (330.6 - 127) * 0.1 / 4, width: (330.6 - 127) * 0.1 / 2, top: (LIST_TOP - 108) / 2, height: LIST_H / 2 }} />
        {order.map((i, pos) => (
          <Tile key={i} i={i} y={drag?.fx === i ? drag.y : LIST_TOP + pos * TILE_PITCH} dragging={drag?.fx === i} hover={!drag && hover === pos} />
        ))}
      </div>
      <div ref={view} className="vfx-view" style={A(PX, VIEW_TOP, 1137, VIEW_TOP + VIEW_H)}>
        <div className="vfx-content" style={{ transform: `translateY(${-scroll / 2}px)`, height: contentH / 2 }}>
          {active.map((i, k) => {
            const P = PANELS[i]
            return (
              <Panel key={FX[i].key} fx={FX[i]} top={k * PANEL_PITCH}>
                <P color={FX[i].color} />
              </Panel>
            )
          })}
        </div>
        {maxScroll > 0 && (
          <i className="vfx-thumb" style={{ top: thumbY / 2, height: thumbH / 2 }}
            onPointerDown={(e) => { e.stopPropagation(); thumbRef.current = { y0: e.clientY, s0: scroll }; try { (e.currentTarget as Element).setPointerCapture(e.pointerId) } catch { /* synthetic */ } }}
            onPointerMove={(e) => { const t = thumbRef.current; if (!t) return; const dy = ((e.clientY - t.y0) / api.scale()) * 2; setScroll(t.s0 + (dy / (VIEW_H - thumbH)) * maxScroll) }}
            onPointerUp={() => { if (thumbRef.current) markDragEnd(); thumbRef.current = null }} />
        )}
      </div>
    </div>
  )
}
