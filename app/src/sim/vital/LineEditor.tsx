import { useEffect, useRef, useState, type RefObject } from 'react'
import { onStatusPacket } from '../../engine/status'
import { markDragEnd } from '../simContext'
import { Box } from './controls'
import { useVital } from './ctx'
import { useDrag, useWheel } from './hooks'
import { powerCurve } from './draw'
import { boostLane, boostRange, decayBoosts, fillGradient } from './lineBoost'
import { requestSave } from './SaveOverlay'
import { lineToEngine } from '../../engine/shapes'
import { useSkinColors, useSkinValues } from './skin'
import { type Line, MAX_POINTS, MAX_POWER, copyLine, flipHorizontal, flipVertical, LINEAR, PAINT_SHAPES, renderLine, smoothTransition, valueAt } from './line'
import { capturePointer } from '../pointer'

// Vital's line editor (line_editor.cpp), with the LFO's playhead and trail (lfo_editor.cpp) and the
// remap's live input (line_map_editor.cpp). Drawn on a canvas so the trail can widen and brighten the
// line point by point as Vital's OpenGlLineRenderer boost does.
//
// The editor works in the model's own coordinates (y 0 at the top), as Vital's does: points under the
// pointer are found within 12 pt, dragged ones snap to the grid unless Alt is held, a segment's power
// handle drags up and down (Shift: every segment, Alt: alternate segments), double-click adds or removes
// a point or resets a power (Shift: all), painting stamps the pattern into the grid cell under the
// pointer (Cmd held flips paint mode for the moment), the wheel steps the grid or the pattern, and the
// right-click menu has Vital's entries.

const PT = 1440 / 2000 // Vital points per drawing unit
const POSITION_WIDTH = 9, POWER_WIDTH = 7, RING_THICKNESS = 0.45, GRAB_RADIUS = 12, DRAG_RADIUS = 20
const PADDING_Y = 6, POWER_MOUSE_MULT = 9, MIN_POINT_DISTANCE_FOR_POWER = 3
const RESOLUTION = 64, WRAP = 8, DRAW_POINTS = RESOLUTION + MAX_POINTS, TOTAL_POINTS = DRAW_POINTS + 2 * WRAP
const PHASE_ENCODING = 0.9 // vital::utils::kPhaseEncodingMultiplier
const BOOST_DECAY = 0.9, SPEED_DECAY_MULT = 5, BACKUP_TIME = 1 / 50 // LfoEditor
const TAIL_DECAY = 0.93 // LineMapEditor
const FRAMES_PER_PACKET = 2 // Vital redraws at 60 fps; the status arrives ~31 times a second

/** The colours one editor draws with (its section's skin). */
export interface LineSkin {
  primary1: string; primary2: string; secondary1: string; secondary2: string; center: string
  accent1: string; accent2: string; background: string; lighten: string
  primaryDisabled: string; secondaryDisabled: string
  lineWidth: number; lineBoost: number; fillBoost: number; fillFade: number
}

const LINE_COLORS = ['Widget Primary 1', 'Widget Primary 2', 'Widget Secondary 1', 'Widget Secondary 2', 'Widget Center Line', 'Widget Accent 1',
  'Widget Accent 2', 'Widget Background', 'Lighten Screen', 'Widget Primary Disabled', 'Widget Secondary Disabled'] as const
const LINE_VALUES = ['Widget Line Width', 'Widget Line Boost', 'Widget Fill Boost', 'Widget Fill Fade'] as const

/** The line skin as `ref`'s element sees it (the Lfo, Envelope, Modulation Matrix … section around it). */
export function useLineSkin(ref: RefObject<Element | null>): LineSkin {
  const c = useSkinColors(ref, LINE_COLORS)
  const v = useSkinValues(ref, LINE_VALUES)
  return {
    primary1: c['Widget Primary 1'], primary2: c['Widget Primary 2'], secondary1: c['Widget Secondary 1'], secondary2: c['Widget Secondary 2'],
    center: c['Widget Center Line'], accent1: c['Widget Accent 1'], accent2: c['Widget Accent 2'], background: c['Widget Background'],
    lighten: c['Lighten Screen'], primaryDisabled: c['Widget Primary Disabled'], secondaryDisabled: c['Widget Secondary Disabled'],
    lineWidth: v['Widget Line Width'], lineBoost: v['Widget Line Boost'], fillBoost: v['Widget Fill Boost'], fillFade: v['Widget Fill Fade'],
  }
}

/** The live input the editor animates: an LFO's encoded phase, or a remap's raw source value. */
export type LineInput =
  | { kind: 'lfo'; read: () => { phase: number[] | null; frequency: number[] | null }; enabled: boolean }
  | { kind: 'map'; read: () => number[] | null }

export interface LineEditorProps {
  at: [number, number, number, number]
  line: Line
  /** Every change, as it happens (the first of a gesture saves an undo step). */
  onChange: (l: Line) => void
  loop: boolean
  active?: boolean
  gridX: number
  gridY: number
  /** The paint button's state; the editor paints when it differs from the temporary Cmd toggle. */
  paint: boolean
  pattern: number
  /** LineEditor::Listener::togglePaintMode: the button shows `enabled !== temporary`. */
  onPaintShown?: (shown: boolean) => void
  /** lineEditorScrolled: the section steps the pattern (painting) or grid X by ±1. */
  onScroll?: (dir: number) => void
  input?: LineInput
  /** LFO only: "Set Start Point" sets the LFO's phase. */
  onSetPhase?: (phase: number) => void
  /** LFO only: Import / Export LFO. */
  onImport?: () => void
  onExport?: () => void
  skin?: LineSkin
  className?: string
  /** Where the fill meets, as a fraction of the height from the top (setFillCenter); the bottom when unset. */
  fillCenter?: number
}

type V = [number, number][]
const toModel = (l: Line): V => l.pts.map(([x, y]) => [x, 1 - y])
const fromModel = (l: Line, pts: V, pw: number[]): Line => ({ ...l, pts: pts.map(([x, y]) => [x, 1 - y]), pw: pts.map((_, i) => pw[i] ?? 0) })

/** The in-app clipboard for Copy / Paste (Vital uses the system one; reading it needs a permission). */
let clipboard: Line | null = null

/** A skin colour (#rrggbb or rgb()/rgba(), as the skin writes them) as [r, g, b, a]. */
export function rgba(c: string): [number, number, number, number] {
  const s = c.trim()
  if (s.startsWith('#')) {
    const h = s.length === 4 ? [...s.slice(1)].map((x) => x + x).join('') : s.slice(1)
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1]
  }
  const m = s.match(/-?[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]
  return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0, m[3] ?? 1]
}
const css = ([r, g, b, a]: number[]) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a.toFixed(3)})`
/** Mixes colour `a` toward `b` by t (Colour::interpolatedWith). */
export function mix(a: string, b: string, t: number): string {
  const x = rgba(a), y = rgba(b)
  return css(x.map((v, i) => v + (y[i] - v) * t))
}
/** A colour with its alpha multiplied (Colour::withMultipliedAlpha). */
export const withAlpha = (c: string, mult: number) => { const [r, g, b, a] = rgba(c); return css([r, g, b, a * mult]) }
/** `fg` drawn over `bg` (Colour::overlaidWith). */
export function over(bg: string, fg: string): string {
  const [br, bgg, bb, ba] = rgba(bg), [fr, fgg, fb, fa] = rgba(fg)
  const a = fa + ba * (1 - fa)
  if (a <= 0) return css([0, 0, 0, 0])
  const ch = (f: number, b: number) => (f * fa + b * ba * (1 - fa)) / a
  return css([ch(fr, br), ch(fgg, bgg), ch(fb, bb), a])
}

export function LineEditor(props: LineEditorProps) {
  const api = useVital()
  const { at } = props
  const active = props.active ?? true
  const canvas = useRef<HTMLCanvasElement>(null)
  // The section's line skin (or the caller's), read from the editor's own element.
  const sectionSkin = useLineSkin(canvas)
  const [entry, setEntry] = useState<{ index: number; phase: boolean; x: number; y: number; text: string } | null>(null)
  // Everything the pointer handlers and the draw loop share, kept out of React so a drag doesn't
  // re-render the section 60 times a second.
  const st = useRef({
    props, activePoint: -1, activePower: -1, activeGrid: -1, dragging: false, last: { x: 0, y: 0 }, temporary: false,
    lanes: [boostLane(TOTAL_POINTS), boostLane(TOTAL_POINTS)], lastPhase: [0, 0], lastVoice: [-1, -1],
    positions: null as number[] | null, showPositions: false, dirty: true, began: false, skin: sectionSkin,
  })
  st.current.props = props
  st.current.skin = props.skin ?? sectionSkin
  st.current.dirty = true

  const size = () => {
    const c = canvas.current!
    const W = c.clientWidth, H = c.clientHeight
    return { W, H, k: W / ((at[2] - at[0]) * PT) }
  }
  const painting = () => st.current.props.paint !== st.current.temporary

  // ── Model access (y down) ───────────────────────────────────────────────────────────────────────
  const model = () => {
    const l = st.current.props.line
    return { l, pts: toModel(l), pw: l.pts.map((_, i) => l.pw[i] ?? 0) }
  }
  const commit = (l: Line, pts: V, pw: number[]) => {
    if (!st.current.began) { api.checkpoint(); st.current.began = true }
    const next = fromModel(l, pts, pw)
    // Pointer events can outrun React's re-render: later ones in this gesture build on this change.
    st.current.props = { ...st.current.props, line: next }
    st.current.dirty = true
    st.current.props.onChange(next)
  }
  const finish = () => { if (st.current.began) markDragEnd(); st.current.began = false }
  const valueAtModel = (pts: V, pw: number[], smooth: boolean, x: number) => 1 - valueAt({ name: '', pts: pts.map(([a, b]) => [a, 1 - b]), pw, smooth }, x)

  // ── Geometry (line_editor.cpp) ──────────────────────────────────────────────────────────────────
  const padY = (y: number, H: number, k: number) => { const pad = k * PADDING_Y; return y * (H - 2 * pad) / H + pad }
  const unpadY = (y: number, H: number, k: number) => { const pad = k * PADDING_Y; return (y - pad) * H / (H - 2 * pad) }
  const powerPosition = (pts: V, pw: number[], i: number): [number, number] => {
    const from = pts[i]
    const to: [number, number] = i < pts.length - 1 ? pts[i + 1] : [pts[0][0] + 1, pts[0][1]]
    let x = (from[0] + to[0]) / 2
    if (x >= 1) x -= 1
    return [x, from[1] + (to[1] - from[1]) * powerCurve(0.5, pw[i] ?? 0)]
  }
  const powerActive = (pts: V, i: number, widthPt: number) => {
    const n = pts.length
    const d = i < n - 1 ? [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]] : [pts[0][0] - pts[n - 1][0] + 1, pts[0][1] - pts[n - 1][1]]
    return widthPt * d[0] >= MIN_POINT_DISTANCE_FOR_POWER && d[1] !== 0
  }
  const hoverPoint = (x: number, y: number) => {
    const { W, H, k } = size()
    const { pts } = model()
    const py = unpadY(y, H, k)
    let best = (GRAB_RADIUS * k) ** 2, hit = -1
    pts.forEach(([px, ppy], i) => { const d = (px * W - x) ** 2 + (ppy * H - py) ** 2; if (d < best) { best = d; hit = i } })
    return hit
  }
  const hoverPower = (x: number, y: number) => {
    const { W, H, k } = size()
    const { pts, pw } = model()
    const py = unpadY(y, H, k)
    let best = (GRAB_RADIUS * k) ** 2, hit = -1
    for (let i = 0; i < pts.length; i++) {
      if (!powerActive(pts, i, W / k)) continue
      const [px, ppy] = powerPosition(pts, pw, i)
      const d = (px * W - x) ** 2 + (ppy * H - py) ** 2
      if (d < best) { best = d; hit = i }
    }
    return hit
  }
  const minX = (pts: V, i: number) => (i === 0 ? 0 : i === pts.length - 1 ? 1 : pts[i - 1][0])
  const maxX = (pts: V, i: number) => (i === 0 ? 0 : i === pts.length - 1 ? 1 : pts[i + 1][0])
  const snapRadiusX = () => (st.current.props.gridX <= 1 ? 0 : 0.02)
  const snapRadiusY = () => (st.current.props.gridY <= 1 ? 0 : 0.04)

  // ── Edits ───────────────────────────────────────────────────────────────────────────────────────
  const addPointAt = (pts: V, pw: number[], p: [number, number]) => {
    if (pts.length >= MAX_POINTS) return
    let index = 0
    for (; index < pts.length; index++) if (pts[index][0] > p[0]) break
    pts.splice(index, 0, p)
    pw.splice(index, 0, 0)
  }
  const movePoint = (index: number, x: number, y: number, snap: boolean) => {
    const { W, H } = size()
    const { l, pts, pw } = model()
    const lo = minX(pts, index), hi = maxX(pts, index), last = pts.length - 1
    let lx = Math.max(lo, Math.min(hi, x / W)), ly = Math.max(0, Math.min(1, y / H))
    const { gridX: gx, gridY: gy } = st.current.props
    if (snap && gx > 0) { const s = Math.max(lo, Math.min(hi, Math.round(lx * gx) / gx)); if (Math.abs(s - lx) < snapRadiusX()) lx = s }
    if (snap && gy > 0) { const s = Math.round(ly * gy) / gy; if (Math.abs(s - ly) < snapRadiusY()) ly = s }
    if (st.current.props.loop && pts[0][1] === pts[last][1]) {
      if (index === 0) pts[last] = [1, ly]
      else if (index === last) pts[0] = [0, ly]
    }
    pts[index] = [lx, ly]
    commit(l, pts, pw)
  }
  const movePower = (index: number, y: number, all: boolean, alternate: boolean) => {
    const { H } = size()
    const { l, pts, pw } = model()
    const n = pts.length
    const delta = (y - st.current.last.y) / H
    const start = all ? 0 : index, end = all ? n - 2 : index
    const altMult = !alternate && pts[index][1] < pts[(index + 1) % n][1] ? -1 : 1
    for (let i = start; i <= end; i++) {
      const fromY = pts[i][1], toY = pts[(i + 1) % n][1]
      if (fromY === toY) continue
      let amount = delta * altMult
      if (fromY < toY && alternate) amount *= -1
      pw[i] = Math.max(-MAX_POWER, Math.min(MAX_POWER, pw[i] + amount * POWER_MOUSE_MULT))
    }
    commit(l, pts, pw)
  }
  const paintLine = (x: number, y: number, alt: boolean) => {
    const { W, H } = size()
    const { l, pts: start, pw: startPw } = model()
    const { gridX: gx, gridY: gy } = st.current.props
    const pts: V = [...start], pw = [...startPw]
    const section = Math.max(0, Math.min(gx - 1, Math.floor(gx * (x / W))))
    st.current.activeGrid = section
    const fromX = section / gx, toX = (section + 1) / gx
    let percentY = Math.max(0, Math.min(1, y / H))
    if (!alt && gy > 0) { const s = Math.round(percentY * gy) / gy; if (Math.abs(s - percentY) < snapRadiusY()) percentY = s }

    let fromIndex = -1, startNum = pts.length, toIndex = startNum
    for (let i = 0; i < startNum; i++) {
      if (pts[i][0] < fromX) fromIndex = i
      const rev = startNum - i - 1
      if (pts[rev][0] > toX) toIndex = rev
    }
    const fromValue = valueAtModel(pts, pw, l.smooth, fromX), toValue = valueAtModel(pts, pw, l.smooth, toX)
    const added: [number, number][] = []
    if (pts[fromIndex + 1][0] !== fromX) { added.push([fromX, fromValue]); toIndex++; startNum++ }
    fromIndex++
    if (pts[toIndex - 1][0] !== toX) { added.push([toX, toValue]); startNum++ }
    else toIndex--
    const shape = PAINT_SHAPES[st.current.props.pattern] ?? PAINT_SHAPES[0]
    const deltaSize = shape.length - Math.max(0, toIndex - fromIndex - 1)
    const num = startNum + deltaSize
    if (num >= MAX_POINTS) return
    for (const p of added) addPointAt(pts, pw, p)
    // setNumPoints: the storage keeps its old entries past the count while they're shifted.
    if (deltaSize > 0) {
      for (let i = num - 1; i >= Math.max(deltaSize, toIndex); i--) { pts[i] = pts[i - deltaSize]; pw[i] = pw[i - deltaSize] }
    } else if (deltaSize < 0) {
      for (let i = fromIndex + 1; i < num; i++) { pts[i] = pts[i - deltaSize]; pw[i] = pw[i - deltaSize] }
    }
    pts.length = num; pw.length = num
    shape.forEach(([t, level], i) => {
      const index = fromIndex + 1 + i
      pts[index] = [fromX * (1 - t) + toX * t, 1 - level * (1 - percentY)]
      pw[index] = 0
    })
    commit(l, pts, pw)
  }

  const setTemporary = (on: boolean) => {
    if (st.current.temporary === on) return
    st.current.temporary = on
    st.current.props.onPaintShown?.(st.current.props.paint !== on)
  }

  // ── Pointer ─────────────────────────────────────────────────────────────────────────────────────
  const local = (e: { clientX: number; clientY: number }) => {
    // The stage is CSS-scaled to fit: client pixels → the canvas's own layout pixels.
    const c = canvas.current!, r = c.getBoundingClientRect()
    return { x: (e.clientX - r.left) * (c.clientWidth / r.width), y: (e.clientY - r.top) * (c.clientHeight / r.height) }
  }
  const command = (e: { metaKey: boolean; ctrlKey: boolean }) => (navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey)

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !active) return
    e.stopPropagation(); e.preventDefault()
    setTemporary(command(e))
    const { x, y } = local(e)
    capturePointer(e, canvas.current!)
    st.current.last = { x, y }
    if (painting()) { paintLine(x, y, e.altKey); st.current.dragging = true; return }
    const p = hoverPoint(x, y)
    if (p >= 0) { st.current.activePoint = p; st.current.activePower = -1; st.current.dragging = true; return }
    const w = hoverPower(x, y)
    if (w >= 0) { st.current.activePower = w; st.current.activePoint = -1; st.current.dragging = true }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = local(e)
    const s = st.current
    if (s.dragging) {
      if (painting()) paintLine(x, y, e.altKey)
      else if (s.activePoint >= 0) movePoint(s.activePoint, x, y, !e.altKey)
      else if (s.activePower >= 0) movePower(s.activePower, y, e.shiftKey, e.altKey)
      s.last = { x, y }
      return
    }
    setTemporary(command(e))
    if (painting()) {
      const { W } = size()
      s.activeGrid = Math.max(0, Math.min(s.props.gridX - 1, Math.floor(s.props.gridX * (x / W))))
    } else {
      const p = hoverPoint(x, y)
      s.activePoint = p
      s.activePower = p < 0 ? hoverPower(x, y) : -1
    }
    s.dirty = true
  }
  const onPointerUp = (e: React.PointerEvent) => {
    st.current.dragging = false
    finish()
    setTemporary(command(e))
  }
  const onPointerLeave = () => {
    if (st.current.dragging) return
    setTemporary(false)
    Object.assign(st.current, { activePoint: -1, activePower: -1, activeGrid: -1, dirty: true })
  }
  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!active || painting()) return
    const { x, y } = local(e)
    const { W, H } = size()
    const { l, pts, pw } = model()
    const p = hoverPoint(x, y), w = hoverPower(x, y)
    if (p >= 0) {
      if (p === 0 || p === pts.length - 1 || pts.length <= 1) return
      pts.splice(p, 1); pw.splice(p, 1)
    } else if (w >= 0) {
      if (e.shiftKey) for (let i = 0; i < pts.length - 1; i++) pw[i] = 0
      else pw[w] = 0
    } else {
      if (pts.length >= MAX_POINTS) return
      addPointAt(pts, pw, [x / W, y / H])
    }
    commit(l, pts, pw); finish()
    st.current.activePoint = hoverPoint(x, y)
    st.current.activePower = -1
  }

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    if (!active) return
    const { x, y } = local(e)
    const s = st.current
    const point = hoverPoint(x, y), power = point < 0 ? hoverPower(x, y) : -1
    const { l, pts, pw } = model()
    const n = pts.length
    const edit = (fn: () => void) => () => { fn(); finish() }
    const entryAt = (index: number, phase: boolean) => {
      const { W, H, k } = size()
      const ew = 50 * k, eh = 30 * k
      setEntry({ index, phase, x: Math.min(pts[index][0] * W, W - ew), y: Math.min(pts[index][1] * H, H - eh), text: String(phase ? pts[index][0] : 1 - pts[index][1]) })
    }
    const items: { label?: string; act?: () => void; sep?: boolean }[] = []
    const lfo = props.input?.kind === 'lfo'
    if (point >= 0) {
      if (lfo) items.push({ label: 'Set Start Point', act: () => props.onSetPhase?.(pts[point][0]) })
      if (point > 0 && point < n - 1) {
        items.push({ label: 'Remove Point', act: edit(() => { pts.splice(point, 1); pw.splice(point, 1); commit(l, pts, pw) }) })
        items.push({ label: 'Enter Point Phase', act: () => entryAt(point, true) })
      }
      items.push({ label: 'Enter Point Value', act: () => entryAt(point, false) })
      items.push({ sep: true })
    }
    if (power >= 0) {
      if (lfo) items.push({ label: 'Set Start Point', act: () => props.onSetPhase?.((pts[power][0] + pts[Math.min(n - 1, power + 1)][0]) / 2) })
      items.push({ label: 'Reset Power', act: edit(() => { if (power < n - 1) { pw[power] = 0; commit(l, pts, pw) } }) })
      if (lfo) items.push({ sep: true })
    } else if (lfo && point < 0 && s.activeGrid >= 0 && painting()) {
      const section = s.activeGrid
      items.push({ label: 'Set Start Point', act: () => props.onSetPhase?.(section / s.props.gridX) })
    }
    items.push({ label: 'Copy', act: () => { clipboard = copyLine(l); void navigator.clipboard?.writeText(JSON.stringify(l)).catch(() => {}) } })
    if (clipboard) { const c = clipboard; items.push({ label: 'Paste', act: edit(() => { const p = copyLine(c); commit(p, toModel(p), p.pw) }) }) }
    // FullInterface::saveLfo: the save box, into User's LFOs.
    items.push({ label: 'Save to LFOs', act: () => requestSave(api, { kind: 'lfo', ext: 'vitallfo', name: l.name, data: { ...lineToEngine(l) } }) })
    if (!lfo) items.push({ label: 'Initialize', act: edit(() => { const p = copyLine(LINEAR); commit(p, toModel(p), p.pw) }) })
    items.push({ label: 'Flip Horizontal', act: edit(() => { const p = flipHorizontal(l); commit(p, toModel(p), p.pw) }) })
    items.push({ label: 'Flip Vertical', act: edit(() => { const p = flipVertical(l); commit(p, toModel(p), p.pw) }) })
    if (lfo && props.onImport) items.push({ label: 'Import LFO', act: props.onImport })
    if (lfo && props.onExport) items.push({ label: 'Export LFO', act: props.onExport })
    api.openMenu({ w: 120, items }, e)
  }
  const commitEntry = (text: string) => {
    const en = entry
    setEntry(null)
    if (!en || text.trim() === '' || !Number.isFinite(parseFloat(text))) return
    const value = parseFloat(text)
    const { l, pts, pw } = model()
    const i = en.index, last = pts.length - 1
    if (i < 0 || i > last) return
    if (en.phase) pts[i] = [Math.max(minX(pts, i), Math.min(maxX(pts, i), value)), pts[i][1]]
    else {
      const startY = pts[i][1], y = 1 - Math.max(0, Math.min(1, value))
      pts[i] = [pts[i][0], y]
      if (i === 0 && pts[last][1] === startY) pts[last] = [1, y]
      else if (i === last && pts[0][1] === startY) pts[0] = [0, y]
    }
    commit(l, pts, pw); finish()
  }

  // Wheel: the section steps the pattern or the grid (a non-passive listener so the page doesn't scroll).
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const wheel = (e: WheelEvent) => {
      if (!e.deltaY) return
      e.preventDefault(); e.stopPropagation()
      st.current.props.onScroll?.(e.deltaY < 0 ? 1 : -1)
    }
    c.addEventListener('wheel', wheel, { passive: false })
    return () => c.removeEventListener('wheel', wheel)
  }, [])

  // ── The live input: trail boosts and playheads, updated per status packet ─────────────────────
  useEffect(() => {
    const boost = (lane: number, start: number, end: number, min: number) => boostRange(st.current.lanes[lane], start, end, WRAP, min)
    const decay = (lane: number, mult: number) => decayBoosts(st.current.lanes[lane], mult)
    const adjust = (phase: number) => {
      const pts = st.current.props.line.pts
      let left = 0
      for (; left < pts.length; left++) if (pts[left][0] >= phase) break
      return (phase * DRAW_POINTS + left) / (DRAW_POINTS + pts.length)
    }
    return onStatusPacket(() => {
      const s = st.current
      const input = s.props.input
      if (!input) return
      s.dirty = true
      if (input.kind === 'lfo') {
        const { phase: encoded, frequency } = input.read()
        const phases: number[] = [], switched: boolean[] = []
        for (let lane = 0; lane < 2; lane++) {
          const raw = encoded?.[lane]
          const inactive = raw === undefined || !Number.isFinite(raw)
          const enc = inactive ? 0 : raw
          const frac = enc - Math.floor(enc)
          const phase = frac / PHASE_ENCODING, voice = enc - frac
          const f = frequency?.[lane]
          const freq = f !== undefined && Number.isFinite(f) ? f : 0
          let d = 1 - Math.abs(phase - s.lastPhase[lane]) * SPEED_DECAY_MULT
          d = inactive ? BOOST_DECAY : Math.max(BOOST_DECAY, Math.min(1, d))
          decay(lane, d ** FRAMES_PER_PACKET)
          const sw = voice !== s.lastVoice[lane] || inactive
          if (sw) s.lastPhase[lane] = Math.max(0, phase - freq * BACKUP_TIME)
          if (input.enabled) boost(lane, adjust(s.lastPhase[lane]), adjust(phase), d)
          else decay(lane, 0)
          s.lastPhase[lane] = phase
          s.lastVoice[lane] = voice
          phases.push(phase); switched.push(sw)
        }
        s.positions = phases
        s.showPositions = input.enabled && !switched.some(Boolean)
      } else {
        const values = input.read()
        for (let lane = 0; lane < 2; lane++) {
          decay(lane, TAIL_DECAY ** FRAMES_PER_PACKET)
          const v = values?.[lane]
          if (v === undefined || !Number.isFinite(v)) continue
          const adjusted = adjust(v)
          boost(lane, s.lastPhase[lane], adjusted, TAIL_DECAY)
          s.lastPhase[lane] = adjusted
        }
        const ok = values && Number.isFinite(values[0])
        s.positions = ok ? [values[0], Number.isFinite(values[1]) ? values[1] : values[0]] : null
        s.showPositions = !!ok
      }
    })
  }, [])

  // ── Drawing ─────────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const s = st.current
      const c = canvas.current
      if (!c || !s.dirty) return
      s.dirty = false
      const { W, H, k } = size()
      // Backing pixels at the displayed size (the stage's CSS scale times the device ratio).
      const dpr = (window.devicePixelRatio || 1) * (c.getBoundingClientRect().width / W || 1)
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr) }
      const g = c.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      const p = s.props
      const on = p.active ?? true
      const sk = s.skin
      const l = p.line
      const pts = toModel(l), pw = l.pts.map((_, i) => l.pw[i] ?? 0), n = pts.length
      const isPainting = p.paint !== s.temporary

      // Grid (setGridPositions): Lighten Screen lines, the painted cell filled.
      g.fillStyle = sk.lighten
      for (let i = 1; i < p.gridX; i++) g.fillRect(Math.round((i / p.gridX) * W) - 0.5 * k, 0, Math.max(1, k), H)
      for (let i = 1; i < p.gridY; i++) g.fillRect(0, padY((i / p.gridY) * H, H, k) - 0.5 * k, W, Math.max(1, k))
      if (isPainting && s.activeGrid >= 0 && p.gridX) {
        const x0 = Math.floor((s.activeGrid * W) / p.gridX) + 1, x1 = Math.floor(((s.activeGrid + 1) * W) / p.gridX)
        g.fillRect(x0, 0, x1 - x0, H)
      }

      // The wave path (resetWavePath): RESOLUTION samples plus every point, then the wrap copies.
      const xs = new Float32Array(TOTAL_POINTS), ys = new Float32Array(TOTAL_POINTS)
      const intermediate = DRAW_POINTS - n
      let prev: [number, number] = [pts[n - 1][0] - 1, pts[n - 1][1]]
      let power = pw[n - 1] ?? 0
      let di = 0, pi = 0
      for (let i = 0; i < intermediate; i++) {
        const t = i / (intermediate - 1)
        while (pi < n && t >= pts[pi][0]) {
          prev = pts[pi]; power = pw[pi]
          xs[WRAP + di] = W * pts[pi][0]; ys[WRAP + di] = padY(H * pts[pi][1], H, k)
          pi++; di++
        }
        const next: [number, number] = pi < n ? pts[pi] : [pts[0][0] + 1, pts[0][1]]
        const dx = next[0] - prev[0]
        let pt = dx > 0 ? (t - prev[0]) / dx : 0
        if (l.smooth) pt = smoothTransition(pt)
        pt = powerCurve(pt, power)
        xs[WRAP + di] = W * t; ys[WRAP + di] = padY(H * (prev[1] + (next[1] - prev[1]) * pt), H, k)
        di++
      }
      for (; di < DRAW_POINTS; di++) { xs[WRAP + di] = W; ys[WRAP + di] = padY(H * pts[n - 1][1], H, k) }
      for (let i = 0; i < WRAP; i++) {
        if (p.loop) {
          xs[i] = xs[DRAW_POINTS + i] - W; ys[i] = ys[DRAW_POINTS + i]
          xs[i + DRAW_POINTS + WRAP] = xs[WRAP + i] + W; ys[i + DRAW_POINTS + WRAP] = ys[WRAP + i]
          for (const { boosts: b } of s.lanes) { b[i] = b[DRAW_POINTS + i]; b[i + DRAW_POINTS + WRAP] = b[WRAP + i] }
        } else {
          xs[i] = xs[WRAP]; ys[i] = ys[WRAP]
          xs[i + DRAW_POINTS + WRAP] = xs[WRAP + DRAW_POINTS - 1]; ys[i + DRAW_POINTS + WRAP] = ys[WRAP + DRAW_POINTS - 1]
        }
      }

      const animating = !!p.input && (p.input.kind === 'map' || p.input.enabled)
      const lineW = sk.lineWidth * k
      const drawLane = (lane: number, line: string, fill: string, boosted: boolean) => {
        const b = s.lanes[lane].boosts
        const base = p.fillCenter === undefined ? H : padY(H * p.fillCenter, H, k)
        const plain = fillGradient(g, fill, sk.fillFade, 0, H)
        for (let i = 0; i < TOTAL_POINTS - 1; i++) {
          const fb = boosted ? (sk.fillBoost * (b[i] + b[i + 1])) / 2 : 0
          g.fillStyle = fb > 0.001 ? fillGradient(g, fill, sk.fillFade, 0, H, fb) : plain
          g.beginPath(); g.moveTo(xs[i], ys[i]); g.lineTo(xs[i + 1], ys[i + 1]); g.lineTo(xs[i + 1], base); g.lineTo(xs[i], base); g.closePath(); g.fill()
        }
        g.strokeStyle = line; g.lineCap = 'round'; g.lineJoin = 'round'
        if (boosted) {
          for (let i = 0; i < TOTAL_POINTS - 1; i++) {
            const boost = Math.max(b[i], b[i + 1])
            g.lineWidth = lineW * (1 + sk.lineBoost * boost)
            g.beginPath(); g.moveTo(xs[i], ys[i]); g.lineTo(xs[i + 1], ys[i + 1]); g.stroke()
          }
        } else {
          g.lineWidth = lineW
          g.beginPath(); g.moveTo(xs[0], ys[0]); for (let i = 1; i < TOTAL_POINTS; i++) g.lineTo(xs[i], ys[i]); g.stroke()
        }
      }
      const fill1 = on ? sk.secondary1 : sk.secondaryDisabled, fill2 = on ? sk.secondary2 : sk.secondaryDisabled
      const pos1 = on ? sk.primary1 : sk.primaryDisabled, pos2 = on ? sk.primary2 : sk.primaryDisabled
      const center = on ? sk.center : sk.primaryDisabled
      drawLane(1, pos2, fill2, animating)
      drawLane(0, pos1, fill1, animating)
      g.strokeStyle = center; g.lineWidth = lineW
      g.beginPath(); g.moveTo(xs[0], ys[0]); for (let i = 1; i < TOTAL_POINTS; i++) g.lineTo(xs[i], ys[i]); g.stroke()

      // The playheads (drawPosition): rings at the input's phase on the curve, the right lane first.
      const ring = (x: number, y: number, diameter: number, thickness: number, color: string, inner: string | null) => {
        const r = diameter / 2
        if (inner) { g.fillStyle = inner; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill() }
        g.strokeStyle = color; g.lineWidth = thickness
        g.beginPath(); g.arc(x, y, Math.max(0, r - thickness / 2), 0, Math.PI * 2); g.stroke()
      }
      if (animating && s.showPositions && s.positions) {
        const rendered = renderLine(l, p.loop)
        const at = (ph: number) => { const t = Math.max(0, Math.min(1, ph)) * (rendered.length - 1); const i = Math.floor(t); return rendered[i] + ((rendered[Math.min(i + 1, rendered.length - 1)] - rendered[i]) * (t - i)) }
        for (const [lane, color] of [[1, pos2], [0, pos1]] as [number, string][]) {
          const ph = s.positions[lane]
          if (!ph) continue
          ring(ph * W, padY(H * (1 - at(ph)), H, k), POSITION_WIDTH * k, POSITION_WIDTH * RING_THICKNESS * k, color, mix(color, sk.background, 0.2))
        }
      }

      // Points (setPointPositions / renderPoints): rings with the background inside, filled power dots.
      for (let i = 0; i < n; i++) {
        ring(W * pts[i][0], padY(H * pts[i][1], H, k), POSITION_WIDTH * k, POSITION_WIDTH * RING_THICKNESS * k, center, sk.background)
        if (powerActive(pts, i, W / k)) {
          const [px, py] = powerPosition(pts, pw, i)
          g.fillStyle = center; g.beginPath(); g.arc(W * px, padY(H * py, H, k), (POWER_WIDTH * k) / 2, 0, Math.PI * 2); g.fill()
        }
      }
      // The hover ring and the drag disc (setEditingCircleBounds).
      const edit = s.activePoint >= 0 && s.activePoint < n ? pts[s.activePoint] : s.activePower >= 0 && s.activePower < n ? powerPosition(pts, pw, s.activePower) : null
      if (edit && !isPainting) {
        const ex = W * edit[0], ey = padY(H * edit[1], H, k)
        if (s.dragging) { g.fillStyle = sk.accent2; g.beginPath(); g.arc(ex, ey, DRAG_RADIUS * 2 * k / 2, 0, Math.PI * 2); g.fill() }
        ring(ex, ey, GRAB_RADIUS * 2 * k, Math.max(1, k), sk.accent1, null)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Box at={at} className={`vt-screen vt-lineeditor ${props.className ?? ''}`}>
      <canvas ref={canvas} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none' }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu} />
      {entry && (
        <input className="vt-entry vt-lineentry" autoFocus defaultValue={entry.text} style={{ left: entry.x, top: entry.y, transform: 'none' }}
          onFocus={(e) => e.currentTarget.select()} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commitEntry(e.currentTarget.value); if (e.key === 'Escape') setEntry(null) }}
          onBlur={(e) => commitEntry(e.currentTarget.value)} />
      )}
    </Box>
  )
}

const ROTARY_LENGTH = 200 * 1000 / 1440 // kDefaultRotaryDragLength in stage px

/** A grid size box (the editors' grid_size_x / grid_size_y SynthSliders): drag up or right for more
 *  (sensitivity 0.2), wheel ±1, double-click resets. */
export function GridValue({ value, max, def, onChange, title }: { value: number; max: number; def: number; onChange: (v: number) => void; title: string }) {
  const acc = useRef<number | null>(null)
  const drag = useDrag((dx, dy) => {
    const start = acc.current ?? value
    acc.current = Math.max(1, Math.min(max, start + ((dx + dy) / (ROTARY_LENGTH / 0.2)) * (max - 1)))
    if (Math.round(acc.current) !== value) onChange(Math.round(acc.current))
  }, () => { acc.current = null })
  const wheel = useWheel((_dx, dy) => { if (dy) onChange(Math.max(1, Math.min(max, value + Math.sign(dy)))) })
  return (
    <span className="c vt-grid-n" ref={wheel} {...drag} title={title}
      onDoubleClick={(e) => { e.stopPropagation(); onChange(def) }}>{value}</span>
  )
}

const PATTERN_NAMES = ['Step', 'Half', 'Down', 'Up', 'Tri'] // strings::kPaintPatternNames

/** The paint pattern selector (PaintPatternSelector::paint): the pattern drawn filled from the bottom,
 *  in the skin's colours while painting and Lighten Screen otherwise; click for the list, wheel steps. */
export function PatternBox({ value, active, onChange, skin, w, h }: { value: number; active: boolean; onChange: (v: number) => void; skin?: LineSkin; w: number; h: number }) {
  const api = useVital()
  const ref = useRef<SVGSVGElement>(null)
  const sectionSkin = useLineSkin(ref)
  const sk = skin ?? sectionSkin
  const wheel = useWheel((_dx, dy) => { if (dy) onChange((value + (dy > 0 ? 1 : -1) + PATTERN_NAMES.length) % PATTERN_NAMES.length) })
  const pad = 2.75, height = h - 2 * pad, width = w - 2 * pad
  const shape = PAINT_SHAPES[value] ?? PAINT_SHAPES[0]
  const d = `M${pad} ${pad + height}` + shape.map(([t, level]) => `L${pad + t * width} ${pad + (1 - level) * height}`).join('') + `L${pad + width} ${pad + height}`
  const lw = Math.max(1, Math.round(h * 0.05 * 2) / 2)
  return (
    <svg ref={(el) => { ref.current = el; wheel(el) }} className="mini vt-pattern" viewBox={`0 0 ${w} ${h}`} style={{ cursor: 'pointer' }}
      onClick={(e) => { e.stopPropagation(); api.openMenu({ w: 70, items: PATTERN_NAMES.map((name, k) => ({ label: name, on: k === value, act: () => onChange(k) })) }, e) }}>
      {active ? <><path d={d} fill={sk.secondary1} /><path d={d} fill={sk.secondary2} /></> : <path d={d} fill={sk.lighten} />}
      <path d={d} fill="none" stroke={active ? sk.center : sk.lighten} strokeWidth={lw} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
