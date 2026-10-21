import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { SynthEngine } from '../../../../web/engine-client.js'
import { readAudioFile } from '../../engine/audioFile'
import { useEngine } from '../../engine/EngineContext'
import { loadLibrary, shiftedFile, type LibFile } from '../../engine/library'
import { lineFromEngine, lineToEngine } from '../../engine/shapes'
import { useVital, type MenuItem, type VitalApi } from './ctx'
import { R, useWheel, type Rect } from './hooks'
import { LineEditor, type LineSkin } from './LineEditor'
import type { Line } from './line'
import { openPopupBrowser } from './PopupBrowser'
import { requestSave } from './SaveOverlay'
import { loadTableFile, tableChanged } from './wavetableIO'
import './wtedit.css'

// Vital's wavetable editor (WavetableEditSection, opened from an oscillator's pencil): the frame edit
// box (the frame at the playhead, its harmonic amplitudes and phases, and over them the selected
// component's overlay), and the timeline (the playhead, the component list and the keyframe
// organizer). Everything edits the oscillator's own WavetableCreator in the engine (vs_wt_* in
// web_synth.cpp). Ported from interface/editor_sections/wavetable_edit_section.cpp and
// interface/wavetable/; positions are the 1.5.5 capture's (s1k, s1l, s1m) in its 2000-wide frame.

const PT = 2000 / 1440 // one Vital point in the capture's frame
const FRAMES = 257 // vital::kNumOscillatorWaveFrames
const LAST = FRAMES - 1
const BARS = 1025 // WaveFrame::kNumRealComplex
const SIZE = 2048 // WaveFrame::kWaveformSize

const WAVE: Rect = [22, 115, 1978, 535]
const AMP: Rect = [22, 543, 1978, 733]
const PHASE: Rect = [22, 741, 1978, 827]
const GEAR: Rect = [22, 543, 50, 571]
const TL: Rect = [14, 848, 1986, 1203]
const PLAY_H = (TL[3] - TL[1]) * (1 / 8) // WavetableOrganizer::kHandleHeightPercent
const ORG_X = TL[0] + (TL[2] - TL[0]) / 4
const ROW_TOP = TL[1] + PLAY_H
/** WavetableOrganizer::handleWidth: odd whole points, an eighth of its height. */
const HANDLE = (1 + 2 * Math.floor(((TL[3] - ROW_TOP) / PT) * (1 / 8) * 0.5)) * PT
const ORG: Rect = [ORG_X, ROW_TOP, TL[2], TL[3]]
const LIST: Rect = [TL[0], ROW_TOP, ORG_X, TL[3]]
const PLAYHEAD: Rect = [ORG_X, TL[1], TL[2], ROW_TOP]
const FRAME_W = (ORG[2] - ORG[0] - HANDLE + PT) / (FRAMES - 1)
const CELL = HANDLE - 2 * PT
/** The overlays' controls strip: centred over the amplitudes, a third of their height. */
const EDIT_Y = AMP[1], EDIT_H = (AMP[3] - AMP[1]) * 0.33
const PAD = 4
const TITLE_H = EDIT_H * 0.4 // WavetableComponentOverlay::kTitleHeightRatio
const OBSCURE = 0.4 // WavetableEditSection::kObscureAmount

const PRIMARY = '#aa88ff', DISABLED = '#848789', BG = '#1d2125'
const FILL = 'rgba(170,136,255,0.43)', FILL_DISABLED = 'rgba(132,135,137,0.4)'
const LIGHTEN = 'rgba(255,255,255,0.133)'

const SOURCE_TYPES = ['Wave Source', 'Line Source', 'Audio File Source']
const MODIFIER_TYPES = ['Phase Shift', 'Wave Window', 'Frequency Filter', 'Slew Limiter', 'Wave Folder', 'Wave Warp']
const INTERPOLATIONS = ['None', 'Waveform Blend', 'Spectral Blend', 'Smooth Waveform Blend', 'Smooth Spectral Blend']

interface Comp { name: string; type_index: number; has_keyframes: boolean; positions: number[]; [k: string]: unknown }
interface Layout { name: string; author: string; full_normalize: boolean; remove_all_dc: boolean; frames: number; groups: Comp[][] }
interface Sel { g: number; c: number; pos: number }

/** The editor's shared state for its overlays. */
interface Ed {
  wt: (op: string, ...args: unknown[]) => Promise<{ data?: any; ok?: boolean; index?: number; length?: number }> // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The frame a gesture renders while it moves (WavetableEditSection::frameChanged). */
  dragPos: () => number
  /** After an edit: `final` renders the whole table (frameDoneEditing), else shows the frame rendered. */
  changed: (final: boolean) => void
  /** After a component's own settings changed: re-read the layout, render everything. */
  reload: () => Promise<void>
  /** Bumped whenever the components change, so overlays re-read their keyframe. */
  rev: number
  zoom: number
  power: boolean
  api: VitalApi
  ctx: BaseAudioContext | null
}

export function openWavetableEditor(api: VitalApi, osc: number) {
  api.setUi({ wtEdit: osc })
}

export function WavetableEditor() {
  const api = useVital()
  const { engine } = useEngine()
  const osc = api.ui.wtEdit as number | undefined
  if (osc === undefined || !engine) return null
  return <Editor key={osc} osc={osc} engine={engine} />
}

// ── Drawing helpers ──

/** A canvas redrawn on every render and resize; `draw` gets the context in device pixels and the
 *  pixels per frame unit. */
function useCanvas(width: number, draw: (g: CanvasRenderingContext2D, w: number, h: number, k: number) => void) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawRef = useRef(draw)
  drawRef.current = draw
  const paint = useCallback(() => {
    const c = ref.current
    if (!c) return
    const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr))
    if (c.width !== w) c.width = w
    if (c.height !== h) c.height = h
    const g = c.getContext('2d')
    if (!g) return
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, w, h)
    drawRef.current(g, w, h, w / width)
  }, [width])
  useLayoutEffect(() => { paint() })
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const ro = new ResizeObserver(paint)
    ro.observe(c)
    return () => ro.disconnect()
  }, [paint])
  return ref
}

/** The pointer in frame units inside an element of frame width `width`. */
function local(e: { clientX: number; clientY: number }, el: Element, width: number) {
  const r = el.getBoundingClientRect(), s = width / r.width
  return { x: (e.clientX - r.left) * s, y: (e.clientY - r.top) * s }
}

const capture = (e: React.PointerEvent) => { try { (e.currentTarget as Element).setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ } }
const fade = (c: string, t: number) => c.replace(/rgba?\(([^)]+)\)/, (_, inner: string) => {
  const p = inner.split(',').map((x) => x.trim())
  return `rgba(${p[0]},${p[1]},${p[2]},${(p[3] === undefined ? 1 : parseFloat(p[3])) * (1 - t)})`
})
const hexA = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`

/** OpenGlLineRenderer with fill: the waveform (+1 at the top) stroked over its fill to the centre. */
function drawWaveform(g: CanvasRenderingContext2D, w: number, h: number, k: number, values: ArrayLike<number>, n: number, line: string, fill: string) {
  const y = (v: number) => (h / 2) * (1 - v)
  g.beginPath()
  g.moveTo(0, h / 2)
  for (let i = 0; i < n; i++) g.lineTo((i * w) / (n - 1), y(values[i]))
  g.lineTo(w, h / 2)
  g.closePath()
  g.fillStyle = fill
  g.fill()
  g.beginPath()
  g.moveTo(0, y(values[0]))
  for (let i = 1; i < n; i++) g.lineTo((i * w) / (n - 1), y(values[i]))
  g.strokeStyle = line
  g.lineWidth = 2 * PT * k
  g.lineJoin = 'round'
  g.stroke()
}

/** BarRenderer: bar i from the bottom to `height(i)` of the box, `zoom` × as wide, starting at the left. */
function drawBars(g: CanvasRenderingContext2D, w: number, h: number, height: (i: number) => number, zoom: number, color: string, additive: boolean) {
  const dpr = window.devicePixelRatio || 1
  const bw = Math.max(2 * dpr, (zoom * w) / BARS)
  g.fillStyle = color
  g.globalCompositeOperation = additive ? 'lighter' : 'source-over'
  for (let i = 0; i < BARS; i++) {
    const x = (zoom * w * i) / BARS
    if (x > w) break
    const bh = Math.max(0, height(i)) * h
    if (bh > 0) g.fillRect(x + 0.5 * dpr, h - bh, bw - dpr, bh)
  }
  g.globalCompositeOperation = 'source-over'
}

/** BarRenderer::setScaledY with square scale (and the power scale): an amplitude's bar height. */
const ampHeight = (amp: number, i: number, power: boolean) => Math.sqrt(Math.max(0, amp * (power ? Math.max(i, 1) / 5 : 1)))
/** scaledYAt: a bar height back to an amplitude. */
const heightAmp = (y01: number, i: number, power: boolean) => (y01 * y01) / (power ? Math.max(i, 1) / 5 : 1)

// ── Small controls (the overlays' text sliders, selectors and toggles) ──

const ROTARY = 200 * 1000 / 1440 // kDefaultRotaryDragLength in stage px

/** SynthSlider::formatValue's default: five characters of the value at five decimal places. */
function fmt(v: number, step?: number): string {
  if (step === 1) return String(Math.round(v))
  let s = v.toFixed(5)
  s = s.slice(0, s.startsWith('-') ? 6 : 5)
  return s.endsWith('.') ? s.slice(0, -1) : s
}

/** A text slider (TextLookAndFeel's rotary): drag up or right for more over the drag length, the wheel
 *  steps, double-click resets; `inc` adds the incrementer arrows on hover. */
function TextSlider({ at, value, min, max, step, def, onChange, inc, title }: {
  at: Rect; value: number; min: number; max: number; step?: number; def: number
  onChange: (v: number, final: boolean) => void; inc?: boolean; title?: string
}) {
  const api = useVital()
  const drag = useRef<{ x: number; y: number; v: number } | null>(null)
  const [hover, setHover] = useState(false)
  const clamp = (v: number) => { const c = Math.max(min, Math.min(max, v)); return step ? Math.round(c / step) * step : c }
  const wheel = useWheel((_dx, dy) => { if (!dy) return; onChange(clamp(value + Math.sign(dy) * (step ?? (max - min) / 100)), true) })
  const h = (at[3] - at[1]) / 2
  return (
    <div ref={wheel} className="wt-text" style={R(...at)} title={title}
      onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); capture(e); drag.current = { x: e.clientX, y: e.clientY, v: value } }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const s = api.scale(), delta = ((e.clientX - d.x) + (d.y - e.clientY)) / s
        onChange(clamp(d.v + (delta * (max - min)) / ROTARY), false)
      }}
      onPointerUp={() => { if (drag.current) { drag.current = null; onChange(value, true) } }}
      onDoubleClick={() => onChange(def, true)}>
      <span style={{ fontSize: h * 0.5 }}>{fmt(value, step)}</span>
      {inc && hover && (
        <div className="wt-inc" style={{ width: h }}>
          <svg viewBox="0 0 1 1" onPointerDown={(e) => { e.stopPropagation(); onChange(clamp(value + (step ?? 1)), true) }}><path d="M0.3 0.65 L0.5 0.4 L0.7 0.65 Z" /></svg>
          <svg viewBox="0 0 1 1" onPointerDown={(e) => { e.stopPropagation(); onChange(clamp(value - (step ?? 1)), true) }}><path d="M0.3 0.35 L0.5 0.6 L0.7 0.35 Z" /></svg>
        </div>
      )}
    </div>
  )
}

/** TextSelector: the chosen option's name; a click lists them all under it. */
function Selector({ at, value, options, onChange, size = 0.4 }: { at: Rect; value: number; options: string[]; onChange: (v: number) => void; size?: number }) {
  const api = useVital()
  const h = (at[3] - at[1]) / 2
  return (
    <div className="wt-text wt-selector" style={R(...at)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        api.openMenu({ items: options.map((label, i) => ({ label, on: i === value, act: () => onChange(i) })) }, { clientX: r.left, clientY: r.bottom })
      }}>
      <span style={{ fontSize: h * size }}>{options[Math.max(0, Math.min(options.length - 1, Math.round(value)))]}</span>
    </div>
  )
}

/** OpenGlToggleButton with TextLookAndFeel and no background: its text, lit when on. */
function Toggle({ at, label, on, onChange }: { at: Rect; label: string; on: boolean; onChange: (on: boolean) => void }) {
  const h = (at[3] - at[1]) / 2
  return (
    <div className={`wt-toggle${on ? ' on' : ''}`} style={{ ...R(...at), fontSize: h * 0.7 * 0.6 }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); onChange(!on) }}>{label}</div>
  )
}

/** A LinearBar slider: the bar filled from the left to the value; press or drag to set it. */
function LinearBar({ at, value, def, onChange }: { at: Rect; value: number; def: number; onChange: (v: number, final: boolean) => void }) {
  const set = (e: React.PointerEvent, final: boolean) => {
    const r = e.currentTarget.getBoundingClientRect()
    onChange(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), final)
  }
  const down = useRef(false)
  return (
    <div className="wt-linear" style={R(...at)}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); capture(e); down.current = true; set(e, false) }}
      onPointerMove={(e) => { if (down.current) set(e, false) }}
      onPointerUp={(e) => { if (down.current) { down.current = false; set(e, true) } }}
      onDoubleClick={() => onChange(def, true)}>
      <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  )
}

/** WavetableComponentOverlay::ControlsBackground: the strip centred over the amplitudes, its
 *  dividers and titled sections. `lines` and the children's bounds are relative to its left edge. */
function Controls({ width, lines, titles, children }: { width: number; lines: number[]; titles: string[]; children?: ReactNode }) {
  const x0 = (2000 - width) / 2
  return (
    <div className="wt-controls" style={R(x0, EDIT_Y, x0 + width, EDIT_Y + EDIT_H)} onPointerDown={(e) => e.stopPropagation()}>
      {titles.map((t, i) => {
        if (!t || i - 1 >= lines.length) return null
        const start = i > 0 ? lines[i - 1] : 0, end = i < lines.length ? lines[i] : width
        return <span key={i} className="wt-ctitle" style={{ ...R(start, 0, end, TITLE_H), fontSize: (TITLE_H * 0.6) / 2 }}>{t}</span>
      })}
      {lines.map((x, i) => <i key={i} className="wt-cline" style={{ left: x / 2 }} />)}
      {children}
    </div>
  )
}

// ── The editor ──

function Editor({ osc, engine }: { osc: number; engine: SynthEngine }) {
  const api = useVital()
  const { ctx } = useEngine()
  const [layout, setLayout] = useState<Layout | null>(null)
  const [sel, setSel] = useState<Sel[]>([])
  /** The overlay shown: the component of the keyframe last selected on its own (frameSelected). */
  const [overlay, setOverlay] = useState<{ g: number; c: number } | null>(null)
  const [playhead, setPlayheadState] = useState(0)
  const [display, setDisplay] = useState<Float32Array | null>(null)
  const [zoom, setZoomState] = useState(8)
  const [power, setPower] = useState(true)
  const [scroll, setScroll] = useState(0)
  const [rev, setRev] = useState(0)
  const ph = useRef(0)
  const layoutRef = useRef<Layout | null>(null)
  layoutRef.current = layout
  const importFile = useRef<HTMLInputElement>(null)

  const wt = useCallback((op: string, ...args: unknown[]) => engine.wavetableEdit(op, osc, ...args), [engine, osc])
  /** updateGlDisplay: the frame at the playhead, after rendering `render` (−2 none, −1 all, else one). */
  const show = useCallback(async (render: number) => {
    const { data } = await wt('render', render, ph.current)
    setDisplay(data as Float32Array)
  }, [wt])
  const reload = useCallback(async () => {
    const { data } = await wt('layout')
    setLayout(data as Layout)
    setRev((r) => r + 1)
    return data as Layout
  }, [wt])
  const finish = useCallback(() => { void show(-1).then(() => tableChanged(api, osc)) }, [show, api, osc])

  /** reset + selectDefaultFrame: the first component's first keyframe, its overlay showing. */
  const reset = useCallback(async () => {
    const l = await reload()
    const first = l.groups[0]?.[0]
    if (first && first.positions.length) { setSel([{ g: 0, c: 0, pos: first.positions[0] }]); setOverlay({ g: 0, c: 0 }) }
    else { setSel([]); setOverlay(null) }
    await show(-2)
  }, [reload, show])
  useEffect(() => { void reset() }, [reset, api.patch.id])

  const setPlayhead = (p: number) => {
    ph.current = p
    setPlayheadState(p)
    // playheadMoved: the oscillator's frame slider follows the playhead.
    api.set(`osc_${osc + 1}_wave_frame`, p)
    void show(-2)
  }
  const dragPos = () => Math.min(Math.max(0, (layoutRef.current?.frames ?? 1) - 1), ph.current)

  const selectFrame = (s: Sel) => { setSel([s]); setOverlay({ g: s.g, c: s.c }) }
  const deselect = () => { setSel([]); setOverlay(null) }
  const indexOf = (s: Sel, l = layout) => l?.groups[s.g]?.[s.c]?.positions.indexOf(s.pos) ?? -1

  const ed: Ed = {
    wt, dragPos, rev, zoom, power, api, ctx,
    changed: (final) => { if (final) finish(); else void show(-2) },
    reload: async () => { await reload(); finish() },
  }

  // The structure edits (WavetableComponentList): each re-reads the layout and renders.
  const structural = async (op: string, ...args: unknown[]) => {
    await wt(op, ...args)
    const l = await reload()
    finish()
    return l
  }
  const addSource = async (type: number) => {
    const l = await structural('addSource', type)
    const g = l.groups.length - 1
    selectFrame({ g, c: 0, pos: l.groups[g][0].positions[0] ?? 0 })
  }
  const addModifier = async (g: number, type: number) => {
    const l = await structural('addModifier', g, type)
    const c = l.groups[g].length - 1
    selectFrame({ g, c, pos: l.groups[g][c].positions[0] ?? 0 })
  }
  const removeComponent = async (g: number, c: number) => {
    // componentRemoved: the selection loses that component's keyframes (all of a removed group).
    await structural('removeComponent', g, c)
    deselect()
  }
  const moveComponent = async (g: number, c: number, up: boolean) => { await structural('moveComponent', g, c, up ? 1 : 0); deselect() }
  const resetComponent = async (g: number, c: number) => {
    const l = await structural('reset', g, c)
    selectFrame({ g, c, pos: l.groups[g][c].positions[0] ?? 0 })
  }

  // The header: the table's name, its file arrows and browser, and the editor's menu.
  const pre = `osc_${osc + 1}`
  const fileKey = api.ui[`${pre}_tableFile`] as string | undefined
  const loadFile = async (file: Blob & { name?: string }, key: string | undefined, name: string) => {
    if (await loadTableFile(api, engine, ctx, osc, file, key, name)) await reset()
  }
  const loadEntry = async (f: LibFile) => loadFile(await f.file(), f.key, f.name)
  const shift = (step: number) => void loadLibrary().then(() => { const f = shiftedFile('wavetable', fileKey, step); if (f) void loadEntry(f) })
  const browse = () => openPopupBrowser(api, { owner: `wtedit${osc}`, kind: 'wavetable', at: [701, 93, 701 + 600 * PT, 93 + 400 * PT] },
    (f) => void loadEntry(f), () => api.ui[`${pre}_tableFile`] as string | undefined)
  const download = (name: string, blob: Blob) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name.replace(/[\\/:*?"<>|]/g, '_')
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  const tableName = layout?.name || 'Init'
  const menu = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    const items: MenuItem[] = [
      { label: 'Save As Wavetable', act: () => void engine.wavetableJson(osc).then((t) => requestSave(api, { kind: 'wavetable', ext: 'vitaltable', name: tableName, data: t as Record<string, unknown> })) },
      { label: 'Import Wavetable', act: () => importFile.current?.click() },
      { label: 'Export Wavetable', act: () => void engine.wavetableJson(osc).then((t) => download(`${tableName}.vitaltable`, new Blob([JSON.stringify(t)], { type: 'application/json' }))) },
      { label: 'Export to .wav File', act: () => void wt('renderBuffer', 256).then(({ data }) => download(`${tableName}.wav`, wavFile(data as Float32Array, 88200, '<!>2048 20000000 wavetable'))) },
      { label: 'Synthesize Preset to Table', act: () => void engine.resynthesize(osc).then(() => { tableChanged(api, osc, { [`${pre}_table`]: 'Resynthesize', [`${pre}_tableFile`]: 'resynthesized' }); void reset() }) },
    ]
    api.openMenu({ w: 130, items }, e)
  }

  const current = sel.length === 1 && overlay && sel[0].g === overlay.g && sel[0].c === overlay.c ? sel[0] : null
  const comp = current && layout ? layout.groups[current.g]?.[current.c] : undefined
  const kfIndex = current ? indexOf(current) : -1
  const type = comp?.type_index ?? -1
  // Which base displays the overlay obscures (setTimeDomainBounds etc. returning true).
  const coversTime = type === 0 || type === 3 || type === 1 || type === 5
  const hidesTime = type === 0 || type === 3 // the wave source editor paints its own background
  const coversAmp = type === 0 || type === 3 || type === 6
  const coversPhase = type === 0 || type === 3

  return (
    <div className="wt-editor" onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <div className="wt-bg" style={R(0, 38, 2000, 1212)} />
      <input ref={importFile} type="file" accept=".vitaltable,.wav,audio/*" hidden
        onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void loadFile(f, undefined, f.name.replace(/\.[^.]+$/, '')) }} />
      <div className="vt-b vt-header" style={R(0, 38, 2000, 108)} />
      <div className="vt-b vt-preset" style={R(701, 55, 1247, 93)}>
        <span className="arr" onClick={() => shift(-1)}>‹</span>
        <span className="nm" onClick={browse}>{layout?.author ? `${tableName} - ${layout.author}` : tableName}</span>
        <span className="arr" onClick={() => shift(1)}>›</span>
      </div>
      <div className="vt-b vt-tools" style={R(1260, 58, 1440, 90)}>
        <span className={api.canUndo ? '' : 'dim'} onClick={() => api.undo()} title="Undo">↶</span>
        <span className={api.canRedo ? '' : 'dim'} onClick={() => api.redo()} title="Redo">↷</span>
        <span onClick={() => requestSave(api, { kind: 'preset', ext: 'vital', name: (api.ui.preset_name as string | undefined) ?? 'Init Preset' })} title="Save">⤓</span>
        <span onClick={menu} title="Menu">≡</span>
      </div>
      <svg className="wt-exit" style={R(1940, 50, 1990, 100)} viewBox="0 0 1 1" onClick={() => api.setUi({ wtEdit: undefined })} aria-label="Close">
        <path d="M0.22 0.22 L0.78 0.78 M0.22 0.78 L0.78 0.22" />
      </svg>

      <div className="wt-body" style={R(14, 108, 1986, 834)} />
      <div className="wt-body" style={R(...TL)} />

      <BaseWave at={WAVE} data={display} obscured={coversTime} hidden={hidesTime} />
      <BaseBars at={AMP} data={display} kind="amp" zoom={zoom} power={power} obscured={coversAmp} hidden={coversAmp && type !== 6}
        onZoom={(z) => setZoomState(z)} />
      <BaseBars at={PHASE} data={display} kind="phase" zoom={zoom} power={power} obscured={coversPhase} hidden={coversPhase}
        onZoom={(z) => setZoomState(z)} />
      {current && comp && kfIndex >= 0 && <Overlay key={`${current.g}:${current.c}:${kfIndex}`} ed={ed} g={current.g} c={current.c} i={kfIndex} comp={comp} />}
      <svg className="wt-gear" style={R(...GEAR)} viewBox="0 0 24 24" onPointerDown={(e) => {
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        const zoomItem = (z: number): MenuItem => ({ label: `Zoom ${z}x`, on: zoom === z, act: () => setZoomState(z) })
        api.openMenu({ items: [
          { label: 'Power Scale', on: power, act: () => setPower(true) }, { label: 'Amplitude Scale', on: !power, act: () => setPower(false) }, { sep: true },
          zoomItem(1), zoomItem(2), zoomItem(4), zoomItem(8), zoomItem(16),
        ] }, { clientX: r.left, clientY: r.bottom })
      }}><path d={GEAR_PATH} /></svg>

      <PlayheadInfo position={playhead} />
      <Playhead position={playhead} onMove={setPlayhead} />
      {layout && <>
        <ComponentList layout={layout} scroll={scroll} onScroll={setScroll}
          onAddSource={(t) => void addSource(t)} onAddModifier={(g, t) => void addModifier(g, t)}
          onRemove={(g, c) => void removeComponent(g, c)} onMove={(g, c, up) => void moveComponent(g, c, up)} onReset={(g, c) => void resetComponent(g, c)}
          onFlags={(normalize, dc) => void wt('flags', normalize, dc).then(async () => { await reload(); finish() })} />
        <Organizer layout={layout} setLayout={setLayout} sel={sel} playhead={playhead} scroll={scroll} onScroll={setScroll}
          wt={wt} selectFrame={selectFrame} selectFrames={(s) => { setSel(s); setOverlay(null) }} moveSel={setSel} deselect={deselect}
          onDragged={(p) => { ph.current = p; setPlayheadState(p); api.set(`osc_${osc + 1}_wave_frame`, p) }}
          afterMove={() => { void show(-2) }} positionsUpdated={async () => { await reload(); finish() }} />
      </>}
    </div>
  )
}

// Paths::gear.
const GEAR_PATH = 'M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8zm8.3 4.6l1.9 1.5-1.9 3.3-2.3-.8a7.6 7.6 0 0 1-1.8 1l-.4 2.4h-3.8l-.4-2.4a7.6 7.6 0 0 1-1.8-1l-2.3.8-1.9-3.3 1.9-1.5a7.7 7.7 0 0 1 0-2.1l-1.9-1.5 1.9-3.3 2.3.8a7.6 7.6 0 0 1 1.8-1l.4-2.4h3.8l.4 2.4a7.6 7.6 0 0 1 1.8 1l2.3-.8 1.9 3.3-1.9 1.5a7.7 7.7 0 0 1 0 2.1z'

/** The frame at the playhead (oscillator_waveform_), in Widget Primary Disabled; faded when the overlay
 *  edits over it, gone when the overlay's own editor paints there. */
function BaseWave({ at, data, obscured, hidden }: { at: Rect; data: Float32Array | null; obscured: boolean; hidden: boolean }) {
  const ref = useCanvas(at[2] - at[0], (g, w, h, k) => {
    if (!data || hidden) return
    drawWaveform(g, w, h, k, data, SIZE, obscured ? hexA(DISABLED, 1 - OBSCURE) : DISABLED, obscured ? fade(FILL_DISABLED, OBSCURE) : FILL_DISABLED)
  })
  return <canvas ref={ref} className="wt-screen" style={R(...at)} />
}

/** frequency_amplitudes_ / frequency_phases_: the playhead frame's harmonics in Widget Secondary
 *  Disabled. The wheel over them zooms (×2^0.75 a notch, 1–32 ×). */
function BaseBars({ at, data, kind, zoom, power, obscured, hidden, onZoom }: {
  at: Rect; data: Float32Array | null; kind: 'amp' | 'phase'; zoom: number; power: boolean; obscured: boolean; hidden: boolean; onZoom: (z: number) => void
}) {
  const ref = useCanvas(at[2] - at[0], (g, w, h) => {
    if (!data || hidden) return
    const color = obscured ? fade(FILL_DISABLED, OBSCURE) : FILL_DISABLED
    if (kind === 'amp') drawBars(g, w, h, (i) => (i < SIZE / 2 ? ampHeight(data[SIZE + i], i, power) : 0), zoom, color, true)
    else drawBars(g, w, h, (i) => (i < SIZE / 2 ? (data[SIZE + SIZE / 2 + i] + 1) / 2 : 0), zoom, color, true)
  })
  const wheel = useWheel((_dx, dy) => { if (dy) onZoom(Math.max(1, Math.min(32, zoom * Math.pow(2, 0.75 * Math.sign(dy))))) })
  return <div ref={wheel} className="wt-screen" style={R(...at)}><canvas ref={ref} /></div>
}

function PlayheadInfo({ position }: { position: number }) {
  // WavetablePlayheadInfo: the position, right-aligned just short of the organizer (1.5.5 sets it
  // closer in than 1.0.6's half a box height).
  return <div className="wt-info" style={{ ...R(TL[0], TL[1], ORG_X - 9, ROW_TOP), fontSize: 8 }}>{position}</div>
}

/** WavetablePlayhead: ticks every 4 frames (taller every 16), the position line; press or drag to move. */
function Playhead({ position, onMove }: { position: number; onMove: (p: number) => void }) {
  const W = PLAYHEAD[2] - PLAYHEAD[0], pad = HANDLE / 2, active = W - 2 * pad + PT
  const ref = useCanvas(W, (g, _w, h, k) => {
    g.fillStyle = 'rgba(255,255,255,0.21)'
    const small = Math.floor(h / 3), big = 2 * small
    for (let i = 0; i < FRAMES; i += 4) {
      const x = Math.round((pad - 0.5 * PT + (i * active) / LAST) * k)
      const lh = i % 16 === 0 ? big : small
      g.fillRect(x, h - lh, Math.max(1, PT * k * 0.72), lh)
    }
    g.fillStyle = PRIMARY
    g.fillRect(Math.round(((active * position) / LAST - 0.5 * PT + pad) * k), 0, Math.max(1, PT * k * 0.72), h)
  })
  const at = (e: React.PointerEvent) => {
    const { x } = local(e, e.currentTarget, W)
    onMove(Math.max(0, Math.min(LAST, Math.round((LAST * (x - pad)) / active))))
  }
  const down = useRef(false)
  return <canvas ref={ref} className="wt-playhead" style={R(...PLAYHEAD)}
    onPointerDown={(e) => { if (e.button !== 0) return; capture(e); down.current = true; at(e) }}
    onPointerMove={(e) => { if (down.current) at(e) }} onPointerUp={() => { down.current = false }} />
}

// ── The component list ──

type Row = { kind: 'comp'; g: number; c: number; comp: Comp } | { kind: 'add'; g: number }
function rowsOf(l: Layout): Row[] {
  const rows: Row[] = []
  l.groups.forEach((group, g) => {
    group.forEach((comp, c) => rows.push({ kind: 'comp', g, c, comp }))
    rows.push({ kind: 'add', g })
  })
  return rows
}

/** WavetableComponentList: each group's source and modifiers with their ☰ menus, its Add Modifier
 *  row, then Add Source, then the table's NORMALIZE TABLE and REMOVE DC switches. */
function ComponentList({ layout, scroll, onScroll, onAddSource, onAddModifier, onRemove, onMove, onReset, onFlags }: {
  layout: Layout; scroll: number; onScroll: (s: number) => void
  onAddSource: (type: number) => void; onAddModifier: (g: number, type: number) => void
  onRemove: (g: number, c: number) => void; onMove: (g: number, c: number, up: boolean) => void; onReset: (g: number, c: number) => void
  onFlags: (normalize: number, dc: number) => void
}) {
  const api = useVital()
  const rows = rowsOf(layout)
  const W = LIST[2] - LIST[0]
  const buttonY = rows.length * HANDLE + 2 * PT
  const wheel = useWheel((_dx, dy) => { if (dy) onScroll(Math.max(0, Math.min(maxScroll(layout), scroll - dy * 0.5))) })
  const menuAt = (e: React.PointerEvent, items: MenuItem[]) => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    api.openMenu({ items }, { clientX: r.left, clientY: r.bottom })
  }
  const y0 = LIST[1] - scroll
  const rowAt = (row: number) => y0 + row * HANDLE + 2 * PT
  const btnY = y0 + buttonY + CELL + HANDLE * 0.5
  const btnW = (W - 3 * 20.5) / 2
  return (
    <div ref={wheel} className="wt-list" style={R(...LIST)}>
      <div className="wt-list-in" style={{ top: -LIST[1] / 2, left: -LIST[0] / 2 }}>
        {rows.map((r, row) => {
          const y = rowAt(row)
          if (r.kind === 'add') {
            return (
              <div key={`a${r.g}`} className="wt-addrow" style={R(LIST[0] + 56, y, LIST[2], y + CELL)}
                onPointerDown={(e) => menuAt(e, MODIFIER_TYPES.map((label, t) => ({ label, act: () => onAddModifier(r.g, t) })))}>
                <Plus /><span>Add Modifier</span>
              </div>
            )
          }
          const source = r.c === 0
          const group = layout.groups[r.g]
          const items: MenuItem[] = source ? [
            ...(r.g > 0 ? [{ label: 'Move Group Up', act: () => onMove(r.g, 0, true) }] : []),
            ...(r.g < layout.groups.length - 1 ? [{ label: 'Move Group Down', act: () => onMove(r.g, 0, false) }] : []),
            { label: 'Reset Source', act: () => onReset(r.g, 0) },
            { label: 'Remove Group', act: () => onRemove(r.g, 0) },
          ] : [
            ...(r.c > 1 ? [{ label: 'Move Up', act: () => onMove(r.g, r.c, true) }] : []),
            ...(r.c < group.length - 1 ? [{ label: 'Move Down', act: () => onMove(r.g, r.c, false) }] : []),
            { label: 'Reset', act: () => onReset(r.g, r.c) },
            { label: 'Remove', act: () => onRemove(r.g, r.c) },
          ]
          return (
            <div key={`c${r.g}:${r.c}`} className="wt-row" style={R(LIST[0] + (source ? 28 : 56), y, LIST[2], y + CELL)}>
              <span style={{ fontSize: HANDLE * 0.42 / 2 }}>{r.comp.name}</span>
              <svg className="wt-menu" viewBox="0 0 1 1" style={{ width: CELL / 2, height: CELL / 2 }} onPointerDown={(e) => menuAt(e, items)}>
                <path d="M0.25 0.36 H0.75 M0.25 0.5 H0.75 M0.25 0.64 H0.75" />
              </svg>
            </div>
          )
        })}
        <div className="wt-addrow" style={R(LIST[0] + 28, rowAt(rows.length), LIST[2], rowAt(rows.length) + CELL)}
          onPointerDown={(e) => menuAt(e, SOURCE_TYPES.map((label, t) => ({ label, act: () => onAddSource(t) })))}>
          <Plus /><span>Add Source</span>
        </div>
        <button type="button" className={`wt-flag${layout.full_normalize ? ' on' : ''}`} style={R(LIST[0] + 20.5, btnY, LIST[0] + 20.5 + btnW, btnY + HANDLE)}
          onPointerDown={(e) => { e.stopPropagation(); onFlags(layout.full_normalize ? 0 : 1, -1) }}>NORMALIZE TABLE</button>
        <button type="button" className={`wt-flag${layout.remove_all_dc ? ' on' : ''}`} style={R(LIST[2] - 20.5 - btnW, btnY, LIST[2] - 20.5, btnY + HANDLE)}
          onPointerDown={(e) => { e.stopPropagation(); onFlags(-1, layout.remove_all_dc ? 0 : 1) }}>REMOVE DC</button>
      </div>
    </div>
  )
}

/** How far the list (and the organizer with it) can scroll: its rows, Add Source and the switches. */
function maxScroll(l: Layout) {
  const rows = rowsOf(l).length
  return Math.max(0, rows * HANDLE + 2 * PT + CELL + HANDLE * 0.5 + HANDLE + 2 * PT - (LIST[3] - LIST[1]))
}

const Plus = () => (
  <svg className="wt-plus" viewBox="0 0 1 1" style={{ width: CELL / 2, height: CELL / 2 }}><path d="M0.5 0.2 V0.8 M0.2 0.5 H0.8" /></svg>
)

// ── The organizer ──

/** The component a timeline row shows (getComponentAtRow): each group's rows, then a gap row. */
function componentAtRow(l: Layout, row: number): { g: number; c: number } | null {
  let r = row
  for (let g = 0; g < l.groups.length && r >= 0; g++) {
    if (r < l.groups[g].length) return { g, c: r }
    r -= l.groups[g].length + 1
  }
  return null
}
function rowOf(l: Layout, g: number, c: number) {
  let row = 0
  for (let k = 0; k < g; k++) row += l.groups[k].length + 1
  return row + c
}

/** WavetableOrganizer: a row per component with its keyframes as diamonds (the selected ones lit),
 *  the frame ticks and the playhead. Press a keyframe to select it and drag the selection; drag on
 *  empty space to box-select; double-click to create or delete a keyframe; right-click for Create
 *  Keyframe / Remove Keyframe(s). */
function Organizer({ layout, setLayout, sel, playhead, scroll, onScroll, wt, selectFrame, selectFrames, moveSel, deselect, onDragged, afterMove, positionsUpdated }: {
  layout: Layout; setLayout: (l: Layout) => void; sel: Sel[]; playhead: number; scroll: number; onScroll: (s: number) => void
  wt: Ed['wt']; selectFrame: (s: Sel) => void; selectFrames: (s: Sel[]) => void; moveSel: (s: Sel[]) => void; deselect: () => void
  onDragged: (position: number) => void; afterMove: () => void; positionsUpdated: () => Promise<void>
}) {
  const api = useVital()
  const W = ORG[2] - ORG[0]
  const offset = -scroll
  /** The gesture: its start, and while dragging the dragged keyframe's start x and the moving keyframes
   *  (their engine indices hold until they settle on release). */
  const mode = useRef<{ kind: 'waiting' | 'selecting' | 'dragging'; x: number; y: number; startX?: number; dragged?: number; moving?: (Sel & { i: number })[] }>({ kind: 'waiting', x: 0, y: 0 })
  const [box, setBox] = useState<Rect | null>(null)
  const selected = (g: number, c: number, pos: number) => sel.some((s) => s.g === g && s.c === c && s.pos === pos)
  const rowFromY = (y: number) => Math.max(0, Math.floor((y - offset) / HANDLE))
  const positionFromX = (x: number) => Math.min(Math.max(0, Math.floor(x / FRAME_W)), LAST)

  const ref = useCanvas(W, (g, w, h, k) => {
    g.fillStyle = BG
    g.fillRect(0, 0, w, h)
    const half = (0.5 * HANDLE) * k
    g.fillStyle = 'rgba(255,255,255,0.066)'
    g.fillRect(0, 0, half, h)
    g.fillRect(w - half, 0, half, h)
    for (let i = 4; i < FRAMES - 1; i += 4) {
      g.fillStyle = i % 32 === 0 ? 'rgba(255,255,255,0.168)' : 'rgba(255,255,255,0.066)'
      g.fillRect(Math.round((i * FRAME_W + HANDLE / 2) * k), 0, Math.max(1, PT * k * 0.72), h)
    }
    // Active rows (setRowQuads): each component's row, a point in from top and bottom.
    g.fillStyle = 'rgba(255,255,255,0.066)'
    let y = offset
    layout.groups.forEach((group) => {
      group.forEach(() => { g.fillRect(0, (y + PT) * k, w, (HANDLE - 2 * PT) * k); y += HANDLE })
      y += HANDLE
    })
    // Keyframe diamonds (kDiamondFragment): Widget Primary 1 when selected, Primary Disabled otherwise,
    // rimmed in the background colour.
    layout.groups.forEach((group, gi) => group.forEach((comp, ci) => {
      const top = (rowOf(layout, gi, ci) * HANDLE + offset) * k, size = HANDLE * k
      comp.positions.forEach((pos) => {
        const on = selected(gi, ci, pos)
        if (!comp.has_keyframes) {
          g.fillStyle = on ? PRIMARY : DISABLED
          g.fillRect(0, top + 2 * k, w, size - 4 * k)
          return
        }
        const x = FRAME_W * pos * k, cx = x + size / 2, cy = top + size / 2, r = size / 2 - PT * k
        g.beginPath(); g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy); g.closePath()
        g.fillStyle = on ? PRIMARY : DISABLED
        g.fill()
        g.lineWidth = 2 * PT * k * 0.72
        g.strokeStyle = BG
        g.stroke()
      })
    }))
    if (box) {
      g.fillStyle = LIGHTEN
      g.fillRect(box[0] * k, box[1] * k, (box[2] - box[0]) * k, (box[3] - box[1]) * k)
    }
    g.fillStyle = PRIMARY
    g.fillRect(Math.round((HANDLE / 2 + playhead * FRAME_W) * k), 0, Math.max(1, PT * k * 0.72), h)
  })

  /** getFrameAtMouseEvent: the keyframe whose diamond holds the point, or a full-row frame. */
  const frameAt = (x: number, y: number): Sel | null => {
    const at = componentAtRow(layout, rowFromY(y))
    if (!at) return null
    const comp = layout.groups[at.g][at.c]
    if (!comp.has_keyframes) return comp.positions.length ? { ...at, pos: comp.positions[0] } : null
    const top = rowOf(layout, at.g, at.c) * HANDLE + offset
    let best: Sel | null = null, bestD = Infinity
    for (const pos of comp.positions) {
      const cx = FRAME_W * pos + HANDLE / 2, cy = top + HANDLE / 2
      const d = Math.abs(x - cx) + Math.abs(y - cy)
      if (d <= HANDLE / 2 && d < bestD) { best = { ...at, pos }; bestD = d }
    }
    return best
  }
  /** positionSelectionBox. */
  const selectionBox = (x: number, y: number): Rect => {
    const m = mode.current
    const pe = positionFromX(x - HANDLE / 2), ps = positionFromX(m.x - HANDLE / 2)
    const re = rowFromY(y), rs = rowFromY(m.y)
    const left = Math.min(ps, pe), right = Math.max(ps, pe)
    const top = Math.min(rs, re), bottom = Math.max(rs, re) + 1
    const bx = Math.round(left * FRAME_W), by = Math.round(top * HANDLE) + offset + PT
    return [bx + HANDLE / 2 - PT, by, bx + HANDLE / 2 - PT + Math.round(right * FRAME_W) - bx + 2 * PT, Math.round(bottom * HANDLE) + offset]
  }
  const createAt = async (x: number, y: number) => {
    const at = componentAtRow(layout, rowFromY(y))
    if (!at) return
    const pos = positionFromX(x - HANDLE / 2)
    await wt('insert', at.g, at.c, pos)
    await positionsUpdated()
    selectFrame({ ...at, pos })
  }
  const removeSelected = async (list: Sel[]) => {
    deselect()
    // deleteSelectedKeyframes: each component's from the last index down, so the others keep theirs.
    const doomed: { g: number; c: number; i: number }[] = []
    for (const s of list) {
      const positions = layout.groups[s.g]?.[s.c]?.positions ?? []
      const i = positions.findIndex((p, k) => p === s.pos && !doomed.some((d) => d.g === s.g && d.c === s.c && d.i === k))
      if (i >= 0) doomed.push({ g: s.g, c: s.c, i })
    }
    doomed.sort((a, b) => b.i - a.i)
    for (const d of doomed) await wt('remove', d.g, d.c, d.i)
    await positionsUpdated()
  }

  const wheel = useWheel((_dx, dy) => { if (dy) onScroll(Math.max(0, Math.min(maxScroll(layout), scroll - dy * 0.5))) })
  return (
    <div ref={wheel} style={{ position: 'absolute', ...R(...ORG) }}>
      <canvas ref={ref} className="wt-organizer" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        onPointerDown={(e) => {
          capture(e)
          const { x, y } = local(e, e.currentTarget, W)
          mode.current = { kind: 'waiting', x, y }
          const hit = frameAt(x, y)
          if (hit) {
            const list = selected(hit.g, hit.c, hit.pos) ? sel : [hit]
            if (list.length === 1) selectFrame(hit)
            const moving = list.map((s) => ({ ...s, i: layout.groups[s.g]?.[s.c]?.positions.indexOf(s.pos) ?? -1 })).filter((s) => s.i >= 0)
            mode.current = { kind: 'dragging', x, y, startX: Math.floor(FRAME_W * hit.pos), dragged: moving.findIndex((s) => s.g === hit.g && s.c === hit.c && s.pos === hit.pos), moving }
          }
        }}
        onPointerMove={(e) => {
          const m = mode.current
          if (!(e.buttons & 3)) return
          const { x, y } = local(e, e.currentTarget, W)
          const dx = x - m.x
          if (m.kind === 'waiting' && Math.round(dx)) { m.kind = 'selecting'; setBox(selectionBox(x, y)) }
          else if (m.kind === 'selecting') setBox(selectionBox(x, y))
          else if (m.kind === 'dragging' && m.moving && m.dragged !== undefined && m.dragged >= 0) {
            // Every selected keyframe moves by the dragged one's change, each clamped to the table.
            const target = Math.floor((m.startX! + dx) / FRAME_W)
            const delta = target - m.moving[m.dragged].pos
            if (!delta) return
            const next: Layout = { ...layout, groups: layout.groups.map((gr) => gr.map((c) => ({ ...c, positions: [...c.positions] }))) }
            for (const k of m.moving) {
              const comp = next.groups[k.g]?.[k.c]
              if (!comp || !comp.has_keyframes) continue
              k.pos = Math.max(0, Math.min(LAST, k.pos + delta))
              comp.positions[k.i] = k.pos
              void wt('move', k.g, k.c, k.i, k.pos, 0)
            }
            setLayout(next)
            moveSel(m.moving.map(({ g, c, pos }) => ({ g, c, pos })))
            onDragged(Math.max(0, Math.min(LAST, target)))
            afterMove()
          }
        }}
        onPointerUp={(e) => {
          const m = mode.current
          const { x, y } = local(e, e.currentTarget, W)
          mode.current = { kind: 'waiting', x: 0, y: 0 }
          if (m.kind === 'waiting' && e.button === 0) deselect()
          else if (m.kind === 'selecting' && box) {
            // The keyframes inside the box, row by row.
            const picked: Sel[] = []
            const r0 = rowFromY(box[1]), r1 = rowFromY(box[3])
            const p0 = positionFromX(box[0] - HANDLE / 2), p1 = positionFromX(box[2] - HANDLE / 2)
            for (let row = r0; row < r1; row++) {
              const at = componentAtRow(layout, row)
              if (!at) continue
              for (const pos of layout.groups[at.g][at.c].positions) if (pos >= p0 && pos < p1) picked.push({ ...at, pos })
            }
            setBox(null)
            selectFrames(picked)
          } else if (m.kind === 'dragging') {
            // mouseUp: the moved keyframes settle into order (reposition), then the table renders.
            void wt('repositionAll').then(positionsUpdated)
          }
          if (e.button === 2) {
            const at = componentAtRow(layout, rowFromY(y))
            if (!at || !layout.groups[at.g][at.c].has_keyframes) return
            const hit = frameAt(x, y)
            const removing = hit ? (selected(hit.g, hit.c, hit.pos) ? sel : [hit]) : []
            api.openMenu({ items: removing.length
              ? [{ label: removing.length > 1 ? 'Remove Keyframes' : 'Remove Keyframe', act: () => void removeSelected(removing) }]
              : [{ label: 'Create Keyframe', act: () => void createAt(x, y) }] }, e)
          }
        }}
        onDoubleClick={(e) => {
          const { x, y } = local(e, e.currentTarget, W)
          const at = componentAtRow(layout, rowFromY(y))
          if (!at || !layout.groups[at.g][at.c].has_keyframes) return
          const hit = frameAt(x, y)
          if (hit) {
            deselect()
            const i = layout.groups[hit.g][hit.c].positions.indexOf(hit.pos)
            if (i >= 0) void wt('remove', hit.g, hit.c, i).then(positionsUpdated)
          } else void createAt(x, y)
        }} />
    </div>
  )
}

// ── The overlays ──

function Overlay(props: { ed: Ed; g: number; c: number; i: number; comp: Comp }) {
  switch (props.comp.type_index) {
    case 0: case 3: return <WaveSourceOverlay {...props} />
    case 1: return <LineSourceOverlay {...props} />
    case 2: return <FileSourceOverlay {...props} />
    case 4: return <PhaseOverlay {...props} />
    case 5: return <WindowOverlay {...props} />
    case 6: return <FilterOverlay {...props} />
    case 7: return <SlewOverlay {...props} />
    case 8: return <FoldOverlay {...props} />
    case 9: return <WarpOverlay {...props} />
    default: return null
  }
}

/** A keyframe's own state (its JSON), re-read when the components change, and a setter that patches
 *  it in the engine: while dragging the playhead's frame renders, on release all of them. */
function useKeyframe({ ed, g, c, i }: { ed: Ed; g: number; c: number; i: number }) {
  const [kf, setKfState] = useState<Record<string, any> | null>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  useEffect(() => { void ed.wt('keyframe', g, c, i).then((r) => setKfState(r.data)) }, [ed.rev, g, c, i]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Record<string, unknown>, final: boolean) => {
    setKfState((k) => ({ ...(k ?? {}), ...patch }))
    void ed.wt('setKeyframe', g, c, i, patch, final ? -1 : ed.dragPos()).then(() => ed.changed(final))
  }
  return [kf, set] as const
}
/** A component's own setting (its JSON outside the keyframes), then everything renders. */
const setComponent = (ed: Ed, g: number, c: number, patch: Record<string, unknown>) =>
  void ed.wt('setComponent', g, c, patch, -1).then(() => ed.reload())

/** WaveSourceOverlay: the keyframe's waveform drawn on a grid (WaveSourceEditor), its harmonic
 *  amplitudes and phases as bars (BarEditor), and the INTERPOLATION · GRID X · GRID Y strip. */
function WaveSourceOverlay({ ed, g, c, i, comp }: { ed: Ed; g: number; c: number; i: number; comp: Comp }) {
  const api = useVital()
  const [, redraw] = useState(0)
  const [grid, setGrid] = useState<[number, number]>([6, 4])
  const values = useRef(new Float32Array(SIZE))
  const amps = useRef(new Float32Array(BARS))
  const phases = useRef(new Float32Array(BARS))
  const loaded = useRef(false)
  const load = (data: Float32Array, bars: boolean) => {
    values.current = data.slice(0, SIZE)
    if (bars) { amps.current = data.slice(SIZE, SIZE + BARS); phases.current = data.slice(SIZE + BARS, SIZE + 2 * BARS) }
    loaded.current = true
    redraw((n) => n + 1)
  }
  useEffect(() => { void ed.wt('waveFrame', g, c, i).then((r) => load(r.data as Float32Array, true)) }, [ed.rev, g, c, i]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sends coalesce: one request in flight, the next carries everything drawn meanwhile.
  const busy = useRef(false), pending = useRef<null | (() => Promise<void>)>(null)
  const send = (run: () => Promise<void>) => {
    if (busy.current) { pending.current = run; return }
    busy.current = true
    void run().then(function next(): Promise<void> | void {
      const p = pending.current
      pending.current = null
      if (p) return p().then(next)
      busy.current = false
    })
  }
  const range = useRef<[number, number] | null>(null)
  const timeChanged = (start: number, end: number, final: boolean) => {
    range.current = range.current ? [Math.min(range.current[0], start), Math.max(range.current[1], end)] : [start, end]
    send(async () => {
      const [s, e] = range.current ?? [start, end]
      range.current = null
      const { data } = await ed.wt('waveTime', g, c, i, values.current, s, e, final ? -1 : ed.dragPos())
      // valuesChanged: the bars follow the drawn wave.
      amps.current = (data as Float32Array).slice(SIZE, SIZE + BARS); phases.current = (data as Float32Array).slice(SIZE + BARS, SIZE + 2 * BARS)
      redraw((n) => n + 1)
      ed.changed(final)
    })
  }
  const barsChanged = (final: boolean) => {
    send(async () => {
      const { data } = await ed.wt('waveFreq', g, c, i, amps.current, phases.current, final ? -1 : ed.dragPos())
      // barsChanged: the wave follows the bars (the bars stay as drawn).
      values.current = (data as Float32Array).slice(0, SIZE)
      redraw((n) => n + 1)
      ed.changed(final)
    })
  }

  // Interpolation: None, or style (Waveform / Spectral, Smooth …) with the mode in its low bit.
  const style = Number(comp.interpolation_style ?? 1), mode = Number(comp.interpolation ?? 1)
  const interp = style === 0 ? 0 : 2 * style + mode - 1
  const setInterp = (v: number) => {
    const s = v ? Math.floor((v + 1) / 2) : 0, m = v ? (v + 1) % 2 : 0
    setComponent(ed, g, c, { interpolation_style: s, interpolation: m })
  }

  const h = EDIT_H, interpW = 8 * h, gridW = 2 * h, total = interpW + 2 * gridW + 2 * PAD
  return (
    <>
      <WaveSourceEditor at={WAVE} values={values.current} grid={grid} onChange={timeChanged} visible={loaded.current}
        onMenu={(e, act) => api.openMenu({ items: [
          { label: 'Clear', act: () => act('clear') }, { label: 'Flip Vertical', act: () => act('flipV') }, { label: 'Flip Horizontal', act: () => act('flipH') },
        ] }, e)} />
      <BarEditor at={AMP} heights={(k) => ampHeight(amps.current[k], k, ed.power)} zoom={ed.zoom} clear={0}
        setHeight={(k, y01) => { amps.current[k] = heightAmp(y01, k, ed.power) }} onChange={barsChanged} />
      <BarEditor at={PHASE} heights={(k) => (phases.current[k] + 1) / 2} zoom={ed.zoom} clear={0.25}
        setHeight={(k, y01) => { phases.current[k] = 2 * y01 - 1 }} onChange={barsChanged} />
      <Controls width={total} lines={[interpW, interpW + gridW + PAD]} titles={['', 'GRID X', 'GRID Y']}>
        <Selector at={[0, 0, interpW, h]} value={interp} options={INTERPOLATIONS} onChange={setInterp} />
        <TextSlider at={[interpW + PAD, TITLE_H, interpW + PAD + gridW, h]} value={grid[0]} min={0} max={16} step={1} def={6} inc
          onChange={(v) => setGrid([v, grid[1]])} />
        <TextSlider at={[interpW + 2 * PAD + gridW, TITLE_H, total, h]} value={grid[1]} min={0} max={16} step={1} def={4} inc
          onChange={(v) => setGrid([grid[0], v])} />
      </Controls>
    </>
  )
}

/** WaveSourceEditor: draw the wave freehand, snapping to the grid's points within a fifth of a cell;
 *  the hovered grid point lit, a line from the last point to the pointer while drawing. */
function WaveSourceEditor({ at, values, grid, onChange, onMenu, visible }: {
  at: Rect; values: Float32Array; grid: [number, number]; visible: boolean
  onChange: (start: number, end: number, final: boolean) => void
  onMenu: (e: React.MouseEvent, act: (what: 'clear' | 'flipV' | 'flipH') => void) => void
}) {
  const W = at[2] - at[0], H = at[3] - at[1]
  const st = useRef({ editing: false, last: { x: 0, y: 0 }, mouse: { x: -1e9, y: 0 } })
  const [, redraw] = useState(0)
  const [gx, gy] = grid
  const snapRadius = () => (gx === 0 || gy === 0 ? 0 : 0.2 * Math.min(H / gy, W / gx))
  const snapped = (p: { x: number; y: number }) => gx === 0 || gy === 0 ? p : { x: (W * Math.round((gx * p.x) / W)) / gx, y: (H * Math.round((gy * p.y) / H)) / gy }
  const snapToGrid = (p: { x: number; y: number }) => {
    const s = snapped(p)
    return Math.hypot(p.x - s.x, p.y - s.y) > snapRadius() ? st.current.last : s
  }
  const hovered = (p: { x: number }) => Math.max(0, Math.min(SIZE - 1, Math.floor((SIZE * p.x) / W)))
  /** changeValues: every sample between the last point and this one on the line joining them. */
  const change = (p0: { x: number; y: number }) => {
    const p = snapToGrid(p0), last = st.current.last
    const from = hovered(last), to = hovered(p)
    let y = p.y
    const slope = last.y - y === 0 ? 0 : (last.y - y) / (last.x - p.x)
    let nextX = (W * to) / SIZE, dir = -1
    if (to < from) { dir = 1; nextX += W / SIZE }
    let inc = nextX - p.x
    for (let k = to; k !== from + dir; k += dir) {
      if (k >= 0 && k < SIZE) values[k] = Math.max(-1, Math.min(1, (-2 * y) / H + 1))
      y += inc * slope
      inc = (dir * W) / SIZE
    }
    onChange(Math.min(from, to), Math.max(from, to), false)
  }
  const ref = useCanvas(W, (g, w, h, k) => {
    g.fillStyle = BG
    g.fillRect(0, 0, w, h)
    g.fillStyle = 'rgba(255,255,255,0.035)'
    for (let x = 1; x < gx; x++) g.fillRect(Math.round((x / gx) * w), 0, Math.max(1, PT * k * 0.72), h)
    for (let y = 1; y < gy; y++) g.fillRect(0, Math.round((y / gy) * h), w, Math.max(1, PT * k * 0.72))
    if (visible) drawWaveform(g, w, h, k, values, SIZE, PRIMARY, FILL)
    const r = snapRadius() * k
    if (r > 0) {
      g.fillStyle = 'rgba(255,255,255,0.19)'
      for (let x = 0; x <= gx; x++) for (let y = 0; y <= gy; y++) { g.beginPath(); g.arc((x / gx) * w, (y / gy) * h, r, 0, Math.PI * 2); g.fill() }
      const s = st.current, hp = s.editing ? s.last : snapped(s.mouse)
      g.fillStyle = 'rgba(255,255,255,0.3)'
      g.beginPath(); g.arc(hp.x * k, hp.y * k, r, 0, Math.PI * 2); g.fill()
    }
    const s = st.current
    if (s.editing) {
      g.strokeStyle = LIGHTEN; g.lineWidth = 2 * PT * k
      g.beginPath(); g.moveTo(s.last.x * k, s.last.y * k); g.lineTo(s.mouse.x * k, s.mouse.y * k); g.stroke()
    }
  })
  const act = (what: 'clear' | 'flipV' | 'flipH') => {
    if (what === 'clear') values.fill(0)
    else if (what === 'flipV') for (let k = 0; k < SIZE; k++) values[k] = -values[k]
    else values.reverse()
    onChange(0, SIZE - 1, true)
  }
  return <canvas ref={ref} className="wt-screen wt-edit" style={R(...at)}
    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onMenu(e, act) }}
    onPointerDown={(e) => {
      if (e.button !== 0) return
      capture(e)
      const p = local(e, e.currentTarget, W), s = st.current
      s.mouse = p
      s.last = snapped(p)
      change(p)
      s.editing = true
      redraw((n) => n + 1)
    }}
    onPointerMove={(e) => {
      const p = local(e, e.currentTarget, W), s = st.current
      s.mouse = p
      if (s.editing) { change(p); s.last = snapToGrid(p) }
      redraw((n) => n + 1)
    }}
    onPointerUp={(e) => {
      const s = st.current
      if (!s.editing) return
      s.editing = false
      const index = hovered(snapToGrid(local(e, e.currentTarget, W)))
      onChange(index, index, true)
      redraw((n) => n + 1)
    }}
    onPointerLeave={() => { st.current.mouse = { x: -W, y: 0 }; redraw((n) => n + 1) }} />
}

/** BarEditor: drag across the bars to draw their heights; right-click for Clear · Clear Left · Clear
 *  Right · Clear Odd · Clear Even · Randomize. `heights` / `setHeight` work in 0 (bottom) … 1. */
function BarEditor({ at, heights, setHeight, zoom, clear, onChange }: {
  at: Rect; heights: (i: number) => number; setHeight: (i: number, y01: number) => void; zoom: number; clear: number
  onChange: (final: boolean) => void
}) {
  const api = useVital()
  const W = at[2] - at[0], H = at[3] - at[1]
  const last = useRef<{ x: number; y: number } | null>(null)
  const lastEdit = useRef({ x: 0, y: 0 })
  const [, redraw] = useState(0)
  const hovered = (x: number) => Math.max(0, Math.min(BARS - 1, Math.floor((BARS * x) / W / zoom)))
  const change = (p: { x: number; y: number }) => {
    const prev = last.current ?? p
    const from = hovered(prev.x), to = hovered(p.x)
    let y = p.y
    const slope = prev.y - y === 0 ? 0 : (prev.y - y) / (prev.x - p.x)
    let nextX = (W * zoom * to) / BARS, dir = -1
    if (to < from) { dir = 1; nextX += (W * zoom) / BARS }
    let inc = nextX - p.x
    for (let k = to; k !== from + dir; k += dir) {
      if (k >= 0 && k < BARS) setHeight(k, Math.max(0, Math.min(1, 1 - y / H)))
      y += inc * slope
      inc = (dir * zoom * W) / BARS
    }
    redraw((n) => n + 1)
    onChange(false)
  }
  const ref = useCanvas(W, (g, w, h) => {
    g.fillStyle = BG
    g.fillRect(0, 0, w, h)
    drawBars(g, w, h, heights, zoom, PRIMARY, false)
  })
  const all = (fn: (k: number) => boolean, value: (k: number) => number = () => clear) => {
    for (let k = 0; k < BARS; k++) if (fn(k)) setHeight(k, value(k))
    redraw((n) => n + 1)
    onChange(true)
  }
  return <canvas ref={ref} className="wt-screen wt-edit" style={R(...at)}
    onContextMenu={(e) => {
      e.preventDefault(); e.stopPropagation()
      const pos = hovered(lastEdit.current.x)
      api.openMenu({ items: [
        { label: 'Clear', act: () => all(() => true) },
        { label: 'Clear Left', act: () => all((k) => k < pos) },
        { label: 'Clear Right', act: () => all((k) => k > pos) },
        { label: 'Clear Odd', act: () => all((k) => k % 2 === 1) },
        { label: 'Clear Even', act: () => all((k) => k % 2 === 0) },
        // randomize: the DC bar at the bottom, the rest anywhere.
        { label: 'Randomize', act: () => all(() => true, (k) => (k === 0 ? 0 : Math.random())) },
      ] }, e)
    }}
    onPointerDown={(e) => {
      const p = local(e, e.currentTarget, W)
      lastEdit.current = p
      if (e.button !== 0) return
      capture(e)
      last.current = p
      change(p)
    }}
    onPointerMove={(e) => { if (!last.current) return; const p = local(e, e.currentTarget, W); change(p); last.current = p }}
    onPointerUp={() => { if (last.current) { last.current = null; onChange(true) } }} />
}

/** WaveLineSourceOverlay: the keyframe's line drawn over the frame (LineEditor, filled to the centre,
 *  4 px wide) and PULL POWER · GRID X · GRID Y. Points added or removed reach every keyframe. */
const WT_SKIN: LineSkin = {
  primary1: PRIMARY, primary2: PRIMARY, secondary1: FILL, secondary2: FILL, center: PRIMARY,
  accent1: 'rgba(255,255,255,0.733)', accent2: 'rgba(255,255,255,0.067)', background: BG, lighten: LIGHTEN,
  primaryDisabled: DISABLED, secondaryDisabled: FILL_DISABLED, lineWidth: 4 * 1000 / 1440 / 1.44, lineBoost: 0, fillBoost: 0, fillFade: 0,
}
function LineSourceOverlay(props: { ed: Ed; g: number; c: number; i: number; comp: Comp }) {
  const { ed, g, c, i } = props
  const [kf, setKf] = useKeyframe(props)
  const [grid, setGrid] = useState<[number, number]>([6, 4])
  const [line, setLine] = useState<Line | null>(null)
  useEffect(() => { if (kf?.line) setLine(lineFromEngine(kf.line)) }, [kf?.line]) // eslint-disable-line react-hooks/exhaustive-deps
  const done = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onLine = (next: Line) => {
    const prev = line
    setLine(next)
    let index = 0, added = 0
    if (prev && prev.pts.length !== next.pts.length) {
      added = next.pts.length - prev.pts.length
      while (index < Math.min(prev.pts.length, next.pts.length) && prev.pts[index][0] === next.pts[index][0] && prev.pts[index][1] === next.pts[index][1]) index++
    }
    void ed.wt('line', g, c, i, lineToEngine(next), index, added, ed.dragPos()).then(() => {
      ed.changed(false)
      // frameDoneEditing once the gesture settles (LineEditor reports every move the same way).
      if (done.current) clearTimeout(done.current)
      done.current = setTimeout(() => ed.changed(true), 200)
    })
  }
  const h = EDIT_H, pullW = 2 * h, gridW = 2 * h, total = pullW + 2 * gridW + 2 * PAD
  return (
    <>
      {line && <LineEditor at={WAVE} line={line} onChange={onLine} loop={false} gridX={grid[0]} gridY={grid[1]} paint={false} pattern={0}
        skin={WT_SKIN} fillCenter={0.5} onScroll={(d) => setGrid([Math.max(0, Math.min(16, grid[0] + d)), grid[1]])} className="wt-linesource" />}
      <Controls width={total} lines={[pullW, pullW + gridW + PAD, pullW + 2 * (gridW + PAD)]} titles={['PULL POWER', 'GRID X', 'GRID Y']}>
        <TextSlider at={[0, TITLE_H, pullW, h]} value={Number(kf?.pull_power ?? 0)} min={0} max={5} def={0}
          onChange={(v, final) => setKf({ pull_power: v }, final)} />
        <TextSlider at={[pullW + PAD, TITLE_H, pullW + PAD + gridW, h]} value={grid[0]} min={0} max={16} step={1} def={6} inc onChange={(v) => setGrid([v, grid[1]])} />
        <TextSlider at={[pullW + 2 * PAD + gridW, TITLE_H, total, h]} value={grid[1]} min={0} max={16} step={1} def={4} inc onChange={(v) => setGrid([grid[0], v])} />
      </Controls>
    </>
  )
}

/** PhaseModifierOverlay: sixteen ticks over the frame (and a full-height set in the strip) that drag
 *  the phase left and right a cycle per width; STYLE and MIX. */
const PHASE_STYLES = ['Normal', '+Even/-Odd', 'Harmonic', 'Harm +Even/-Odd', 'Clear']
function PhaseOverlay(props: { ed: Ed; g: number; c: number; i: number; comp: Comp }) {
  const { ed, g, c, comp } = props
  const [kf, setKf] = useKeyframe(props)
  const phase = Number(kf?.phase ?? 0)
  const h = EDIT_H, styleW = 4 * h, phaseW = 8 * h, mixW = 5 * h, mixPad = 0.5 * h, total = styleW + phaseW + mixW + 2 * PAD
  const x0 = (2000 - total) / 2
  return (
    <>
      <PhaseTicks at={WAVE} phase={phase} maxHeight={0.2} onChange={(p, final) => setKf({ phase: p }, final)} />
      <Controls width={total} lines={[styleW, styleW + phaseW + PAD]} titles={['STYLE', '', 'MIX']}>
        <Selector at={[0, TITLE_H, styleW, h]} value={Number(comp.style ?? 0)} options={PHASE_STYLES} onChange={(v) => setComponent(ed, g, c, { style: v })} />
        <LinearBar at={[styleW + phaseW + 2 * PAD + mixPad, TITLE_H + (h - TITLE_H) * 0.3, total - mixPad, h - (h - TITLE_H) * 0.3]} value={Number(kf?.mix ?? 1)} def={1}
          onChange={(v, final) => setKf({ mix: v }, final)} />
      </Controls>
      <PhaseTicks at={[x0 + styleW + PAD, EDIT_Y, x0 + styleW + PAD + phaseW, EDIT_Y + h]} phase={phase} maxHeight={1} onChange={(p, final) => setKf({ phase: p }, final)} />
    </>
  )
}

/** PhaseEditor: kNumLines ticks at the phase, halving in height at each finer division. */
function PhaseTicks({ at, phase, maxHeight, onChange }: { at: Rect; phase: number; maxHeight: number; onChange: (p: number, final: boolean) => void }) {
  const W = at[2] - at[0]
  const ref = useCanvas(W, (g, w, h, k) => {
    g.fillStyle = LIGHTEN
    for (let i = 0; i < 16; i++) {
      let t = phase / (2 * Math.PI) + i / 16
      t -= Math.floor(t)
      let th = maxHeight
      for (let div = 2; div < 16; div *= 2) if (i % div) th /= 2
      g.fillRect(t * w, h - th * h, Math.max(1, PT * k * 0.72), th * h)
    }
  })
  const last = useRef<number | null>(null)
  const p = useRef(phase)
  p.current = phase
  return <canvas ref={ref} className="wt-ticks" style={R(...at)}
    onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); capture(e); last.current = local(e, e.currentTarget, W).x }}
    onPointerMove={(e) => {
      if (last.current === null) return
      const x = local(e, e.currentTarget, W).x
      p.current += (2 * Math.PI * (x - last.current)) / W
      last.current = x
      onChange(p.current, false)
    }}
    onPointerUp={() => { if (last.current !== null) { last.current = null; onChange(p.current, true) } }} />
}

/** WaveWindowOverlay: the window's two edges dragged over the frame (WaveWindowEditor), its SHAPE,
 *  LEFT POSITION and RIGHT POSITION. */
const WINDOW_SHAPES = ['Raised Cos', 'Half Sin', 'Linear', 'Square', 'Wiggle']
function applyWindow(shape: number, t: number) {
  if (shape === 0) return 0.5 - 0.5 * Math.cos(Math.PI * t)
  if (shape === 1) return Math.sin((Math.PI * t) / 2)
  if (shape === 3) return t < 1 ? 0 : 1
  if (shape === 4) return t * Math.cos(Math.PI * (t * 1.5 + 0.5))
  return t
}
function WindowOverlay(props: { ed: Ed; g: number; c: number; i: number; comp: Comp }) {
  const { ed, g, c, comp } = props
  const [kf, setKf] = useKeyframe(props)
  const left = Number(kf?.left_position ?? 0.25), right = Number(kf?.right_position ?? 0.75)
  const shape = Number(comp.window_shape ?? 0)
  const h = EDIT_H, shapeW = 5 * h, posW = 5 * h, posPad = 0.5 * h, total = shapeW + 2 * posW + 2 * PAD
  const bar = (x0: number): Rect => [x0, TITLE_H + (h - TITLE_H) * 0.3, x0 + posW - 2 * posPad, h - (h - TITLE_H) * 0.3]
  const lx = shapeW + PAD + posPad
  return (
    <>
      <WindowEditor at={WAVE} left={left} right={right} shape={shape} onChange={(l, r, final) => setKf({ left_position: l, right_position: r }, final)} />
      <Controls width={total} lines={[shapeW, shapeW + posW + PAD]} titles={['', 'LEFT POSITION', 'RIGHT POSITION']}>
        <Selector at={[0, 0, shapeW, h]} value={shape} options={WINDOW_SHAPES} onChange={(v) => setComponent(ed, g, c, { window_shape: v })} />
        <LinearBar at={bar(lx)} value={left} def={0} onChange={(v, final) => setKf({ left_position: Math.min(v, right) }, final)} />
        <LinearBar at={bar(lx + posW - 2 * posPad + PAD + 2 * posPad)} value={right} def={1} onChange={(v, final) => setKf({ right_position: Math.max(v, left) }, final)} />
      </Controls>
    </>
  )
}

/** WaveWindowEditor: the window's outline (filled to the centre), a grab bar at each edge (5 % of the
 *  width), lit while hovered or dragged. */
function WindowEditor({ at, left, right, shape, onChange }: { at: Rect; left: number; right: number; shape: number; onChange: (l: number, r: number, final: boolean) => void }) {
  const W = at[2] - at[0]
  const GRAB = 0.05
  const [hover, setHover] = useState<'l' | 'r' | null>(null)
  const editing = useRef<'l' | 'r' | null>(null)
  const pos = useRef({ left, right })
  pos.current = { left, right }
  const sideAt = (x: number): 'l' | 'r' | null => {
    const dl = Math.abs(left * W - x), dr = Math.abs(right * W - x)
    const chooseLeft = dl < dr || (dl === dr && x < left * W)
    if (dl < GRAB * W && chooseLeft) return 'l'
    if (dr < GRAB * W) return 'r'
    return null
  }
  const ref = useCanvas(W, (g, w, h, k) => {
    const half = h / 2, pts: [number, number][] = [], n = 50
    for (let i = 0; i < n; i++) { const t = i / (n - 1); pts.push([t * left * w, half + applyWindow(shape, t) * half]) }
    for (let i = 0; i < n; i++) { const t = i / (n - 1); pts.push([right * w + t * (w - right * w), half + applyWindow(shape, 1 - t) * half]) }
    const all = [...pts, ...pts.slice().reverse().map(([x, y]) => [x, h - y] as [number, number])]
    g.beginPath(); all.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath()
    g.fillStyle = fade(FILL, 0.5); g.fill()
    g.strokeStyle = PRIMARY; g.lineWidth = 2 * PT * k; g.lineJoin = 'round'; g.stroke()
    const quad = (x: number) => g.fillRect((x - GRAB / 2) * w, 0, GRAB * w, h)
    g.fillStyle = 'rgba(255,255,255,0.066)'
    quad(left); quad(right)
    const lit = editing.current ?? null
    if (lit) quad(lit === 'l' ? left : right)
    if (hover) quad(hover === 'l' ? left : right)
  })
  const move = (x: number, final: boolean) => {
    const t = x / W, { left: l, right: r } = pos.current
    if (editing.current === 'l') onChange(Math.max(0, Math.min(r, t)), r, final)
    else if (editing.current === 'r') onChange(l, Math.max(l, Math.min(1, t)), final)
  }
  return <canvas ref={ref} className="wt-ticks" style={R(...at)}
    onPointerDown={(e) => { if (e.button !== 0) return; capture(e); const x = local(e, e.currentTarget, W).x; editing.current = sideAt(x); move(x, false) }}
    onPointerMove={(e) => { const x = local(e, e.currentTarget, W).x; if (editing.current) move(x, false); else setHover(sideAt(x)) }}
    onPointerUp={(e) => { if (editing.current) { move(local(e, e.currentTarget, W).x, true); editing.current = null; setHover(null) } }}
    onPointerLeave={() => setHover(null)} />
}

/** FrequencyFilterOverlay: STYLE · CUTOFF · SHAPE and NORMALIZE. */
const FILTER_STYLES = ['Low Pass', 'Band Pass', 'High Pass', 'Comb']
function FilterOverlay(props: { ed: Ed; g: number; c: number; i: number; comp: Comp }) {
  const { ed, g, c, comp } = props
  const [kf, setKf] = useKeyframe(props)
  const h = EDIT_H, sw = 4 * h, total = 4 * sw + 3 * PAD, np = h / 6
  return (
    <Controls width={total} lines={[sw, 2 * sw + PAD, 3 * sw + 2 * PAD]} titles={['STYLE', 'CUTOFF', 'SHAPE']}>
      <Selector at={[0, TITLE_H, sw, h]} value={Number(comp.style ?? 0)} options={FILTER_STYLES} onChange={(v) => setComponent(ed, g, c, { style: v })} />
      <TextSlider at={[sw + PAD, TITLE_H, 2 * sw + PAD, h]} value={Number(kf?.cutoff ?? 4)} min={0} max={10} def={4} onChange={(v, final) => setKf({ cutoff: v }, final)} />
      <TextSlider at={[2 * sw + 2 * PAD, TITLE_H, 3 * sw + 2 * PAD, h]} value={Number(kf?.shape ?? 0.5)} min={0} max={1} def={0.5} onChange={(v, final) => setKf({ shape: v }, final)} />
      <Toggle at={[3 * sw + 2 * PAD, np, 4 * sw + 2 * PAD, h - np]} label="NORMALIZE" on={!!comp.normalize} onChange={(on) => setComponent(ed, g, c, { normalize: on })} />
    </Controls>
  )
}

/** SlewLimiterOverlay: the two limits (Vital titles them DOWN LIMIT then UP LIMIT over the up then
 *  down sliders). */
function SlewOverlay(props: { ed: Ed; g: number; c: number; i: number; comp: Comp }) {
  const [kf, setKf] = useKeyframe(props)
  const h = EDIT_H, lw = 4 * h, total = 2 * lw + PAD
  return (
    <Controls width={total} lines={[lw]} titles={['DOWN LIMIT', 'UP LIMIT']}>
      <TextSlider at={[0, TITLE_H, lw, h]} value={Number(kf?.up_run_rise ?? 0)} min={0} max={1} def={0} onChange={(v, final) => setKf({ up_run_rise: v }, final)} />
      <TextSlider at={[lw + PAD, TITLE_H, total, h]} value={Number(kf?.down_run_rise ?? 0)} min={0} max={1} def={0} onChange={(v, final) => setKf({ down_run_rise: v }, final)} />
    </Controls>
  )
}

/** WaveFoldOverlay: MULTIPLY. */
function FoldOverlay(props: { ed: Ed; g: number; c: number; i: number; comp: Comp }) {
  const [kf, setKf] = useKeyframe(props)
  const h = EDIT_H, w = 4 * h
  return (
    <Controls width={w} lines={[]} titles={['MULTIPLY']}>
      <TextSlider at={[0, TITLE_H, w, h]} value={Number(kf?.fold_boost ?? 1)} min={1} max={32} def={1} onChange={(v, final) => setKf({ fold_boost: v }, final)} />
    </Controls>
  )
}

/** WaveWarpOverlay: X Asymmetric · X WARP · Y Asymmetric · Y WARP. */
function WarpOverlay(props: { ed: Ed; g: number; c: number; i: number; comp: Comp }) {
  const { ed, g, c, comp } = props
  const [kf, setKf] = useKeyframe(props)
  const h = EDIT_H, sym = 3.5 * h, warp = 5 * h, wp = 0.5 * h, total = 2 * sym + 2 * warp + 3 * PAD, sp = h / 6
  const hx = sym + PAD + wp, vx = hx + warp - 2 * wp + PAD + wp, vwx = vx + sym + PAD + wp
  return (
    <Controls width={total} lines={[sym, sym + warp + PAD, 2 * sym + warp + 2 * PAD, total]} titles={['', 'X WARP', '', 'Y WARP']}>
      <Toggle at={[0, sp, sym, h - sp]} label="X Asymmetric" on={!!comp.horizontal_asymmetric} onChange={(on) => setComponent(ed, g, c, { horizontal_asymmetric: on })} />
      <TextSlider at={[hx, TITLE_H, hx + warp - 2 * wp, h]} value={Number(kf?.horizontal_power ?? 0)} min={-20} max={20} def={0} onChange={(v, final) => setKf({ horizontal_power: v }, final)} />
      <Toggle at={[vx, sp, vx + sym, h - sp]} label="Y Asymmetric" on={!!comp.vertical_asymmetric} onChange={(on) => setComponent(ed, g, c, { vertical_asymmetric: on })} />
      <TextSlider at={[vwx, TITLE_H, vwx + warp - 2 * wp, h]} value={Number(kf?.vertical_power ?? 0)} min={-20} max={20} def={0} onChange={(v, final) => setKf({ vertical_power: v }, final)} />
    </Controls>
  )
}

/** FileSourceOverlay: the audio (AudioFileViewer, its window lit; drag it to move the window, drop
 *  audio on it to load), POSITION and WINDOW SIZE boxes (a note name sets the size to its period),
 *  WINDOW FADE, BLEND STYLE, PHASE STYLE and NORMALIZE. */
const FADE_STYLES = ['File Blend', 'None', 'Time', 'Spectral']
const FILE_PHASES = ['None', 'Clear', 'Vocode']
function noteToMidiKey(text: string): number {
  const scale = [-3, -1, 0, 2, 4, 5, 7]
  let t = text.toLowerCase().replace(/ /g, '')
  if (text.length < 2) return -1
  const n = t.charCodeAt(0) - 97
  if (n < 0 || n >= 7) return -1
  let offset = scale[n]
  t = t.slice(1)
  if (t[0] === '#') { t = t.slice(1); offset++ } else if (t[0] === 'b') { t = t.slice(1); offset-- }
  if (!t.length) return -1
  let negative = false
  if (t[0] === '-') { t = t.slice(1); negative = true; if (!t.length) return -1 }
  let octave = t.charCodeAt(0) - 48
  if (negative) octave = -octave
  return 12 * (octave + 1) + offset
}
function FileSourceOverlay(props: { ed: Ed; g: number; c: number; i: number; comp: Comp }) {
  const { ed, g, c, comp } = props
  const [kf, setKf] = useKeyframe(props)
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  const [dragging, setDragging] = useState(false)
  const samples = Number(comp.samples ?? 0), rate = Number(comp.sample_rate ?? 44100)
  const windowSize = Number(comp.window_size ?? 2048)
  const start = Number(kf?.start_position ?? 0)
  useEffect(() => { void ed.wt('filePeaks', g, c).then((r) => setPeaks(r.length ? (r.data as Float32Array) : null)) }, [ed.rev, g, c]) // eslint-disable-line react-hooks/exhaustive-deps
  const [posText, setPosText] = useState('')
  const [sizeText, setSizeText] = useState('')
  useEffect(() => setPosText(start.toFixed(1)), [start])
  useEffect(() => setSizeText(windowSize.toFixed(1)), [windowSize])
  const maxPos = Math.max(0, samples - windowSize)
  const setStart = (p: number, final: boolean) => setKf({ start_position: Math.max(0, Math.min(maxPos, p)) }, final)

  const h = EDIT_H, textW = 2.5 * h, fadeW = 3 * h, selW = 3 * h, normW = 2.5 * h, border = 1.5 * h
  const total = 2000 - 2 * border
  const audioW = total - normW - 2 * selW - fadeW - 2 * textW - 6 * PAD
  const ex = audioW + PAD
  const lines = [audioW, audioW + textW + PAD, audioW + 2 * textW + 2 * PAD, audioW + 2 * textW + fadeW + 3 * PAD,
    audioW + 2 * textW + fadeW + selW + 4 * PAD, audioW + 2 * textW + fadeW + 2 * selW + 5 * PAD]
  const load = async (file: File) => {
    if (!ed.ctx) return
    let audio
    try { audio = await readAudioFile(file, ed.ctx) } catch { window.alert(`${file.name} isn't an audio file this browser can read.`); return }
    await ed.wt('fileLoad', g, c, audio.channels[0].slice(0, 176400), audio.sampleRate)
    await ed.reload()
  }
  const np = h / 6
  const text = (at: Rect, value: string, set: (s: string) => void, apply: (s: string) => void) => (
    <input className="wt-textedit" style={{ ...R(...at), fontSize: ((at[3] - at[1]) * 0.6) / 2 }} value={value}
      onChange={(e) => set(e.currentTarget.value)} onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { apply(e.currentTarget.value); e.currentTarget.blur() } }}
      onBlur={(e) => apply(e.currentTarget.value)} />
  )
  return (
    <Controls width={total} lines={lines} titles={['', 'POSITION', 'WINDOW SIZE', 'WINDOW FADE', 'BLEND STYLE', 'PHASE STYLE', '']}>
      <AudioViewer at={[1, 1, audioW, h - 1]} peaks={peaks} position={samples ? start / samples : 0} size={samples ? windowSize / samples : 1}
        fade={Number(kf?.window_fade ?? 1)} dragging={dragging}
        onMove={(ratio, final) => setStart(start + ratio * maxPos, final)}
        onDragState={setDragging} onDrop={(f) => void load(f)} />
      {text([ex, TITLE_H, ex + textW, h - 1], posText, setPosText, (s) => setStart(parseFloat(s) || 0, true))}
      {text([ex + textW + PAD, TITLE_H, ex + 2 * textW + PAD, h - 1], sizeText, setSizeText, (s) => {
        // windowTextToSize: a note's period at the file's rate, else the number (1 … 9999.9).
        const note = noteToMidiKey(s.trim())
        const size = note < 0 || note >= 128 ? Math.max(1, Math.min(9999.9, parseFloat(s) || 0)) : rate / (440 * Math.pow(2, (note - 69) / 12))
        setComponent(ed, g, c, { window_size: size })
      })}
      <TextSlider at={[ex + 2 * textW + 2 * PAD, TITLE_H, ex + 2 * textW + 2 * PAD + fadeW, h]} value={Number(kf?.window_fade ?? 1)} min={0} max={1} def={1}
        onChange={(v, final) => setKf({ window_fade: v }, final)} />
      <Selector at={[lines[3] + PAD, TITLE_H, lines[3] + PAD + selW, h]} value={Number(comp.fade_style ?? 0)} options={FADE_STYLES} onChange={(v) => setComponent(ed, g, c, { fade_style: v })} />
      <Selector at={[lines[4] + PAD, TITLE_H, lines[4] + PAD + selW, h]} value={Number(comp.phase_style ?? 0)} options={FILE_PHASES} onChange={(v) => setComponent(ed, g, c, { phase_style: v })} />
      <Toggle at={[lines[5] + PAD, np, lines[5] + PAD + normW, h - np]} label="NORMALIZE" on={!!comp.normalize_gain} onChange={(on) => setComponent(ed, g, c, { normalize_gain: on })} />
    </Controls>
  )
}

/** AudioFileViewer: the file's peaks mirrored about the centre (Widget Primary 1, filled at 10 %), the
 *  window and its fades lit; dragging moves the window by the drag's share of the width. */
function AudioViewer({ at, peaks, position, size, fade: windowFade, dragging, onMove, onDragState, onDrop }: {
  at: Rect; peaks: Float32Array | null; position: number; size: number; fade: number; dragging: boolean
  onMove: (ratio: number, final: boolean) => void; onDragState: (on: boolean) => void; onDrop: (f: File) => void
}) {
  const W = at[2] - at[0]
  const ref = useCanvas(W, (g, w, h, k) => {
    const buffer = h * 0.1, inner = h - 2 * buffer, center = buffer + inner / 2, n = 256
    const fadeLen = Math.max(windowFade * size, 1 / n)
    const s0 = position - fadeLen / 2, s1 = position + size + fadeLen / 2
    const boost = (i: number) => {
      const t = i / (n - 1)
      const p = Math.max(0, Math.min(1, Math.min(t - s0, s1 - t) / fadeLen)) * Math.PI
      return 0.5 - Math.cos(p) * 0.5
    }
    for (let i = 0; i < n - 1; i++) {
      const v0 = peaks ? peaks[i] : 0, v1 = peaks ? peaks[i + 1] : 0
      const x0 = (i / (n - 1)) * w, x1 = ((i + 1) / (n - 1)) * w
      const b = (boost(i) + boost(i + 1)) / 2
      g.fillStyle = `rgba(170,136,255,${0.1 + 0.9 * b * 0.6})`
      g.beginPath(); g.moveTo(x0, center - v0 * (inner / 2)); g.lineTo(x1, center - v1 * (inner / 2)); g.lineTo(x1, center + v1 * (inner / 2)); g.lineTo(x0, center + v0 * (inner / 2)); g.closePath(); g.fill()
    }
    g.strokeStyle = PRIMARY; g.lineWidth = 1.5 * k
    for (const sign of [-1, 1]) {
      g.beginPath()
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * w, y = center + sign * (peaks ? peaks[i] : 0) * (inner / 2); if (i) g.lineTo(x, y); else g.moveTo(x, y) }
      g.stroke()
    }
    if (dragging) { g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, 0, w, h) }
  })
  const last = useRef<number | null>(null)
  return <canvas ref={ref} className="wt-audio" style={R(...at)}
    onDragOver={(e) => { if ([...e.dataTransfer.items].some((it) => it.kind === 'file')) { e.preventDefault(); onDragState(true) } }}
    onDragLeave={() => onDragState(false)}
    onDrop={(e) => { e.preventDefault(); onDragState(false); const f = e.dataTransfer.files[0]; if (f) onDrop(f) }}
    onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); capture(e); last.current = local(e, e.currentTarget, W).x }}
    onPointerMove={(e) => { if (last.current === null) return; const x = local(e, e.currentTarget, W).x; onMove((x - last.current) / W, false); last.current = x }}
    onPointerUp={(e) => { if (last.current === null) return; const x = local(e, e.currentTarget, W).x; onMove((x - last.current) / W, true); last.current = null }} />
}

/** A mono 16-bit WAV with a "clm " chunk (WavetableEditSection::exportToWav's file). */
function wavFile(data: Float32Array, rate: number, clm: string): Blob {
  const clmBytes = new TextEncoder().encode(clm)
  const clmSize = clmBytes.length + (clmBytes.length & 1)
  const dataSize = data.length * 2
  const buf = new ArrayBuffer(12 + 24 + 8 + clmSize + 8 + dataSize)
  const v = new DataView(buf)
  let o = 0
  const tag = (s: string) => { for (let i = 0; i < 4; i++) v.setUint8(o++, s.charCodeAt(i)) }
  const u32 = (n: number) => { v.setUint32(o, n, true); o += 4 }
  const u16 = (n: number) => { v.setUint16(o, n, true); o += 2 }
  tag('RIFF'); u32(buf.byteLength - 8); tag('WAVE')
  tag('fmt '); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
  tag('clm '); u32(clmBytes.length); new Uint8Array(buf, o, clmBytes.length).set(clmBytes); o += clmSize
  tag('data'); u32(dataSize)
  for (let i = 0; i < data.length; i++, o += 2) v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767))), true)
  return new Blob([buf], { type: 'audio/wav' })
}
