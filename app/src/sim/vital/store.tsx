import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { markDragEnd } from '../simContext'
import { filterInput, initValues, norm, PARAMS, toggleRoute, withInputs } from './params'

/** ModulationManager's kDefaultModulationRatio: the least depth a dropped connection starts with. */
const DEFAULT_MOD_RATIO = 0.25
import { Ctx, useVital, type Menu, type Mod, type Snap, type Ui, type VitalApi } from './ctx'

// The Vital drawing's state: every parameter's raw value, the modulation connections, undo/redo,
// the open menu, and the drag-a-modulator gesture (Vital's way of connecting: drag a source onto a
// control). The engine link (../../engine/EngineSync.tsx) plays whatever this state holds.

const INIT_UI: Ui = { page: 'voice', env: 0, lfo: 0, rand: 0, envZoom: 1 }

/** The last state, kept outside React: switching synth tabs (or a hot reload) brings it back. */
let memory: Snap | null = null

export function VitalProvider({ children }: { children: ReactNode }) {
  const [v, setVState] = useState(() => memory?.v ?? initValues())
  const [mods, setModsState] = useState<Mod[]>(() => memory?.mods ?? [])
  // The latest values and routings, updated as each change is made rather than at the next render:
  // gestures read them (api.get / api.getMods) so pointer events that outrun React build on each other.
  const liveV = useRef(v), liveMods = useRef(mods)
  const setV = useCallback((next: Record<string, number> | ((o: Record<string, number>) => Record<string, number>)) => {
    liveV.current = typeof next === 'function' ? next(liveV.current) : next
    setVState(liveV.current)
  }, [])
  const setMods = useCallback((next: Mod[] | ((m: Mod[]) => Mod[])) => {
    liveMods.current = typeof next === 'function' ? next(liveMods.current) : next
    setModsState(liveMods.current)
  }, [])
  const get = useCallback((id: string) => liveV.current[id], [])
  const getMods = useCallback(() => liveMods.current, [])
  const [ui, setUiS] = useState<Ui>(() => memory?.ui ?? INIT_UI)
  const [past, setPast] = useState<Snap[]>([])
  const [future, setFuture] = useState<Snap[]>([])
  const [dragSrc, setDragSrc] = useState<string | null>(null)
  const [focusSrc, setFocusSrc] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [notes, setNotes] = useState<Set<number>>(new Set())
  const [noteOnAt, setOnAt] = useState(0)
  const [noteOffAt, setOffAt] = useState(0)
  const [patch, setPatch] = useState<{ id: number; from: 'init' | 'engine' }>({ id: 0, from: 'init' })
  const rootRef = useRef<HTMLDivElement | null>(null)
  const cur = useRef<Snap>({ v, mods, ui })
  useEffect(() => { cur.current = { v, mods, ui }; memory = cur.current })

  const checkpoint = useCallback(() => { setPast((p) => [...p.slice(-80), cur.current]); setFuture([]) }, [])
  /** A user edit's undo step, which also marks the patch modified (HeaderSection::notifyChange: the
   *  preset name gets a "*" until the patch is loaded, initialised or saved). */
  const edit = useCallback(() => { checkpoint(); setUiS((u) => (u.modified ? u : { ...u, modified: true })) }, [checkpoint])
  const set = useCallback((id: string, val: number) => {
    const route = filterInput(id)
    if (route) {
      setV((o) => withInputs({ ...o, [route.dest]: toggleRoute(Math.round(o[route.dest] ?? 0), route.filter, val >= 0.5) }))
      return
    }
    const d = PARAMS[id]
    const x = d ? Math.max(d.min, Math.min(d.max, d.scale === 'idx' ? Math.round(val) : val)) : val
    setV((o) => {
      if (o[id] === x) return o
      const next = { ...o, [id]: x }
      // Series routing is one way at a time: FIL2 into filter 1 or FIL1 into filter 2 (filterSerialSelected).
      if (x >= 0.5 && id === 'filter_1_filter_input') next.filter_2_filter_input = 0
      if (x >= 0.5 && id === 'filter_2_filter_input') next.filter_1_filter_input = 0
      return id.endsWith('_destination') ? withInputs(next) : next
    })
  }, [])
  const restore = (s: Snap) => { setV(s.v); setMods(s.mods); setUiS(s.ui) }
  const undo = () => { const s = past[past.length - 1]; if (!s) return; setFuture((f) => [cur.current, ...f]); setPast((p) => p.slice(0, -1)); restore(s) }
  const redo = () => { const s = future[0]; if (!s) return; setPast((p) => [...p, cur.current]); setFuture((f) => f.slice(1)); restore(s) }
  const init = () => { checkpoint(); setV(initValues()); setMods([]); setUiS(INIT_UI); setPatch((p) => ({ id: p.id + 1, from: 'init' })) }
  /** A whole patch read back from the engine (a loaded preset); `uiPatch` carries its name, wavetable
   *  names and LFO shapes. */
  const replace = (values: Record<string, number>, nextMods: Mod[], uiPatch: Ui) => {
    checkpoint()
    setV(withInputs({ ...initValues(), ...values }))
    setMods(nextMods)
    setUiS((u) => ({ ...u, ...uiPatch, modified: false }))
    setPatch((p) => ({ id: p.id + 1, from: 'engine' }))
  }

  const addMod = useCallback((src: string, dst: string) => {
    setMods((m) => (m.some((x) => x.src === src && x.dst === dst) || m.length >= 64 ? m : [...m, { src, dst, amt: 0, bipolar: false, stereo: false, bypass: false, power: 0 }]))
  }, [])
  const setMod = useCallback((i: number, patch: Partial<Mod>) => setMods((m) => m.map((x, j) => (j === i ? { ...x, ...patch } : x))), [])
  const removeMod = useCallback((i: number) => setMods((m) => m.filter((_, j) => j !== i)), [])
  const setUi = useCallback((patch: Ui) => setUiS((u) => ({ ...u, ...patch })), [])

  // The root's drawn width over its own: the full interface is 1000 stage px wide, a set of parts as
  // wide as they are laid out.
  const scale = useCallback(() => { const el = rootRef.current; return el && el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1 }, [])
  const toStage = useCallback((cx: number, cy: number) => {
    const r = rootRef.current?.getBoundingClientRect()
    if (!r) return { x: cx, y: cy }
    const s = scale()
    return { x: (cx - r.left) / s, y: (cy - r.top) / s }
  }, [scale])

  // A modulation source's press, as Vital's ModulationButton and ModulationManager handle it: the press
  // makes it the current modulator (its rings show at its destinations, and it runs); the drag starts
  // once the pointer leaves the button. While the pointer is over a control the connection exists (and
  // plays), leaving takes it away, releasing keeps it. Its depth starts at max(1 − the control's
  // position, 0.25) of the range; holding any modifier key makes it bipolar, at max(2 · min(position,
  // 1 − position), 0.25); the wheel steps the depth mid-drag. A release inside the button is a click.
  const beginSourceDrag = useCallback((src: string, e: React.PointerEvent, onClick?: () => void) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    setFocusSrc(src)
    const bounds = (e.currentTarget as Element).getBoundingClientRect()
    const inside = (x: number, y: number) => x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom
    let dragging = false
    let temp: { dst: string; bipolar: boolean } | null = null
    const depth = (dst: string, bipolar: boolean) => {
      const t = norm(dst, cur.current.v[dst] ?? PARAMS[dst]?.def ?? 0)
      return Math.max(bipolar ? 2 * Math.min(t, 1 - t) : 1 - t, DEFAULT_MOD_RATIO)
    }
    const clearTemp = () => {
      if (!temp) return
      const dst = temp.dst
      setMods((m) => m.filter((x) => !(x.src === src && x.dst === dst)))
      temp = null
      rootRef.current?.removeAttribute('data-temp-drop')
    }
    const targetAt = (cx: number, cy: number) => document.elementFromPoint(cx, cy)?.closest('[data-drop]')?.getAttribute('data-drop') ?? null
    const move = (ev: PointerEvent) => {
      // The button let go where the page didn't hear it (outside the window): the drag ends there.
      if (ev.pointerType === 'mouse' && !(ev.buttons & 1)) { up(); return }
      if (!dragging && !inside(ev.clientX, ev.clientY)) { dragging = true; edit(); setDragSrc(src) }
      if (!dragging) return
      const dst = targetAt(ev.clientX, ev.clientY)
      const bipolar = ev.altKey || ev.shiftKey || ev.ctrlKey || ev.metaKey
      if (temp && temp.dst !== dst) clearTemp()
      if (!dst) return
      if (temp) {
        if (temp.bipolar !== bipolar) {
          temp.bipolar = bipolar
          const amt = depth(dst, bipolar)
          setMods((m) => m.map((x) => (x.src === src && x.dst === dst ? { ...x, amt, bipolar } : x)))
        }
        return
      }
      if (cur.current.mods.some((x) => x.src === src && x.dst === dst) || cur.current.mods.length >= 64) return
      temp = { dst, bipolar }
      rootRef.current?.setAttribute('data-temp-drop', '')
      setMods((m) => [...m, { src, dst, amt: depth(dst, bipolar), bipolar, stereo: false, bypass: false, power: 0 }])
    }
    const wheel = (ev: WheelEvent) => {
      if (!temp) return
      ev.preventDefault()
      const dst = temp.dst
      // One notch steps the depth knob 3.5 % of its −1…1 range, as a SynthSlider wheel does.
      const step = Math.sign(-ev.deltaY) * 0.035 * 2
      setMods((m) => m.map((x) => (x.src === src && x.dst === dst ? { ...x, amt: Math.max(-1, Math.min(1, x.amt + step)) } : x)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('wheel', wheel)
      if (!dragging) { onClick?.(); return }
      setDragSrc(null)
      markDragEnd()
      temp = null
      rootRef.current?.removeAttribute('data-temp-drop')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('wheel', wheel, { passive: false })
  }, [edit])

  // Pressing anything but a source, a depth ring or a menu drops the current modulator
  // (ModulationButton::focusLost / ModulationManager::mouseDown on an ordinary control).
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element
      if (!t.closest?.('[data-src], .vt-ring, .vt-menu, .vt-srccallout')) setFocusSrc(null)
      // The expanded knob box closes the same way (ModulationExpansionBox::focusLost).
      if (!t.closest?.('.vt-srccallout, .vt-srcexpand')) setUiS((u) => (u.srcExpanded ? { ...u, srcExpanded: undefined } : u))
    }
    window.addEventListener('pointerdown', down, true)
    return () => window.removeEventListener('pointerdown', down, true)
  }, [])

  const openMenu = useCallback((m: Omit<Menu, 'x' | 'y'>, e: { clientX: number; clientY: number }) => {
    const p = toStage(e.clientX, e.clientY)
    setMenu({ ...m, x: p.x, y: p.y })
  }, [toStage])
  const closeMenu = useCallback(() => setMenu(null), [])
  const setNote = useCallback((n: number, on: boolean) => {
    setNotes((s) => {
      const t = new Set(s)
      if (on) t.add(n); else t.delete(n)
      if (on && !s.size) setOnAt(performance.now())
      if (!on && s.size && !t.size) setOffAt(performance.now())
      return t
    })
  }, [])

  const api = useMemo<VitalApi>(() => ({
    v, get, set, mods, getMods, addMod, setMod, removeMod, ui, setUi, checkpoint: edit, undo, redo, canUndo: past.length > 0, canRedo: future.length > 0, init, replace, patch,
    dragSrc, beginSourceDrag, focusSrc, setFocusSrc, menu, openMenu, closeMenu, scale, toStage, notes, setNote, noteOnAt, noteOffAt, rootRef,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [v, mods, ui, past, future, dragSrc, focusSrc, menu, notes, noteOnAt, noteOffAt, patch])
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

/** The open menu, drawn at stage coordinates inside the root; any click elsewhere closes it. */
export function MenuLayer() {
  const { menu, closeMenu, rootRef } = useVital()
  useEffect(() => {
    if (!menu) return
    const off = (e: PointerEvent) => { if (!(e.target as Element).closest?.('.vt-menu')) closeMenu() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu() } }
    window.addEventListener('pointerdown', off, true)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('pointerdown', off, true); window.removeEventListener('keydown', key, true) }
  }, [menu, closeMenu])
  if (!menu) return null
  const cols = menu.cols ?? [menu.items]
  const w = menu.w ?? 120
  const h = Math.max(...cols.map((c) => c.reduce((a, it) => a + (it.sep ? 9 : 21), 8)))
  const W = rootRef.current?.offsetWidth || 1000, H = rootRef.current?.offsetHeight || 606
  const x = Math.min(menu.x, W - w * cols.length - 4), y = Math.min(menu.y, H - h - 4)
  return (
    <div className="vt-menu" style={{ left: Math.max(2, x), top: Math.max(2, y) }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      {cols.map((c, ci) => (
        <div key={ci} className="vt-menucol" style={{ width: w }}>
          {c.map((it, i) => it.sep ? <i key={i} className="vt-menusep" /> : (
            <button key={i} type="button" className={`vt-menuitem${it.on ? ' on' : ''}${it.dim ? ' dim' : ''}`}
              onClick={() => { it.act?.(); if (!menu.dual) closeMenu() }}
              onDoubleClick={() => { if (menu.dual && it.on) closeMenu() }}>{it.label}</button>
          ))}
        </div>
      ))}
    </div>
  )
}
