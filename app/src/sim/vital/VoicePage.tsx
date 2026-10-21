import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { liveValue, useStatus } from '../../engine/status'
import { useEngine } from '../../engine/EngineContext'
import { FilterCurve } from '../../engine/FilterCurve'
import { WaveDisplay } from '../../engine/WaveDisplay'
import { Region } from '../kit'
import { Box, Bubble, dropTarget, HSlider, Knob, Power, Rings, Selector, TextEntry, TextValue, Toggle, VSlider } from './controls'
import { useVital, type MenuItem } from './ctx'
import { filterDb, oscFrame, powerCurve, spectrum } from './draw'
import { R, useControlMenu, useDrag, useSlider, useWheel } from './hooks'
import { DESTINATION_MENU, DESTINATIONS, MORPH_TYPES, norm, PARAMS, shown, WARP_TYPES } from './params'
import { FilterIcon, filterMode, FilterModelSelector } from './filterUi'
import { SampleViewer } from './SampleViewer'
import { openPopupBrowser } from './PopupBrowser'
import { requestSave } from './SaveOverlay'
import { loadLibrary, shiftedFile, type LibFile } from '../../engine/library'
import { readAudioFile } from '../../engine/audioFile'
import { loadTableFile as loadWavetableFile, tableChanged } from './wavetableIO'
import { openWavetableEditor } from './WavetableEditor'

// Vital's VOICE page: OSC 1–3, the sampler (SMP) and FILTER 1 | FILTER 2, each control wired to its
// parameter. Positions are the capture's (2000 × 1211) relative to each section, halved by R().

const PURPLE = '#aa88ff', ORANGE = '#ffb74d'
/** vital::constants::kNumSourceDestinations: the routes a source can take (the rest of the range is unused). */
const SOURCE_DESTINATIONS = 5
/** The closed selectors' short names (oscillator_section.cpp kSpectralMorphTypes / kDistortionTypes). */
const MORPH_SHORT = ['---', 'VOCODE', 'FORM SCALE', 'HARM STRETCH', 'INHARMONIC', 'SMEAR', 'RAND AMP', 'LOW PASS', 'HIGH PASS', 'PHASE DISP', 'SHEPARD TONE', 'TIME SKEW']
const WARP_SHORT = ['---', 'SYNC', 'FORMANT', 'QUANTIZE', 'BEND', 'SQUEEZE', 'PULSE', 'FM <- OSC', 'FM <- OSC', 'FM <- SAMPLE', 'RM <- OSC', 'RM <- OSC', 'RM <- SAMPLE']
/** Types whose amount knob is bipolar (isBipolarSpectralMorphType / isBipolarDistortionType). */
const BIPOLAR_MORPHS = new Set([0, 1, 2, 3, 4, 9])
const BIPOLAR_WARPS = new Set([0, 1, 2, 4, 5])
/** FM / RM warps name the oscillator they read (getDistortionSuffix, ProducersModule modulation indices). */
function warpSuffix(type: number, osc: number): string {
  const first = osc === 0 ? 1 : 0, second = osc === 1 ? 2 : first + 1
  if (type === 7 || type === 10) return ` ${first + 1}`
  if (type === 8 || type === 11) return ` ${second + 1}`
  return ''
}
/** Transpose drags at Vital's kTransposeMouseSensitivity 0.2: 1000 pt (in stage px) for the whole range. */
const TRANSPOSE_SPAN = 1000 * 1000 / 1440

/** transpose_quantize.cpp setKeyBounds: twelve keys as circles, the black row above the white, in a box
 *  w × h starting at y. Returns [x, y, diameter] per semitone. */
function keyBounds(y: number, w: number, h: number): [number, number, number][] {
  const inner = Math.trunc(w * 0.03), outer = Math.trunc(w * 0.11)
  const key = (w - 6 * inner - 2 * outer) / 7
  const yMid = y + (h - key) / 2
  const offset = 0.86602540378 * (key + inner)
  const yBlack = yMid - offset / 2, yWhite = yBlack + offset
  const out: [number, number, number][] = []
  for (let i = 0; i < 7; i++) out[2 * i - (i > 2 ? 1 : 0)] = [outer + (key + inner) * i, yWhite, key]
  for (let i = 0; i < 6; i++) {
    if (i === 2) continue
    out[2 * i + (i < 2 ? 1 : 0)] = [outer + (key + inner) / 2 + (key + inner) * i, yBlack, key]
  }
  return out
}

/** The transpose-quantize button (TransposeQuantizeButton): the twelve dots in the chip, all lit on hover;
 *  a press opens the TRANSPOSE SNAP callout. The value is a bit per semitone plus bit 12 for Global Snap. */
function QuantizeButton({ pre, at }: { pre: string; at: [number, number, number, number] }) {
  const api = useVital()
  const [hover, setHover] = useState(false)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const p = `${pre}_transpose_quantize`
  const q = Math.round(api.v[p] ?? 0)
  const w = (at[2] - at[0]) / 2, h = (at[3] - at[1]) / 2
  return (
    <Box ref={ref} at={at} className="vt-qbutton" onPointerDown={(e) => { e.stopPropagation(); setOpen(true); setHover(false) }}
      onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)} title="Transpose Snap">
      <svg viewBox={`0 0 ${w} ${h}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        {keyBounds(0, w, h).map(([x, y, d], n) => (
          <circle key={n} cx={x + d / 2} cy={y + d / 2} r={d / 2} fill={hover ? 'rgba(255,255,255,0.266)' : q & (1 << n) ? '#aa88ff' : 'rgba(255,255,255,0.133)'} />
        ))}
      </svg>
      {open && <SnapCallout p={p} anchor={ref.current} w={w} onClose={() => setOpen(false)} />}
    </Box>
  )
}

/** TransposeQuantizeCallOut: TRANSPOSE SNAP over twelve large keys you press or drag across to turn on or
 *  off (the first key decides which), the hovered one lightened, and the Global Snap toggle. 4 × the
 *  button's width, 0.6 of that tall; it closes when pressing outside. */
function SnapCallout({ p, anchor, w, onClose }: { p: string; anchor: HTMLElement | null; w: number; onClose: () => void }) {
  const api = useVital()
  const [hover, setHover] = useState(-1)
  const mode = useRef<'on' | 'off' | null>(null)
  const box = useRef<HTMLDivElement>(null)
  // A CallOutBox: a press outside it or Escape dismisses it.
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true) }
  }, [onClose])
  const root = api.rootRef.current
  if (!anchor || !root) return null
  const q = Math.round(api.v[p] ?? 0), global = (q >> 12) & 1
  const cw = w * 4, ch = cw * 0.6
  const title = ch * 0.2, globalH = ch * 0.2
  const keys = keyBounds(title, cw, ch - title - globalH)
  const r = anchor.getBoundingClientRect()
  const c = api.toStage(r.left + r.width / 2, r.bottom)
  const left = Math.min(root.offsetWidth - cw - 2, Math.max(2, c.x - cw / 2)), top = Math.min(root.offsetHeight - ch - 2, c.y + 4)
  const keyAt = (e: React.PointerEvent) => {
    const b = box.current!.getBoundingClientRect(), s = b.width / cw
    const x = (e.clientX - b.left) / s, y = (e.clientY - b.top) / s
    return keys.findIndex(([kx, ky, d]) => (x - kx - d / 2) ** 2 + (y - ky - d / 2) ** 2 <= (d / 2) ** 2)
  }
  const paint = (n: number) => {
    if (n < 0) return
    const cur = Math.round(api.get(p) ?? 0), on = !!(cur & (1 << n))
    if (!mode.current) mode.current = on ? 'off' : 'on'
    if ((mode.current === 'on') !== on) api.set(p, cur ^ (1 << n))
  }
  return createPortal(
    <div ref={box} className="vt-snapcallout" style={{ left, top, width: cw, height: ch }}
      onPointerDown={(e) => { e.stopPropagation(); mode.current = null; const n = keyAt(e); if (n >= 0) { api.checkpoint(); paint(n); try { box.current!.setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ } } }}
      onPointerMove={(e) => { const n = keyAt(e); setHover(n); if (e.buttons & 1 && mode.current) paint(n) }}
      onPointerUp={() => { mode.current = null }} onPointerLeave={() => setHover(-1)}>
      <span className="vt-snaptitle" style={{ height: title, fontSize: title * 0.7 }}>TRANSPOSE SNAP</span>
      <svg viewBox={`0 0 ${cw} ${ch}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        {keys.map(([x, y, d], n) => <circle key={n} cx={x + d / 2} cy={y + d / 2} r={d / 2} fill={q & (1 << n) ? '#aa88ff' : 'rgba(255,255,255,0.133)'} />)}
        {hover >= 0 && <circle cx={keys[hover][0] + keys[hover][2] / 2} cy={keys[hover][1] + keys[hover][2] / 2} r={keys[hover][2] / 2} fill="rgba(255,255,255,0.133)" />}
      </svg>
      <span className={`vt-snapglobal${global ? ' on' : ''}`} style={{ top: ch - globalH, height: globalH }}
        onPointerDown={(e) => { e.stopPropagation(); api.checkpoint(); api.set(p, Math.round(api.get(p) ?? 0) ^ (1 << 12)) }}>Global Snap</span>
    </div>,
    root,
  )
}

/** The pitch chip: transpose (left) | tune (right), and between them under the label the transpose-snap
 *  button (placeJointControls). */
function PitchChip({ pre, at }: { pre: string; at: [number, number, number, number] }) {
  const h = at[3] - at[1], label = 18 * 2000 / 1440
  return (
    <Box at={at} className="vt-chip">
      <TextValue p={`${pre}_transpose`} className="l" fmt={(v) => String(Math.round(v))} span={TRANSPOSE_SPAN} shiftIndex={12} meterLeft />
      <span className="t">PITCH</span>
      <TextValue p={`${pre}_tune`} className="r" fmt={(v) => String(Math.round(v * 100))} span={200} />
      <QuantizeButton pre={pre} at={[h, label, at[2] - at[0] - h, h]} />
    </Box>
  )
}

/** The unison viewer (UnisonViewer) under the UNISON label: a 1-pt bar per voice, its offset the voice's
 *  detune curve (powerScale(|t|, detune power) × 0.1 × detune, the voices' modulated totals while they
 *  play), in Widget Primary 1 at half strength across 70 % of the height. The invisible detune-power
 *  slider over it drags that curve (InvisibleSlider). */
function UnisonViewer({ pre, at, on }: { pre: string; at: [number, number, number, number]; on: boolean }) {
  const api = useVital()
  const value = (k: string) => liveValue(`${pre}_${k}`) ?? api.v[`${pre}_${k}`] ?? PARAMS[`${pre}_${k}`].def
  useStatus('num_voices') // redraw with the status packets while the totals move
  const voices = Math.min(16, Math.max(1, Math.round(value('unison_voices'))))
  const detune = 0.1 * value('unison_detune'), power = value('detune_power')
  const w = (at[2] - at[0]) / 2, h = (at[3] - at[1]) / 2
  const active = 1 - h / (2 * w)
  const xs = voices === 1 ? [0] : Array.from({ length: voices }, (_, k) => {
    const t = (2 * k) / (voices - 1) - 1
    const ps = powerCurve(Math.abs(t), power)
    return (t < 0 ? -ps : ps) * active * detune
  })
  const sl = useSlider(`${pre}_detune_power`)
  const menu = useControlMenu(`${pre}_detune_power`, () => sl.setEditing(true))
  return (
    <Box at={at} className="vt-unison" {...sl.handlers} onContextMenu={menu}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        {xs.map((x, k) => <rect key={k} x={((x + 1) / 2) * w - 0.35} y={h * 0.15} width={0.7} height={h * 0.7} fill={on ? 'rgba(170,136,255,0.5)' : 'rgba(76,79,82,0.5)'} />)}
      </svg>
      {sl.popup && <Bubble text={`Detune Power: ${shown(`${pre}_detune_power`, api.v[`${pre}_detune_power`] ?? 1.5)}`} />}
      {sl.editing && <TextEntry p={`${pre}_detune_power`} onDone={() => sl.setEditing(false)} />}
    </Box>
  )
}

/** ‹ DESTINATION ›: a source's five routes (Filter 1 · Filter 2 · Filter 1+2 · Effects · Direct Out; the
 *  arrows wrap at kNumSourceDestinations), the menu opening under the selector's left edge. */
function Dest({ p, at, label }: { p: string; at: [number, number, number, number]; label: string }) {
  const api = useVital()
  const v = Math.round(api.v[p] ?? 0)
  const n = SOURCE_DESTINATIONS
  return (
    <Region tags={['flow']} className="vt-b vt-sel" style={R(...at)} label={label}>
      <span className="arr" onClick={(e) => { e.stopPropagation(); api.checkpoint(); api.set(p, (v + n - 1) % n) }}>‹</span>
      <span className="nm" onClick={(e) => {
        e.stopPropagation()
        const box = (e.currentTarget.parentElement ?? e.currentTarget).getBoundingClientRect()
        api.openMenu({ w: 90, items: DESTINATION_MENU.slice(0, n).map((name, i) => ({ label: name, on: i === v, act: () => { api.checkpoint(); api.set(p, i) } })) }, { clientX: box.left, clientY: box.bottom })
      }}>{DESTINATIONS[v]}</span>
      <span className="arr" onClick={(e) => { e.stopPropagation(); api.checkpoint(); api.set(p, (v + 1) % n) }}>›</span>
    </Region>
  )
}

/** The in-app clipboard for the display's Copy / Paste (Vital uses the system one). */
let tableClipboard: { name?: string } | null = null

/** The wavetable display (Wavetable3d): 3D (stacked frames), 2D (the frame in use) or SP (its
 *  harmonics). Press and drag up or down to move through the frames (the whole range per height) with
 *  the frame slider's popup showing; the wheel steps the frame slider; right-click for Save to
 *  Wavetables · Copy · Paste · Initialize · Resynthesize Preset to Wavetable (Text to Wavetable needs
 *  Vital's server). Audio dropped on it becomes the wavetable, by the zone it's dropped on. */
function WaveScreen({ i, on, at }: { i: number; on: boolean; at: [number, number, number, number] }) {
  const api = useVital()
  const pre = `osc_${i + 1}`
  const [scrub, setScrub] = useState(false)
  const frameId = `${pre}_wave_frame`
  const frameRange = PARAMS[frameId].max - PARAMS[frameId].min
  // Wavetable3d keeps the dragged value itself (current_value_), so fast moves never build on a stale one.
  const dragValue = useRef(0)
  const g = useDrag((_dx, dy) => {
    dragValue.current = Math.max(0, Math.min(frameRange, dragValue.current + (dy * frameRange) / ((at[3] - at[1]) / 2)))
    api.set(frameId, dragValue.current)
  })
  const wheelFrame = useWheel((_dx, dy) => { if (!dy) return; api.checkpoint(); api.set(frameId, (api.v[frameId] ?? 0) + Math.sign(dy) * 0.035 * frameRange); setScrub(true) })
  const stop = (e: React.PointerEvent) => e.stopPropagation()
  const table = (api.ui[`${pre}_table`] as string) ?? 'Init'
  const view = Math.round(api.v[`${pre}_view_2d`] ?? 1)
  const frame = norm(`${pre}_wave_frame`, api.v[`${pre}_wave_frame`] ?? 0)
  const warp = Math.round(api.v[`${pre}_distortion_type`] ?? 0), warpAmt = api.v[`${pre}_distortion_amount`] ?? 0.5
  const morph = Math.round(api.v[`${pre}_spectral_morph_type`] ?? 0), morphAmt = api.v[`${pre}_spectral_morph_amount`] ?? 0.5
  const { engine } = useEngine()
  const s = useMemo(() => oscFrame(table, frame, warp, warpAmt, morph, morphAmt), [table, frame, warp, warpAmt, morph, morphAmt])
  const W = 189, H = 72, mid = 21 + H / 2
  const path = (a: number[], dx = 0, dy = 0, sx = 1, sy = 1) => a.map((y, k) => `${k ? 'L' : 'M'} ${(dx + k / (a.length - 1) * W * sx).toFixed(1)} ${(dy + mid - y * H * 0.42 * sy).toFixed(1)}`).join(' ')
  const line = on ? PURPLE : '#4c4f52'
  const setTable = (t: string) => { api.checkpoint(); api.setUi({ [`${pre}_table`]: t, [`${pre}_tableFile`]: undefined }) }
  const { ctx } = useEngine()
  // OscillatorSection::loadFile: a .vitaltable loads as it is; audio is spliced into frames, or vocoded /
  // pitch-spliced when dropped on those zones.
  const loadTableFile = async (file: File, key: string | undefined, name: string, style = 1) => {
    if (engine) await loadWavetableFile(api, engine, ctx, i, file, key, name, style)
  }
  const loadEntry = async (f: LibFile) => loadTableFile(await f.file(), f.key, f.name)
  const fileKey = api.ui[`${pre}_tableFile`] as string | undefined
  const shiftTable = (step: number) => void loadLibrary().then(() => { const f = shiftedFile('wavetable', fileKey, step); if (f) void loadEntry(f) })
  const dy = i * 199.5
  const browse = () => openPopupBrowser(api, { owner: `osc${i}`, kind: 'wavetable', at: [768, 115 + dy, 1621, 685 + dy], ignore: [127, 108 + dy, 1131, 307 + dy] },
    (f) => void loadEntry(f), () => api.ui[`${pre}_tableFile`] as string | undefined)
  // Wavetable3d's drop zones while audio is dragged over: the top 3/8 WAVETABLE, the bottom 3/8 PITCH
  // SPLICE, VOCODE between.
  const [dropStyle, setDropStyle] = useState(0)
  const dropAt = (e: React.DragEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect(), y = (e.clientY - r.top) / r.height
    return y < 3 / 8 ? 1 : y > 5 / 8 ? 4 : 2
  }
  let body
  if (view === 2) {
    const h = spectrum(s, 40)
    body = h.map((m, k) => { const bh = Math.min(1, Math.log10(1 + m * 9)) * 64; return <rect key={k} x={4 + k * 4.6} y={88 - bh} width={2.6} height={bh} fill={line} opacity={on ? 0.9 : 0.6} /> })
  } else if (view === 0) {
    const frames = Array.from({ length: 9 }, (_, k) => oscFrame(table, k / 8, warp, warpAmt, morph, morphAmt, 64))
    body = <>
      {frames.map((f, k) => <path key={k} d={path(f, 14 + k * 4, 14 - k * 3.2, 0.72, 0.6)} fill="none" stroke={line} strokeWidth={0.6} opacity={0.35} />)}
      <path d={path(s, 14 + frame * 32, 14 - frame * 25.6, 0.72, 0.6)} fill="none" stroke={line} strokeWidth={1.2} />
    </>
  } else {
    body = <path d={`${path(s)} L ${W} ${mid} L 0 ${mid} Z`} fill={on ? 'rgba(170,136,255,.55)' : 'none'} stroke={line} strokeWidth={1.1} strokeLinejoin="round" />
  }
  const menu = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    const items: MenuItem[] = [
      { label: 'Save to Wavetables', dim: !engine, act: engine ? () => void engine.wavetableJson(i).then((t) => requestSave(api, { kind: 'wavetable', ext: 'vitaltable', name: table, data: t as Record<string, unknown> })) : undefined },
      { label: 'Copy', dim: !engine, act: engine ? () => void engine.wavetableJson(i).then((t) => { tableClipboard = t as { name?: string }; void navigator.clipboard?.writeText(JSON.stringify(t)).catch(() => {}) }) : undefined },
      ...(tableClipboard && engine ? [{ label: 'Paste', act: () => { const t = tableClipboard!; api.checkpoint(); void engine.setWavetable(i, t).then(() => tableChanged(api, i, { [`${pre}_table`]: t.name || 'Pasted', [`${pre}_tableFile`]: 'pasted' })) } }] : []),
      { sep: true },
      { label: 'Initialize', act: () => setTable('Init') },
      // Text to Wavetable needs Vital's server, so it isn't offered.
      { label: 'Resynthesize Preset to Wavetable', dim: !engine, act: engine ? () => void engine.resynthesize(i).then(() => tableChanged(api, i, { [`${pre}_table`]: 'Resynthesize', [`${pre}_tableFile`]: 'resynthesized' })) : undefined },
    ]
    api.openMenu({ w: 120, items }, e)
  }
  return (
    <Box at={at} className="vt-screen vt-wavescreen" ref={wheelFrame} onContextMenu={menu}
      onDragOver={(e) => { if ([...e.dataTransfer.items].some((it) => it.kind === 'file')) { e.preventDefault(); setDropStyle(dropAt(e)) } }}
      onDragLeave={() => setDropStyle(0)}
      onDrop={(e) => { e.preventDefault(); const style = dropAt(e); setDropStyle(0); const f = e.dataTransfer.files[0]; if (f) void loadTableFile(f, undefined, f.name.replace(/\.[^.]+$/, ''), style) }}
      onPointerDown={(e) => { if (e.button !== 0) return; dragValue.current = api.v[frameId] ?? 0; g.onPointerDown(e); setScrub(true) }} onPointerMove={g.onPointerMove}
      onPointerUp={g.onPointerUp} onPointerCancel={g.onPointerCancel} onPointerLeave={() => setScrub(false)}>
      <svg viewBox="0 0 189 89" className="vt-wavesvg" preserveAspectRatio="none">{engine ? <WaveDisplay osc={i} view={view} on={on} /> : body}</svg>
      {scrub && <Bubble at="right" text={`Frame: ${shown(frameId, api.v[frameId] ?? 0)}`} />}
      <div className="vt-tname" onPointerDown={stop}>
        <span className="arr" onClick={(e) => { e.stopPropagation(); shiftTable(-1) }}>‹</span>
        <span className="nm" onClick={(e) => { e.stopPropagation(); browse() }}>{table}</span>
        <span className="arr" onClick={(e) => { e.stopPropagation(); shiftTable(1) }}>›</span>
      </div>
      {dropStyle > 0 && (
        <div className="vt-wtdrop">
          {([[1, 'WAVETABLE', 0], [2, 'VOCODE', 25], [4, 'PITCH SPLICE', 50]] as const).map(([st, label, top]) => (
            <span key={st} className={dropStyle === st ? 'on' : ''} style={{ top: `${top}%` }}>{label}</span>
          ))}
        </div>
      )}
      <span className="vt-2d" onPointerDown={stop} onClick={(e) => { e.stopPropagation(); api.checkpoint(); api.set(`${pre}_view_2d`, (view + 2) % 3) }}>{['3D', '2D', 'SP'][view]}</span>
      <span className="vt-pencil" onPointerDown={stop} onClick={(e) => { e.stopPropagation(); openWavetableEditor(api, i) }} title="Edit Wavetable">✎</span>
    </Box>
  )
}

export function Osc({ i }: { i: number }) {
  const api = useVital()
  const pre = `osc_${i + 1}`, y = 108 + i * 200, name = `OSC ${i + 1}`
  const on = (api.v[`${pre}_on`] ?? 0) >= 0.5
  const morph = Math.round(api.v[`${pre}_spectral_morph_type`] ?? 0), warp = Math.round(api.v[`${pre}_distortion_type`] ?? 0)
  const phaseBar = warp >= 1 && warp <= 6 // Sync, Formant, Quantize, Bend, Squeeze, Pulse
  return (
    <Region tags={['source']} className={`vt-osc${on ? ' on' : ''}`} style={R(127, y, 1131, y + 190)} label={name}>
      <div className="vt-b vt-strip" style={R(0, 0, 45, 190)} />
      <Power p={`${pre}_on`} x={22} y={21} />
      <span className="vt-vlabel" style={{ left: 22 / 2, top: 110 / 2 }}>{name}</span>
      <PitchChip pre={pre} at={[53, 7, 228, 57]} />
      <Knob p={`${pre}_level`} x={94} y={95} d={58} dim={!on} label="LEVEL" labelAt={[53, 128, 135, 150]} />
      <Knob p={`${pre}_pan`} x={185} y={95} d={58} dim={!on} label="PAN" labelAt={[147, 128, 228, 150]} />
      <Dest p={`${pre}_destination`} at={[53, 160, 228, 184]} label={`${name} destination`} />
      {/* Warps that read a phase get the distortion-phase bar under the display, which shrinks to make
          room (OscillatorSection::setDistortionPhaseVisible, usesDistortionPhase). */}
      <WaveScreen i={i} on={on} at={[235, 7, 613, phaseBar ? 171 : 185]} />
      <VSlider p={`${pre}_wave_frame`} at={[621, 7, 631, phaseBar ? 171 : 185]} thumb={30} dim={!on} prefix="Frame: " />
      {phaseBar && <HSlider p={`${pre}_distortion_phase`} at={[231, 175, 617, 185]} thumb={22} fillFrom={0.5} dim={!on || !warp} color="#ffffff" popup="below" prefix="Phase: " />}
      <Box at={[639, 7, 813, 57]} className="vt-chip">
        <TextValue p={`${pre}_unison_voices`} className="l" fmt={(v) => `${Math.round(v)}v`} span={150} meterLeft />
        <span className="t">UNISON</span>
        <TextValue p={`${pre}_unison_detune`} className="r" fmt={(v) => `${Math.round(v * v)}%`} />
        <UnisonViewer pre={pre} on={on} at={[50, 18 * 2000 / 1440, 124, 50]} />
      </Box>
      <Box at={[822, 7, 996, 57]} className="vt-chip">
        <TextValue p={`${pre}_phase`} className="l" fmt={(v) => String(Math.round(v * 360))} />
        <span className="t">PHASE</span>
        <TextValue p={`${pre}_random_phase`} className="r" fmt={(v) => `${Math.round(v * 100)}%`} />
      </Box>
      <Knob p={`${pre}_spectral_morph_amount`} x={726} y={112} d={86} dim={!on || !morph} prefix="Spectral Morph: "
        bipolar={BIPOLAR_MORPHS.has(morph)} defaultValue={BIPOLAR_MORPHS.has(morph) ? 0.5 : 0} />
      <Knob p={`${pre}_distortion_amount`} x={909} y={112} d={86} dim={!on || !warp} prefix="Wave Morph: "
        bipolar={BIPOLAR_WARPS.has(warp)} defaultValue={BIPOLAR_WARPS.has(warp) ? 0.5 : 0} />
      <Selector p={`${pre}_spectral_morph_type`} at={[639, 160, 813, 184]} label={MORPH_SHORT[morph]} menuW={110}
        menuCols={() => [MORPH_TYPES.flatMap((n, k): MenuItem[] => [...(k === 1 ? [{ sep: true }] : []), { label: n, on: k === morph, act: () => { api.checkpoint(); api.set(`${pre}_spectral_morph_type`, k) } }])]} />
      <Selector p={`${pre}_distortion_type`} at={[822, 160, 996, 184]} label={WARP_SHORT[warp] + warpSuffix(warp, i)} menuW={100}
        menuCols={() => [WARP_TYPES.flatMap((n, k): MenuItem[] => [...(k === 1 || k === 7 ? [{ sep: true }] : []), { label: n + warpSuffix(k, i), on: k === warp, act: () => { api.checkpoint(); api.set(`${pre}_distortion_type`, k) } }])]} />
    </Region>
  )
}


// Paths::keyboard / shuffle / loop / bounce in their unit box: the keyboard's three filled keys, the
// others 0.12-wide strokes ending in arrowheads (width 0.4 or 0.35, length 0.26) whose tips sit at the
// stroke's end (JUCE createStrokeWithArrowheads shortens the stroke by the head's length).
const arrow = (x: number, y: number, dx: number, width: number, length = 0.26) =>
  `M${x} ${y - width / 2} L${x + dx * length} ${y} L${x} ${y + width / 2} Z`
const SAMPLE_ICONS: Record<string, { fill?: string; stroke?: string; cap: 'round' | 'butt' }> = {
  sample_keytrack: {
    fill: 'M0.24 0.35 L0.24 0.65 L0.41 0.65 L0.41 0.5 L0.35 0.5 L0.35 0.35 Z M0.48 0.65 L0.48 0.35 L0.52 0.35 L0.52 0.5 L0.58 0.5 L0.58 0.65 L0.42 0.65 L0.42 0.5 L0.48 0.5 Z M0.65 0.35 L0.76 0.35 L0.76 0.65 L0.59 0.65 L0.59 0.5 L0.65 0.5 Z',
    cap: 'butt',
  },
  sample_random_phase: {
    stroke: 'M0.1 0.7 L0.25 0.7 L0.55 0.3 L0.69 0.3 M0.1 0.3 L0.25 0.3 L0.325 0.4 M0.475 0.6 L0.55 0.7 L0.69 0.7',
    fill: arrow(0.69, 0.3, 1, 0.35) + arrow(0.69, 0.7, 1, 0.35),
    cap: 'butt',
  },
  sample_loop: { stroke: 'M0.68 0.3 L0.85 0.3 L0.85 0.7 L0.15 0.7 L0.15 0.3 L0.35 0.3', fill: arrow(0.35, 0.3, 1, 0.4), cap: 'round' },
  sample_bounce: { stroke: 'M0.5 0.5 L0.26 0.5 M0.5 0.5 L0.74 0.5', fill: arrow(0.26, 0.5, -1, 0.4) + arrow(0.74, 0.5, 1, 0.4), cap: 'butt' },
}

/** OpenGlShapeButton with on colours: Icon Button Off / On, their Hover colours faded in over five
 *  frames, Pressed while held. */
function SampleToggle({ p, x, y, size, title }: { p: string; x: number; y: number; size: number; title: string }) {
  const api = useVital()
  const [down, setDown] = useState(false)
  const lit = (api.v[p] ?? 0) >= 0.5
  const icon = SAMPLE_ICONS[p]
  return (
    <svg className={`vt-smpicon${lit ? ' on' : ''}${down ? ' down' : ''}`} viewBox="0 0 1 1" style={{ left: x, top: y, width: size, height: size }} aria-label={title}
      onPointerDown={(e) => { e.stopPropagation(); setDown(true) }} onPointerUp={() => setDown(false)} onPointerLeave={() => setDown(false)}
      onClick={(e) => { e.stopPropagation(); api.checkpoint(); api.set(p, lit ? 0 : 1) }}>
      {icon.stroke && <path d={icon.stroke} fill="none" stroke="currentColor" strokeWidth={0.12} strokeLinecap={icon.cap} strokeLinejoin="round" />}
      {icon.fill && <path d={icon.fill} fill="currentColor" />}
    </svg>
  )
}

export function Sampler() {
  const api = useVital()
  const { engine, ctx } = useEngine()
  const on = (api.v.sample_on ?? 0) >= 0.5
  const [info, setInfo] = useState<{ name: string; peaks: Float32Array } | null>(null)
  const [dragging, setDragging] = useState(false)
  // The engine's sample (its name and the viewer's peaks): after it starts, a preset load or an init.
  useEffect(() => {
    if (!engine) return
    let live = true
    const timer = setTimeout(() => void engine.sampleInfo().then((r) => { if (live) setInfo({ name: r.name, peaks: r.peaks }) }), 50)
    return () => { live = false; clearTimeout(timer) }
  }, [engine, api.patch.id])
  // SampleSection::loadFile: the file at its own rate, both channels when it has two.
  const load = async (file: File, key?: string) => {
    if (!engine || !ctx) return
    let audio
    try { audio = await readAudioFile(file, ctx) } catch { window.alert(`${file.name} isn't an audio file this browser can read.`); return }
    const left = audio.channels[0]
    const right = audio.channels.length > 1 ? audio.channels[1] : null
    await engine.loadSample(left, right, audio.sampleRate, file.name.replace(/\.[^.]+$/, ''))
    const r = await engine.sampleInfo()
    setInfo({ name: r.name, peaks: r.peaks })
    api.setUi({ modified: true, sampleFile: key })
  }
  const pick = (files: FileList | null) => {
    const f = [...(files ?? [])].find((x) => x.type.startsWith('audio/') || /\.(wav|aiff?|flac|mp3|ogg|m4a)$/i.test(x.name))
    if (f) void load(f)
  }
  const loadEntry = async (f: LibFile) => load(await f.file(), f.key)
  // The name opens the sample browser at the selector's right; ‹ › step through every sample.
  const step = (k: number) => (e: React.MouseEvent) => {
    e.stopPropagation()
    void loadLibrary().then(() => { const f = shiftedFile('sample', api.ui.sampleFile as string | undefined, k); if (f) void loadEntry(f) })
  }
  const browse = (e: React.MouseEvent) => {
    e.stopPropagation()
    openPopupBrowser(api, { owner: 'sample', kind: 'sample', at: [741, 713, 1595, 1140], ignore: [127, 708, 1131, 803] },
      (f) => void loadEntry(f), () => api.ui.sampleFile as string | undefined)
  }
  const isFile = (e: React.DragEvent) => [...e.dataTransfer.items].some((it) => it.kind === 'file')
  return (
    <Region tags={['source']} className={`vt-osc vt-smp${on ? ' on' : ''}`} style={R(127, 708, 1131, 803)} label="Sampler">
      <div className="vt-b vt-strip" style={R(0, 0, 45, 95)} />
      <Power p="sample_on" x={22} y={21} />
      <span className="vt-vlabel" style={{ left: 22 / 2, top: 62 / 2 }}>SMP</span>
      <PitchChip pre="sample" at={[53, 7, 228, 57]} />
      <Dest p="sample_destination" at={[53, 66, 228, 90]} label="Sampler destination" />
      <Box at={[235, 7, 613, 90]} className="vt-screen vt-smpscreen"
        onDragOver={(e) => { if (isFile(e)) { e.preventDefault(); setDragging(true) } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files) }}>
        <div className="vt-tname">
          <span className="arr" onClick={step(-1)}>‹</span>
          <span className="nm" onClick={browse}>{info?.name ?? 'White Noise'}</span>
          <span className="arr" onClick={step(1)}>›</span>
        </div>
        <SampleViewer peaks={info?.peaks ?? null} on={on} style={{ left: 0, top: 14.9, width: '100%', height: 25.3 }} />
        {dragging && <div className="vt-smpdrop" />}
      </Box>
      <Knob p="sample_level" x={681} y={34} d={58} dim={!on} label="LEVEL" labelAt={[640, 66, 722, 90]} />
      <Knob p="sample_pan" x={771} y={34} d={58} dim={!on} label="PAN" labelAt={[730, 66, 812, 90]} />
      {/* The four toggles: keytrack and loop on the left, random phase and bounce on the right. */}
      <div className="vt-b vt-smpicons" style={R(820, 8, 995, 88)}>
        <SampleToggle p="sample_keytrack" x={16.4} y={-0.5} size={20.1} title="Keytrack" />
        <SampleToggle p="sample_random_phase" x={52.5} y={-0.5} size={20.1} title="Random phase" />
        <SampleToggle p="sample_loop" x={16.4} y={19.6} size={20.1} title="Loop" />
        <SampleToggle p="sample_bounce" x={52.5} y={19.6} size={20.1} title="Bounce" />
      </div>
    </Region>
  )
}

/** The filter's display: the response curve (the engine's, once it runs); drag sideways for cutoff, up
 *  and down for resonance (formant X / Y on the formant model), full range per width / height; the wheel
 *  does the same; the cutoff and resonance popups show while pressed (FilterResponse::mouseDown). */
function FilterScreen({ pre, on, at, color }: { pre: string; on: boolean; at: [number, number, number, number]; color: string }) {
  const api = useVital()
  const { engine } = useEngine()
  const [pressed, setPressed] = useState(false)
  const v = (k: string) => api.get(`${pre}_${k}`) ?? PARAMS[`${pre}_${k}`]?.def ?? 0
  const model = Math.round(v('model')), style = Math.round(v('style'))
  const cutoff = v('cutoff'), res = v('resonance'), blend = v('blend')
  const W = 231, H = 70
  const move = (dx: number, dy: number) => {
    if (model === 5) { api.set(`${pre}_formant_x`, v('formant_x') + dx / W); api.set(`${pre}_formant_y`, v('formant_y') + dy / H) }
    else { api.set(`${pre}_cutoff`, v('cutoff') + dx / W * 128); api.set(`${pre}_resonance`, v('resonance') + dy / H) }
  }
  const drag = useDrag((dx, dy) => move(dx, dy))
  const wheel = useWheel((dx, dy) => { api.checkpoint(); move(dx / 100 * 8, dy / 100 * 8) })
  const d = useMemo(() => {
    if (engine) return ''
    const pts = Array.from({ length: 116 }, (_, k) => {
      const f = 8 + (k / 115) * 128
      const db = filterDb(model, style, cutoff, res, blend, f, { formantX: v('formant_x'), formantY: v('formant_y'), transpose: v('formant_transpose') })
      return [k / 115 * W, Math.min(H + 2, Math.max(-2, H * (0.52 - db * 0.028)))]
    })
    return pts.map(([x, y], k) => `${k ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, model, style, cutoff, res, blend, api.v])
  const [xId, yId, xLabel, yLabel] = model === 5 ? ['formant_x', 'formant_y', 'Formant X: ', 'Formant Y: '] : ['cutoff', 'resonance', 'Cutoff: ', 'Resonance: ']
  return (
    <Box at={at} className={`vt-screen vt-fscreen${dropTarget(api, `${pre}_cutoff`) ? ' target' : ''}`} data-drop={`${pre}_cutoff`} {...drag} ref={wheel}
      onPointerDown={(e) => { drag.onPointerDown(e); setPressed(true) }} onPointerLeave={() => setPressed(false)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {engine
          ? <FilterCurve pre={pre} w={W} h={H} on={on} />
          : <path d={`${d} L ${W} ${H + 2} L 0 ${H + 2} Z`} fill={on ? (color === ORANGE ? '#956746' : 'rgba(170,136,255,.5)') : 'none'} stroke={on ? color : '#4c4f52'} strokeWidth={0.8} />}
      </svg>
      {pressed && <Bubble at="below" text={xLabel + shown(`${pre}_${xId}`, v(xId))} />}
      {pressed && <Bubble at="right" text={yLabel + shown(`${pre}_${yId}`, v(yId))} />}
      <Rings p={`${pre}_cutoff`} x={W / 2} y={57.5} at="above" />
    </Box>
  )
}

export function Filter({ k }: { k: number }) {
  const api = useVital()
  const pre = `filter_${k + 1}`, x0 = 127 + k * 502
  const on = (api.v[`${pre}_on`] ?? 0) >= 0.5
  const mode = filterMode(Math.round(api.v[`${pre}_model`] ?? 0), Math.round(api.v[`${pre}_style`] ?? 0))
  const inputs: [string, string][] = [['osc1_input', 'OSC1'], ['osc2_input', 'OSC2'], ['osc3_input', 'OSC3'], ['sample_input', 'SMP']]
  return (
    <Region tags={['filter']} className={`vt-filter${on ? ' on' : ''}`} style={R(x0, 813, x0 + 497, 1140)} label={`FILTER ${k + 1}`}>
      <Power p={`${pre}_on`} x={24} y={29} color={ORANGE} className="f" />
      <span className="vt-fname" style={{ left: 75 / 2, top: 17 / 2 }}>FILTER {k + 1}</span>
      <FilterModelSelector pre={pre} at={[203, 15, 485, 44]} className="vt-sel big" menuAt="right" />
      <FilterIcon icon={mode.left} className="vt-fic" style={{ left: 9, top: 23, width: 14, height: 10 }} />
      <FilterIcon icon={mode.right} className="vt-fic" style={{ left: 229, top: 23, width: 14, height: 10 }} />
      {mode.showBlend
        ? <HSlider p={`${pre}_blend`} at={[41, 53, 453, 63]} thumb={22} fillFrom={0.5} dim={!on} color="#ffffff" popup="above" prefix="Blend: " snap={1} ringsAt="below" />
        : <HSlider p={`${pre}_formant_transpose`} at={[41, 53, 453, 63]} thumb={22} fillFrom={0.5} dim={!on} color="#ffffff" popup="above" ringsAt="below" />}
      <FilterScreen pre={pre} on={on} at={[8, 69, 471, 210]} color={ORANGE} />
      {mode.formant
        ? <VSlider p={`${pre}_formant_y`} at={[479, 67, 489, 207]} thumb={36} dim={!on} prefix="Formant Y: " />
        : <VSlider p={`${pre}_resonance`} at={[479, 67, 489, 207]} thumb={36} dim={!on} prefix="Resonance: " />}
      {mode.formant
        ? <HSlider p={`${pre}_formant_x`} at={[8, 215, 471, 227]} thumb={42} fillFrom={0} dim={!on} color="#ffffff" rings={false} prefix="Formant X: " />
        : <HSlider p={`${pre}_cutoff`} at={[8, 215, 471, 227]} thumb={42} fillFrom={0} dim={!on} color="#ffffff" rings={false} prefix="Cutoff: " />}
      <Region tags={['flow']} className="vt-fsrc" style={R(8, 235, 266, 320)} label={`Filter ${k + 1} inputs`}>
        {inputs.map(([p, n], j) => <Toggle key={p} p={`${pre}_${p}`} className="vt-fin" at={[(j % 2) * 94, Math.floor(j / 2) * 30, (j % 2) * 94 + 87, Math.floor(j / 2) * 30 + 24]}>{n}</Toggle>)}
        <Toggle p={`${pre}_filter_input`} className="vt-fin" at={[46, 60, 134, 84]}>{k === 0 ? 'FIL2' : 'FIL1'}</Toggle>
      </Region>
      <Knob key={mode.firstKnob} p={`${pre}_${mode.firstKnob}`} x={244} y={262} d={58} color={ORANGE} dim={!on} label={mode.label1} labelAt={[204, 294, 286, 318]} />
      <Knob p={`${pre}_mix`} x={343} y={262} d={58} color={ORANGE} dim={!on} label="MIX" labelAt={[303, 294, 385, 318]} />
      <Knob key={mode.secondKnob} p={`${pre}_${mode.secondKnob}`} x={442} y={262} d={58} color={ORANGE} dim={!on} label={mode.label2} labelAt={[402, 294, 484, 318]} snap={mode.formant ? undefined : 0} />
    </Region>
  )
}

export function VoicePage() {
  return <>{[0, 1, 2].map((i) => <Osc key={i} i={i} />)}<Sampler /><Filter k={0} /><Filter k={1} /></>
}
