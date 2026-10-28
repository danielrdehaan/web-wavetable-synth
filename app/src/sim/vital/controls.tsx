import { useCallback, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { learnItems } from '../../engine/midi'
import { routeSlot, useLiveLanes, useStatus } from '../../engine/status'
import { amountScale, modulatable, norm, PARAMS, shown, shownAmount, sourceName } from './params'
import { useVital, type MenuItem } from './ctx'
import { R, useControlMenu, useDrag, useModRange, useSlider, valueFromText, type Rect } from './hooks'
import { sk, useSkin, useSkinValues, type ColorKey, type Skin, type SkinSection } from './skin'

// Vital's controls, drawn as its default skin draws them and behaving as its controls do (useSlider):
// drag (Cmd/Ctrl for fine), wheel, double-click for the default, Alt-click to type a value, right-click
// for the menu; the value popup shows while pressed, dragged or wheeled.
// A control a modulator can reach is a drop target while a modulator is dragged; once connected it
// shows the modulation's range and, for the source in focus, a depth ring to drag.
// Positions are the capture's 2000-wide frame, halved (`R`), relative to the enclosing section.
// Colours come from the skin (`var(--sk-*)`), so a control takes its section's overrides (data-skin on an
// ancestor); the `color` / `track` props still win when a caller passes them.

/** Sections whose overrides sit inside another's (EffectsInterface's All Effects holds each effect). */
const SKIN_PARENT: Partial<Record<SkinSection, SkinSection>> = Object.fromEntries(
  (['Chorus', 'Compressor', 'Delay', 'Distortion', 'Equalizer', 'Effects Filter', 'Flanger', 'Phaser', 'Reverb'] as const).map((s) => [s, 'All Effects']))

/** A skin colour as `section` sees it (findColour walking up its parents to the globals). */
export function skinColor(skin: Skin, section: SkinSection | null, key: ColorKey): string {
  for (let s: SkinSection | undefined = section ?? undefined; s; s = SKIN_PARENT[s]) {
    const c = skin.overrides[s]?.colors[key]
    if (c) return c
  }
  return skin.colors[key] ?? '#000000'
}

/** The section a destination's control sits in, for its Rotary Arc colour away from the control. */
const DESTINATION_SECTIONS: [RegExp, SkinSection][] = [
  [/^(filter_1|filter_2)_/, 'Filter'], [/^filter_fx_/, 'Effects Filter'], [/^compressor_/, 'Compressor'], [/^delay_/, 'Delay'],
  [/^distortion_/, 'Distortion'], [/^env_/, 'Envelope'], [/^lfo_/, 'Lfo'], [/^random_/, 'RandomLfo'], [/^eq_/, 'Equalizer'],
  [/^flanger_/, 'Flanger'], [/^phaser_/, 'Phaser'], [/^reverb_/, 'Reverb'], [/^chorus_/, 'Chorus'], [/^osc_/, 'Oscillator'],
  [/^sample_/, 'Sample'], [/^macro_/, 'Macro'],
]
/** A destination's Rotary Arc colour in the current skin (its section's override, else the global), as a
 *  source's depth knobs take it (ModulationAmountKnob::setDestinationComponent). */
export function useArcColor(): (dst: string) => string {
  const { skin } = useSkin()
  return useCallback((dst: string) => skinColor(skin, DESTINATION_SECTIONS.find(([re]) => re.test(dst))?.[1] ?? null, 'Rotary Arc'), [skin])
}

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
  const arcColor = useArcColor()
  const g = useDrag((dx, dy, fine) => api.setMod(i, { amt: Math.max(-1, Math.min(1, (api.getMods()[i]?.amt ?? 0) + (2 * (dx + dy) / RING_LENGTH) * (fine ? 0.1 : 1))) }))
  if (!m) return null
  const deg = Math.abs(m.amt) * 360
  // The ring is the ModulationManager's (Modulation Drag Drop), so away from the source it takes that
  // section's colours, not the control's (--vt-mdd-*, set by DragGhost's SkinLayers).
  const color = side === 'source' ? arcColor(m.dst) : m.src === api.focusSrc ? 'var(--vt-mdd-modulation-meter-control)' : 'var(--vt-mdd-rotary-arc)'
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
      <span className="vt-ringdot" style={{ background: `conic-gradient(${m.amt < 0 ? 'from ' + (360 - deg) + 'deg, ' : ''}${color} ${deg}deg, var(--vt-mdd-widget-background) 0)` }} />
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
 *  the meter is the left colour, only the right the right, both the centre. The range shown while a ring
 *  is hovered is the centre colour too. CSS colours, for styles. */
export const METER = { center: sk('Modulation Meter'), left: sk('Modulation Meter Left'), right: sk('Modulation Meter Right') }

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

/** The skin values a rotary is drawn with (OpenGlSlider::setSliderDisplayValues, SynthSlider::
 *  drawRotaryShadow, ModulationMeter::getMeterBounds), as its section has them. */
const KNOB_VALUES = ['Knob Arc Size', 'Knob Arc Thickness', 'Knob Body Size', 'Knob Handle Length', 'Knob Mod Meter Arc Size',
  'Knob Mod Meter Arc Thickness', 'Knob Shadow Width', 'Knob Shadow Offset'] as const

/** Vital's rotary. `x, y, d`: centre and body diameter in the capture's frame (the default skin's 40 pt
 *  body); the skin's knob values size the arc, body, handle, meter and shadow relative to that. `color`
 *  and `track` override the skin's Rotary Arc / Rotary Arc Unselected. */
export function Knob({ p, x, y, d, color, bipolar, dim = false, label, labelAt, track, popup = 'below', prefix = '', snap, defaultValue }: {
  p: string; x: number; y: number; d: number; color?: string; bipolar?: boolean; dim?: boolean; label?: string; labelAt?: Rect; track?: string
  popup?: PopupAt; prefix?: string; snap?: number; defaultValue?: number
}) {
  const api = useVital()
  const sl = useSlider(p, { snap, defaultValue })
  const menu = useControlMenu(p, () => sl.setEditing(true))
  const modulated = useModRange(p) !== null
  const range = useShownRange(p)
  const live = useLiveNorm(p, modulated)
  const ref = useRef<HTMLDivElement>(null)
  const kv = useSkinValues(ref, KNOB_VALUES)
  const shadowId = useId()
  const pd = PARAMS[p]
  const bip = bipolar ?? (pd ? pd.min < 0 && pd.max > 0 && Math.abs(pd.min) === pd.max : false)
  const t = norm(p, api.v[p] ?? 0)
  // `u`: stage px per Vital point at this knob's size (the default 40 pt body fills `d` less its border).
  // The arc sits at Knob Arc Size / 2, the handle runs Knob Handle Length of the way in from it, the
  // meter is Knob Mod Meter Arc Size across and Thickness thick, the hovered range 2 pt thick just outside
  // the meter (its bounds grown by 2). Thickness doesn't scale with the knob, as in Vital: the default
  // 2.4 pt draws the track 1.4 px and the value arc and handle 1.7 px, as captured.
  const D = d / 2, c = D / 2, u = (c - 0.6) / 20
  const body = (kv['Knob Body Size'] / 2) * u, ar = (kv['Knob Arc Size'] / 2) * u
  const tk = kv['Knob Arc Thickness'] / 2.4
  const meterT = kv['Knob Mod Meter Arc Thickness'], meterR = (kv['Knob Mod Meter Arc Size'] / 2 - meterT / 2) * u
  const mr = (kv['Knob Mod Meter Arc Size'] / 2 + 1) * u
  const a = (v: number) => ((135 + 270 * v) * Math.PI) / 180
  const at = (v: number, k: number) => [c + k * Math.cos(a(v)), c + k * Math.sin(a(v))]
  const arc = (u0: number, u1: number, k: number) => {
    const lo = Math.max(0, Math.min(u0, u1)), hi = Math.min(1, Math.max(u0, u1))
    const [x0, y0] = at(lo, k), [x1, y1] = at(hi, k)
    return `M ${x0} ${y0} A ${k} ${k} 0 ${(hi - lo) * 270 > 180 ? 1 : 0} 1 ${x1} ${y1}`
  }
  const [h0x, h0y] = at(t, ar * (1 - kv['Knob Handle Length'])), [h1x, h1y] = at(t, ar)
  const from = bip ? 0.5 : 0
  const drop = modulatable(p) && !dim
  const thick = sl.hover ? 1.4 : 1 // OpenGlSlider::redoImage: the arc thickens on hover
  // drawRotaryShadow: a Shadow-coloured radial glow Knob Shadow Width past the body, its centre Knob
  // Shadow Offset down, solid to the body's edge less the offset and fading in quarters (0.5625, 0.25,
  // 0.0625 of the alpha) to nothing.
  const shadowW = kv['Knob Shadow Width'] * u, shadowR = body + shadowW
  const shadowStart = shadowR > 0 ? Math.max(0, body - Math.abs(kv['Knob Shadow Offset'] * u)) / shadowR : 0
  // The track and the arc: the skin's unselected / selected rotary colours (the Disabled ones while the
  // control is inactive; an inactive value arc is drawn in the track's colour, as captured).
  const trackColor = track ?? sk(dim ? 'Rotary Arc Unselected Disabled' : 'Rotary Arc Unselected')
  const arcStroke = dim ? sk('Rotary Arc Unselected Disabled') : color ?? sk('Rotary Arc')
  return (
    <>
      <div className={`vt-knob${dim ? ' dim' : ''}${drop && dropTarget(api, p) ? ' target' : ''}`} style={{ left: x / 2 - c, top: y / 2 - c, width: D, height: D }}
        data-param={p} {...(drop ? { 'data-drop': p } : {})} {...sl.handlers} ref={(el) => { ref.current = el; sl.handlers.ref(el) }} onContextMenu={menu}>
        <svg viewBox={`0 0 ${D} ${D}`} aria-hidden="true">
          {shadowW > 0 && <>
            <defs>
              <radialGradient id={shadowId} gradientUnits="userSpaceOnUse" cx={c} cy={c + kv['Knob Shadow Offset'] * u} r={shadowR}>
                {([[0, 1], [shadowStart, 1], [1 - (1 - shadowStart) * 0.75, 0.5625], [1 - (1 - shadowStart) * 0.5, 0.25], [1 - (1 - shadowStart) * 0.25, 0.0625], [1, 0]] as const)
                  .map(([o, k], i) => <stop key={i} offset={o} style={{ stopColor: sk('Shadow') }} stopOpacity={k} />)}
              </radialGradient>
            </defs>
            <circle cx={c} cy={c + kv['Knob Shadow Offset'] * u} r={shadowR} fill={`url(#${shadowId})`} />
          </>}
          {body > 0 && <circle cx={c} cy={c} r={body} strokeWidth={0.6} style={{ fill: sk('Rotary Body'), stroke: sk('Rotary Body Border') }} />}
          <path d={arc(0, 1, ar)} fill="none" strokeWidth={1.4 * tk * thick} strokeLinecap="round" style={{ stroke: trackColor }} />
          {Math.abs(t - from) > 0.004 && <path d={arc(from, t, ar)} fill="none" strokeWidth={1.7 * tk * thick} strokeLinecap="round" style={{ stroke: arcStroke }} />}
          {live && meterSegments(t, live).map((g, k) => <path key={k} d={arc(g.lo, g.hi, meterR)} fill="none" strokeWidth={meterT * u} style={{ stroke: g.color }} />)}
          {range && <path d={arc(t + range.lo, t + range.hi, mr)} fill="none" strokeWidth={2 * u} style={{ stroke: METER.center }} />}
          <line x1={h0x} y1={h0y} x2={h1x} y2={h1y} strokeWidth={1.7 * tk} strokeLinecap="round" style={{ stroke: sk('Rotary Hand') }} />
        </svg>
        {sl.popup && <Bubble at={popup} text={prefix + shown(p, api.v[p] ?? 0)} />}
        {sl.editing && <TextEntry p={p} onDone={() => sl.setEditing(false)} />}
        <Rings p={p} x={c} y={(labelAt ? labelAt[3] / 2 - (y / 2 - c) : D) + RING_SIZE / 2} all={sl.hover} />
      </div>
      {label && labelAt && <Pill at={labelAt} dim={dim}>{label}</Pill>}
    </>
  )
}

/** A horizontal slider (filter cutoff and blend, LFO phase): a Linear Slider Unselected track, a Linear
 *  Slider fill from `fillFrom` and a Linear Slider Thumb (`color` overrides the thumb). */
export function HSlider({ p, at, thumb = 30, className = '', fillFrom, dim = false, color, rings = true, popup = 'below', prefix = '', snap, ringsAt = 'above' }: {
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

/** A section's power button: Power Button On / Off (`color` overrides the on colour). */
export function Power({ p, x, y, color, className = '' }: { p: string; x: number; y: number; color?: string; className?: string }) {
  const api = useVital()
  const on = (api.v[p] ?? 0) >= 0.5
  return (
    <span className={`vt-dot ${className}${on ? ' on' : ''}`} style={{ left: x / 2 - 5.5, top: y / 2 - 5.5, background: on && color ? color : undefined }} title={PARAMS[p]?.name} data-param={p}
      onClick={(e) => { e.stopPropagation(); api.checkpoint(); api.set(p, on ? 0 : 1) }} />
  )
}
