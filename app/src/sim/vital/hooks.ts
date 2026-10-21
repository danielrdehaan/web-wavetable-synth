import { learnItems } from '../../engine/midi'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { markDragEnd } from '../simContext'
import { norm, PARAMS, shown, sourceName } from './params'
import { useVital, type MenuItem, type VitalApi } from './ctx'

// The Vital controls' gestures (controls.tsx draws them).

export type Rect = [number, number, number, number]
export const R = (x0: number, y0: number, x1: number, y1: number): CSSProperties => ({ left: x0 / 2, top: y0 / 2, width: (x1 - x0) / 2, height: (y1 - y0) / 2 })

/** Pointer drag in stage pixels: `onMove(dx, dy, fine)` with dy positive upward and `fine` while Cmd/Ctrl
 *  is held (Vital's slow-drag modifier). Saves an undo step when the pointer first moves. */
export function useDrag(onMove: (dx: number, dy: number, fine: boolean) => void, onEnd?: () => void) {
  const api = useVital()
  const last = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)
  const cb = useRef(onMove)
  cb.current = onMove
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault(); e.stopPropagation()
      last.current = { x: e.clientX, y: e.clientY }
      moved.current = false
      try { (e.currentTarget as Element).setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!last.current) return
      const s = api.scale()
      const dx = (e.clientX - last.current.x) / s, dy = (last.current.y - e.clientY) / s
      last.current = { x: e.clientX, y: e.clientY }
      if (!dx && !dy) return
      if (!moved.current) api.checkpoint()
      moved.current = true
      cb.current(dx, dy, e.metaKey || e.ctrlKey)
    },
    onPointerUp: () => { if (last.current && moved.current) markDragEnd(); last.current = null; onEnd?.() },
    onPointerCancel: () => { last.current = null },
  }
}

/** A wheel handler on an element (non-passive, so it can keep the page from scrolling): spread the
 *  returned ref onto the element. `onWheel(dx, dy, e)` gets the wheel deltas, positive = up / right. */
export function useWheel(onWheel: (dx: number, dy: number, e: WheelEvent) => void) {
  const cb = useRef(onWheel)
  cb.current = onWheel
  const el = useRef<Element | null>(null)
  useEffect(() => {
    const node = el.current
    if (!node) return
    const handler = (e: Event) => { const w = e as WheelEvent; w.preventDefault(); w.stopPropagation(); cb.current(-w.deltaX, -w.deltaY, w) }
    node.addEventListener('wheel', handler, { passive: false })
    return () => node.removeEventListener('wheel', handler)
  }, [])
  return (node: Element | null) => { el.current = node }
}

/** SynthSlider::mouseWheelMove on a stepped control (a TextSelector's value box): each wheel notch steps
 *  the value by one, up adds, clamped to its range. Vital ignores smooth (trackpad) scrolling; a browser
 *  can't tell the two apart, so the movement is gathered and stepped every 50 px. `pick` replaces the
 *  plain set (a choice that has to do more). */
export function useStepWheel(p: string, count: number, pick?: (i: number) => void) {
  const api = useVital()
  const acc = useRef(0)
  return useWheel((_dx, dy) => {
    acc.current += dy
    if (Math.abs(acc.current) < 50) return
    const step = Math.sign(acc.current)
    acc.current = 0
    const v = Math.round(api.get(p) ?? PARAMS[p]?.def ?? 0)
    const next = Math.max(0, Math.min(count - 1, v + step))
    if (next === v) return
    api.checkpoint()
    if (pick) pick(next); else api.set(p, next)
  })
}

/** How a control drags, as Vital's SynthSlider sets it up. */
export interface SliderOpts {
  /** 'rotary' (knobs: right or up adds), 'x' or 'y' (bars and text values, along that axis). */
  kind?: 'rotary' | 'x' | 'y'
  /** Stage px for the whole range on 'x'/'y' controls: the control's longer side (setMouseDragSensitivity). */
  length?: number
  /** SynthSlider sensitivity_ (transpose 0.2). */
  sensitivity?: number
  /** setShiftIndexAmount: Shift-drag and Shift-wheel move in these steps (12 on transpose). */
  shiftIndex?: number
  /** snapValue: within 5 % of the range the value snaps here (blend 1, keytrack 0). */
  snap?: number
  /** setDoubleClickReturnValue, when it isn't the parameter's default (morph / warp amounts). */
  defaultValue?: number
}

/** Vital's kDefaultRotaryDragLength (200 pt) in stage px (the 1000-px stage draws Vital's 1440-pt window). */
const ROTARY_LENGTH = 200 * 1000 / 1440
/** One wheel notch on a continuous control, as a fraction of its range (JUCE's proportional wheel). */
const WHEEL_STEP = 0.035

/** A control's gestures, Vital's way (synth_slider.cpp): drag with Cmd/Ctrl for fine and Shift for index
 *  steps; wheel steps; double-click resets; Alt-click types a value; right-click opens the menu. The value
 *  popup shows on press, drag, wheel and double-click and hides when the pointer leaves; never on hover. */
export function useSlider(p: string, opts: SliderOpts = {}) {
  const api = useVital()
  const { kind = 'rotary', sensitivity = 1, shiftIndex = 0, snap } = opts
  const d = PARAMS[p]
  const [popup, setPopup] = useState(false)
  const [hover, setHover] = useState(false)
  const [editing, setEditing] = useState(false)
  const drag = useRef<{ x: number; y: number; t: number; moved: boolean } | null>(null)
  const live = useRef({ api, d })
  live.current = { api, d }

  const setFromNorm = (t: number, shift: boolean) => {
    const { api: a, d: dd } = live.current
    if (!dd) return
    let v = dd.min + Math.max(0, Math.min(1, t)) * (dd.max - dd.min)
    if (shift && shiftIndex) {
      const start = a.v[p] ?? dd.def, offset = ((start - dd.min) % shiftIndex + shiftIndex) % shiftIndex
      v = dd.min + offset + Math.round((v - dd.min - offset) / shiftIndex) * shiftIndex
    }
    else if (dd.scale === 'idx') v = Math.round(v)
    if (snap !== undefined && Math.abs(v - snap) < 0.05 * (dd.max - dd.min)) v = snap
    a.set(p, v)
  }

  const wheelRef = useRef<HTMLElement | SVGElement | null>(null)
  useEffect(() => {
    const el = wheelRef.current
    if (!el) return
    const onWheel = (e: Event) => {
      const w = e as WheelEvent
      const { api: a, d: dd } = live.current
      if (!dd || !w.deltaY) return
      w.preventDefault(); w.stopPropagation()
      const dir = w.deltaY < 0 ? 1 : -1
      const value = a.v[p] ?? dd.def
      a.checkpoint()
      if (dd.scale === 'idx') a.set(p, value + dir * (w.shiftKey && shiftIndex ? shiftIndex : 1))
      else a.set(p, value + dir * WHEEL_STEP * (dd.max - dd.min))
      setPopup(true)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [p, shiftIndex])

  const span = (kind === 'rotary' ? ROTARY_LENGTH : opts.length ?? 120) / sensitivity
  const handlers = {
    ref: (el: HTMLElement | SVGElement | null) => { wheelRef.current = el },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault(); e.stopPropagation()
      if (e.altKey) { setEditing(true); return }
      drag.current = { x: e.clientX, y: e.clientY, t: norm(p, api.v[p] ?? d?.def ?? 0), moved: false }
      setPopup(true)
      try { (e.currentTarget as Element).setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const g = drag.current
      if (!g) return
      const s = api.scale()
      const dx = (e.clientX - g.x) / s, dy = (g.y - e.clientY) / s
      g.x = e.clientX; g.y = e.clientY
      const along = kind === 'rotary' ? dx + dy : kind === 'x' ? dx : dy
      if (!along) return
      if (!g.moved) { api.checkpoint(); g.moved = true }
      const fine = e.metaKey || e.ctrlKey ? 0.1 : 1
      const index = e.shiftKey && shiftIndex ? Math.max(1, shiftIndex / 2) : 1
      g.t = Math.max(0, Math.min(1, g.t + (along / span) * fine * index))
      setFromNorm(g.t, e.shiftKey)
    },
    onPointerUp: () => { if (drag.current?.moved) markDragEnd(); drag.current = null },
    onPointerCancel: () => { drag.current = null },
    onPointerEnter: () => setHover(true),
    onPointerLeave: () => { setHover(false); if (!drag.current) setPopup(false) },
    onDoubleClick: (e: React.MouseEvent) => { e.stopPropagation(); if (!d) return; api.checkpoint(); api.set(p, opts.defaultValue ?? d.def); setPopup(true) },
  }
  return { handlers, popup: popup && !api.dragSrc, hover, editing, setEditing }
}

/** The number a typed entry means: shown units, or "n%" of the range (SynthSlider text entry). */
export function valueFromText(p: string, text: string): number | null {
  const d = PARAMS[p]
  const s = text.trim()
  if (!d || !s) return null
  if (s.endsWith('%') && !d.units?.includes('%')) {
    const n = parseFloat(s)
    return Number.isNaN(n) ? null : d.min + (n / 100) * (d.max - d.min)
  }
  if (d.opts) {
    const i = d.opts.findIndex((o) => o.toLowerCase() === s.toLowerCase())
    if (i >= 0) return d.min + i
  }
  const n = parseFloat(s)
  if (Number.isNaN(n)) return null
  // Typed values are the shown values; invert the display mapping by search (it's monotonic per scale).
  let lo = d.min, hi = d.max
  const f = (x: number) => parseFloat(shown(p, x, false))
  const up = f(hi) >= f(lo)
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if ((f(m) < n) === up) lo = m; else hi = m }
  return (lo + hi) / 2
}

/** Right-click on a control: Vital's menu for it (SynthSlider::createPopupMenu): default, enter a value,
 *  MIDI learn, and a Disconnect item per modulation (plus Disconnect all when there are several).
 *  `enter` opens the control's inline text entry. */
export function useControlMenu(p: string, enter?: () => void) {
  const api = useVital()
  return (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    const conns = api.mods.map((m, i) => ({ m, i })).filter((x) => x.m.dst === p)
    // SynthSlider::createPopupMenu's order.
    const items: MenuItem[] = [
      { label: 'Set to Default Value', act: () => { api.checkpoint(); api.set(p, PARAMS[p].def) } },
      ...learnItems(p),
      { label: 'Enter Value', act: () => (enter ? enter() : enterValue(api, p)) },
      ...(conns.length ? [{ sep: true } as MenuItem, ...conns.map(({ m, i }) => ({ label: `Disconnect from ${sourceName(m.src)}`, act: () => { api.checkpoint(); api.removeMod(i) } }))] : []),
      ...(conns.length > 1 ? [{ label: 'Disconnect all modulations', act: () => { api.checkpoint(); for (let k = conns.length - 1; k >= 0; k--) api.removeMod(conns[k].i) } }] : []),
    ]
    api.openMenu({ items, w: 120 }, e)
  }
}

/** Enter Value for controls without an inline editor. */
function enterValue(api: VitalApi, p: string) {
  const s = window.prompt(PARAMS[p].name, shown(p, api.v[p], false))
  const v = s == null ? null : valueFromText(p, s)
  if (v !== null) { api.checkpoint(); api.set(p, v) }
}

/** Sum of the connections' depths into `p` (the drawn modulation range), as a fraction of its range. */
export function useModRange(p: string): { lo: number; hi: number } | null {
  const { mods } = useVital()
  const list = mods.filter((m) => m.dst === p && !m.bypass)
  if (!list.length) return null
  let lo = 0, hi = 0
  for (const m of list) {
    if (m.bipolar) { lo -= Math.abs(m.amt) / 2; hi += Math.abs(m.amt) / 2 } else if (m.amt < 0) lo += m.amt; else hi += m.amt
  }
  return { lo, hi }
}


/** performance.now(), refreshed every frame while `active` (the playheads and the scope). */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!active) return
    let id = 0
    const tick = () => { setNow(performance.now()); id = requestAnimationFrame(tick) }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [active])
  return now
}
