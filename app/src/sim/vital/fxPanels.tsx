import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useEngine } from '../../engine/EngineContext'
import { OutputDisplay, SpectrogramGrid } from '../../engine/OutputDisplay'
import { EqCurve, eqAxis, useEqResponse } from '../../engine/EqCurve'
import { useLiveLanes, useStatusLanes } from '../../engine/status'
import { FilterCurve } from '../../engine/FilterCurve'
import { ModFxCurve } from '../../engine/ModFxCurve'
import { useEngineQuery } from '../../engine/useEngineQuery'
import { Box, Bubble, dropTarget, HSlider, Knob, TextValue, VSlider } from './controls'
import { FilterIcon, filterMode, FilterModelSelector } from './filterUi'
import { useVital, type MenuItem } from './ctx'
import { distort, eqDb, flangerDb, over, phaserDb, PX, reverbEqDb } from './fxMath'
import { R, useControlMenu, useDrag, useStepWheel, useWheel, type Rect } from './hooks'
import { filterDb } from './draw'
import { COMP_BANDS, DELAY_STYLES, DIST_FILTER_ORDER, DIST_TYPES, DIST_TYPES_SHORT, FREQ_SYNC, PARAMS, shown, SYNCED_FREQ } from './params'

// The EFFECTS page's nine panels, measured from the capture (s6a–s6c): every panel is 193.8 tall,
// x from 344.4 (its strip) to 1131.2 in the 2000-wide frame. Positions below are frame x (shifted by
// the panel's left edge, PX) and y from the panel's top; R() halves them.

const B = (x0: number, y0: number, x1: number, y1: number): Rect => [x0 - PX, y0, x1 - PX, y1]
type Col = readonly [number, number]
// Rows: top box / knob row, bottom box / knob row; label strips start at S1 / S2.
const Y1 = [8.4, 92.4] as const, Y2 = [101.2, 186.2] as const
const S1 = 67.4, S2 = 161.2, K1 = 36.4, K2 = 129.6, KD = 55
// Columns: three on the left, two on the right (the panels share them).
const CA: Col = [397.9, 470.8], CB: Col = [479.2, 552.8], CC: Col = [561.1, 634.0], CD: Col = [887.5, 1001.4], CE: Col = [1009.7, 1123.6]
const EA: Col = [397.9, 511.8], EB: Col = [520.1, 634.7], EC: Col = [643.1, 756.9]
const GREY = '#8b8e91'

/** A knob in a column, with its pill: `row` 1 (top) or 2 (bottom). */
function K({ p, col, row, color, label, dim, colorDim, bipolar }: { p: string; col: Col; row: 1 | 2; color: string; label: string; dim?: boolean; colorDim?: boolean; bipolar?: boolean }) {
  const cy = row === 1 ? K1 : K2, s = row === 1 ? S1 : S2, b = row === 1 ? Y1[1] : Y2[1]
  return <Knob p={p} x={(col[0] + col[1]) / 2 - PX} y={cy} d={KD} color={colorDim ? GREY : color} dim={dim} bipolar={bipolar} label={label} labelAt={B(col[0], s, col[1], b + 0.7)} />
}

/** A value box with its label strip (VOICES, MODE, TYPE …). */
function ValBox({ at, split, label, children, onClick, onContextMenu, boxRef, className = '' }: {
  at: Rect; split: number; label: string; children: ReactNode; onClick?: (e: React.MouseEvent) => void
  onContextMenu?: (e: React.MouseEvent) => void; boxRef?: React.Ref<HTMLDivElement>; className?: string
}) {
  return (
    <Box ref={boxRef} at={B(...at)} className={`vfx-box ${className}`} onClick={onClick} onContextMenu={onContextMenu}>
      <div className="vfx-val" style={{ height: (split - at[1]) / 2 }}>{children}</div>
      <div className="vfx-lbl" style={{ height: (at[3] - split) / 2 }}>{label}</div>
    </Box>
  )
}

/** A box whose value is one of a list: click for the list, opened over the label strip as Vital does. */
function MenuBox({ p, at, split, label, names, short, onPick }: {
  p: string; at: Rect; split: number; label: string; names: readonly string[]; short?: readonly string[]
  /** Replaces the plain set when choosing an entry needs more (the delay's mode copies its tempo). */
  onPick?: (i: number) => void
}) {
  const api = useVital()
  const v = Math.round(api.v[p] ?? 0)
  const open = (e: React.MouseEvent) => {
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).querySelector('.vfx-lbl')!.getBoundingClientRect()
    api.openMenu({ w: (at[2] - at[0]) / 2, items: names.map((n, i): MenuItem => ({ label: n, act: () => { api.checkpoint(); if (onPick) onPick(i); else api.set(p, i) } })) }, { clientX: r.left, clientY: r.top })
  }
  // TextSelector: the wheel steps through the list, right-click gives the slider menu.
  const wheel = useStepWheel(p, names.length, onPick)
  const menu = useControlMenu(p)
  return <ValBox at={at} split={split} label={label} onClick={open} onContextMenu={menu} boxRef={wheel} className="vfx-menu">{(short ?? names)[v]}</ValBox>
}

function NoteIcon({ sync }: { sync: number }) {
  return (
    <svg viewBox="0 0 20 32" className="vfx-note" aria-hidden="true">
      {sync === 0
        ? <><circle cx={10} cy={18} r={7} fill="none" stroke="currentColor" strokeWidth={2} /><path d="M10 13 V18 H14" stroke="currentColor" strokeWidth={2} fill="none" /></>
        : <><ellipse cx={7.6} cy={25.6} rx={6.6} ry={5.3} transform="rotate(-18 7.6 25.6)" fill="currentColor" /><rect x={11.6} y={1.5} width={2.6} height={24} rx={0.6} fill="currentColor" />
          {sync === 2 && <circle cx={17.5} cy={25} r={1.8} fill="currentColor" />}
          {sync === 3 && <text x={16} y={10} fontSize={9} fill="currentColor">3</text>}</>}
    </svg>
  )
}

/** TEMPO: the synced value (or seconds) on the left, the note that opens the sync menu on the right. */
function TempoBox({ pre, at, split = S1, aux = false }: { pre: string; at: Rect; split?: number; aux?: boolean }) {
  const api = useVital()
  const pp = aux ? `${pre}_aux` : pre
  const sync = Math.round(api.v[`${pp}_sync`] ?? 1)
  const w = at[2] - at[0], sepR = w > 150 ? 59 : 39
  const valW = (w - sepR) / 2
  const openSync = (e: React.MouseEvent) => {
    e.stopPropagation()
    api.openMenu({ w: 90, items: FREQ_SYNC.slice(0, 4).map((n, i): MenuItem => ({ label: n, on: i === sync, act: () => { api.checkpoint(); api.set(`${pp}_sync`, i) } })) }, e)
  }
  const fmt = sync === 0
    ? (x: number) => `${shown(`${pp}_frequency`, x, false)} s`
    : (x: number) => SYNCED_FREQ[Math.round(x)] ?? ''
  return (
    <ValBox at={at} split={split} label="TEMPO" className="vfx-tempo">
      <TextValue p={sync === 0 ? `${pp}_frequency` : `${pp}_tempo`} fmt={fmt} span={sync === 0 ? 300 : 150} className="vfx-tv" style={{ width: valW }} />
      <i className="vfx-sep" style={{ left: valW - 1 }} />
      <span className="vfx-noteb" style={{ left: valW, width: sepR / 2 }} onClick={openSync}><NoteIcon sync={sync} /></span>
    </ValBox>
  )
}

/** A display: an svg in frame units over Vital's dark screen. */
function Screen({ at, children, className = '', drop, overlay, ...rest }: {
  at: Rect; children?: ReactNode; className?: string; drop?: string; ref?: React.Ref<HTMLDivElement>
  /** HTML drawn over the display (popups). */
  overlay?: ReactNode
} & React.HTMLAttributes<HTMLDivElement>) {
  const api = useVital()
  const w = at[2] - at[0], h = at[3] - at[1]
  return (
    <Box at={B(...at)} className={`vt-screen vfx-screen ${className}${drop && dropTarget(api, drop) ? ' target' : ''}`} {...(drop ? { 'data-drop': drop } : {})} {...rest}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">{children}</svg>
      {overlay}
    </Box>
  )
}

const pathOf = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
const v0 = (api: ReturnType<typeof useVital>, p: string) => api.get(p) ?? PARAMS[p]?.def ?? 0

/** A response curve across a display: `fy(semitone)` → y; filled to the bottom. */
function Curve({ w, h, fy, color, fill = true, from = 8, to = 136, n = 140, alpha = [0.6, 0.45] }: { w: number; h: number; fy: (f: number) => number; color: string; fill?: boolean; from?: number; to?: number; n?: number; alpha?: [number, number] }) {
  const pts: [number, number][] = Array.from({ length: n + 1 }, (_, k) => { const f = from + (k / n) * (to - from); return [(k / n) * w, Math.max(-2, Math.min(h + 2, fy(f)))] })
  const d = pathOf(pts)
  const id = `g${color.slice(1)}${Math.round(alpha[0] * 100)}`
  return (
    <>
      {fill && <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={over(color, alpha[0])} /><stop offset="1" stopColor={over(color, alpha[1])} /></linearGradient></defs>}
      {fill && <path d={`${d} L ${w} ${h + 2} L 0 ${h + 2} Z`} fill={`url(#${id})`} />}
      <path d={d} fill="none" stroke={color} strokeWidth={3} strokeLinejoin="round" />
    </>
  )
}

/** Chorus and delay's filter display: drag sideways for the cutoff, up and down for the spread. */
/** A control's modulated [left, right] while the engine reports them, else its value in both (the
 *  displays' getValue). */
function useFxLanes(id: string): [number, number] {
  const api = useVital()
  const lanes = useLiveLanes(id)
  const base = v0(api, id)
  return lanes ?? [base, base]
}

const FILL_FADE = 0.3 // Widget Fill Fade
const DISABLED = { line: '#666666', fill: 'rgba(102,102,102,0.13)' } // Widget Primary / Secondary Disabled

/** A display's two channels as its OpenGlLineRenderer draws them: the right (`d[1]`, Widget Primary /
 *  Secondary 2) and then the left over it (`d[0]`, … 1), each line filled to `close` with the fill faded
 *  by Widget Fill Fade away from the line. Off, only the left, in the disabled colours. */
function Stereo({ d, close, line, fill, line2 = line, fill2 = fill, on, width, offLine = DISABLED.line, leftFirst = false }: {
  d: [string, string]; close: string; line: string; fill: string; line2?: string; fill2?: string; on: boolean; width: number
  /** The section's Widget Primary Disabled. */
  offLine?: string
  /** DelayFilterViewer draws the left first and the right over it, both channels even while off. */
  leftFirst?: boolean
}) {
  const id = useId()
  const layer = (path: string, stroke: string, f: string, k: string) => (
    <g key={k}>
      <defs><linearGradient id={id + k} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={f} /><stop offset="1" stopColor={f} stopOpacity={1 - FILL_FADE} /></linearGradient></defs>
      <path d={`${path}${close}`} fill={`url(#${id + k})`} />
      <path d={path} fill="none" stroke={stroke} strokeWidth={width} strokeLinejoin="round" />
    </g>
  )
  if (!on && !leftFirst) return layer(d[0], offLine, DISABLED.fill, 'l')
  const left = on ? layer(d[0], line, fill, 'l') : layer(d[0], offLine, DISABLED.fill, 'l')
  const right = on ? layer(d[1], line2, fill2, 'r') : layer(d[1], offLine, DISABLED.fill, 'r')
  return <>{leftFirst ? [left, right] : [right, left]}</>
}

/** Chorus and delay's filter display (delay_section.h DelayFilterViewer): a one-pole high-pass × low-pass
 *  around the cutoff, ± spread × 8 octaves, gain ratio(high − low) + 1, MIDI 8–132 over −18…+6 dB,
 *  filled to the bottom. Drag sideways for the cutoff, up and down for the spread (full range per
 *  width / height). */
function BandFilterScreen({ at, cutoff, spread, color, fill, on }: { at: Rect; cutoff: string; spread: string; color: string; fill: string; on: boolean }) {
  const api = useVital()
  const w = at[2] - at[0], h = at[3] - at[1]
  const c = useFxLanes(cutoff), sp = useFxLanes(spread)
  const drag = useDrag((dx, dy) => {
    const cd = PARAMS[cutoff], sd = PARAMS[spread]
    api.set(cutoff, v0(api, cutoff) + (dx * 2 / w) * (cd.max - cd.min))
    api.set(spread, v0(api, spread) + (dy * 2 / h) * (sd.max - sd.min))
  })
  const lane = (i: 0 | 1) => {
    const radius = Math.max(sp[i] * 8 * 12, 0)
    const highCut = c[i] - radius, lowCut = c[i] + radius
    const n = 64, start = 8, end = 132
    const inc = Math.pow(2, (end - start) / (n - 1) / 12)
    let highRatio = Math.pow(2, (start - highCut) / 12), lowRatio = Math.pow(2, (start - lowCut) / 12)
    const gain = Math.pow(2, (highCut - lowCut) / 12) + 1
    const pts: [number, number][] = []
    for (let k = 0; k < n; k++) {
      const response = gain * (1 / Math.sqrt(1 + lowRatio * lowRatio)) * (highRatio / Math.sqrt(1 + highRatio * highRatio))
      const y = (20 * Math.log10(response) + 18) / 24
      pts.push([(w * k) / (n - 1), Math.max(-2, Math.min(h + 2, (1 - y) * h))])
      highRatio *= inc; lowRatio *= inc
    }
    return pathOf(pts)
  }
  return (
    <Screen at={at} drop={cutoff} {...drag}>
      <Stereo d={[lane(0), lane(1)]} close={` L ${w} ${h + 2} L 0 ${h + 2} Z`} line={color} fill={fill} on={on} width={2 * SCALE * 2} offLine="#4c4f52" leftFirst />
    </Screen>
  )
}

/** The chorus voices (ChorusViewer): one bar per delay line at 1 / chorus_delaysN over 0…70 ms, the middle
 *  half of the height, bar width 0.3 of a slot, additive; they move with the chorus's modulation. */
function ChorusBars({ w, h, color, on }: { w: number; h: number; color: string; on: boolean }) {
  const api = useVital()
  const lanes = [useStatusLanes('chorus_delays1'), useStatusLanes('chorus_delays2'), useStatusLanes('chorus_delays3'), useStatusLanes('chorus_delays4')]
  const voices = Math.round(v0(api, 'chorus_voices')) * 4
  const barW = ((0.3 * 2) / 16) * (w / 2)
  const bars: ReactNode[] = []
  for (let i = 0; i < voices; i++) {
    const f = lanes[Math.floor(i / 4)]?.[i % 4]
    if (f === undefined || !Number.isFinite(f) || f <= 0) continue
    const x = ((1 / f) / 0.07) * w
    bars.push(<rect key={i} x={x - barW / 2} y={h * 0.25} width={barW} height={h * 0.5} fill={on ? over(color, 0.64) : 'rgba(102,102,102,0.13)'} style={{ mixBlendMode: 'plus-lighter' }} />)
  }
  return <>{bars}</>
}

/** The strip, power button and vertical name every panel has. */
export function Panel({ fx, top, children }: { fx: { key: string; label: string; on: string; color: string }; top: number; children: ReactNode }) {
  const api = useVital()
  const on = (api.v[fx.on] ?? 0) >= 0.5
  return (
    <div className={`vfx-panel fx-${fx.key}`} style={{ ...R(0, top, 1131.2 - PX, top + 193.8) }}>
      <i className="vfx-strip" />
      <span className="vt-dot vfx-pdot" style={{ left: 23.6 / 2 - 5.5, top: 23.1 / 2 - 5.5, background: on ? fx.color : undefined }}
        onClick={(e) => { e.stopPropagation(); api.checkpoint(); api.set(fx.on, on ? 0 : 1) }} title={`${fx.label} on/off`} />
      <span className="vfx-vlabel">{fx.label}</span>
      {children}
    </div>
  )
}

// ——— Chorus ———
export function ChorusPanel({ color }: { color: string }) {
  const api = useVital()
  const { engine } = useEngine()
  const on = (api.v.chorus_on ?? 0) >= 0.5
  const voices = Math.round(v0(api, 'chorus_voices'))
  const d1 = v0(api, 'chorus_delay_1'), d2 = v0(api, 'chorus_delay_2'), depth = v0(api, 'chorus_mod_depth')
  const W = 879.2 - 641.7, H = 92.4 - 8.4
  const bars = useMemo(() => {
    // One pair of bars (left and right) per voice pair, placed between DELAY 1 and DELAY 2 (log time).
    const x = (e: number) => W * 0.3 + (e + 8) * 27.5
    const out: { x: number; w: number }[] = []
    const bw = 5 + depth * 6
    for (let i = 0; i < voices; i++) {
      const e = voices === 1 ? (d1 + d2) / 2 : d1 + ((d2 - d1) * i) / (voices - 1)
      const cx = x(e)
      out.push({ x: cx - bw - 0.4, w: bw }, { x: cx + 0.4, w: bw })
    }
    return out
  }, [voices, d1, d2, depth, W])
  return (
    <>
      <ValBox at={[397.9, Y1[0], 511.8, Y1[1]]} split={S1} label="VOICES"><TextValue p="chorus_voices" fmt={(x) => String(Math.round(x) * 4)} span={60} className="vfx-tv" /></ValBox>
      <TempoBox pre="chorus" at={[519.4, Y1[0], 634.0, Y1[1]]} />
      <Screen at={[641.7, Y1[0], 879.2, Y1[1]]}>
        {engine
          ? <ChorusBars w={W} h={H} color={color} on={on} />
          : bars.map((b, i) => <rect key={i} x={b.x} y={H * 0.255} width={b.w} height={H * 0.48} rx={b.w / 2.6} fill={over(color, 0.6)} stroke={over(color, 0.35)} strokeWidth={1.5} opacity={0.92} />)}
      </Screen>
      <BandFilterScreen at={[641.7, Y2[0], 879.2, Y2[1]]} cutoff="chorus_cutoff" spread="chorus_spread" color={color} fill="rgba(159,136,255,0.4)" on={on} />
      <K p="chorus_feedback" col={CD} row={1} color={color} label="FEEDBACK" />
      <K p="chorus_dry_wet" col={CE} row={1} color={color} label="MIX" />
      <K p="chorus_mod_depth" col={CA} row={2} color={color} label="DEPTH" />
      <K p="chorus_delay_1" col={CB} row={2} color={color} label="DELAY 1" />
      <K p="chorus_delay_2" col={CC} row={2} color={color} label="DELAY 2" />
      <K p="chorus_cutoff" col={CD} row={2} color={color} label="CUTOFF" />
      <K p="chorus_spread" col={CE} row={2} color={color} label="SPREAD" />
    </>
  )
}

// ——— Compressor ———
const BANDS = ['low', 'band', 'high'] as const
type CompPoint = 'upper_threshold' | 'lower_threshold' | 'upper_ratio' | 'lower_ratio'
// CompressorEditor constants: kCompressorAreaBuffer, kMinDb, kDbLineSections, kRatioDbLines, kGrabRadius (pt).
const COMP_BUFFER = 0.05, COMP_MIN_DB = -80, COMP_LINE_SECTIONS = 8, COMP_RATIO_LINES = 14, COMP_GRAB = 8
/** Stage px per Vital pt (the 1000-px stage draws Vital's 1440-pt window). */
const SCALE = 1000 / 1440
/** Which bands each MODE uses: Multiband all three, Low Band = low + band, High Band = band + high, Single = band. */
const BANDS_ON = [[1, 1, 1], [1, 1, 0], [0, 1, 1], [0, 1, 0]]
/** The multiband compressor display, drawn and edited as Vital's CompressorEditor (compressor_editor.cpp):
 *  per band, the region above the upper threshold and below the lower one shaded by the sign of its ratio,
 *  14 fading ratio lines per region stepped from the 10 dB grid, left / right output bars and 2 px input
 *  lines from the engine's band levels (sqrt of the mean squares, −80…0 dB). Drag a threshold (−80 dB per
 *  height, kept within −79…−1 and pushing the other) or the region beyond it for its ratio (0.6 per height);
 *  Shift moves all six thresholds; double-click a region resets its ratio. */
function CompressorScreen() {
  const api = useVital()
  const at: Rect = [641.7, 8.4, 1001.4, 185.1]
  const w = at[2] - at[0], h = at[3] - at[1]
  const mode = Math.round(v0(api, 'compressor_enabled_bands'))
  const lowOn = mode === 0 || mode === 1, highOn = mode === 0 || mode === 2
  const on = (api.v.compressor_on ?? 0) >= 0.5
  const box = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ band: number; what: CompPoint } | null>(null)
  const [popup, setPopup] = useState<string | null>(null)
  const last = useRef<number | null>(null)
  const levels = [
    [useStatusLanes('compressor_low_input'), useStatusLanes('compressor_low_output')],
    [useStatusLanes('compressor_band_input'), useStatusLanes('compressor_band_output')],
    [useStatusLanes('compressor_high_input'), useStatusLanes('compressor_high_output')],
  ] as const // BANDS, in order

  // Columns (renderCompressor): an 80 % active area in three, 5 % gaps; a missing low / high band's space goes to the band.
  const section = (1 - 4 * COMP_BUFFER) / 3
  let lowStart = COMP_BUFFER * w, lowEnd = (COMP_BUFFER + section) * w
  let bandStart = (2 * COMP_BUFFER + section) * w, bandEnd = w - bandStart
  let highStart = w - lowEnd, highEnd = w - lowStart
  if (!lowOn) { bandStart = lowStart; lowStart = lowEnd = -w }
  if (!highOn) { bandEnd = highEnd; highStart = highEnd = -w }
  const cols: [number, number][] = [[lowStart, lowEnd], [bandStart, bandEnd], [highStart, highEnd]]

  const yForDb = (db: number) => h * (1 - (2 * (Math.max(COMP_MIN_DB, Math.min(0, db)) - COMP_MIN_DB) / -COMP_MIN_DB - 1)) * 0.5
  const val = (band: number, k: string) => v0(api, `compressor_${BANDS[band]}_${k}`)
  const grab = COMP_GRAB * SCALE

  const hoverAt = (x: number, y: number): { band: number; what: CompPoint } | null => {
    const pos = (3 * x) / ((1 - COMP_BUFFER) * w)
    let index = Math.floor(pos)
    if (index >= 3 || index < 0 || pos - index < 3 * COMP_BUFFER) return null
    if (index === 0 && !lowOn) index = 1
    if (index === 2 && !highOn) index = 1
    const upperY = Math.max(grab, yForDb(val(index, 'upper_threshold'))), lowerY = Math.min(h - grab, yForDb(val(index, 'lower_threshold')))
    const du = y - upperY, dl = y - lowerY
    if (Math.abs(du) <= grab && Math.abs(du) < Math.abs(dl)) return { band: index, what: 'upper_threshold' }
    if (Math.abs(dl) <= grab) return { band: index, what: 'lower_threshold' }
    if (du < 0) return { band: index, what: 'upper_ratio' }
    if (dl > 0) return { band: index, what: 'lower_ratio' }
    return null
  }
  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * w, y: ((e.clientY - r.top) / r.height) * h }
  }
  const setThreshold = (band: number, which: 'upper' | 'lower', db: number, clamp: boolean) => {
    const id = `compressor_${BANDS[band]}_${which}_threshold`
    const v = clamp ? Math.max(COMP_MIN_DB + 1, Math.min(-1, db)) : db
    api.set(id, Math.max(COMP_MIN_DB + 1, Math.min(-1, v)))
    const other = which === 'upper' ? 'lower' : 'upper', otherV = val(band, `${other}_threshold`)
    if (clamp && (which === 'upper' ? v < otherV : v > otherV)) api.set(`compressor_${BANDS[band]}_${other}_threshold`, v)
    setPopup(`${v.toFixed(1)} dB`)
  }
  const move = (e: React.PointerEvent) => {
    const p = local(e)
    if (last.current === null || !hover) { setHover(hoverAt(p.x, p.y)); return }
    const delta = (p.y - last.current) / h
    last.current = p.y
    if (!delta) return
    if (e.shiftKey) {
      for (let band = 0; band < 3; band++) for (const which of ['upper', 'lower'] as const) setThreshold(band, which, val(band, `${which}_threshold`) + COMP_MIN_DB * delta, false)
      return
    }
    const { band, what } = hover
    if (what === 'upper_threshold') setThreshold(band, 'upper', val(band, what) + COMP_MIN_DB * delta, true)
    else if (what === 'lower_threshold') setThreshold(band, 'lower', val(band, what) + COMP_MIN_DB * delta, true)
    else if (what === 'upper_ratio') api.set(`compressor_${BANDS[band]}_upper_ratio`, Math.max(0, Math.min(1, val(band, what) + 0.6 * delta)))
    else api.set(`compressor_${BANDS[band]}_lower_ratio`, Math.max(-1, Math.min(1, val(band, what) - 0.6 * delta)))
  }

  const regions: ReactNode[] = [], lines: ReactNode[] = [], meters: ReactNode[] = []
  const regionColor = (ratio: number) => (!on ? 'rgba(255,255,255,0.067)' : ratio > 0 ? '#10735b' : ratio < 0 ? '#0b4039' : 'rgba(255,255,255,0.067)')
  cols.forEach(([x0, x1], band) => {
    if (x1 <= 0) return
    const tu = val(band, 'upper_threshold'), tl = val(band, 'lower_threshold'), ru = val(band, 'upper_ratio'), rl = val(band, 'lower_ratio')
    regions.push(<rect key={`u${band}`} x={x0} y={0} width={x1 - x0} height={yForDb(tu)} fill={regionColor(ru)} />)
    regions.push(<rect key={`l${band}`} x={x0} y={yForDb(tl)} width={x1 - x0} height={h - yForDb(tl)} fill={regionColor(-rl)} />)
    for (const [upper, threshold, ratio] of [[true, tu, ru], [false, tl, rl]] as const) {
      // setRatioLines: start on the 10 dB grid beyond the threshold, compress each line toward it.
      const position = (COMP_LINE_SECTIONS * (threshold - COMP_MIN_DB)) / -COMP_MIN_DB
      let db = (upper ? Math.ceil(position) : Math.floor(position)) * (-COMP_MIN_DB / COMP_LINE_SECTIONS) + COMP_MIN_DB
      const step = (upper ? 1 : -1) * (-COMP_MIN_DB / COMP_LINE_SECTIONS)
      const hot = hover?.band === band && hover.what === `${upper ? 'upper' : 'lower'}_ratio`
      for (let i = 0; i < COMP_RATIO_LINES; i++) {
        const out = db + (threshold - db) * ratio
        lines.push(<rect key={`${band}${upper}${i}`} x={x0} y={yForDb(out) - 2 * SCALE} width={x1 - x0} height={4 * SCALE}
          fill="#ffffff" opacity={Math.min(1, ((COMP_RATIO_LINES - i) * (hot ? 5 : 2.5)) / COMP_RATIO_LINES) * 0.133} />)
        db += step
      }
    }
    // Meters: output bars from the level down, 2 px input lines; left lane left of centre, right lane right.
    const barW = 0.2 * section * w, mid = (x0 + x1) / 2
    const [input, output] = levels[band]
    ;[0, 1].forEach((lane) => {
      const x = lane ? mid + SCALE : mid - barW
      const dbOf = (ms: number | undefined) => (ms === undefined || !Number.isFinite(ms) || ms <= 0 ? COMP_MIN_DB : 20 * Math.log10(Math.sqrt(ms)))
      const yo = yForDb(dbOf(output?.[lane])), yi = yForDb(dbOf(input?.[lane]))
      meters.push(<rect key={`o${band}${lane}`} x={x} y={yo} width={barW} height={h - yo} fill="#1de9b6" />)
      meters.push(<rect key={`i${band}${lane}`} x={x} y={yi - SCALE} width={barW} height={2 * SCALE} fill="#ffffff" />)
    })
  })
  const hoverLine = hover && hover.what.endsWith('threshold') && cols[hover.band][1] > 0
    ? <rect x={cols[hover.band][0]} y={yForDb(val(hover.band, hover.what)) - SCALE} width={cols[hover.band][1] - cols[hover.band][0]} height={2 * SCALE} fill="#ffffff" />
    : null

  return (
    <Screen at={at} className="vfx-comp" ref={box} style={{ cursor: hover ? 'ns-resize' : 'default' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        const p = local(e), hit = hoverAt(p.x, p.y)
        setHover(hit)
        if (!hit) return
        e.stopPropagation(); api.checkpoint(); last.current = p.y
        try { (e.currentTarget as Element).setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
      }}
      onPointerMove={move}
      onPointerUp={() => { last.current = null; setPopup(null) }}
      onPointerLeave={() => { if (last.current === null) setHover(null) }}
      onDoubleClick={(e) => { const p = local(e), hit = hoverAt(p.x, p.y); if (hit?.what.endsWith('ratio')) { api.checkpoint(); api.set(`compressor_${BANDS[hit.band]}_${hit.what}`, 0) } }}>
      {Array.from({ length: COMP_LINE_SECTIONS - 1 }, (_, i) => <rect key={i} x={0} y={(h * (i + 1)) / COMP_LINE_SECTIONS} width={w} height={SCALE} fill="rgba(255,255,255,0.133)" />)}
      {regions}
      {lines}
      {hoverLine}
      {meters}
      {popup && <foreignObject x={0} y={h - 22} width={w} height={22}><div className="vfx-comppop">{popup}</div></foreignObject>}
    </Screen>
  )
}

export function CompressorPanel({ color }: { color: string }) {
  const api = useVital()
  const mode = Math.round(v0(api, 'compressor_enabled_bands'))
  return (
    <>
      <MenuBox p="compressor_enabled_bands" at={[397.9, Y1[0], 552.8, Y1[1]]} split={S1} label="MODE" names={COMP_BANDS} short={['Multiband', 'Low Band', 'High Band', 'Single']} />
      <K p="compressor_mix" col={CC} row={1} color={color} label="MIX" />
      <K p="compressor_low_gain" col={CA} row={2} color={color} label="LOW" dim={!BANDS_ON[mode][0]} />
      <K p="compressor_band_gain" col={CB} row={2} color={color} label="BAND" dim={!BANDS_ON[mode][1]} />
      <K p="compressor_high_gain" col={CC} row={2} color={color} label="HIGH" dim={!BANDS_ON[mode][2]} />
      <CompressorScreen />
      <K p="compressor_attack" col={CE} row={1} color={color} label="ATTACK" />
      <K p="compressor_release" col={CE} row={2} color={color} label="RELEASE" />
    </>
  )
}

// ——— Delay ———
/** The delay's repeats (delay_section.cpp DelayViewer): 50 bars across a fixed 4 seconds from the left
 *  edge, the first the dry level and then the wet level decaying by the feedback, the left channel up from
 *  the centre and the right down (ping-pong styles interleave them). Tempo modes ignore the BPM, as
 *  Vital's display does. Drag up and down for the feedback. */
function DelayTaps({ color }: { color: string }) {
  const api = useVital()
  const at: Rect = [641.7, Y1[0], 879.2, Y1[1]]
  const w = at[2] - at[0], h = at[3] - at[1]
  const on = (api.v.delay_on ?? 0) >= 0.5
  // Each channel reads its own lane of the modulated values; the right channel of a stereo style reads
  // the aux controls' left lane (getRawFrequency / getTempoFrequency).
  const feedbacks = useFxLanes('delay_feedback'), mixes = useFxLanes('delay_dry_wet')
  const freqs = useFxLanes('delay_frequency'), auxFreq = useFxLanes('delay_aux_frequency')[0]
  const tempos = useFxLanes('delay_tempo'), auxTempo = useFxLanes('delay_aux_tempo')[0]
  const style = Math.round(v0(api, 'delay_style'))
  const sync = [Math.round(v0(api, 'delay_sync')), Math.round(v0(api, 'delay_aux_sync'))]
  const mono = style === 0
  const channel = (index: number) => (index && !mono ? 1 : 0)
  const frequency = (index: number) => {
    const aux = channel(index) === 1
    if (sync[channel(index)] === 0) return aux ? auxFreq : freqs[index]
    return Math.round(aux ? auxTempo : tempos[index]) - 6
  }
  const multiplier = (index: number) => { const m = sync[channel(index)]; return m === 2 ? 1.5 : m === 3 ? 2 / 3 : 1 }
  const fade = (t: number) => Math.sin((t * Math.PI) / 2) // futils::equalPowerFade
  const bars: ReactNode[] = []
  const N = 50
  for (const index of [0, 1] as const) {
    const feedback = Math.max(-1, Math.min(1, feedbacks[index]))
    const mix = Math.max(0, Math.min(1, mixes[index]))
    let wet = fade(mix)
    const dry = fade(1 - mix)
    const inc = (2 * Math.pow(2, -frequency(index)) * multiplier(index)) / 4
    const other = (2 * Math.pow(2, -frequency(1 - index)) * multiplier(1 - index)) / 4
    let even = inc, odd = inc, x = -1
    if (style === 2) { if (index) x -= other; even = inc + other; odd = even }
    else if (style === 3) { if (index === 0) { odd = other + inc; even = other } else { odd = inc; even = other + inc } }
    const barW = (Math.min(1, (N * inc) / 2) * 2) / N
    const fill = on ? color : '#4c4f52' // Delay: Widget Primary 1 and 2 are the same pink
    const toPx = (gx: number) => ((gx + 1) / 2) * w
    const bar = (gx: number, amount: number, k: number) => {
      const top = index ? h / 2 : h / 2 - (amount * h) / 2
      bars.push(<rect key={`${index}-${k}`} x={toPx(gx) - (barW / 2) * (w / 2)} y={top} width={barW * (w / 2)} height={(amount * h) / 2} fill={fill} />)
    }
    bar(-1, dry, 0)
    for (let i = 1; i < N; i++) {
      x += i % 2 ? odd : even
      bar(x, wet, i)
      wet *= Math.abs(feedback)
    }
  }
  const drag = useDrag((_dx, dy) => api.set('delay_feedback', v0(api, 'delay_feedback') + (dy * 2 / w) * 2))
  return <Screen at={at} {...drag}>{bars}</Screen>
}

export function DelayPanel({ color }: { color: string }) {
  const api = useVital()
  // Every mode but Mono shows the second (aux) tempo control (DelaySection::resizeTempoControls). Leaving
  // Mono copies the main tempo, sync and frequency into it, as the hidden aux controls would otherwise
  // keep stale values (DelaySection::sliderValueChanged).
  const style = Math.round(v0(api, 'delay_style'))
  const split = style !== 0
  const setStyle = (i: number) => {
    if (style === 0 && i !== 0) {
      api.set('delay_aux_tempo', v0(api, 'delay_tempo'))
      api.set('delay_aux_sync', v0(api, 'delay_sync'))
      api.set('delay_aux_frequency', v0(api, 'delay_frequency'))
    }
    api.set('delay_style', i)
  }
  return (
    <>
      {split
        ? <><TempoBox pre="delay" at={[397.9, Y1[0], 512, Y1[1]]} /><TempoBox pre="delay" aux at={[520, Y1[0], 634.0, Y1[1]]} /></>
        : <TempoBox pre="delay" at={[397.9, Y1[0], 634.0, Y1[1]]} />}
      <MenuBox p="delay_style" at={[397.9, Y2[0], 634.0, Y2[1]]} split={S2} label="MODE" names={DELAY_STYLES} onPick={setStyle} />
      <DelayTaps color={color} />
      <BandFilterScreen at={[641.7, Y2[0], 879.2, Y2[1]]} cutoff="delay_filter_cutoff" spread="delay_filter_spread" color={color} fill="rgba(255,153,233,0.4)" on={(api.v.delay_on ?? 0) >= 0.5} />
      <K p="delay_feedback" col={CD} row={1} color={color} label="FEEDBACK" />
      <K p="delay_dry_wet" col={CE} row={1} color={color} label="MIX" />
      <K p="delay_filter_cutoff" col={CD} row={2} color={color} label="CUTOFF" />
      <K p="delay_filter_spread" col={CE} row={2} color={color} label="SPREAD" />
    </>
  )
}

// ——— Distortion ———
export function DistortionPanel({ color }: { color: string }) {
  const api = useVital()
  const type = v0(api, 'distortion_type'), drive = v0(api, 'distortion_drive'), mix = v0(api, 'distortion_mix')
  const order = Math.round(v0(api, 'distortion_filter_order'))
  const cutoff = v0(api, 'distortion_filter_cutoff'), res = v0(api, 'distortion_filter_resonance'), blend = v0(api, 'distortion_filter_blend')
  const tw = 756.9 - 581.2, th = Y1[1] - Y1[0], fh = Y2[1] - Y2[0]
  const curve: [number, number][] = Array.from({ length: 121 }, (_, k) => { const x = -1 + (2 * k) / 120; return [(k / 120) * tw, th / 2 - distort(type, drive, mix, x) * (th / 2) * 0.9] })
  const cd = pathOf(curve)
  // Engine curves (DistortionViewer / DistortionFilterResponse) at the modulated drive and filter values.
  const on = (api.v.distortion_on ?? 0) >= 0.5
  const liveDrive = useFxLanes('distortion_drive'), liveCutoff = useFxLanes('distortion_filter_cutoff')
  const liveRes = useFxLanes('distortion_filter_resonance'), liveBlend = useFxLanes('distortion_filter_blend')
  const transfer = useEngineQuery(`${type}|${liveDrive}`, (e) => Promise.all([0, 1].map((i) => e.distortionCurve(Math.round(type), liveDrive[i], 128))))
  const response = useEngineQuery(`${liveCutoff}|${liveRes}|${liveBlend}`, (e) => Promise.all([0, 1].map((i) => e.distortionFilter(liveCutoff[i], liveRes[i], liveBlend[i], PARAMS.distortion_filter_cutoff.min))))
  const transferPath = (c: Float32Array) => pathOf(Array.from(c, (y, k) => [(k / (c.length - 1)) * tw, (1 - y) * (th / 2)] as [number, number]))
  const responsePath = (c: Float32Array) => pathOf(Array.from(c, (y, k) => [(k / (c.length - 1)) * tw, Math.max(-2, Math.min(fh + 2, (fh / 2) * (1 - y)))] as [number, number]))
  // Up drags the drive over its whole range per screen width (DistortionViewer::mouseDrag); the filter
  // screen moves cutoff sideways and resonance up and down.
  const fdrag = useDrag((dx, dy) => { api.set('distortion_filter_cutoff', v0(api, 'distortion_filter_cutoff') + (dx * 2 / tw) * 128); api.set('distortion_filter_resonance', v0(api, 'distortion_filter_resonance') + dy * 2 / fh) })
  const tdrag = useDrag((_dx, dy) => api.set('distortion_drive', v0(api, 'distortion_drive') + (dy * 2 / tw) * 60))
  const none = order === 0
  return (
    <>
      <MenuBox p="distortion_type" at={[397.9, Y1[0], 572.2, Y1[1]]} split={S1} label="TYPE" names={DIST_TYPES} short={DIST_TYPES_SHORT} />
      <MenuBox p="distortion_filter_order" at={[397.9, Y2[0], 572.2, Y2[1]]} split={S2} label="FILTER" names={DIST_FILTER_ORDER} />
      <Screen at={[581.2, Y1[0], 756.9, Y1[1]]} drop="distortion_drive" {...tdrag}>
        {transfer
          ? <Stereo d={[transferPath(transfer[0]), transferPath(transfer[1])]} close={` L ${tw} ${th / 2} L 0 ${th / 2} Z`} line={color} fill="rgba(255,82,82,0.4)" on={on} width={4 * SCALE} />
          : <><path d={`${cd} L ${tw} ${th / 2} L 0 ${th / 2} Z`} fill={on ? over(color, 0.4) : 'rgba(102,102,102,0.13)'} />
            <path d={cd} fill="none" stroke={on ? color : '#666666'} strokeWidth={3} /></>}
      </Screen>
      <Screen at={[581.2, Y2[0], 756.9, Y2[1]]} drop={none ? undefined : 'distortion_filter_cutoff'} {...fdrag}>
        {response
          ? <Stereo d={[responsePath(response[0]), responsePath(response[1])]} close={` L ${tw} ${fh + 2} L 0 ${fh + 2} Z`} line={color} fill="rgba(255,82,82,0.4)" on={on && !none} width={4 * SCALE} />
          : <Curve w={tw} h={fh} color={none ? '#5d6064' : color} fill={!none} fy={(f) => fh * (0.41 - filterDb(0, 0, cutoff, res, blend, f) * 0.035)} />}
      </Screen>
      <K p="distortion_drive" col={[765.3, 939.6]} row={1} color={color} label="DRIVE" bipolar={false} />
      <K p="distortion_mix" col={[948.6, 1122.9]} row={1} color={color} label="MIX" />
      <K p="distortion_filter_cutoff" col={[765.3, 878.5]} row={2} color={color} colorDim={none} label="CUTOFF" />
      <K p="distortion_filter_resonance" col={[887.5, 1000.7]} row={2} color={color} colorDim={none} label="RESONANCE" />
      <K p="distortion_filter_blend" col={[1009.7, 1122.9]} row={2} color={color} colorDim={none} label="BLEND" />
    </>
  )
}

// ——— Equalizer ———
const EQ_BANDS = ['low', 'band', 'high'] as const

/** The equalizer display (EqualizerResponse): the engine's curve over a ±15 dB axis plus 20 %; press
 *  anywhere and the nearest node within 0.06 × width is grabbed, then follows the pointer (cutoff = x,
 *  gain = y); the wheel over a node sets that band's resonance. A node's halo shows while dragging. */
const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12)
const EQ_MIN_FREQ = midiToHz(PARAMS.eq_low_cutoff.min), EQ_MAX_FREQ = midiToHz(PARAMS.eq_low_cutoff.max)
const EQ_SPECTRUM_SKIN = { line: 'rgba(255,255,255,0.133)', fill: 'rgb(59,62,66)', fillFade: 0.3 }

function EqScreen({ color, sel, setSel }: { color: string; sel: number; setSel: (b: number) => void }) {
  const api = useVital()
  const { engine } = useEngine()
  const at: Rect = [764.6, 8.4, 1123.6, 185.1]
  const w = at[2] - at[0], h = at[3] - at[1]
  const v = (k: string) => v0(api, k)
  const axis = eqAxis('eq_low_gain', 0.2)
  const band = (b: string) => ({ cutoff: `eq_${b}_cutoff`, resonance: `eq_${b}_resonance`, gain: `eq_${b}_gain`, mode: `eq_${b}_mode` })
  const data = useEqResponse([band(EQ_BANDS[0]), band(EQ_BANDS[1]), band(EQ_BANDS[2])])
  const [dragging, setDragging] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const nodeX = (b: string) => ((v(`eq_${b}_cutoff`) - PARAMS[`eq_${b}_cutoff`].min) / (PARAMS[`eq_${b}_cutoff`].max - PARAMS[`eq_${b}_cutoff`].min)) * w
  const nodeY = (b: string) => ((axis.max - v(`eq_${b}_gain`)) / (axis.max - axis.min)) * h
  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * w, y: ((e.clientY - r.top) / r.height) * h }
  }
  const nearest = (x: number, y: number) => {
    let best = -1, bestD = (0.06 * w) ** 2
    EQ_BANDS.forEach((b, i) => { const dd = (nodeX(b) - x) ** 2 + (nodeY(b) - y) ** 2; if (dd <= bestD) { best = i; bestD = dd } })
    return best
  }
  const moveTo = (band: number, x: number, y: number) => {
    const b = EQ_BANDS[band], c = PARAMS[`eq_${b}_cutoff`], g = PARAMS[`eq_${b}_gain`]
    api.set(`eq_${b}_cutoff`, c.min + Math.max(0, Math.min(1, x / w)) * (c.max - c.min))
    const ratio = Math.max(0, Math.min(1, (y - 0.5 * 0.2 * h) / ((1 - 0.2) * h)))
    api.set(`eq_${b}_gain`, ratio * (g.min - g.max) + g.max)
  }
  const wheel = useWheel((_dx, dy, e) => {
    const p = local(e), band = nearest(p.x, p.y)
    if (band < 0) return
    const id = `eq_${EQ_BANDS[band]}_resonance`, d = PARAMS[id]
    api.checkpoint(); api.set(id, v(id) + Math.sign(dy) * 0.035 * (d.max - d.min))
  })
  return (
    <Screen at={at} className="vfx-eq" ref={(el) => { box.current = el; wheel(el) }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        const p = local(e), band = nearest(p.x, p.y)
        if (band < 0) return
        e.stopPropagation(); setSel(band); setDragging(band); api.checkpoint()
        try { (e.currentTarget as Element).setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
      }}
      onPointerMove={(e) => { if (dragging !== null) { const p = local(e); moveTo(dragging, p.x, p.y) } }}
      onPointerUp={() => setDragging(null)} onPointerCancel={() => setDragging(null)}>
      {/* EqualizerResponse's frequency lines and the Spectrogram of the equalizer's own output behind the
          curve (EqualizerSection: Lighten Screen line, Widget Background overlaid with it as the fill). */}
      <SpectrogramGrid group w={w} h={h} minFreq={EQ_MIN_FREQ} maxFreq={EQ_MAX_FREQ} px={2000 / 1440} />
      {engine && (api.v.eq_on ?? 0) >= 0.5 && (
        <OutputDisplay group w={w} h={h} lineWidth={2 * 2000 / 1440} skin={EQ_SPECTRUM_SKIN}
          spectrogram={{ id: 2, source: 1, minDb: -50, maxDb: 0, minFreq: EQ_MIN_FREQ, maxFreq: EQ_MAX_FREQ }} />
      )}
      {engine && data
        ? <EqCurve px={2} data={data} w={w} h={h} axis={axis} line="#fff6e1" fill="rgba(255,246,225,0.2)" on={(api.v.eq_on ?? 0) >= 0.5} />
        : <Curve w={w} h={h} color={color} fill={false} fy={(f) => h / 2 - (eqDb(f, v) / 20) * (h / 2)} n={180} />}
      {dragging !== null && <circle cx={nodeX(EQ_BANDS[dragging])} cy={nodeY(EQ_BANDS[dragging])} r={0.18 * h} fill="rgba(255,255,255,0.1)" />}
      {EQ_BANDS.map((b, i) => (
        <circle key={b} cx={nodeX(b)} cy={nodeY(b)} r={0.06 * h} fill={i === sel ? color : 'none'} stroke={color} strokeWidth={i === sel ? 0 : 1} className="vfx-node" />
      ))}
    </Screen>
  )
}

export function EqPanel({ color }: { color: string }) {
  const api = useVital()
  const sel = (api.ui.eqBand as number) ?? 0
  const setSel = (b: number) => api.setUi({ eqBand: b })
  const band = EQ_BANDS[sel]
  const cols = [EA, EB, EC]
  return (
    <>
      {cols.map((c, i) => {
        const p = `eq_${EQ_BANDS[i]}_mode`, m = Math.round(v0(api, p))
        return (
          // The mode buttons (OpenGlShapeButton, useOnColors): a fixed shape per band (high pass, notch, low
          // pass) in the Equalizer's Icon Button On colour when on and Off when off.
          <Box key={i} at={B(c[0], 8.4, c[1], 49.8)} className={`vfx-eqbtn${m ? ' on' : ''}`} title={PARAMS[p].opts?.[m]}
            onClick={(e) => { e.stopPropagation(); api.checkpoint(); api.set(p, m ? 0 : 1); setSel(i) }}>
            <FilterIcon icon={(['highPass', 'notch', 'lowPass'] as const)[i]} className="vfx-eqicon" style={{}} />
          </Box>
        )
      })}
      <Box at={B(397.9, 57.3, 756.9, 59.7)} className="vfx-eqtrack"><i style={{ left: `${(sel * 100) / 3}%`, width: '33.3%', background: color }} /></Box>
      {['LOW', 'BAND', 'HIGH'].map((n, i) => (
        <span key={n} className={`vfx-eqtab${i === sel ? ' on' : ''}`} style={{ ...R(cols[i][0] - PX, 66, cols[i][1] - PX, 94), color: i === sel ? color : undefined }}
          onClick={(e) => { e.stopPropagation(); setSel(i) }}>{n}</span>
      ))}
      <K key={`g${band}`} p={`eq_${band}_gain`} col={EA} row={2} color={color} label="GAIN" dim={Math.round(v0(api, `eq_${band}_mode`)) === 1} />
      <K key={`c${band}`} p={`eq_${band}_cutoff`} col={EB} row={2} color={color} label="CUTOFF" />
      <K key={`r${band}`} p={`eq_${band}_resonance`} col={EC} row={2} color={color} label="RESONANCE" />
      <EqScreen color={color} sel={sel} setSel={setSel} />
    </>
  )
}

// ——— Filter ———
export function FilterPanel({ color }: { color: string }) {
  const api = useVital()
  const pre = 'filter_fx'
  const at: Rect = [765.3, 25.4, 1105.3, 167.4]
  const w = at[2] - at[0], h = at[3] - at[1]
  const v = (k: string) => v0(api, `${pre}_${k}`)
  const model = Math.round(v('model')), style = Math.round(v('style'))
  const mode = filterMode(model, style)
  const { engine } = useEngine()
  const [pressed, setPressed] = useState(false)
  // FilterResponse gestures: full range per width / height, no fine mode, no double-click; the wheel's
  // x and y go to cutoff and resonance (formant X / Y).
  const move = (dx: number, dy: number) => {
    if (model === 5) { api.set(`${pre}_formant_x`, v('formant_x') + dx * 2 / w); api.set(`${pre}_formant_y`, v('formant_y') + dy * 2 / h) }
    else { api.set(`${pre}_cutoff`, v('cutoff') + (dx * 2 / w) * 128); api.set(`${pre}_resonance`, v('resonance') + dy * 2 / h) }
  }
  const drag = useDrag((dx, dy) => move(dx, dy))
  const wheel = useWheel((dx, dy) => { api.checkpoint(); move(dx / 100 * 8, dy / 100 * 8) })
  return (
    <>
      <FilterModelSelector pre={pre} at={B(397.9, 8.7, 756.9, 93.4)} className="vt-sel big vfx-fsel" menuAt="below" />
      <K key={mode.firstKnob} p={`${pre}_${mode.firstKnob}`} col={EA} row={2} color={color} label={mode.label1} />
      <K p={`${pre}_mix`} col={EB} row={2} color={color} label="MIX" />
      <K key={mode.secondKnob} p={`${pre}_${mode.secondKnob}`} col={EC} row={2} color={color} label={mode.label2} />
      <FilterIcon icon={mode.left} className="vfx-fic" style={R(771 - PX, 6, 791 - PX, 19)} />
      <FilterIcon icon={mode.right} className="vfx-fic" style={R(1089 - PX, 6, 1109 - PX, 19)} />
      {mode.showBlend
        ? <HSlider p={`${pre}_blend`} at={B(800, 7.4, 1081.3, 17.4)} thumb={21.3} fillFrom={0.5} color="#ffffff" className="vfx-slide" popup="above" prefix="Blend: " snap={1} ringsAt="below" />
        : <HSlider p={`${pre}_formant_transpose`} at={B(800, 7.4, 1081.3, 17.4)} thumb={21.3} fillFrom={0.5} color="#ffffff" className="vfx-slide" popup="above" ringsAt="below" />}
      <Screen at={at} drop={`${pre}_cutoff`} {...drag} ref={wheel}
        onPointerDown={(e) => { drag.onPointerDown(e); setPressed(true) }} onPointerLeave={() => setPressed(false)}
        overlay={pressed && <>
          <Bubble at="below" text={mode.formant ? `Formant X: ${shown(`${pre}_formant_x`, v('formant_x'))}` : `Cutoff: ${shown(`${pre}_cutoff`, v('cutoff'))}`} />
          <Bubble at="right" text={mode.formant ? `Formant Y: ${shown(`${pre}_formant_y`, v('formant_y'))}` : `Resonance: ${shown(`${pre}_resonance`, v('resonance'))}`} />
        </>}>
        {engine
          ? <FilterCurve px={2} fx pre={pre} w={w} h={h} on={(api.v.filter_fx_on ?? 0) >= 0.5} />
          : <Curve w={w} h={h} color={color} fy={(f) => h * (0.526 - filterDb(model, style, v('cutoff'), v('resonance'), v('blend'), f, { formantX: v('formant_x'), formantY: v('formant_y'), transpose: v('formant_transpose') }) * 0.028)} />}
      </Screen>
      <VSlider p={`${pre}_${mode.formant ? 'formant_y' : 'resonance'}`} at={B(1113.3, 25.4, 1124, 167.4)} thumb={42} />
      <HSlider p={`${pre}_${mode.formant ? 'formant_x' : 'cutoff'}`} at={B(765.3, 175.4, 1105.3, 185.4)} thumb={43} fillFrom={0} color="#ffffff" className="vfx-slide" />
    </>
  )
}

// ——— Flanger and Phaser ———
function ModFxScreen({ kind, color }: { kind: 'flanger' | 'phaser'; color: string }) {
  const api = useVital()
  const at: Rect = kind === 'flanger' ? [581.2, 8.4, 879.2, 186.2] : [581.2, 26.1, 879.2, 184.8]
  const w = at[2] - at[0], h = at[3] - at[1]
  const v = (k: string) => v0(api, `${kind}_${k}`)
  const center = v('center'), depth = v('mod_depth'), off = v('phase_offset'), fbk = v('feedback'), mix = v('dry_wet')
  const span = kind === 'flanger' ? depth * 24 : depth
  const cL = center + (span / 2) * Math.sin(Math.PI / 2), cR = center + (span / 2) * Math.sin(Math.PI / 2 + 2 * Math.PI * off)
  const fy = kind === 'flanger'
    ? (c: number) => (f: number) => h * (0.52 - flangerDb(f, c, fbk, mix * 2) * 0.012)
    : (c: number) => (f: number) => h * (0.38 - phaserDb(f, c, fbk, mix, v('blend')) * 0.034)
  const { engine } = useEngine()
  // Sideways moves the centre over the full width; up and down the feedback over its full −1…1 per
  // height (FlangerResponse / PhaserResponse drags; no fine mode).
  const drag = useDrag((dx, dy) => { api.set(`${kind}_center`, v('center') + (dx * 2 / w) * 128); api.set(`${kind}_feedback`, v('feedback') + (dy * 4 / h)) })
  return (
    <Screen at={at} drop={`${kind}_center`} {...drag}>
      {engine
        ? <ModFxCurve px={2} kind={kind} w={w} h={h} on={(api.v[`${kind}_on`] ?? 0) >= 0.5} />
        : <><Curve w={w} h={h} color={color} fy={fy(cR)} n={320} alpha={[0.5, 0.4]} /><Curve w={w} h={h} color={color} fill={false} fy={fy(cL)} n={320} /></>}
    </Screen>
  )
}

export function FlangerPanel({ color }: { color: string }) {
  return (
    <>
      <TempoBox pre="flanger" at={[397.9, Y1[0], 572.2, Y1[1]]} />
      <K p="flanger_phase_offset" col={[397.9, 572.2]} row={2} color={color} label="OFFSET" />
      <ModFxScreen kind="flanger" color={color} />
      <K p="flanger_feedback" col={CD} row={1} color={color} label="FEEDBACK" />
      <K p="flanger_dry_wet" col={CE} row={1} color={color} label="MIX" />
      <K p="flanger_center" col={CD} row={2} color={color} label="CENTER" />
      <K p="flanger_mod_depth" col={CE} row={2} color={color} label="DEPTH" />
    </>
  )
}

export function PhaserPanel({ color }: { color: string }) {
  return (
    <>
      <TempoBox pre="phaser" at={[397.9, Y1[0], 572.2, Y1[1]]} />
      <K p="phaser_phase_offset" col={[397.9, 572.2]} row={2} color={color} label="OFFSET" />
      <HSlider p="phaser_blend" at={B(581.2, 8.1, 879.2, 18.1)} thumb={41} fillFrom={0.5} snap={1} popup="above" prefix="Blend: " color="#ffffff" className="vfx-slide vfx-pblend" ringsAt="below" />
      <ModFxScreen kind="phaser" color={color} />
      <K p="phaser_feedback" col={CD} row={1} color={color} label="FEEDBACK" />
      <K p="phaser_dry_wet" col={CE} row={1} color={color} label="MIX" />
      <K p="phaser_center" col={CD} row={2} color={color} label="CENTER" />
      <K p="phaser_mod_depth" col={CE} row={2} color={color} label="DEPTH" />
    </>
  )
}

// ——— Reverb ———
/** The reverb's feedback EQ (an EqualizerResponse with only the low and high shelves, buffer 0.4): the
 *  engine's curve, nodes grabbed and dragged as on the Equalizer; LOW / HIGH pick the knobs' band. */
function ReverbScreen({ color, sel, setSel }: { color: string; sel: number; setSel: (b: number) => void }) {
  const api = useVital()
  const { engine } = useEngine()
  const at: Rect = [506.7, 8, 685.3, 184.7]
  const w = at[2] - at[0], h = at[3] - at[1]
  const v = (k: string) => v0(api, k)
  const buffer = 0.4
  const axis = eqAxis('reverb_low_shelf_gain', buffer)
  const data = useEqResponse([{ cutoff: 'reverb_low_shelf_cutoff', gain: 'reverb_low_shelf_gain' }, null, { cutoff: 'reverb_high_shelf_cutoff', gain: 'reverb_high_shelf_gain' }])
  const lowC = v('reverb_low_shelf_cutoff'), lowG = v('reverb_low_shelf_gain'), highC = v('reverb_high_shelf_cutoff'), highG = v('reverb_high_shelf_gain')
  const names = ['low', 'high']
  const nodeX = (b: string) => { const d = PARAMS[`reverb_${b}_shelf_cutoff`]; return ((v(`reverb_${b}_shelf_cutoff`) - d.min) / (d.max - d.min)) * w }
  const nodeY = (b: string) => ((axis.max - v(`reverb_${b}_shelf_gain`)) / (axis.max - axis.min)) * h
  const [dragging, setDragging] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * w, y: ((e.clientY - r.top) / r.height) * h }
  }
  const nearest = (x: number, y: number) => {
    let best = -1, bestD = (0.06 * w) ** 2
    names.forEach((b, i) => { const dd = (nodeX(b) - x) ** 2 + (nodeY(b) - y) ** 2; if (dd <= bestD) { best = i; bestD = dd } })
    return best
  }
  const moveTo = (band: number, x: number, y: number) => {
    const b = names[band], c = PARAMS[`reverb_${b}_shelf_cutoff`], g = PARAMS[`reverb_${b}_shelf_gain`]
    api.set(`reverb_${b}_shelf_cutoff`, c.min + Math.max(0, Math.min(1, x / w)) * (c.max - c.min))
    const ratio = Math.max(0, Math.min(1, (y - 0.5 * buffer * h) / ((1 - buffer) * h)))
    api.set(`reverb_${b}_shelf_gain`, ratio * (g.min - g.max) + g.max)
  }
  const toX = (s: number) => (s / 128) * w, toY = (d: number) => 36.7 - d * 18.7
  const fallback = pathOf(Array.from({ length: 121 }, (_, k) => { const f = (k / 120) * 128; return [toX(f), toY(reverbEqDb(f, lowC, lowG, highC, highG))] as [number, number] }))
  return (
    <Screen at={at} className="vfx-rev" ref={box}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        const p = local(e), band = nearest(p.x, p.y)
        if (band < 0) return
        e.stopPropagation(); setSel(band); setDragging(band); api.checkpoint()
        try { (e.currentTarget as Element).setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
      }}
      onPointerMove={(e) => { if (dragging !== null) { const p = local(e); moveTo(dragging, p.x, p.y) } }}
      onPointerUp={() => setDragging(null)} onPointerCancel={() => setDragging(null)}>
      {engine && data
        ? <EqCurve px={2} data={data} w={w} h={h} axis={axis} line="#9898ff" line2="#8fa0ff" fill="rgba(143,160,255,0.4)" on={(api.v.reverb_on ?? 0) >= 0.5} />
        : <><path d={`${fallback} L ${w} ${toY(0)} L 0 ${toY(0)} Z`} fill={over(color, 0.5)} /><path d={fallback} fill="none" stroke={color} strokeWidth={3} /></>}
      <rect x={12} y={0} width={w - 24} height={2.4} fill="#4c4f52" />
      <rect x={12 + sel * (w - 24) / 2} y={0} width={(w - 24) / 2} height={2.4} fill={color} />
      {['LOW', 'HIGH'].map((n, i) => (
        <text key={n} x={i ? 126.3 : 53.3} y={22} textAnchor="middle" fontSize={20.4} fill={i === sel ? color : '#8a8d90'} className="vfx-revtab"
          onPointerDown={(e) => { e.stopPropagation(); setSel(i) }}>{n}</text>
      ))}
      {dragging !== null && <circle cx={nodeX(names[dragging])} cy={nodeY(names[dragging])} r={0.18 * h} fill="rgba(255,255,255,0.1)" />}
      {names.map((b, i) => (
        <circle key={b} cx={nodeX(b)} cy={nodeY(b)} r={0.06 * h} fill={i === sel ? color : 'none'} stroke={color} strokeWidth={i === sel ? 0 : 1} className="vfx-node" />
      ))}
    </Screen>
  )
}

export function ReverbPanel({ color }: { color: string }) {
  const api = useVital()
  const sel = (api.ui.reverbBand as number) ?? 0
  const b = sel ? 'high' : 'low'
  const c = (x0: number, x1: number): Col => [x0, x1]
  return (
    <>
      <K p="reverb_pre_low_cutoff" col={c(397.9, 500)} row={1} color={color} label="LOW CUT" />
      <K p="reverb_pre_high_cutoff" col={c(397.9, 500)} row={2} color={color} label="HIGH CUT" />
      <ReverbScreen color={color} sel={sel} setSel={(s) => api.setUi({ reverbBand: s })} />
      <K key={`c${b}`} p={`reverb_${b}_shelf_cutoff`} col={c(693.3, 793.3)} row={1} color={color} label="CUTOFF" />
      <K key={`g${b}`} p={`reverb_${b}_shelf_gain`} col={c(693.3, 793.3)} row={2} color={color} label="GAIN" />
      <K p="reverb_chorus_amount" col={c(803.3, 903.3)} row={1} color={color} label="CHOR AMT" />
      <K p="reverb_chorus_frequency" col={c(803.3, 903.3)} row={2} color={color} label="CHOR FREQ" />
      <K p="reverb_delay" col={c(912, 1013.3)} row={1} color={color} label="DELAY" />
      <K p="reverb_size" col={c(912, 1013.3)} row={2} color={color} label="SIZE" />
      <K p="reverb_dry_wet" col={c(1021.3, 1123.3)} row={1} color={color} label="MIX" />
      <K p="reverb_decay_time" col={c(1021.3, 1123.3)} row={2} color={color} label="TIME" />
    </>
  )
}

