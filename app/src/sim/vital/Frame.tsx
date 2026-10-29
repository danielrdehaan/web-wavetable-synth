import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useEngine } from '../../engine/EngineContext'
import { OutputDisplay } from '../../engine/OutputDisplay'
import { DEFAULT_PRESET_KEY, defaultPreset, initializePreset, loadPresetText } from './presetIO'
import { jumpPreset } from './PresetBrowser'
import { requestSave } from './SaveOverlay'
import { importBank } from '../../engine/library'
import { SourceButton } from './SourceButton'
import { useStatusLanes } from '../../engine/status'
import { noteVelocity } from '../../engine/velocity'
import { useMidiNotes } from '../../engine/midi'
import { clearTuning, pickTuningFile, useTuning } from '../../engine/tuning'
import { APP_NAME } from '../../name'
import { Region } from '../kit'
import { Box, Bubble, Knob, TextEntry } from './controls'
import { mix } from './LineEditor'
import { useVital } from './ctx'
import { oscFrame } from './draw'
import { R, useControlMenu, useNow, useSlider } from './hooks'
import { norm, shown } from './params'
import { sk, useSkinColors, useSkinValues } from './skin'
import { capturePointer } from '../pointer'

// Vital's frame: the header (page tabs, preset bar, undo/redo, the volume strip and scope), the macro
// column with the wheels, and the keyboard. The header mark is a neutral one, not Vital's logo, and
// the title bar carries this build's own name (builds of Vital's source mustn't be called Vital). Each
// part takes its Vital skin section (data-skin): Header, Logo, Macro, Keyboard (the wheels' BendSection
// and the keyboard); the title bar isn't Vital's and keeps its own colours.

export type Page = 'voice' | 'effects' | 'matrix' | 'advanced'
const TABS: { id: Page; label: string; cx: number; mark: number }[] = [
  { id: 'voice', label: 'VOICE', cx: 196, mark: 127 }, { id: 'effects', label: 'EFFECTS', cx: 336, mark: 267 },
  { id: 'matrix', label: 'MATRIX', cx: 475, mark: 405 }, { id: 'advanced', label: 'ADVANCED', cx: 614, mark: 545 },
]

export function Header() {
  const api = useVital()
  const page = (api.ui.page as Page) ?? 'voice'
  const mark = TABS.find((t) => t.id === page)!.mark
  const { engine } = useEngine()
  const file = useRef<HTMLInputElement>(null)
  const bankFile = useRef<HTMLInputElement>(null)
  // A fresh start opens the default preset once one is set, as Vital opens with it.
  const started = useRef(false)
  useEffect(() => {
    if (!engine || started.current) return
    started.current = true
    const text = defaultPreset()
    if (text && !api.ui.modified) void loadPresetText(api, engine, text, 'Init Preset')
  }, [engine]) // eslint-disable-line react-hooks/exhaustive-deps
  const openPreset = async (f: File) => {
    if (!engine) return
    if (!(await loadPresetText(api, engine, await f.text(), f.name.replace(/\.vital$/i, '')))) window.alert(`${f.name} isn't a preset this synth can read.`)
    else api.setUi({ presetFile: undefined, presetExternal: true })
  }
  /** The patch as .vital text, its macro names included. */
  const presetText = (name: string) => {
    const macros = Object.fromEntries([0, 1, 2, 3].map((m) => [`macro${m + 1}`, (api.ui[`macro_${m}_name`] as string | undefined) ?? `MACRO ${m + 1}`]))
    return engine!.savePreset({ preset_name: name, ...macros })
  }
  const download = (name: string, text: string) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    a.download = `${name.replace(/[\\/:*?"<>|]/g, '_')}.vital`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  const current = () => (api.ui.preset_name as string | undefined) ?? 'Init Preset'
  /** Save Preset: the save box (SaveSection), into User. */
  const openSave = () => requestSave(api, { kind: 'preset', ext: 'vital', name: current() })
  /** Export Preset: writes the patch under its current name; the session keeps its name and state. */
  const exportPreset = async () => {
    if (!engine) return
    download(current(), await presetText(current()))
  }
  /** Set as Default Preset: Initialize Preset (and a fresh start) load this patch from then on. */
  const setDefault = async () => {
    if (!engine) return
    try { localStorage.setItem(DEFAULT_PRESET_KEY, await presetText(current())) } catch { /* storage unavailable */ }
  }
  const tuning = useTuning()
  const presetMenu = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    api.openMenu({ w: 120, items: [
      { label: 'Browse Presets', act: () => api.setUi({ presetBrowser: true }) }, { label: 'Save Preset', dim: !engine, act: engine ? openSave : undefined },
      { label: 'Open External Preset', dim: !engine, act: engine ? () => file.current?.click() : undefined },
      { label: 'Export Preset', dim: !engine, act: engine ? () => void exportPreset() : undefined },
      { label: 'Import Bank', act: () => bankFile.current?.click() },
      { label: 'Export Bank', act: () => api.setUi({ bankExporter: true, presetBrowser: undefined }) }, { sep: true },
      { label: 'Initialize Preset', act: () => void initializePreset(api, engine) },
      { label: 'Set as Default Preset', dim: !engine, act: engine ? () => void setDefault() : undefined }, { sep: true },
      { label: 'Load Tuning File', dim: !engine, act: engine ? () => pickTuningFile(engine) : undefined },
      ...(!tuning.isDefault ? [{ label: `Clear Tuning: ${tuning.name}`, act: () => { if (engine) void clearTuning(engine) } }] : []),
    ] }, e)
  }
  return (
    <>
      <div className="vt-title"><i /><i /><i /><span>{APP_NAME}</span></div>
      <input ref={bankFile} type="file" accept=".vitalbank,application/zip" hidden
        onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void importBank(f).then((n) => { if (!n) window.alert(`${f.name} has no presets, wavetables, LFOs or samples in it.`) }) }} />
      <input ref={file} type="file" accept=".vital,application/json" hidden
        onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void openPreset(f) }} />
      <div className="vt-headerskin" data-skin="Header">
      <div className="vt-b vt-header" style={R(0, 38, 2000, 108)} />
      {/* A neutral mark where Vital's logo sits. */}
      {/* In the Logo skin: the ring in Widget Primary 1, the mark in Widget Secondary 1 (LogoButton's ring and
          letter colours). */}
      <svg className="vt-logo" data-skin="Logo" style={R(38, 47, 90, 103)} viewBox="0 0 52 56" aria-label="About" onClick={(e) => { e.stopPropagation(); api.setUi({ about: true }) }}>
        <circle cx={26} cy={28} r={21} fill="none" style={{ stroke: sk('Widget Primary 1') }} strokeWidth={3} />
        <path d="M9 28 C 15 12, 20 12, 26 28 S 37 44, 43 28" fill="none" style={{ stroke: sk('Widget Secondary 1') }} strokeWidth={3} strokeLinecap="round" />
      </svg>
      {!api.ui.presetBrowser && !api.ui.bankExporter && <><div className="vt-b vt-tabtrack" style={R(127, 39, 683, 43)} />
        <div className="vt-b vt-tabmark" style={R(mark, 39, mark + 140, 43)} /></>}
      {/* HeaderSection::setTemporaryTab: while the preset browser is open its name takes the tabs' place,
          with an × that closes it. */}
      {api.ui.presetBrowser || api.ui.bankExporter ? (
        <div className="vt-temptab" style={R(127, 39, 683, 108)}>
          <svg viewBox="0 0 1 1" className="vt-tempx" onClick={(e) => { e.stopPropagation(); api.setUi({ presetBrowser: undefined, bankExporter: undefined }) }} aria-label="Close">
            <path d="M0.25 0.25 L0.75 0.75 M0.25 0.75 L0.75 0.25" />
          </svg>
          <span>{api.ui.bankExporter ? 'EXPORT BANK' : 'PRESET BROWSER'}</span>
        </div>
      ) : TABS.map((t) => {
        const btn = (
          <button key={t.id} type="button" className={`vt-tab${page === t.id ? ' on' : ''}`} style={{ left: t.cx / 2 - 40, top: 58 / 2, width: 80 }}
            onClick={(e) => { e.stopPropagation(); api.setUi({ page: t.id }) }}>{t.label}</button>
        )
        return t.id === 'effects' ? <Region key={t.id} tags={['effects']} className="vt-tabregion" label="EFFECTS page">{btn}</Region> : btn
      })}
      <Box at={[701, 55, 1247, 93]} className="vt-preset" onContextMenu={presetMenu}>
        <span className="arr" onClick={(e) => { e.stopPropagation(); if (engine) void jumpPreset(api, engine, -1) }}>‹</span>
        <span className="nm" onClick={(e) => { e.stopPropagation(); api.setUi({ presetBrowser: api.ui.presetBrowser ? undefined : true, bankExporter: undefined }) }}>{api.ui.modified ? '*' : ''}{(api.ui.preset_name as string | undefined) ?? 'Init Preset'}</span>
        <span className="arr" onClick={(e) => { e.stopPropagation(); if (engine) void jumpPreset(api, engine, 1) }}>›</span>
      </Box>
      <div className="vt-b vt-tools" style={R(1260, 58, 1440, 90)}>
        <span className={api.canUndo ? '' : 'dim'} onClick={(e) => { e.stopPropagation(); api.undo() }} title="Undo">↶</span>
        <span className={api.canRedo ? '' : 'dim'} onClick={(e) => { e.stopPropagation(); api.redo() }} title="Redo">↷</span>
        <span className={engine ? '' : 'dim'} onClick={(e) => { e.stopPropagation(); openSave() }} title="Save">⤓</span>
        <span onClick={presetMenu} title="Menu">≡</span>
      </div>
      <Volume />
      <Scope />
      </div>
    </>
  )
}

// The volume strip (volume_section.cpp / peak_meter_viewer.cpp), in the header's own units: the
// section spans the header's height, each meter is an eighth of it, starting 3/8 down; ticks every
// 6 dB from −66 to +6 sit under the meters and the volume slider is the white arrow between them.
const VOL = { x: 1456.7, y: 40, w: 263.3, h: 66.5 }
const PT = 2000 / 1440 // one of Vital's points in the drawing's units
const METER_MIN_DB = -80, METER_MAX_DB = 6, CLIP_SECONDS = 71 / 60 // kClampDecay 0.014 a frame at 60 fps
const meterT = (mag: number) => {
  const db = 20 * Math.log10(Math.max(mag, 1e-9))
  const t = Math.max((db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB), 0)
  return Math.min(t * t, 1)
}

/** The volume slider over the left / right peak meters, as Vital's header draws them. */
export function Volume() {
  const api = useVital()
  const { w, h } = VOL
  const mh = h / 8, buffer = h / 2 - mh, pad = PT
  const sl = useSlider('volume', { kind: 'x', length: w / 2 })
  const menu = useControlMenu('volume', () => sl.setEditing(true))
  const x = norm('volume', api.v.volume ?? 0) * w
  const pointY = buffer + 2 * mh + 2 * pad, endY = buffer + 3.5 * mh
  const arrow = endY - pointY
  const ticksY = buffer + 2 * mh + pad + 4 * PT, tickH = mh / 2
  const ticks: number[] = []
  for (let db = -66; db <= 6; db += 6) ticks.push(((db + 80) ** 2 / 7399.4404) * w)
  // PeakMeterViewer's corners: a third of its height, at most half the Widget Rounded Corner.
  const ref = useRef<HTMLDivElement>(null)
  const rounded = useSkinValues(ref, ['Widget Rounded Corner'] as const)['Widget Rounded Corner']
  const radius = Math.min(mh / 3, (rounded / 2) * PT)
  return (
    <Box at={[VOL.x, VOL.y, VOL.x + w, VOL.y + h]} className="vt-meter" {...sl.handlers} ref={(el: HTMLDivElement | null) => { ref.current = el; sl.handlers.ref(el) }} onContextMenu={menu} title="Volume">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
        <PeakMeter lane={0} y={buffer} w={w} h={mh} radius={radius} />
        <PeakMeter lane={1} y={buffer + mh + PT} w={w} h={mh} radius={radius} />
        {ticks.map((tx) => <rect key={tx} x={tx} y={ticksY} width={PT} height={tickH} style={{ fill: sk('Lighten Screen') }} />)}
        <path d={`M${x} ${pointY}L${x + arrow / 2} ${endY}L${x - arrow / 2} ${endY}Z`} style={{ fill: sk('Linear Slider Thumb') }} />
      </svg>
      {sl.popup && <Bubble at="below" text={shown('volume', api.v.volume ?? 0)} />}
      {sl.editing && <TextEntry p="volume" onDone={() => sl.setEditing(false)} />}
    </Box>
  )
}

/** One channel's peak meter: the level, its held peak (a one-point line) and the clip latch, in the Header
 *  skin: Widget Secondary 1 → 2 (Widget Accent 1 → 2 while clipped) over Widget Background below 0 dB
 *  and Widget Background half-way to Background above it, the 0 dB line in Lighten Screen. */
function PeakMeter({ lane, y, w, h, radius }: { lane: number; y: number; w: number; h: number; radius: number }) {
  const peak = useStatusLanes('peak_meter')?.[lane]
  const memory = useStatusLanes('peak_meter_memory')?.[lane]
  const clipUntil = useRef(0)
  const now = performance.now() / 1000
  if ((peak ?? 0) > 1 || (memory ?? 0) > 1) clipUntil.current = now + CLIP_SECONDS
  const clipped = now < clipUntil.current
  const zero = w * meterT(1)
  const id = `vt-peak-${lane}`
  const live = peak !== undefined && Number.isFinite(peak)
  const held = memory !== undefined && Number.isFinite(memory) ? meterT(memory) * w : null
  return (
    <>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2={w} y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: sk(clipped ? 'Widget Accent 1' : 'Widget Secondary 1') }} />
          <stop offset="1" style={{ stopColor: sk(clipped ? 'Widget Accent 2' : 'Widget Secondary 2') }} />
        </linearGradient>
        <clipPath id={`${id}c`}><rect x={0} y={y} width={w} height={h} rx={radius} /></clipPath>
      </defs>
      <g clipPath={`url(#${id}c)`}>
        <rect x={0} y={y} width={zero} height={h} style={{ fill: sk('Widget Background') }} />
        <rect x={zero} y={y} width={w - zero} height={h} style={{ fill: 'color-mix(in srgb, var(--sk-widget-background) 50%, var(--sk-background))' }} />
        <rect x={zero} y={y} width={PT} height={h} style={{ fill: sk('Lighten Screen') }} />
        {live && <rect x={0} y={y} width={meterT(peak) * w} height={h} fill={`url(#${id})`} />}
        {held !== null && held > 0 && <rect x={held - PT} y={y} width={PT} height={h} fill={`url(#${id})`} />}
      </g>
    </>
  )
}

/** The header display: the engine's oscilloscope, or its spectrogram once clicked (view_spectrogram, a
 *  button over the display that the preset saves). Before sound is on, a drawn stand-in. */
function Scope() {
  const { engine } = useEngine()
  return engine ? <EngineScope /> : <DrawnScope />
}

/** The header display: the oscilloscope, or the spectrogram (−40 … 0 dB, no grid) once clicked. */
function EngineScope() {
  const api = useVital()
  const spectrogram = Math.round(api.v.view_spectrogram ?? 0) === 1
  return (
    <Box at={[1731, 47.6, 1986, 99.7]} className="vt-scope" title={spectrogram ? 'Spectrogram' : 'Oscilloscope'}
      onClick={(e) => { e.stopPropagation(); api.set('view_spectrogram', spectrogram ? 0 : 1) }}>
      <OutputDisplay w={255} h={52} spectrogram={spectrogram ? { id: 0, minDb: -40, maxDb: 0 } : null} pt={PT} />
    </Box>
  )
}

function DrawnScope() {
  const api = useVital()
  const on = api.notes.size > 0 && (api.v.osc_1_on ?? 0) >= 0.5
  const now = useNow(on)
  const table = (api.ui.osc_1_table as string) ?? 'Init'
  const f = oscFrame(table, (api.v.osc_1_wave_frame ?? 0) / 256, Math.round(api.v.osc_1_distortion_type ?? 0), api.v.osc_1_distortion_amount ?? 0.5, Math.round(api.v.osc_1_spectral_morph_type ?? 0), api.v.osc_1_spectral_morph_amount ?? 0.5, 64)
  const shift = (now / 900) % 1
  const amp = 9 * (api.v.osc_1_level ?? 0.7)
  const d = on ? Array.from({ length: 129 }, (_, k) => { const ph = ((k / 64 + shift) % 1) * 63; return `${k ? 'L' : 'M'} ${(k / 128 * 127.5).toFixed(1)} ${(12.5 - f[Math.floor(ph)] * amp).toFixed(1)}` }).join(' ') : 'M 0 12.5 L 127.5 12.5'
  return (
    <Box at={[1731, 47, 1986, 99]} className="vt-scope">
      <svg viewBox="0 0 127.5 26" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}><path d={d} fill="none" style={{ stroke: sk('Widget Primary 1') }} strokeWidth={0.9} /></svg>
    </Box>
  )
}

/** The macro's label and its rename (SingleMacroSection): the pencil opens an editor with the name
 *  selected; Enter or leaving saves it trimmed and upper-cased (an empty name keeps the old one),
 *  Escape cancels. */
function MacroName({ m }: { m: number }) {
  const api = useVital()
  const [edit, setEdit] = useState(false)
  const cancelled = useRef(false)
  const name = (api.ui[`macro_${m}_name`] as string) ?? `MACRO ${m + 1}`
  const save = (text: string) => {
    setEdit(false)
    if (cancelled.current) { cancelled.current = false; return }
    const next = text.trim().toUpperCase()
    if (next && next !== name) { api.checkpoint(); api.setUi({ [`macro_${m}_name`]: next }) }
  }
  return (
    <>
      <span className="vt-pen" style={{ left: 80 / 2, top: (m * 200 + 70) / 2 }} title="Rename" onClick={(e) => { e.stopPropagation(); setEdit(true) }}>✎</span>
      {edit
        ? <input className="vt-mname" autoFocus defaultValue={name} style={{ left: 0, top: (m * 200 + 99) / 2, width: 99 / 2 }} onClick={(e) => e.stopPropagation()}
          onFocus={(e) => e.currentTarget.select()} onBlur={(e) => save(e.currentTarget.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() } else if (e.key === 'Enter') e.currentTarget.blur() }} />
        : <span className="vt-mlabel" style={{ left: 0, top: (m * 200 + 101) / 2, width: 99 / 2 }}>{name}</span>}
    </>
  )
}


/** A wheel (ControlWheel): a vertical bar slider (sensitivity 0.5: the whole range per twice its height),
 *  with the slider's wheel, menu, popup above and double-click reset; the pitch wheel springs back to
 *  centre on release. Drawn as Vital paints it: six ridges either side of the marker on a drum turning
 *  through 80 % of half a turn, each ridge fading toward the drum's edges (Keyboard skin colours). */
const WHEEL_COLORS = ['Widget Secondary 1', 'Widget Accent 1', 'Widget Primary 1'] as const

function Wheel({ p, x, spring }: { p: string; x: number; spring: boolean }) {
  const api = useVital()
  const W = 13, H = 37
  const sl = useSlider(p, { kind: 'y', length: H, sensitivity: 0.5 })
  const menu = useControlMenu(p, () => sl.setEditing(true))
  const v = api.v[p] ?? 0
  const buffer = W * 0.05, width = W - 2 * buffer, height = H - 4 * buffer
  // ControlWheel in the Keyboard skin: the drum Widget Secondary 1, the ridges Widget Accent 1, the
  // marker Widget Primary 1.
  const ref = useRef<HTMLSpanElement>(null)
  const sc = useSkinColors(ref, WHEEL_COLORS)
  const fill = sc['Widget Secondary 1'], ridge = sc['Widget Accent 1'], marker = sc['Widget Primary 1']
  let t = 1 - norm(p, v)
  t = (t - 0.5) * 0.8 + 0.5
  const shapes: ReactNode[] = []
  const line = (ratio: number, color: string, k: string) => {
    const radians = Math.PI * ratio - Math.PI / 2
    if (Math.abs(radians) > Math.PI * 0.6) return
    const sin = Math.sin(radians), cos = Math.cos(radians)
    let y = 2 * buffer + height * 0.5 + sin * height * 0.45
    const round = Math.abs(sin) * W * 0.25, lineH = cos * height * 0.165
    const edge = Math.min(y - 2 * buffer, height + 2 * buffer - y)
    const alpha = Math.max(0, Math.min(1, edge / (height * 0.12)))
    const offset = (lineH + round) / 2
    shapes.push(<rect key={k} x={buffer} y={y - offset} width={width} height={Math.max(0, lineH + round)} rx={round} fill={mix(fill, color, alpha)} />)
    y = sin > 0 ? y - round : y + lineH
    shapes.push(<rect key={`${k}f`} x={buffer} y={y - offset} width={width} height={2 * round} rx={round} fill={fill} />)
  }
  for (let i = 6; t + i / 6 >= 0.5; i--) line(t + i / 6, i === 0 ? marker : ridge, `a${i}`)
  for (let i = -6; t + i / 6 < 0.5; i++) line(t + i / 6, i === 0 ? marker : ridge, `b${i}`)
  return (
    <span className="w" style={{ left: x }} {...sl.handlers} ref={(el: HTMLSpanElement | null) => { ref.current = el; sl.handlers.ref(el) }} onContextMenu={menu}
      onPointerUp={(e) => { sl.handlers.onPointerUp(); if (spring) api.set(p, 0); e.stopPropagation() }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        <rect x={buffer} y={buffer} width={W - 2 * buffer} height={H - 2 * buffer} rx={W * 0.15} fill={fill} />
        {shapes}
      </svg>
      {sl.popup && <Bubble at="above" text={shown(p, v)} />}
      {sl.editing && <TextEntry p={p} onDone={() => sl.setEditing(false)} />}
    </span>
  )
}

export function Macros() {
  return (
    <Region tags={['mod']} className="vt-macros" label="Macros and wheels" style={R(14, 108, 113, 1200)} skin="Macro">
      {[0, 1, 2, 3].map((m) => (
        <div key={m}>
          <Box at={[0, m * 200, 99, m * 200 + 95]} className="vt-macrotop" />
          <SourceButton src={`macro_control_${m + 1}`} at={[0, m * 200 + 95, 99, m * 200 + 194]} className="vt-macrobot" title="Drag onto a control to modulate it" />
          <Knob p={`macro_control_${m + 1}`} x={49} y={m * 200 + 47} d={58} popup="right" />
          <MacroName m={m} />
        </div>
      ))}
      <SourceButton src="pitch_wheel" at={[0, 797, 99, 894]} className="vt-macrobot" title="Drag onto a control to modulate it"><span className="vt-mlabel top">PITCH WHL</span></SourceButton>
      <SourceButton src="mod_wheel" at={[0, 897, 99, 994]} className="vt-macrobot" title="Drag onto a control to modulate it"><span className="vt-mlabel top">MOD WHL</span></SourceButton>
      <Box at={[0, 997, 99, 1092]} className="vt-macrotop vt-wheels" data-skin="Keyboard"><Wheel p="pitch_wheel" x={7} spring /><Wheel p="mod_wheel" x={29} spring={false} /></Box>
    </Region>
  )
}

const WHITE = 1859 / 75 / 2
const BLACK_AT = [13.2, 41.7, 85.4, 114.6, 143.1].map((x) => x / 2)
const IS_BLACK = [false, true, false, true, false, false, true, false, true, false, true, false]
/** MidiKeyboard::kBlackKeyHeightRatio. */
const BLACK_KEY_HEIGHT = 0.7

/** Vital's keyboard (MidiKeyboard): all 128 notes; press, or drag along it. Velocity comes from how far
 *  down the key you press (soft at the top, full at the bottom; black keys over their own 70 % height). */
export function Keyboard() {
  const api = useVital()
  const midiNotes = useMidiNotes()
  const held = useRef<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  // The hovered key gets a Widget Accent 2 overlay (MidiKeyboard's hover_note_quad_).
  const [hover, setHover] = useState<number | null>(null)
  const noteAt = (e: React.PointerEvent) => {
    const t = (e.target as Element).closest('[data-note]')
    return t ? Number(t.getAttribute('data-note')) : null
  }
  const velocityAt = (n: number, clientY: number) => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return 0.8
    const y = (clientY - r.top) / r.height
    return Math.max(1 / 127, Math.min(1, IS_BLACK[n % 12] ? y / BLACK_KEY_HEIGHT : y))
  }
  const press = (n: number | null, clientY = 0) => {
    if (held.current === n) return
    if (held.current !== null) { api.setNote(held.current, false); noteVelocity.delete(held.current) }
    held.current = n
    if (n !== null) { noteVelocity.set(n, velocityAt(n, clientY)); api.setNote(n, true) }
  }
  const keys = []
  for (let n = 0; n < 128; n++) {
    const oct = Math.floor(n / 12), pc = n % 12
    if (IS_BLACK[pc]) continue
    const wi = oct * 7 + [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6][pc]
    keys.push(<i key={n} data-note={n} className={`wk${api.notes.has(n) || midiNotes.has(n) ? ' on' : ''}${hover === n ? ' hover' : ''}`} style={{ left: wi * WHITE, width: WHITE - 1 }} />)
  }
  for (let n = 0; n < 128; n++) {
    const oct = Math.floor(n / 12), pc = n % 12
    if (!IS_BLACK[pc]) continue
    const k = [1, 3, 6, 8, 10].indexOf(pc)
    keys.push(<i key={n} data-note={n} className={`bk${api.notes.has(n) || midiNotes.has(n) ? ' on' : ''}${hover === n ? ' hover' : ''}`} style={{ left: oct * 7 * WHITE + BLACK_AT[k], width: 9.7 }} />)
  }
  return (
    <div ref={box} className="vt-b vt-keyboard" data-skin="Keyboard" style={R(127, 1153, 1986, 1206)}
      onPointerDown={(e) => { e.stopPropagation(); capturePointer(e); press(noteAt(e), e.clientY) }}
      onPointerLeave={() => setHover(null)}
      onPointerMove={(e) => { setHover(noteAt(e)); if (held.current === null) return; const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-note]'); press(el ? Number(el.getAttribute('data-note')) : held.current, e.clientY) }}
      onPointerUp={() => press(null)} onPointerCancel={() => press(null)} onClick={(e) => e.stopPropagation()}>
      {keys}
    </div>
  )
}
