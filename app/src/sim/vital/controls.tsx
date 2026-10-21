import { useState, type CSSProperties, type ReactNode } from 'react'
import { learnItems } from '../../engine/midi'
import { routeSlot, useLiveLanes, useStatus } from '../../engine/status'
import { amountScale, arcColor, modulatable, norm, PARAMS, shown, shownAmount, sourceName } from './params'
import { useVital, type MenuItem } from './ctx'
import { R, useControlMenu, useDrag, useModRange, useSlider, valueFromText, type Rect } from './hooks'


// Vital's controls, drawn as its default skin draws them and behaving as its controls do (useSlider):
// drag (Cmd/Ctrl for fine), wheel, double-click for the default, Alt-click to type a value, right-click
// for the menu; the value popup shows while pressed, dragged or wheeled.
// A control a modulator can reach is a drop target while a modulator is dragged; once connected it
// shows the modulation's range and, for the source in focus, a depth ring to drag.
// Positions are the capture's 2000-wide frame, halved (`R`), relative to the enclosing section.

export function Box({ at, className = '', children, style, ...rest }: { at: Rect; className?: string; children?: ReactNode; style?: CSSProperties; ref?: React.Ref<HTMLDivElement> } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`vt-b ${className}`} style={{ ...R(...at), ...style }} {...rest}>{children}</div>
}

/** A label under a control (Vital's Label Background pill). */
export function Pill({ at, children, dim = false, className = '' }: { at: Rect; children: ReactNode; dim?: boolean; className?: string }) {
  return <Box at={at} className={`vt-pill${dim ? ' dim' : ''} ${className}`}>{children}</Box>
}

/** Where a control's value popup sits (SynthSlider popup placement; Vital's default is below). */
export type PopupAt = 'below' | 'above' | 'right' | 'left'

/** The value popup Vital shows while a control is pressed, dragged or wheeled. */
export function Bubble({ text, at = 'above', below = false }: { text: string; at?: PopupAt; below?: boolean }) {
  const where = below ? 'below' : at
  return <span className={`vt-bubble${where === 'above' ? '' : ` ${where}`}`}>{text}</span>
}

/** Inline value entry over a control (Alt-click or Enter Value): Enter or leaving commits, Escape cancels.
 *  Takes the shown units, an option name, or "n%" of the range. */
export function TextEntry({ p, onDone }: { p: string; onDone: () => void }) {
  const api = useVital()
  const commit = (text: string) => {
    const v = valueFromText(p, text)
    if (v !== null) { api.checkpoint(); api.set(p, v) }
    onDone()
  }
  return (
    <input className="vt-entry" autoFocus defaultValue={shown(p, api.v[p] ?? PARAMS[p]?.def ?? 0, false)}
      onFocus={(e) => e.currentTarget.select()} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commit(e.currentTarget.value); if (e.key === 'Escape') onDone() }}
      onBlur={(e) => commit(e.currentTarget.value)} />
  )
}

/** Vital's kDefaultRotaryDragLength in stage px, for the depth rings (−1…1 over it). */
const RING_LENGTH = 200 * 1000 / 1440

/** A depth ring for one modulation (ModulationAmountKnob): drag up or right for more (Cmd/Ctrl fine),
 *  double-click removes it, middle-click bypasses it, right-click for its menu; pressing it makes its
 *  source the current modulator. Its popup shows on hover, named for the other end: on a source it
 *  names the destination and takes the destination's arc colour; at a destination it names the source,
 *  in Modulation Meter Control for the current modulator and the default arc colour otherwise. */
export function ModRing({ i, style, side = 'dest', popup = 'below' }: { i: number; style?: CSSProperties; side?: 'source' | 'dest'; popup?: PopupAt }) {
  const api = useVital()
  const m = api.mods[i]
  const [hot, setHot] = useState(false)
  const g = useDrag((dx, dy, fine) => api.setMod(i, { amt: Math.max(-1, Math.min(1, (api.getMods()[i]?.amt ?? 0) + (2 * (dx + dy) / RING_LENGTH) * (fine ? 0.1 : 1))) }))
  if (!m) return null
  const deg = Math.abs(m.amt) * 360
  const color = side === 'source' ? arcColor(m.dst) : m.src === api.focusSrc ? '#64ffda' : '#aa88ff'
  const menu = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    api.openMenu({ w: 100, items: [
      { label: 'Remove', act: () => { api.checkpoint(); api.removeMod(i) } },
      { label: m.bypass ? 'Unbypass' : 'Bypass', act: () => { api.checkpoint(); api.setMod(i, { bypass: !m.bypass }) } },
      { label: m.bipolar ? 'Make Unipolar' : 'Make Bipolar', act: () => { api.checkpoint(); api.setMod(i, { bipolar: !m.bipolar }) } },
      { label: m.stereo ? 'Make Mono' : 'Make Stereo', act: () => { api.checkpoint(); api.setMod(i, { stereo: !m.stereo }) } },
      { sep: true },
      ...learnItems(`modulation_${routeSlot(m.src, m.dst) ?? i + 1}_amount`),
      { label: 'Enter Value', act: () => { const s = window.prompt('Amount', shownAmount(m.dst, m.amt)); const n = s == null ? NaN : parseFloat(s); if (!Number.isNaN(n)) { api.checkpoint(); api.setMod(i, { amt: Math.max(-1, Math.min(1, n / amountScale(m.dst))) }) } } },
    ] }, e)
  }
  return (
    <span className={`vt-ring${m.bypass ? ' bypass' : ''}${hot ? ' hot' : ''}`} style={style} {...g} onContextMenu={menu}
      onPointerDown={(e) => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); api.checkpoint(); api.setMod(i, { bypass: !m.bypass }); return } api.setFocusSrc(m.src); g.onPointerDown(e) }}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => { e.stopPropagation(); api.checkpoint(); api.removeMod(i); api.setUi({ ringHot: undefined }) }}
      onPointerEnter={() => { setHot(true); api.setUi({ ringHot: i }) }} onPointerLeave={() => { setHot(false); api.setUi({ ringHot: undefined }) }}>
      <span className="vt-ringdot" style={{ background: `conic-gradient(${m.amt < 0 ? 'from ' + (360 - deg) + 'deg, ' : ''}${color} ${deg}deg, #1d2125 0)` }} />
      {hot && <Bubble at={popup} text={`${side === 'source' ? PARAMS[m.dst]?.name ?? m.dst : sourceName(m.src)}: ${shownAmount(m.dst, m.amt)}`} />}
    </span>
  )
}

/** A depth ring's size: ModulationAmountKnob is 24 pt square (size_ratio × 24). */
export const RING_SIZE = 24 * 1000 / 1440

/** The depth rings at a destination (makeCurrentModulatorAmountsVisible / makeModulationsVisible), placed
 *  by the control's modulation placement: `at` 'below' / 'above' lays them in a row, 'left' / 'right' in
 *  a column, centred on (`x`, `y`), the centre of the current modulator's ring; each ring's popup opens
 *  the same way. At rest only the current modulator's shows; while the control is hovered every
 *  connection's does, centred, a gap kept in the middle for the current one and the count kept odd. */
export function Rings({ p, x, y, all = false, at = 'below' }: { p: string; x: number; y: number; all?: boolean; at?: PopupAt }) {
  const api = useVital()
  const into = api.mods.map((m, i) => ({ m, i })).filter(({ m }) => m.dst === p)
  const current = into.find(({ m }) => m.src === api.focusSrc)
  const slots: (number | null)[] = []
  if (all) {
    const others: (number | null)[] = into.filter((r) => r !== current).map(({ i }) => i)
    if (current) {
      others.splice(Math.floor((others.length + 1) / 2), 0, current.i)
      if (others.length % 2 === 0) others.push(null)
    }
    slots.push(...others)
  } else if (current) slots.push(current.i)
  const start = -(slots.length - 1) / 2
  const row = at === 'below' || at === 'above'
  return <>{slots.map((i, k) => {
    if (i === null) return null
    const d = (start + k) * RING_SIZE
    const cx = row ? x + d : x, cy = row ? y : y + d
    return <ModRing key={i} i={i} popup={at} style={{ left: cx - RING_SIZE / 2, top: cy - RING_SIZE / 2 }} />
  })}</>
}

/** Whether `p` lights up as a drop target while a source is dragged: not the source's own control and
 *  not one it already modulates (ModulationManager::startModulationMap). */
export function dropTarget(api: { dragSrc: string | null; mods: { src: string; dst: string }[] }, p: string) {
  return !!api.dragSrc && api.dragSrc !== p && !api.mods.some((m) => m.src === api.dragSrc && m.dst === p)
}

/** Vital's modulation meter colours (Modulation Meter / Left / Right): where only the left lane reaches
 *  the meter is green, only the right blue, both teal. The range shown while a ring is hovered is the
 *  centre colour too. */
export const METER = { center: '#1de9b6', left: '#1de952', right: '#1dc2e9' }

/** A modulated control's live left and right positions (0–1 of its range) from the engine, or null when
 *  it isn't modulated or the engine isn't running. Mono totals report with no voice playing (a macro
 *  moves its meter on its own); poly totals join them while a voice plays, as ModulationMeter does. */
function useLiveNorm(p: string, modulated: boolean): [number, number] | null {
  const lanes = useLiveLanes(p)
  if (!modulated || lanes === null) return null
  const n = (x: number) => Math.max(0, Math.min(1, norm(p, x)))
  return [n(lanes[0]), n(lanes[1])]
}

/** kRotary/LinearModulationFragmentShader's colouring: the meter runs from the set value `t` to each
 *  lane; the stretch both lanes cover is the centre colour, the rest of each lane its own. */
export function meterSegments(t: number, [l, r]: [number, number]): { lo: number; hi: number; color: string }[] {
  const a0 = Math.min(t, l), a1 = Math.max(t, l), b0 = Math.min(t, r), b1 = Math.max(t, r)
  const c0 = Math.max(a0, b0), c1 = Math.min(a1, b1)
  const out = [{ lo: c0, hi: c1, color: METER.center }]
  if (a0 < c0) out.push({ lo: a0, hi: c0, color: METER.left })
  if (a1 > c1) out.push({ lo: c1, hi: a1, color: METER.left })
  if (b0 < c0) out.push({ lo: b0, hi: c0, color: METER.right })
  if (b1 > c1) out.push({ lo: c1, hi: b1, color: METER.right })
  return out.filter((s) => s.hi - s.lo > 0.002)
}

/** The modulation range to draw on `p`: as Vital does, only while one of its rings is hovered or a
 *  modulator is being dragged (the live meter shows the rest of the time). Before the engine runs there's
 *  no meter, so the range always shows. */
function useShownRange(p: string) {
  const api = useVital()
  const range = useModRange(p)
  const engineOn = useStatus('num_voices') !== null
  if (!range) return null
  const ringHot = api.ui.ringHot as number | undefined
  const hovered = ringHot !== undefined && api.mods[ringHot]?.dst === p
  return !engineOn || hovered || api.dragSrc ? range : null
}

/** Vital's rotary. `x, y, d`: centre and body diameter in the capture's frame. */
export function Knob({ p, x, y, d, color = '#aa88ff', bipolar, dim = false, label, labelAt, track = '#4c4f52', popup = 'below', prefix = '', snap, defaultValue }: {
  p: string; x: number; y: number; d: number; color?: string; bipolar?: boolean; dim?: boolean; label?: string; labelAt?: Rect; track?: string
  popup?: PopupAt; prefix?: string; snap?: number; defaultValue?: number
}) {
  const api = useVital()
  const sl = useSlider(p, { snap, defaultValue })
  const menu = useControlMenu(p, () => sl.setEditing(true))
  const modulated = useModRange(p) !== null
  const range = useShownRange(p)
  const live = useLiveNorm(p, modulated)
  const pd = PARAMS[p]
  const bip = bipolar ?? (pd ? pd.min < 0 && pd.max > 0 && Math.abs(pd.min) === pd.max : false)
  const t = norm(p, api.v[p] ?? 0)
  // Skin: body 40 pt, arc 32 pt; the meter 39 pt across, 3 pt thick; the hovered range 2 pt thick just
  // outside the meter (its bounds grown by 2).
  const D = d / 2, c = D / 2, body = c - 0.6, ar = body * 0.8, pt = body / 20, meterR = 18 * pt, mr = 20.5 * pt
  const a = (u: number) => ((135 + 270 * u) * Math.PI) / 180
  const at = (u: number, k: number) => [c + k * Math.cos(a(u)), c + k * Math.sin(a(u))]
  const arc = (u0: number, u1: number, k: number) => {
    const lo = Math.max(0, Math.min(u0, u1)), hi = Math.min(1, Math.max(u0, u1))
    const [x0, y0] = at(lo, k), [x1, y1] = at(hi, k)
    return `M ${x0} ${y0} A ${k} ${k} 0 ${(hi - lo) * 270 > 180 ? 1 : 0} 1 ${x1} ${y1}`
  }
  const [h0x, h0y] = at(t, ar * 0.5), [h1x, h1y] = at(t, ar)
  const from = bip ? 0.5 : 0
  const drop = modulatable(p) && !dim
  const thick = sl.hover ? 1.4 : 1 // OpenGlSlider::redoImage: the arc thickens on hover
  return (
    <>
      <div className={`vt-knob${dim ? ' dim' : ''}${drop && dropTarget(api, p) ? ' target' : ''}`} style={{ left: x / 2 - c, top: y / 2 - c, width: D, height: D }}
        data-param={p} {...(drop ? { 'data-drop': p } : {})} {...sl.handlers} onContextMenu={menu}>
        <svg viewBox={`0 0 ${D} ${D}`} aria-hidden="true">
          <circle cx={c} cy={c} r={body} fill="#262a2e" stroke="#4c4f52" strokeWidth={0.6} />
          <path d={arc(0, 1, ar)} fill="none" stroke={track} strokeWidth={1.4 * thick} strokeLinecap="round" />
          {Math.abs(t - from) > 0.004 && <path d={arc(from, t, ar)} fill="none" stroke={dim ? '#4c4f52' : color} strokeWidth={1.7 * thick} strokeLinecap="round" />}
          {live && meterSegments(t, live).map((g, k) => <path key={k} d={arc(g.lo, g.hi, meterR)} fill="none" stroke={g.color} strokeWidth={3 * pt} />)}
          {range && <path d={arc(t + range.lo, t + range.hi, mr)} fill="none" stroke={METER.center} strokeWidth={2 * pt} />}
          <line x1={h0x} y1={h0y} x2={h1x} y2={h1y} stroke="#ffffff" strokeWidth={1.7} strokeLinecap="round" />
        </svg>
        {sl.popup && <Bubble at={popup} text={prefix + shown(p, api.v[p] ?? 0)} />}
        {sl.editing && <TextEntry p={p} onDone={() => sl.setEditing(false)} />}
        <Rings p={p} x={c} y={(labelAt ? labelAt[3] / 2 - (y / 2 - c) : D) + RING_SIZE / 2} all={sl.hover} />
      </div>
      {label && labelAt && <Pill at={labelAt} dim={dim}>{label}</Pill>}
    </>
  )
}

/** A horizontal slider (filter cutoff and blend, LFO phase): a track, a fill from `fill` and a thumb. */
export function HSlider({ p, at, thumb = 30, className = '', fillFrom, dim = false, color = '#6a6d70', rings = true, popup = 'below', prefix = '', snap, ringsAt = 'above' }: {
  p: string; at: Rect; thumb?: number; className?: string; fillFrom?: number; dim?: boolean; color?: string; rings?: boolean
  popup?: PopupAt; prefix?: string; snap?: number
  /** setModulationPlacement: 'above' (cutoff, phase bars) or Vital's default 'below' (blend bars). */
  ringsAt?: 'above' | 'below'
}) {
  const api = useVital()
  const w = (at[2] - at[0]) / 2
  const sl = useSlider(p, { kind: 'x', length: w, snap })
  const menu = useControlMenu(p, () => sl.setEditing(true))
  const modulated = useModRange(p) !== null
  const range = useShownRange(p)
  const live = useLiveNorm(p, modulated)
  const t = norm(p, api.v[p] ?? 0)
  const tw = thumb / 2
  const pos = t * (w - tw)
  const drop = modulatable(p) && !dim
  return (
    <Box at={at} className={`vt-hslide ${className}${drop && dropTarget(api, p) ? ' target' : ''}${sl.hover ? ' hover' : ''}`} data-param={p} {...(drop ? { 'data-drop': p } : {})}
      {...sl.handlers} onContextMenu={menu}>
      {fillFrom !== undefined && <i className="fill" style={{ left: Math.min(pos, fillFrom * (w - tw)) + tw / 2, width: Math.abs(pos - fillFrom * (w - tw)) }} />}
      {range && <i className="mod" style={{ left: tw / 2 + (t + range.lo) * (w - tw), width: (range.hi - range.lo) * (w - tw) }} />}
      {live && meterSegments(t, live).map((g, k) => <i key={k} className="mod live" style={{ left: tw / 2 + g.lo * (w - tw), width: (g.hi - g.lo) * (w - tw), background: g.color }} />)}
      <i className="h" style={{ left: pos, width: tw, background: dim ? undefined : color }} />
      {sl.popup && <Bubble at={popup} text={prefix + shown(p, api.v[p] ?? 0)} />}
      {sl.editing && <TextEntry p={p} onDone={() => sl.setEditing(false)} />}
      {rings && <Rings p={p} x={w / 2} y={ringsAt === 'above' ? -RING_SIZE / 2 : (at[3] - at[1]) / 2 + RING_SIZE / 2} at={ringsAt} all={sl.hover} />}
    </Box>
  )
}

/** A vertical scroll-style slider (wave frame, resonance). */
export function VSlider({ p, at, thumb = 30, dim = false, popup = 'right', prefix = '' }: { p: string; at: Rect; thumb?: number; dim?: boolean; popup?: PopupAt; prefix?: string }) {
  const api = useVital()
  const h = (at[3] - at[1]) / 2
  const sl = useSlider(p, { kind: 'y', length: h })
  const menu = useControlMenu(p, () => sl.setEditing(true))
  const modulated = useModRange(p) !== null
  const range = useShownRange(p)
  const live = useLiveNorm(p, modulated)
  const t = norm(p, api.v[p] ?? 0)
  const th = thumb / 2
  const drop = modulatable(p) && !dim
  const yOf = (u: number) => (1 - u) * (h - th) + th / 2
  return (
    <Box at={at} className={`vt-vscroll${drop && dropTarget(api, p) ? ' target' : ''}${sl.hover ? ' hover' : ''}`} data-param={p} {...(drop ? { 'data-drop': p } : {})} {...sl.handlers} onContextMenu={menu}>
      <i style={{ top: (1 - t) * (h - th), height: th, bottom: 'auto' }} />
      {range && <b className="mod" style={{ top: yOf(Math.min(1, t + range.hi)), height: Math.max(0, yOf(Math.max(0, t + range.lo)) - yOf(Math.min(1, t + range.hi))) }} />}
      {live && meterSegments(t, live).map((g, k) => <b key={k} className="mod live" style={{ top: yOf(g.hi), height: yOf(g.lo) - yOf(g.hi), background: g.color }} />)}
      {sl.popup && <Bubble at={popup} text={prefix + shown(p, api.v[p] ?? 0)} />}
      {sl.editing && <TextEntry p={p} onDone={() => sl.setEditing(false)} />}
      <Rings p={p} x={-RING_SIZE / 2} y={h / 2} at="left" all={sl.hover} />
    </Box>
  )
}

/** A dragged text value (unison voices, transpose, polyphony …): vertical drag over `span` stage px
 *  for the whole range (the control's longer side ÷ its sensitivity), Shift steps by `shiftIndex`. While
 *  dragged it shows its name, as Vital's text sliders do. `fmt` overrides the printed value. */
export function TextValue({ p, style, className = '', fmt, span = 120, shiftIndex, popup = 'below', meterLeft = false }: {
  p: string; style?: CSSProperties; className?: string; fmt?: (v: number) => string; span?: number; shiftIndex?: number; popup?: PopupAt
  /** setModulationBarRight(false): the meter on the left edge (oscillator and sample transpose, unison voices). */
  meterLeft?: boolean
}) {
  const api = useVital()
  const sl = useSlider(p, { kind: 'y', length: span, shiftIndex })
  const menu = useControlMenu(p, () => sl.setEditing(true))
  const v = api.v[p] ?? 0
  const drop = modulatable(p)
  return (
    <span className={`vt-tv ${className}${drop && dropTarget(api, p) ? ' target' : ''}`} style={style} data-param={p} {...(drop ? { 'data-drop': p } : {})} {...sl.handlers} onContextMenu={menu}>
      {fmt ? fmt(v) : shown(p, v)}
      {sl.popup && <Bubble at={popup} text={PARAMS[p]?.name ?? p} />}
      {sl.editing && <TextEntry p={p} onDone={() => sl.setEditing(false)} />}
      {drop && <LinearMeter p={p} left={meterLeft} />}
      {drop && <span className="vt-tvrings"><Rings p={p} x={0} y={RING_SIZE / 2} all={sl.hover} /></span>}
    </span>
  )
}

/** A text or curve control's modulation meter (getModulationMeterBounds: kTextBarSize): a 2 px bar up
 *  its right edge (or left), running from the set value to each lane's live value bottom to top, in the
 *  meter colours; the hovered ring's range is the same bar in the centre colour. */
export function LinearMeter({ p, left = false }: { p: string; left?: boolean }) {
  const api = useVital()
  const modulated = useModRange(p) !== null
  const range = useShownRange(p)
  const live = useLiveNorm(p, modulated)
  if (!live && !range) return null
  const t = norm(p, api.v[p] ?? 0)
  const side = left ? { left: 0 } : { right: 0 }
  const bar = (lo: number, hi: number, color: string, k: string | number) => {
    const a = Math.max(0, Math.min(1, lo)), b = Math.max(0, Math.min(1, hi))
    return <i key={k} className="vt-linmeter" style={{ ...side, bottom: `${a * 100}%`, height: `${(b - a) * 100}%`, background: color }} />
  }
  return <>
    {live && meterSegments(t, live).map((g, k) => bar(g.lo, g.hi, g.color, k))}
    {range && bar(t + range.lo, t + range.hi, METER.center, 'range')}
  </>
}

/** ‹ value ›: the arrows step through the options; clicking the name opens the list. */
export function Selector({ p, at, className = '', names, label, menuCols, menuW = 120, values, dim = false }: {
  p: string; at: Rect; className?: string; names?: readonly string[]; label?: string; menuCols?: () => MenuItem[][]; menuW?: number; values?: number[]; dim?: boolean
}) {
  const api = useVital()
  const d = PARAMS[p]
  const list = values ?? Array.from({ length: (names ?? d.opts ?? []).length }, (_, i) => i)
  const nm = names ?? d.opts ?? []
  const v = Math.round(api.v[p] ?? 0)
  const at_ = list.indexOf(v)
  const step = (k: number) => (e: React.MouseEvent) => { e.stopPropagation(); api.checkpoint(); api.set(p, list[(at_ + k + list.length) % list.length]) }
  const open = (e: React.MouseEvent) => {
    e.stopPropagation()
    const cols = menuCols?.() ?? [list.map((x) => ({ label: nm[x], on: x === v, act: () => { api.checkpoint(); api.set(p, x) } }))]
    api.openMenu({ items: cols[0], cols: menuCols ? cols : undefined, w: menuW }, e)
  }
  return (
    <Box at={at} className={`vt-sel ${className}${dim ? ' dim' : ''}`} data-param={p}>
      <span className="arr" onClick={step(-1)}>‹</span>
      <span className="nm" onClick={open}>{label ?? nm[v] ?? ''}</span>
      <span className="arr" onClick={step(1)}>›</span>
    </Box>
  )
}

/** A two-state button (pills such as SYNC, LEGATO; text buttons such as OSC1 inputs). */
export function Toggle({ p, at, children, className = 'vt-pill', onColor }: { p: string; at: Rect; children: ReactNode; className?: string; onColor?: string }) {
  const api = useVital()
  const on = (api.v[p] ?? 0) >= 0.5
  return (
    <Box at={at} className={`${className} vt-toggle${on ? ' on' : ''}`} style={on && onColor ? { color: onColor } : undefined} data-param={p}
      onClick={(e) => { e.stopPropagation(); api.checkpoint(); api.set(p, on ? 0 : 1) }}>{children}</Box>
  )
}

/** A section's power button. */
export function Power({ p, x, y, color = '#aa88ff', className = '' }: { p: string; x: number; y: number; color?: string; className?: string }) {
  const api = useVital()
  const on = (api.v[p] ?? 0) >= 0.5
  return (
    <span className={`vt-dot ${className}${on ? ' on' : ''}`} style={{ left: x / 2 - 5.5, top: y / 2 - 5.5, background: on ? color : undefined }} title={PARAMS[p]?.name} data-param={p}
      onClick={(e) => { e.stopPropagation(); api.checkpoint(); api.set(p, on ? 0 : 1) }} />
  )
}
