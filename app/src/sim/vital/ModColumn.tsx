import { type ReactNode, useRef, useState } from 'react'
import { Region } from '../kit'
import { Box, Bubble, dropTarget, HSlider, Knob, LinearMeter, Pill, RING_SIZE, Rings, TextEntry, TextValue, Toggle } from './controls'
import { useVital } from './ctx'
import { powerCurve } from './draw'
import { LINE_SHAPES, PAINT_SHAPES, type Line } from './line'
import { openPopupBrowser } from './PopupBrowser'
import { loadLibrary, shiftedFile, type LibFile } from '../../engine/library'
import type { LineShape } from '../../../../web/engine-client.js'
import { EnvelopeEditor } from './EnvelopeEditor'
import { SourceButton } from './SourceButton'
import { GridValue, LineEditor, PatternBox } from './LineEditor'
import { RandomDisplay } from '../../engine/RandomDisplay'
import { statusLanes } from '../../engine/status'
import { lineFromEngine, lineToEngine } from '../../engine/shapes'
import { R, useControlMenu, useSlider, useStepWheel } from './hooks'
import { FREQ_SYNC, LFO_SYNC, LFO_SYNC_SHORT, N_ENV, N_LFO, N_RAND, RANDOM_NAMES, RANDOM_SHORT, shown, SYNCED_FREQ } from './params'

// Vital's modulator column, on every page: ENV 1–6, LFO 1–8 and RAND 1–4 (tabs that scroll), the MIDI
// sources grid, and the voice and glide boxes. A tab is both a selector (click) and the modulator's
// handle (drag it onto a control to connect it, as Vital does).

const TEAL = '#64ffda'

/** Vital's vertical source tabs (ModulationTabSelector): click to show one, drag it onto a control to
 *  modulate. They show the minimum (3 ENV, 4 LFO, 2 RAND) plus one past the highest connected, sharing
 *  the column's height (getNumModulationsToShow, checkNumShown); there's no scrolling. */
function SourceTabs({ kind, label, n, min, h, sel, onSel }: { kind: string; label: string; n: number; min: number; h: number; sel: number; onSel: (i: number) => void }) {
  const api = useVital()
  let count = min
  for (let i = min - 1; i < n; i++) if (api.mods.some((m) => m.src === `${kind}_${i + 1}`)) count = i + 2
  count = Math.min(n, Math.max(count, sel + 1))
  const cell = (h + 2) / count
  return (
    <Box at={[0, 0, 98, h]} className="vt-sidetabs">
      {Array.from({ length: count }, (_, i) => {
        const src = `${kind}_${i + 1}`
        const y0 = Math.round(i * cell), y1 = Math.round((i + 1) * cell) - 3
        return (
          <SourceButton key={src} src={src} at={[0, y0, 98, y1]} className="vt-sidetab" selected={i === sel} onClick={() => onSel(i)}
            title={`Drag ${label} ${i + 1} onto a control to modulate it`}>
            {label} {i + 1}
          </SourceButton>
        )
      })}
    </Box>
  )
}



/** ENV n's display: Vital's DAHDSR with draggable points (attack, decay/sustain, release) and curve handles. */
const ENV_KNOBS: [string, string][] = [['delay', 'DELAY'], ['attack', 'ATTACK'], ['hold', 'HOLD'], ['decay', 'DECAY'], ['sustain', 'SUSTAIN'], ['release', 'RELEASE']]

export function EnvSection() {
  const api = useVital()
  const sel = (api.ui.env as number) ?? 0
  const pre = `env_${sel + 1}`
  return (
    <Region tags={sel === 0 ? ['mod', 'main'] : ['mod']} className="vt-mod" style={R(1147, 108, 1986, 412)} label={`ENV ${sel + 1}`}>
      <SourceTabs kind="env" label="ENV" n={N_ENV} min={3} h={304} sel={sel} onSel={(i) => api.setUi({ env: i })} />
      <Box at={[98, 0, 839, 304]} className="vt-modbody" />
      <EnvelopeEditor at={[105, 7, 831, 202]} pre={pre} running={pre === 'env_1' || api.focusSrc === pre || api.mods.some((m) => m.src === pre)} />
      {ENV_KNOBS.map(([k, n], i) => <Knob key={k} p={`${pre}_${k}`} x={162 + i * 122} y={240} d={58} color={TEAL} label={n} labelAt={[106 + i * 122, 272, 219 + i * 122, 297]} />)}
    </Region>
  )
}

/** A tempo box (LFO, RAND, effects): the rate in its sync mode, the mode chosen by the icon's menu. */
export function TempoBox({ pre, at, label = 'TEMPO' }: { pre: string; at: [number, number, number, number]; label?: string }) {
  const api = useVital()
  const sync = Math.round(api.v[`${pre}_sync`] ?? 1)
  const syncMenu = useControlMenu(`${pre}_sync`)
  const val = sync === 0
    ? <TextValue p={`${pre}_frequency`} fmt={(x) => `${shown(`${pre}_frequency`, x, false)} s`} span={300} />
    : sync === 4
      // Keytrack: transpose | tune split by a divider (LfoSection's keytrack_transpose_ / keytrack_tune_);
      // Shift steps the transpose an octave.
      ? <><TextValue p={`${pre}_keytrack_transpose`} className="vt-kt" fmt={(x) => String(Math.round(x))} span={1000 * 1000 / 1440} shiftIndex={12} />
        <i className="vt-ktdiv" />
        <TextValue p={`${pre}_keytrack_tune`} className="vt-kt" fmt={(x) => String(Math.round(x * 100))} span={200 * 1000 / 1440} /></>
      : <TextValue p={`${pre}_tempo`} fmt={(x) => SYNCED_FREQ[Math.round(x)] + (sync === 2 ? '.' : sync === 3 ? 'T' : '')} span={150} />
  const note = <><path d="M9 1.5 V11" stroke="currentColor" strokeWidth={1.4} /><ellipse cx={6.6} cy={11} rx={2.7} ry={2} fill="currentColor" /></>
  const icon = (
    <svg viewBox="0 0 16 14" width={13} height={12}>
      {sync === 0 && <><circle cx={8} cy={7} r={5.5} fill="none" stroke="currentColor" strokeWidth={1.3} /><path d="M8 3.5 V7 L10.5 8.5" fill="none" stroke="currentColor" strokeWidth={1.3} /></>}
      {sync === 4 && <><rect x={1} y={2} width={14} height={10} rx={1} fill="none" stroke="currentColor" strokeWidth={1.2} /><path d="M4.5 2 V8 M8 2 V8 M11.5 2 V8" stroke="currentColor" strokeWidth={1.4} /></>}
      {sync >= 1 && sync <= 3 && note}
      {sync === 2 && <circle cx={12.5} cy={11} r={1.2} fill="currentColor" />}
      {sync === 3 && <text x={11} y={6} fontSize={6} fill="currentColor">3</text>}
    </svg>
  )
  return (
    <Box at={at} className="vt-valbox vt-tempo">
      <b>{val}<i className="vt-sep" />
        <span className="vt-noteicon" onClick={(e) => { e.stopPropagation(); api.openMenu({ w: 95, items: FREQ_SYNC.map((n, i) => ({ label: n, on: i === sync, act: () => { api.checkpoint(); api.set(`${pre}_sync`, i) } })) }, bottomLeft(e)) }}
          onContextMenu={syncMenu}>{icon}</span>
      </b>
      <span>{label}</span>
    </Box>
  )
}

/** A menu box (MODE): the current option, the list on click. */
/** Where a text selector's list opens (TextSelector::mouseDown: the control's bottom-left). */
const bottomLeft = (e: React.MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return { clientX: r.left, clientY: r.bottom } }

function MenuBox({ p, at, names, short, label }: { p: string; at: [number, number, number, number]; names: readonly string[]; short: readonly string[]; label: string }) {
  const api = useVital()
  const v = Math.round(api.v[p] ?? 0)
  const menu = useControlMenu(p)
  const wheel = useStepWheel(p, names.length)
  return (
    <Box ref={wheel} at={at} className="vt-valbox" onContextMenu={menu}
      onClick={(e) => { e.stopPropagation(); api.openMenu({ w: 110, items: names.map((n, i) => ({ label: n, on: i === v, act: () => { api.checkpoint(); api.set(p, i) } })) }, bottomLeft(e)) }}>
      <b>{short[v]}</b><span>{label}</span>
    </Box>
  )
}

function useShape(i: number): [Line, (s: Line) => void] {
  const api = useVital()
  const s = (api.ui[`lfo_${i}_shape`] as Line | undefined) ?? LINE_SHAPES[0]
  return [s, (n) => api.setUi({ [`lfo_${i}_shape`]: n })]
}

const SMOOTH_MODES = ['FADE IN', 'SMOOTH'] // strings::kSmoothModeNames

/** Writes a line shape as the engine's LFO file (LineGenerator::stateToJson) for Export LFO. */
function exportLfo(l: Line) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(lineToEngine(l))], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url; a.download = `${l.name || 'LFO'}.vitallfo`; a.click()
  URL.revokeObjectURL(url)
}

export function LfoSection() {
  const api = useVital()
  const sel = (api.ui.lfo as number) ?? 0
  const pre = `lfo_${sel + 1}`
  const [s, setS] = useShape(sel)
  const gx = (api.ui[`lfo_${sel}_gx`] as number) ?? 8, gy = (api.ui[`lfo_${sel}_gy`] as number) ?? 1
  const paint = !!api.ui[`lfo_${sel}_paint`]
  const pat = (api.ui[`lfo_${sel}_pattern`] as number) ?? 0
  // The paint button shows the editor's mode, which Cmd held flips for the moment (togglePaintMode).
  const [shownPaint, setShownPaint] = useState<boolean | null>(null)
  const painting = shownPaint ?? paint
  const file = useRef<HTMLInputElement>(null)
  // LfoSection::loadFile: an LFO file's shape, named after the file.
  const fileKey = `lfo_${sel}_file`
  const loadShape = async (f: LibFile) => {
    try {
      const shape = lineFromEngine(JSON.parse(await (await f.file()).text()) as LineShape)
      api.checkpoint(); setS({ ...shape, name: f.name }); api.setUi({ [fileKey]: f.key })
    } catch { /* not an LFO file */ }
  }
  const shiftShape = async (step: number) => { await loadLibrary(); const f = shiftedFile('lfo', api.ui[fileKey] as string | undefined, step); if (f) void loadShape(f) }
  const browseShapes = () => openPopupBrowser(api, { owner: `lfo${sel}`, kind: 'lfo', at: [1266, 62, 1978, 416], ignore: [1147, 418, 1986, 830] },
    (f) => void loadShape(f), () => api.ui[fileKey] as string | undefined)

  const smoothMode = Math.round(api.v[`${pre}_smooth_mode`] ?? 1)
  // The engine runs an LFO that's connected or selected (isModSourceEnabled / forceShowModulation).
  const used = api.focusSrc === pre || api.mods.some((m) => m.src === pre)
  return (
    <Region tags={['mod']} className="vt-mod" style={R(1147, 418, 1986, 830)} label={`LFO ${sel + 1}`}>
      <SourceTabs kind="lfo" label="LFO" n={N_LFO} min={4} h={412} sel={sel} onSel={(i) => api.setUi({ lfo: i })} />
      <Box at={[98, 0, 839, 412]} className="vt-modbody" />
      <Box at={[105, 7, 226, 39]} className="vt-chip flat">
        <span className={`pen${painting ? ' on' : ''}`} title="Paint" onClick={(e) => { e.stopPropagation(); api.setUi({ [`lfo_${sel}_paint`]: !paint }) }}>✎</span>
        <PatternBox value={pat} active={painting} w={40} h={14} onChange={(v) => api.setUi({ [`lfo_${sel}_pattern`]: v })} />
      </Box>
      <Box at={[234, 7, 341, 39]} className="vt-chip flat">
        <GridValue value={gx} max={32} def={8} title="Grid X" onChange={(v) => api.setUi({ [`lfo_${sel}_gx`]: v })} /><span className="c">–</span>
        <GridValue value={gy} max={24} def={1} title="Grid Y" onChange={(v) => api.setUi({ [`lfo_${sel}_gy`]: v })} />
      </Box>
      <span className={`vt-curve${s.smooth ? ' on' : ''}`} style={{ left: 363 / 2, top: 10 / 2 }} title="Smooth" onClick={(e) => { e.stopPropagation(); api.checkpoint(); setS({ ...s, smooth: !s.smooth }) }}>
        <svg viewBox="0 0 16 16"><path d="M2 14 C 6 14, 6 2, 10 2 S 14 2, 14 2" fill="none" stroke="currentColor" strokeWidth={1.6} /><circle cx={2.5} cy={13.5} r={1.6} fill="currentColor" /><circle cx={13.5} cy={2.5} r={1.6} fill="currentColor" /></svg>
      </span>
      {/* The shape's name (LfoSection's preset selector): it opens the LFO browser above the section; ‹ ›
          step through every LFO file (LoadSave::getShiftedFile). */}
      <Box at={[396, 7, 831, 39]} className="vt-sel big">
        <span className="arr" onClick={(e) => { e.stopPropagation(); void shiftShape(-1) }}>‹</span>
        <span className="nm" onClick={(e) => { e.stopPropagation(); browseShapes() }}>{s.name}</span>
        <span className="arr" onClick={(e) => { e.stopPropagation(); void shiftShape(1) }}>›</span>
      </Box>
      <LineEditor at={[105, 44, 831, 288]} line={s} onChange={setS} loop gridX={gx} gridY={gy} paint={paint} pattern={pat}
        onPaintShown={(v) => setShownPaint(v === paint ? null : v)}
        onScroll={(dir) => (painting
          ? api.setUi({ [`lfo_${sel}_pattern`]: (pat + dir + PAINT_SHAPES.length) % PAINT_SHAPES.length })
          : api.setUi({ [`lfo_${sel}_gx`]: Math.max(1, Math.min(32, gx + dir)) }))}
        input={{ kind: 'lfo', enabled: used, read: () => ({ phase: statusLanes(`${pre}_phase`), frequency: statusLanes(`${pre}_frequency`) }) }}
        onSetPhase={(ph) => { api.checkpoint(); api.set(`${pre}_phase`, ph) }}
        onImport={() => file.current?.click()} onExport={() => exportLfo(s)} />
      <input ref={file} type="file" accept=".vitallfo,application/json" hidden onChange={async (e) => {
        const f = e.currentTarget.files?.[0]
        e.currentTarget.value = ''
        if (!f) return
        try { const l = lineFromEngine(JSON.parse(await f.text())); if (l.pts.length >= 2) { api.checkpoint(); setS({ ...l, name: f.name.replace(/\.vitallfo$/i, '') }) } }
        catch { window.alert(`${f.name} isn't an LFO file this synth can read.`) }
      }} />
      {/* The phase: a full LinearBar SynthSlider (drag, wheel, menu, rings, drop target). */}
      <HSlider p={`${pre}_phase`} at={[105, 294, 831, 304]} thumb={20} color="#ffffff" className="vt-phase" />
      <MenuBox p={`${pre}_sync_type`} at={[105, 312, 262, 397]} names={LFO_SYNC} short={LFO_SYNC_SHORT} label="MODE" />
      <TempoBox pre={pre} at={[271, 312, 428, 397]} />
      {smoothMode === 0
        ? <Knob p={`${pre}_fade_time`} x={499} y={342} d={58} color={TEAL} />
        : <Knob p={`${pre}_smooth_time`} x={499} y={342} d={58} color={TEAL} />}
      <Pill at={[437, 372, 561, 397]} className="vt-modelabel">
        <span style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); api.openMenu({ w: 70, items: SMOOTH_MODES.map((label, k) => ({ label, on: k === smoothMode, act: () => { api.checkpoint(); api.set(`${pre}_smooth_mode`, k) } })) }, e) }}>{SMOOTH_MODES[smoothMode]}</span>
      </Pill>
      <Knob p={`${pre}_delay_time`} x={633} y={342} d={58} color={TEAL} label="DELAY" labelAt={[571, 372, 695, 397]} />
      <Knob p={`${pre}_stereo`} x={767} y={342} d={58} color={TEAL} label="STEREO" labelAt={[705, 372, 829, 397]} />
    </Region>
  )
}

export function RandSection() {
  const api = useVital()
  const sel = (api.ui.rand as number) ?? 0
  const pre = `random_${sel + 1}`
  return (
    <Region tags={['mod']} className="vt-mod" style={R(1147, 830, 1583, 1036)} label={`RAND ${sel + 1}`}>
      <SourceTabs kind="random" label="RAND" n={N_RAND} min={2} h={206} sel={sel} onSel={(i) => api.setUi({ rand: i })} />
      <Box at={[98, 0, 436, 206]} className="vt-modbody" />
      <Toggle p={`${pre}_sync_type`} at={[105, 8, 262, 32]}>SYNC</Toggle>
      <Toggle p={`${pre}_stereo`} at={[271, 8, 428, 32]}>STEREO</Toggle>
      <Box at={[105, 40, 428, 106]} className="vt-screen"><i className="vt-midline" /><RandomDisplay n={sel + 1} w={161.5} h={33} /></Box>
      <MenuBox p={`${pre}_style`} at={[105, 112, 262, 197]} names={RANDOM_NAMES} short={RANDOM_SHORT} label="MODE" />
      <TempoBox pre={pre} at={[271, 112, 428, 197]} />
    </Region>
  )
}

const MIDI_SOURCES: [string, string][] = [['note', 'NOTE'], ['velocity', 'VELOCITY'], ['lift', 'LIFT'], ['note_in_octave', 'OCT NOTE'], ['aftertouch', 'PRESSURE'], ['slide', 'SLIDE'], ['stereo', 'STEREO'], ['random', 'RAND']]

export function MidiSources() {
  return (
    <Region tags={['mod']} className="vt-midi" style={R(1589, 830, 1986, 1036)} label="MIDI sources">
      {MIDI_SOURCES.map(([src, n], i) => {
        return (
          <SourceButton key={src} src={src} at={[(i % 4) * 99.5, Math.floor(i / 4) * 103, (i % 4) * 99.5 + 97, Math.floor(i / 4) * 103 + 100]}
            className="vt-midicell" title={`Drag ${n} onto a control to modulate it`}>
            {n}
          </SourceButton>
        )
      })}
    </Region>
  )
}

function NumBox({ p, at, children }: { p: string; at: [number, number, number, number]; children?: ReactNode }) {
  // VOICES and BEND drag at voice_section.cpp's kKnobSensitivity 0.2 (1000 pt, in stage px, per range).
  return <Box at={at} className="vt-num"><TextValue p={p} fmt={(x) => String(Math.round(x))} span={1000 * 1000 / 1440} />{children}</Box>
}

/** The spread knob's label is the stereo mode's menu (VoiceSection: SPREAD or ROTATE, stereo_mode). */
function StereoModeLabel() {
  const api = useVital()
  const mode = Math.round(api.v.stereo_mode ?? 0)
  const names = ['SPREAD', 'ROTATE'] // strings::kStereoModeNames
  return (
    <Pill at={[319, 70, 428, 94]} className="vt-modelabel">
      <span style={{ cursor: 'pointer' }} onPointerDown={(e) => {
        e.stopPropagation()
        api.openMenu({ w: 70, items: names.map((label, k) => ({ label, on: k === mode, act: () => { api.checkpoint(); api.set('stereo_mode', k) } })) }, bottomLeft(e))
      }}>{names[mode]}</span>
    </Pill>
  )
}

export function VoiceBox() {
  return (
    <Box at={[1147, 1040, 1583, 1140]} className="vt-modbody vt-voice">
      <NumBox p="polyphony" at={[8, 8, 98, 70]} /><NumBox p="pitch_bend_range" at={[105, 8, 195, 70]} />
      <Pill at={[8, 70, 98, 94]}>VOICES</Pill><Pill at={[105, 70, 195, 94]}>BEND</Pill>
      <Knob p="velocity_track" x={258} y={36} d={58} label="VEL TRK" labelAt={[203, 70, 312, 94]} />
      <Knob p="stereo_routing" x={373} y={36} d={58} />
      <StereoModeLabel />
    </Box>
  )
}

/** SLOPE: the glide's power slider in CurveLookAndFeel (powerScale(t, −value) in Rotary Arc, greyed when
 *  inactive), a full rotary SynthSlider: drag, wheel, menu, popup, modulation target and rings. */
function SlopeBox() {
  const api = useVital()
  const p = 'portamento_slope'
  const sl = useSlider(p)
  const menu = useControlMenu(p, () => sl.setEditing(true))
  const slope = api.v[p] ?? 0
  const curve = Array.from({ length: 17 }, (_, k) => { const t = k / 16; return `${k ? 'L' : 'M'} ${4 + t * 48} ${28 - powerCurve(t, -slope) * 25}` }).join(' ')
  return (
    <Box at={[127, 8, 240, 70]} className={`vt-num slope${dropTarget(api, p) ? ' target' : ''}`} data-drop={p} {...sl.handlers} onContextMenu={menu}>
      <svg viewBox="0 0 56 31"><path d={curve} stroke="#aa88ff" fill="none" strokeWidth={1.4} strokeLinecap="round" /></svg>
      {sl.popup && <Bubble text={shown(p, slope)} />}
      {sl.editing && <TextEntry p={p} onDone={() => sl.setEditing(false)} />}
      <LinearMeter p={p} />
      <span className="vt-tvrings"><Rings p={p} x={0} y={RING_SIZE / 2} all={sl.hover} /></span>
    </Box>
  )
}

export function GlideBox() {
  return (
    <Box at={[1589, 1040, 1986, 1140]} className="vt-modbody vt-voice">
      <Knob p="portamento_time" x={63} y={36} d={58} label="GLIDE" labelAt={[8, 70, 118, 94]} />
      <SlopeBox />
      <Pill at={[127, 70, 240, 94]}>SLOPE</Pill>
      <Toggle p="portamento_force" at={[249, 6, 389, 29]}>ALWAYS GLIDE</Toggle>
      <Toggle p="portamento_scale" at={[249, 36, 389, 59]}>OCTAVE SCALE</Toggle>
      <Toggle p="legato" at={[249, 66, 389, 89]}>LEGATO</Toggle>
    </Box>
  )
}
