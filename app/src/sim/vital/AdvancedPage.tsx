import { useRef } from 'react'
import { Knob, TextValue, Toggle } from './controls'
import { useVital, type MenuItem, type VitalApi } from './ctx'
import { R, useControlMenu, useStepWheel, useWheel, type Rect } from './hooks'
import { loadBuiltinTuning, pickTuningFile, TUNING_NAMES, useTuning } from '../../engine/tuning'
import { OVERSAMPLING, PARAMS, shown, UNISON_STACKS, VOICE_OVERRIDE, VOICE_PRIORITY } from './params'
import { useEngine } from '../../engine/EngineContext'
import { useLanesOr } from '../../engine/status'
import { OutputDisplay, SpectrogramGrid } from '../../engine/OutputDisplay'
import { sk, useSkin } from './skin'
import './advanced.css'

// Vital's ADVANCED page (s0d, s7c–e in the deep capture): per oscillator its OPTIONS (NOTE TRACK,
// HI-RES WAVETABLE; lit while the oscillator is on) and UNISON settings (lit while it's on with more than
// one unison voice), then VOICE, OVERSAMPLING, DISPLAY and the ANALYSIS scope and spectrum. Positions are
// the capture's 2000-wide frame relative to the page's top-left (127, 108), halved by `R`.

/** The unison stack menu as Vital 1.5.5 lists it (s7e). */
const STACK_MENU = ['Unison', 'Center Drop 12', 'Center Drop 24', 'Octave', 'Octave + 7', '2x Octave', 'Power Chord', '2x Power Chord', 'Major Chord', 'Minor Chord', 'Harmonics', 'Odd Harmonics', 'Sub Harmonics']
const FREQ_UNITS = ['Semitones', 'Hz']
const OVERSAMPLE_LABELS = ['1x (Draft)', '2x (Recommended)', '4x (High CPU)', '8x (Ultra CPU)']

/** A value box with its label strip under it (Vital's text component + label). */
function ValBox({ at, split, label, children, onClick, onContextMenu, boxRef, dim = false, className = '' }: {
  at: Rect; split: number; label: string; children: React.ReactNode; onClick?: (e: React.MouseEvent) => void; dim?: boolean; className?: string
  onContextMenu?: (e: React.MouseEvent) => void; boxRef?: React.Ref<HTMLDivElement>
}) {
  const [x0, y0, x1, y1] = at
  return (
    <div ref={boxRef} className={`vad-valbox${dim ? ' dim' : ''} ${className}`} style={R(x0, y0, x1, y1)} onContextMenu={onContextMenu}>
      <div className="v" style={{ height: (split - y0) / 2 }} onClick={onClick}>{children}</div>
      <div className="l">{label}</div>
    </div>
  )
}

const menuOf = (api: VitalApi, e: React.MouseEvent, items: MenuItem[], w = 110) => api.openMenu({ items, w }, e)

function OscRow({ i }: { i: number }) {
  const api = useVital()
  const n = i + 1, y = i * 199.5
  const on = (api.v[`osc_${n}_on`] ?? 0) >= 0.5
  const uni = on && (api.v[`osc_${n}_unison_voices`] ?? 1) > 1
  const p = (k: string) => `osc_${n}_${k}`
  const stack = Math.round(api.v[p('stack_style')] ?? 0)
  const stackMenu = (e: React.MouseEvent) => menuOf(api, e, STACK_MENU.map((name) => {
    const idx = UNISON_STACKS.indexOf(name as never)
    return { label: name, on: idx === stack, dim: idx < 0, act: idx < 0 ? undefined : () => { api.checkpoint(); api.set(p('stack_style'), idx) } }
  }), 87)
  return (
    <>
      <div className={`vad-sec${on ? ' on' : ''}`} style={R(0, y, 221, y + 194)}>
        <div className="vad-strip" style={R(0, 0, 45, 194)}><span className="vad-vlabel">OSC {n} OPTIONS</span></div>
        <Toggle p={p('midi_track')} at={[53, 7.8, 213.3, 93]} className="vad-btn">NOTE TRACK</Toggle>
        <Toggle p={p('smooth_interpolation')} at={[53, 100.8, 213.3, 186.3]} className="vad-btn">HI-RES WAVETABLE</Toggle>
      </div>
      <div className={`vad-sec${uni ? ' on' : ''}`} style={R(226.5, y, 1004, y + 194)}>
        <div className="vad-strip" style={R(0, 0, 45.5, 194)}><span className="vad-vlabel">OSC {n} UNISON</span></div>
        <ValBox at={[53, 7.8, 216, 93]} split={67.5} label="STACK" onClick={stackMenu} className="click">
          {STACK_MENU.includes(UNISON_STACKS[stack]) ? UNISON_STACKS[stack] : '---'}
        </ValBox>
        <ValBox at={[53, 100.8, 216, 186.3]} split={160.5} label="DETUNE RANGE">
          <TextValue p={p('detune_range')} fmt={(v) => shown(p('detune_range'), v, false)} span={200} />
        </ValBox>
        <Knob p={p('unison_blend')} x={289.5} y={36.9} d={55} dim={!uni} label="UNISON BLEND" labelAt={[223.6, 67.5, 355, 93]} />
        <SpreadDisplay n={n} active={uni} />
        {([['stereo_spread', 'STEREO UNISON', 289.5, 223.6, 355], ['frame_spread', 'TABLE SPREAD', 428, 362.5, 494], ['spectral_morph_spread', 'SPECT SPREAD', 566.5, 501, 632.5], ['distortion_spread', 'DIST SPREAD', 705, 639.5, 770.5]] as const).map(([k, label, x, l0, l1]) => (
          <Knob key={k} p={p(k)} x={x} y={130} d={55} dim={!uni} bipolar={k !== 'stereo_spread'} label={label} labelAt={[l0, 160.5, l1, 186.3]} />
        ))}
      </div>
    </>
  )
}

/** SpreadVisualizer (oscillator_advanced_section.cpp): three rows, bottom to top the wave frame,
 *  spectral morph and distortion amount each unison voice plays, a 1 pt Widget Secondary 1 bar per
 *  voice and channel (the left channel's at even slots, the right's at odd), read from the modulated
 *  values. Voice i (stepping by two, the count rounded up to even) sits at value + spread × 2i / (voices
 *  − 2), clamped; nothing is drawn for two voices or fewer. */
function SpreadDisplay({ n, active }: { n: number; active: boolean }) {
  const api = useVital()
  const pre = `osc_${n}`
  const useValue = (k: string, def: number) => useLanesOr(`${pre}_${k}`, api.v[`${pre}_${k}`] ?? def)
  const voicesLanes = useValue('unison_voices', 1)
  const frame = useValue('wave_frame', 0), morph = useValue('spectral_morph_amount', 0.5), distortion = useValue('distortion_amount', 0.5)
  const frameSpread = useValue('frame_spread', 0), morphSpread = useValue('spectral_morph_spread', 0), distortionSpread = useValue('distortion_spread', 0)
  const W = 203.85, H = 42.6, M = 5.5 * 1000 / 1440, PX = 1000 / 1440
  const rowH = (H - M) / 3 - M
  const bars: React.ReactElement[] = []
  let voices = Math.max(0, Math.trunc(voicesLanes[0]))
  if (voices > 2) {
    voices += voices % 2
    const x = (u: number) => Math.max(0, Math.min(1, u)) * (W - 2 * M) + M - PX / 2
    for (let i = 0; i < voices; i += 2) {
      const t = (2 * i) / (voices - 2)
      for (const lane of [0, 1] as const) {
        const rows = [(frame[lane] + frameSpread[lane] * t) / 256, morph[lane] + morphSpread[lane] * t, distortion[lane] + distortionSpread[lane] * t]
        rows.forEach((u, r) => {
          const y = H - M - (r + 1) * rowH - r * M
          bars.push(<rect key={`${i}-${lane}-${r}`} x={x(u)} y={y} width={PX} height={rowH} />)
        })
      }
    }
  }
  return (
    <div className={`vad-spread${active ? ' on' : ''}`} style={R(362.5, 7.8, 770.2, 93)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"><g style={{ fill: sk('Widget Secondary 1') }}>{bars}</g></svg>
    </div>
  )
}

/** A value box whose value opens a menu of names (NOTE PRIORITY, VOICE OVERRIDE …). */
function ParamMenuBox({ p, names, at, split, label }: { p: string; names: readonly string[]; at: Rect; split: number; label: string }) {
  const api = useVital()
  const v = Math.round(api.v[p] ?? PARAMS[p].def)
  const wheel = useStepWheel(p, names.length)
  const menu = useControlMenu(p)
  return (
    <ValBox at={at} split={split} label={label} className="click" boxRef={wheel} onContextMenu={menu}
      onClick={(e) => menuOf(api, e, names.map((name, i) => ({ label: name, on: i === v, act: () => { api.checkpoint(); api.set(p, i) } })), 85)}>
      {names[v]}
    </ValBox>
  )
}

/** TUNING (TuningSelector): the tuning's name ("Default" when it has none); clicking lists Vital's four
 *  tunings and Load Tuning File..., at the click; the wheel steps through the four. */
function TuningBox({ at, split }: { at: Rect; split: number }) {
  const api = useVital()
  const { engine } = useEngine()
  const tuning = useTuning()
  const shown = tuning.name || 'Default'
  const pick = (i: number) => { if (engine) void loadBuiltinTuning(engine, i) }
  const at_ = TUNING_NAMES.indexOf(shown as (typeof TUNING_NAMES)[number])
  const acc = useRef(0)
  const wheel = useWheel((_dx, dy) => {
    acc.current += dy
    if (Math.abs(acc.current) < 50) return
    const next = Math.max(0, Math.min(TUNING_NAMES.length - 1, (at_ < 0 ? TUNING_NAMES.length : at_) + Math.sign(acc.current)))
    acc.current = 0
    if (next !== at_) pick(next)
  })
  return (
    <ValBox at={at} split={split} label="TUNING" className="click small" boxRef={wheel}
      onClick={(e) => menuOf(api, e, [
        ...TUNING_NAMES.map((name, i) => ({ label: name, on: name === shown, act: () => pick(i) })),
        { sep: true },
        { label: 'Load Tuning File...', dim: !engine, act: engine ? () => pickTuningFile(engine) : undefined },
      ], 95)}>
      {shown}
    </ValBox>
  )
}

function UiMenuBox({ k, names, def, at, split, label, extra }: { k: string; names: string[]; def: string; at: Rect; split: number; label: string; extra?: string }) {
  const api = useVital()
  const cur = (api.ui[k] as string | undefined) ?? def
  return (
    <ValBox at={at} split={split} label={label} className="click small"
      onClick={(e) => menuOf(api, e, [...names.map((name) => ({ label: name, on: name === cur, act: () => api.setUi({ [k]: name }) })), ...(extra ? [{ sep: true }, { label: extra, dim: true }] : [])], 95)}>
      {cur}
    </ValBox>
  )
}

/** THEME: the skins (Vital's default and the bundled ones, plus one loaded from a file), then Load
 *  Skin... for a .vitalskin of the reader's own. */
function ThemeBox({ at, split }: { at: Rect; split: number }) {
  const api = useVital()
  const skins = useSkin()
  const pick = useRef<HTMLInputElement>(null)
  return (
    <>
      <ValBox at={at} split={split} label="THEME" className="click small"
        onClick={(e) => menuOf(api, e, [...skins.names.map((name) => ({ label: name, on: name === skins.skin.name, act: () => skins.choose(name) })),
          { sep: true }, { label: 'Load Skin...', act: () => pick.current?.click() }], 95)}>
        {skins.skin.name}
      </ValBox>
      <input ref={pick} type="file" accept=".vitalskin,application/json" hidden onChange={(e) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (file) skins.load(file).catch(() => console.warn(`${file.name} isn't a Vital skin`)) // Vital ignores it too
      }} />
    </>
  )
}

export function AdvancedPage() {
  const api = useVital()
  const over = Math.round(api.v.oversampling ?? 1)
  const { engine } = useEngine()
  return (
    <div className="vad" data-skin="Advanced">
      {[0, 1, 2].map((i) => <OscRow key={i} i={i} />)}

      <div className="vad-sec on" style={R(0, 606, 221, 1032)}>
        <div className="vad-title" style={R(0, 0, 221, 45)}>VOICE</div>
        <ParamMenuBox p="voice_priority" names={VOICE_PRIORITY} at={[7.8, 53, 213.3, 129]} split={103.6} label="NOTE PRIORITY" />
        <ParamMenuBox p="voice_override" names={VOICE_OVERRIDE} at={[7.8, 137, 213.3, 214]} split={188} label="VOICE OVERRIDE" />
        <TuningBox at={[7.8, 221.5, 213.3, 298.6]} split={273} />
        <Toggle p="mpe_enabled" at={[7.8, 306.4, 213.3, 335]} className="vad-btn small">MPE ENABLED</Toggle>
        <ValBox at={[7.8, 342.4, 106.5, 419]} split={393} label="TUNE">
          <TextValue p="voice_tune" fmt={(v) => `${shown('voice_tune', v, false)} c`} span={200} />
        </ValBox>
        <ValBox at={[114, 342.4, 213.3, 419]} split={393} label="TRANSPOSE">
          <TextValue p="voice_transpose" span={300} />
        </ValBox>
      </div>

      <div className="vad-sec on" style={R(226.5, 606, 447.6, 821)}>
        <div className="vad-title" style={R(0, 0, 221, 45)}>OVERSAMPLING</div>
        {OVERSAMPLE_LABELS.map((label, i) => (
          <div key={label} className={`vad-radio${over === i ? ' on' : ''}`} style={R(7.8, 53 + i * 40.4, 213.3, 85.6 + i * 40.4)}
            onClick={() => { api.checkpoint(); api.set('oversampling', i) }} title={OVERSAMPLING[i]}>{label}</div>
        ))}
      </div>

      <div className="vad-sec on" style={R(226.5, 827, 447.6, 1032)}>
        <div className="vad-title" style={R(0, 0, 221, 45)}>DISPLAY</div>
        <UiMenuBox k="advFreqUnits" names={FREQ_UNITS} def="Semitones" at={[7.8, 52.7, 213.3, 121.4]} split={95.6} label="FREQUENCY UNITS" />
        <ThemeBox at={[7.8, 128.9, 213.3, 198]} split={172} />
      </div>

      <div className="vad-sec on" style={R(453, 606, 1004, 1032)}>
        <div className="vad-title" style={R(0, 0, 551, 45)}>ANALYSIS</div>
        {/* OutputDisplays: Vital's stock Oscilloscope and Spectrogram (−50 … 0 dB, 9.2 Hz – 21 kHz, grid),
            in the Advanced skin section (the oscilloscope at its Widget Line Width; the spectrogram at 2 pt). */}
        <div className="vad-scope" style={R(7.5, 53, 544, 239.5)}>
          {engine
            ? <OutputDisplay w={536.5} h={186.5} spectrogram={null} pt={2000 / 1440} />
            : <svg viewBox="0 0 268 93" preserveAspectRatio="none"><line x1={0} x2={268} y1={46.5} y2={46.5} /></svg>}
        </div>
        <div className="vad-spectrum" style={R(7.5, 247.3, 544, 419)}>
          <SpectrogramGrid w={536.5} h={171.7} />
          {engine && <OutputDisplay w={536.5} h={171.7} spectrogram={{ id: 1, minDb: -50, maxDb: 0 }} pt={2000 / 1440} />}
        </div>
      </div>
    </div>
  )
}
