import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { LineShape } from '../../../../web/engine-client.js'
import { loadLibrary, shiftedFile, type LibFile } from '../../engine/library'
import { lineFromEngine } from '../../engine/shapes'
import { openPopupBrowser } from './PopupBrowser'
import { learnItems } from '../../engine/midi'
import { routeSlot, statusLanes, useRouteLanes } from '../../engine/status'
import { Bubble } from './controls'
import { useVital, type Mod, type VitalApi } from './ctx'
import { R, useDrag } from './hooks'
import { powerCurve } from './draw'
import { type Line, LINEAR, PAINT_SHAPES } from './line'
import { GridValue, LineEditor, PatternBox } from './LineEditor'
import { amountScale, MOD_LISTS, shownAmount } from './params'
import './matrix.css'

// Vital's MATRIX page (s0c, s4a, s4m-h…o in the deep capture): one row per modulation connection plus
// an empty row to make a new one (choose its source and destination), the BIPOLAR / STEREO toggles, the
// MORPH curve (the connection's power, dragged up or down), the AMOUNT slider and, under the list, the
// selected row's MOD REMAP curve editor. Positions are the capture's 2000-wide frame, relative to the
// page's top-left (127, 108), halved by `R`.

/** The matrix menus' source names (getMenuSourceDisplayName) and order: Vital sorts its sources by id,
 *  naturally (aftertouch first). */
const SRC_NAMES: Record<string, string> = {
  aftertouch: 'Pressure', lift: 'Lift', mod_wheel: 'Mod Wheel', note: 'Note', note_in_octave: 'Note In Octave',
  pitch_wheel: 'Pitch Wheel', random: 'Rand', slide: 'Slide', stereo: 'Stereo', velocity: 'Velocity',
}
const srcName = (id: string) => SRC_NAMES[id] ?? id.replace(/^env_(\d)$/, 'Env $1').replace(/^lfo_(\d)$/, 'Lfo $1').replace(/^random_(\d)$/, 'Rand $1').replace(/^macro_control_(\d)$/, 'Macro $1')
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })
const SRC_IDS = [...MOD_LISTS.sources].sort(natural)

/** kDestinationSubMenuPrefixes, Delay twice as Vital lists it; `local` submenus show each control's
 *  local description, the rest its display name. */
const SUBMENUS: ({ prefix: string; name: string; local?: boolean } | 'sep')[] = [
  'sep',
  { prefix: 'osc_1_', name: 'Oscillator 1', local: true }, { prefix: 'osc_2_', name: 'Oscillator 2', local: true },
  { prefix: 'osc_3_', name: 'Oscillator 3', local: true }, { prefix: 'sample_', name: 'Sample' },
  { prefix: 'filter_1_', name: 'Filter 1', local: true }, { prefix: 'filter_2_', name: 'Filter 2', local: true },
  { prefix: 'filter_fx_', name: 'Filter FX', local: true },
  'sep',
  { prefix: 'lfo_', name: 'LFOs' }, { prefix: 'random_', name: 'Randoms' }, { prefix: 'env_', name: 'Envelopes' },
  { prefix: 'modulation_', name: 'Mod Matrix' },
  'sep',
  { prefix: 'chorus_', name: 'Chorus' }, { prefix: 'compressor_', name: 'Compressor' }, { prefix: 'delay_', name: 'Delay' },
  { prefix: 'distortion_', name: 'Distortion' }, { prefix: 'phaser_', name: 'Phaser' }, { prefix: 'flanger_', name: 'Flanger' },
  { prefix: 'reverb_', name: 'Reverb' }, { prefix: 'delay_', name: 'Delay' }, { prefix: 'eq_', name: 'Equalizer' },
]

interface Group { name: string; items: { id: string; label: string }[] }
type MenuRow = Group | 'sep' | 'none'

/** ModulationMatrix's destination menu: "-", Global (every destination no submenu claims), then the
 *  submenus, each listing its destinations in natural id order. */
function buildGroups(): MenuRow[] {
  const ids = MOD_LISTS.destinations.map((d) => d.id).sort(natural)
  const info = new Map(MOD_LISTS.destinations.map((d) => [d.id, d]))
  const prefixes = SUBMENUS.flatMap((s) => (s === 'sep' ? [] : [s.prefix]))
  const global = ids.filter((id) => !prefixes.some((p) => id.startsWith(p))).map((id) => ({ id, label: info.get(id)!.name }))
  return ['none', { name: 'Global', items: global }, ...SUBMENUS.map((s): MenuRow => s === 'sep' ? 'sep' : {
    name: s.name,
    items: ids.filter((id) => id.startsWith(s.prefix)).map((id) => ({ id, label: s.local ? info.get(id)!.local : info.get(id)!.name })),
  })]
}

/** ModulationSelector::getTextFromValue (getMenuSourceDisplayName): the id with the first "control_"
 *  dropped and each token capitalized — "Eq Band Cutoff", "Macro 1". */
const dstName = (id: string) => id.replace('control_', '').split('_').filter(Boolean).map((t) => t[0].toUpperCase() + t.slice(1)).join(' ')

// ── MOD REMAP ────────────────────────────────────────────────────────────────────────────────────────

/** Where a routing's remap curve lives in the UI state (absent = linear). */
export const remapKey = (m: { src: string; dst: string }) => `mxRemap:${m.src}>${m.dst}`

/** The selected row's remap (ModulationMatrix's map editors, LineMapEditor): the shared line editor,
 *  not looping, animated by the routing's live source value; greyed out while the row has no
 *  connection. Its top bar is the editors' own: paint and pattern, grid X / Y, smooth, the shape. */
function RemapPanel({ api, n, mod }: { api: VitalApi; n: number; mod: Mod | null }) {
  const key = mod ? remapKey(mod) : null
  const r: Line = (key && (api.ui[key] as Line | undefined)) || LINEAR
  const put = (x: Line) => { if (key) api.setUi({ [key]: x }) }
  const paint = !!api.ui.mxPaint
  const pattern = (api.ui.mxPattern as number) ?? 0
  const gx = (api.ui.mxGridX as number) ?? 8, gy = (api.ui.mxGridY as number) ?? 1
  const [shownPaint, setShownPaint] = useState<boolean | null>(null)
  const painting = shownPaint ?? paint
  const on = !!mod
  // ModulationMatrix::loadFile: an LFO file as the remap curve, named after the file; the name opens the
  // LFO browser to the selector's right, ‹ › step through every LFO file.
  const fileKey = key ? `${key}:file` : ''
  const loadCurve = async (f: LibFile) => {
    if (!on) return
    try {
      const shape = lineFromEngine(JSON.parse(await (await f.file()).text()) as LineShape)
      api.checkpoint(); put({ ...shape, name: f.name }); api.setUi({ [fileKey]: f.key })
    } catch { /* not an LFO file */ }
  }
  const step = (k: number) => (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!on) return
    void loadLibrary().then(() => { const f = shiftedFile('lfo', api.ui[fileKey] as string | undefined, k); if (f) void loadCurve(f) })
  }
  const browse = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!on) return
    openPopupBrowser(api, { owner: 'remap', kind: 'lfo', at: [1122, 750, 1834, 1104], ignore: [127, 108, 1131, 1140] },
      (f) => void loadCurve(f), () => api.ui[fileKey] as string | undefined)
  }
  return (
    <div className={`vmx-remap${on ? ' on' : ''}`} style={R(0, 634.6, 1004, 1032)}>
      <span className="vmx-rtitle" style={{ left: 35 / 2, top: 0, height: 45 / 2 }}>MOD REMAP {n}</span>
      <div className="vmx-hbox" style={R(218, 7.4, 335, 37.4)}>
        <span className={`vmx-brush${painting ? ' on' : ''}`} title="Paint" onClick={() => api.setUi({ mxPaint: !paint })}>
          <svg viewBox="0 0 14 14"><path d="M12.5 1.5 L6 8 M5.4 8.6 C3.6 8.6 3 9.8 2.6 12 C4.6 11.8 6 11.2 6 9.2 Z" stroke="currentColor" strokeWidth={1.6} fill="currentColor" strokeLinecap="round" /></svg>
        </span>
        <span className="vmx-pattern" title="Paint pattern">
          <PatternBox value={pattern} active={painting} w={36} h={14} onChange={(v) => api.setUi({ mxPattern: v })} />
        </span>
      </div>
      <div className="vmx-hbox vmx-grid vt-chip flat" style={R(345.5, 7.4, 440, 37.4)}>
        <GridValue value={gx} max={32} def={8} title="Grid X" onChange={(v) => api.setUi({ mxGridX: v })} /><span className="dash">–</span>
        <GridValue value={gy} max={24} def={1} title="Grid Y" onChange={(v) => api.setUi({ mxGridY: v })} />
      </div>
      <span className={`vmx-smooth${r.smooth ? ' on' : ''}`} style={{ left: 471 / 2 - 9, top: 22.4 / 2 - 0 }} title="Smooth"
        onClick={() => { if (!on) return; api.checkpoint(); put({ ...r, smooth: !r.smooth }) }}>
        <svg viewBox="0 0 18 16"><path d="M3 13 C 3 6, 15 10, 15 3" fill="none" stroke="currentColor" strokeWidth={1.6} /><circle cx={3} cy={13} r={2} fill="currentColor" /><circle cx={15} cy={3} r={2} fill="currentColor" /></svg>
      </span>
      <div className="vt-b vt-sel vmx-shape" style={R(503.6, 7.4, 995, 37.4)}>
        <span className="arr" onClick={step(-1)}>‹</span>
        <span className="nm" onClick={browse}>{r.name}</span>
        <span className="arr" onClick={step(1)}>›</span>
      </div>
      <LineEditor at={[7.8, 45, 997, 388.4]} className="vmx-rdisp" line={r} onChange={put} loop={false} active={on}
        gridX={gx} gridY={gy} paint={paint} pattern={pattern}
        onPaintShown={(v) => setShownPaint(v === paint ? null : v)}
        onScroll={(dir) => (painting
          ? api.setUi({ mxPattern: (pattern + dir + PAINT_SHAPES.length) % PAINT_SHAPES.length })
          : api.setUi({ mxGridX: Math.max(1, Math.min(32, gx + dir)) }))}
        input={{ kind: 'map', read: () => { const slot = mod ? routeSlot(mod.src, mod.dst) : null; return slot ? statusLanes(`modulation_source_${slot}`) : null } }} />
    </div>
  )
}

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────────────

type SortKey = 'num' | 'src' | 'bip' | 'ste' | 'mor' | 'amt' | 'dst'
const COLS: { key: SortKey; label: string; x0: number; x1: number }[] = [
  { key: 'num', label: '#', x0: 20, x1: 68 }, { key: 'src', label: 'SOURCE', x0: 68, x1: 268.5 }, { key: 'bip', label: 'BIPOLAR', x0: 268.5, x1: 347.7 },
  { key: 'ste', label: 'STEREO', x0: 347.7, x1: 427 }, { key: 'mor', label: 'MORPH', x0: 427, x1: 506 }, { key: 'amt', label: 'AMOUNT', x0: 506, x1: 764.4 },
  { key: 'dst', label: 'DESTINATION', x0: 764.4, x1: 985 },
]
const ROW_H = 48.5
const TRACK: [number, number] = [525, 752]
const ROTARY_LENGTH = 200 * 1000 / 1440 // kDefaultRotaryDragLength in stage px

function AmountSlider({ api, i, mod }: { api: VitalApi; i: number; mod: Mod | null }) {
  const [dragging, setDragging] = useState(false)
  const g = useDrag((dx, _dy, shift) => {
    if (!mod) return
    setDragging(true)
    api.setMod(i, { amt: Math.max(-1, Math.min(1, api.getMods()[i].amt + (dx * 2) / ((TRACK[1] - TRACK[0]) / 2) / (shift ? 10 : 1))) })
  }, () => setDragging(false))
  const w = (TRACK[1] - TRACK[0]) / 2, th = 21.5
  const amt = mod?.amt ?? 0
  const c = Math.max(th / 2, Math.min(w - th / 2, w / 2 + (amt * w) / 2))
  return (
    <div className={`vmx-amount${mod ? '' : ' empty'}`} style={R(TRACK[0], 19, TRACK[1], 29.2)} {...(mod ? g : {})}
      onDoubleClick={(e) => { e.stopPropagation(); if (mod) { api.checkpoint(); api.setMod(i, { amt: 0 }) } }}
      onContextMenu={(e) => {
        e.preventDefault(); e.stopPropagation()
        if (!mod) return
        // The amount is a SynthSlider (modulation_N_amount): its usual menu.
        api.openMenu({ w: 120, items: [
          { label: 'Set to Default Value', act: () => { api.checkpoint(); api.setMod(i, { amt: 0 }) } },
          ...learnItems(`modulation_${routeSlot(mod.src, mod.dst) ?? i + 1}_amount`),
          { label: 'Enter Value', act: () => {
            const s = window.prompt('Amount', shownAmount(mod.dst, mod.amt))
            const n = s == null ? NaN : parseFloat(s)
            if (!Number.isNaN(n)) { api.checkpoint(); api.setMod(i, { amt: Math.max(-1, Math.min(1, n / amountScale(mod.dst))) }) }
          } },
        ] }, e)
      }}>
      {mod && <i className="fill" style={{ left: Math.min(c, w / 2), width: Math.abs(c - w / 2) }} />}
      <i className="thumb" style={{ left: c - th / 2, width: th }}>
        {mod && dragging && <Bubble text={shownAmount(mod.dst, amt)} />}
      </i>
    </div>
  )
}

/** The MORPH control (the row's power slider in CurveLookAndFeel): a rotary that drags up or right
 *  (Cmd/Ctrl fine), double-click resets; drawn as the curve powerScale(t, −value), an S through the
 *  middle when the row is bipolar, in Rotary Arc, greyed while the row has no connection. */
function MorphBox({ api, i, mod }: { api: VitalApi; i: number; mod: Mod | null }) {
  const g = useDrag((dx, dy, fine) => { if (mod) api.setMod(i, { power: Math.max(-10, Math.min(10, api.getMods()[i].power + ((dx + dy) * 20 / ROTARY_LENGTH) * (fine ? 0.1 : 1))) }) })
  const value = mod?.power ?? 0, power = -value
  const size = 20, lw = 2 * 1000 / 1440, active = size - lw
  const x0 = lw / 2, y0 = size - lw / 2
  let d = `M${x0} ${y0}`
  if (mod?.bipolar) {
    const half = active / 2
    for (let k = 0; k < 8; k++) { const t = (2 * (k + 1)) / 16; d += `L${(x0 + t * half).toFixed(2)} ${(y0 - powerCurve(t, -power) * half).toFixed(2)}` }
    for (let k = 0; k < 8; k++) { const t = (2 * (k + 1)) / 16; d += `L${(x0 + t * half + half).toFixed(2)} ${(y0 - powerCurve(t, power) * half - half).toFixed(2)}` }
  } else {
    for (let k = 0; k < 16; k++) { const t = (k + 1) / 16; d += `L${(x0 + t * active).toFixed(2)} ${(y0 - powerCurve(t, power) * active).toFixed(2)}` }
  }
  return (
    <div className="vmx-morph" style={R(446, 4.3, 485.5, 43.9)} {...(mod ? g : {})} title={mod ? `Morph: ${value.toFixed(2)}` : undefined}
      onDoubleClick={(e) => { e.stopPropagation(); if (mod) { api.checkpoint(); api.setMod(i, { power: 0 }) } }}>
      <svg viewBox={`0 0 ${size} ${size}`}><path d={d} fill="none" stroke={mod ? '#aa88ff' : '#4c4f52'} strokeWidth={lw} strokeLinecap="round" strokeLinejoin="bevel" /></svg>
    </div>
  )
}

/** The row's live modulation meter (ModulationMeterReadouts): 2-pt bars along the destination box's
 *  bottom from its centre, out to the routing's scaled amount (modulation_amount_N), left lane then right. */
function RowMeter({ m }: { m: Mod }) {
  const lanes = useRouteLanes(m.src, m.dst, 'amount')
  if (!lanes) return null
  const [x0, x1] = [764.5, 984], w = x1 - x0, mid = (x0 + x1) / 2
  return (
    <>
      {[[0, '#1de952'], [1, '#1dc2e9']].map(([lane, color]) => {
        const v = lanes[lane as number]
        const t = Math.max(0, Math.min(1, 0.5 * ((Number.isFinite(v) ? v : 0) + 1)))
        const x = x0 + t * w
        return <i key={lane} className="vmx-meter" style={{ ...R(Math.min(mid, x), 43.9 - 2 * 2000 / 1440, Math.max(mid, x), 43.9), background: color as string }} />
      })}
    </>
  )
}

const BipolarIcon = () => <svg viewBox="0 0 30 12"><path d="M1 6 L7 1 V4 H11 V8 H7 V11 Z M29 6 L23 1 V4 H19 V8 H23 V11 Z" fill="currentColor" /><circle cx={15} cy={6} r={3} fill="currentColor" /></svg>
const StereoIcon = () => <svg viewBox="0 0 22 20"><path d="M3 13 V10 A8 8 0 0 1 19 10 V13" fill="none" stroke="currentColor" strokeWidth={2} /><rect x={2} y={11} width={4.5} height={8} rx={1.6} fill="currentColor" /><rect x={15.5} y={11} width={4.5} height={8} rx={1.6} fill="currentColor" /></svg>

interface MenuState { kind: 'src' | 'dst'; row: number | 'new'; top: number }

export function MatrixPage() {
  const api = useVital()
  const { mods } = api
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'num', dir: 1 })
  const [pending, setPending] = useState<{ src?: string; dst?: string }>({})
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [cat, setCat] = useState<string | null>(null)
  const groups = useMemo(buildGroups, [])
  const selRaw = api.ui.mxSel as number | undefined
  const sel = selRaw === undefined ? (mods.length ? 0 : mods.length) : Math.min(selRaw, mods.length)
  const select = (i: number) => api.setUi({ mxSel: i })

  useEffect(() => {
    if (!menu) return
    const off = (e: PointerEvent) => { if (!(e.target as Element).closest?.('.vmx-menu')) setMenu(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(null) } }
    window.addEventListener('pointerdown', off, true)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('pointerdown', off, true); window.removeEventListener('keydown', key, true) }
  }, [menu])

  const rows = mods.map((m, i) => ({ m, i }))
  const val = (m: Mod, i: number, k: SortKey): string | number => k === 'num' ? i : k === 'src' ? srcName(m.src) : k === 'dst' ? dstName(m.dst) : k === 'bip' ? +m.bipolar : k === 'ste' ? +m.stereo : k === 'mor' ? m.power : m.amt
  rows.sort((a, b) => { const x = val(a.m, a.i, sort.key), y = val(b.m, b.i, sort.key); return (x < y ? -1 : x > y ? 1 : a.i - b.i) * sort.dir })

  const setSrc = (row: number | 'new', src: string | null) => {
    setMenu(null)
    api.checkpoint()
    if (row === 'new') {
      const p = { ...pending, src: src ?? undefined }
      if (p.src && p.dst) { const at = mods.findIndex((m) => m.src === p.src && m.dst === p.dst); api.addMod(p.src, p.dst); select(at >= 0 ? at : mods.length); setPending({}) } else setPending(p)
      return
    }
    if (!src) { api.removeMod(row); return }
    if (mods.some((m, j) => j !== row && m.src === src && m.dst === mods[row].dst)) return
    api.setMod(row, { src })
  }
  // The destination menu is a DualPopupSelector: a pick applies and the menu stays open on that row
  // (a new routing's row once it's made); "-" removes the routing and closes it.
  const setDst = (row: number | 'new', dst: string | null) => {
    api.checkpoint()
    if (row === 'new') {
      const p = { ...pending, dst: dst ?? undefined }
      if (p.src && p.dst) {
        const at = mods.findIndex((m) => m.src === p.src && m.dst === p.dst)
        api.addMod(p.src, p.dst); select(at >= 0 ? at : mods.length); setPending({})
        setMenu((cur) => (cur ? { ...cur, row: at >= 0 ? at : mods.length } : cur))
      } else setPending(p)
      return
    }
    if (!dst) { setMenu(null); api.removeMod(row); return }
    if (mods.some((m, j) => j !== row && m.dst === dst && m.src === mods[row].src)) return
    api.setMod(row, { dst })
  }
  const open = (kind: 'src' | 'dst', row: number | 'new', top: number) => () => {
    select(row === 'new' ? mods.length : row)
    const cur = kind === 'dst' ? (row === 'new' ? pending.dst : mods[row]?.dst) : null
    const g = cur ? groups.find((x) => typeof x === 'object' && x.items.some((it) => it.id === cur)) : null
    setCat(g && typeof g === 'object' ? g.name : null)
    setMenu({ kind, row, top })
  }
  const allRows = [...rows.map(({ m, i }) => ({ m: m as Mod | null, i })), { m: null, i: mods.length }]
  const curGroup = groups.find((g) => typeof g === 'object' && g.name === cat) as Group | undefined
  const menuDst = menu?.kind === 'dst' ? (menu.row === 'new' ? pending.dst : mods[menu.row]?.dst) : undefined

  return (
    <div className="vmx">
      <div className="vmx-head" style={R(0, 0, 1004, 44.5)}>
        {COLS.map((c) => (
          <span key={c.key} className={`vmx-hcol${sort.key === c.key ? ' sorted' : ''}`} style={R(c.x0, 0, c.x1, 44.5)}
            onClick={() => { setSort((s) => ({ key: c.key, dir: s.key === c.key ? (s.dir === 1 ? -1 : 1) : 1 })) }}>
            {c.label}{sort.key === c.key && <i className={`vmx-arrow${sort.dir === -1 ? ' up' : ''}`} />}
          </span>
        ))}
      </div>
      <div className="vmx-rows" style={R(0, 45.5, 1004, 630)}>
        {allRows.map(({ m, i }, k) => {
          const isNew = !m
          const top = k * ROW_H
          const selected = i === sel
          const srcTxt = m ? srcName(m.src) : pending.src ? srcName(pending.src) : '-'
          const dstTxt = m ? dstName(m.dst) : pending.dst ? dstName(pending.dst) : '-'
          const row = isNew ? 'new' as const : i
          return (
            <div key={isNew ? 'new' : `${m!.src}>${m!.dst}`} className={`vmx-row${m ? ' on' : ''}${m?.bypass ? ' bypass' : ''}${selected ? ' sel' : ''}`} style={R(0, top, 1004, top + 48)}
              onClick={() => select(i)}>
              <i className="vmx-bar" style={R(7.8, 11.8, 12, 36.1)} /><i className="vmx-bar" style={R(992.5, 11.8, 996.7, 36.1)} />
              <span className={`vmx-num${m ? ' btn' : ''}`} style={R(20, 0, 68, 48)} title={m ? (m.bypass ? 'Bypassed' : 'Bypass') : undefined}
                onClick={() => { select(i); if (m) { api.checkpoint(); api.setMod(i, { bypass: !m.bypass }) } }}>{m?.bypass ? 'X' : i + 1}</span>
              <span className="vmx-box" style={R(68, 4.3, 263.4, 43.9)} onClick={open('src', row, top)}>{srcTxt}</span>
              <span className={`vmx-icon${m?.bipolar ? ' on' : ''}`} style={R(268.5, 0, 347.7, 48)}
                onClick={() => { select(i); if (m) { api.checkpoint(); api.setMod(i, { bipolar: !m.bipolar }) } }}><BipolarIcon /></span>
              <span className={`vmx-icon ste${m?.stereo ? ' on' : ''}`} style={R(347.7, 0, 427, 48)}
                onClick={() => { select(i); if (m) { api.checkpoint(); api.setMod(i, { stereo: !m.stereo }) } }}><StereoIcon /></span>
              <MorphBox api={api} i={i} mod={m} />
              <AmountSlider api={api} i={i} mod={m} />
              {m && <RowMeter m={m} />}
              <span className={`vmx-box${!m && pending.dst ? ' part' : ''}`} style={R(764.5, 4.3, 984, 43.9)} onClick={open('dst', row, top)}>{dstTxt}</span>
            </div>
          )
        })}
      </div>
      <RemapPanel api={api} n={sel + 1} mod={mods[sel] ?? null} />

      {menu?.kind === 'src' && (
        <div className="vmx-menu vmx-srcmenu" style={{ left: 68 / 2, top: -68.4 / 2 } as CSSProperties} onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => setSrc(menu.row, null)}>-</button>
          {SRC_IDS.map((id) => <button key={id} type="button" onClick={() => setSrc(menu.row, id)}>{srcName(id)}</button>)}
        </div>
      )}
      {menu?.kind === 'dst' && (
        <div className="vmx-menu vmx-dstmenu" style={{ left: 985 / 2, top: 30 / 2 } as CSSProperties} onClick={(e) => e.stopPropagation()}>
          <div className="col">
            {groups.map((g, j) => g === 'sep' ? <i key={j} className="sep" />
              : g === 'none' ? <button key={j} type="button" onClick={() => setDst(menu.row, null)}>-</button>
              : <button key={j} type="button" className={cat === g.name ? 'hi' : ''} onClick={() => setCat(g.name)}>{g.name}</button>)}
          </div>
          <div className="col right">
            {curGroup?.items.map((it) => <button key={it.id} type="button" className={it.id === menuDst ? 'cur' : ''} onClick={() => setDst(menu.row, it.id)}
              onDoubleClick={() => { if (it.id === menuDst) setMenu(null) }}>{it.label}</button>)}
          </div>
        </div>
      )}
    </div>
  )
}
