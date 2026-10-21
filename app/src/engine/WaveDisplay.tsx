import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useVital } from '../sim/vital/ctx'
import { useEngine } from './EngineContext'
import { useLanesOr } from './status'

// The oscillator display as Vital draws it (interface/editor_components/wavetable_3d.cpp), from the
// engine's own data: in 3D all 257 raw frames stroked along a perspective line and shaded
// (paint3dBackground) with the current frame drawn over it; in 2D the current frame filled to the
// centre; in SP its harmonic magnitudes on a log axis, mirrored (loadSpectrumData). The current frame
// is spectrally morphed and phase-distorted by the engine exactly as Vital's display computes it
// (vs_osc_display), at the knobs' modulated values (mono totals, plus poly ones while a voice plays),
// once per channel: the right channel's line is drawn with the left's (Widget Primary 2 is Primary 1). Geometry and colours are the
// default skin's ("Oscillator" overrides).

const W = 189, H = 89 // the screen's drawing box (the sim's viewBox)
const SCALE = 1000 / 1440 // the drawing's 1000-wide stage vs Vital's 1440 pt window

// Skin: Wavetable Horizontal/Vertical Angle, Draw Width (Oscillator), Draw Height, Y Offset.
const H_ANGLE = -0.24, V_ANGLE = 1.22, DRAW_WIDTH = 0.78, WAVE_HEIGHT = 0.1, Y_OFFSET = 0.05
const WAVE_RANGE_X = Math.cos(H_ANGLE) * DRAW_WIDTH
const FRAME_RANGE_X = -Math.sin(H_ANGLE) * DRAW_WIDTH
const WAVE_RANGE_Y = 2 * FRAME_RANGE_X * Math.cos(V_ANGLE)
const FRAME_RANGE_Y = -2 * WAVE_RANGE_X * Math.cos(V_ANGLE)
const START_X = 0.5 * (1 - WAVE_RANGE_X - FRAME_RANGE_X)
const START_Y = 0.5 * (1 - WAVE_RANGE_Y - FRAME_RANGE_Y) + Y_OFFSET
const DRAW_ANGLE = Math.atan(WAVE_RANGE_Y / WAVE_RANGE_X)
const OFFSET_X = -Math.sin(DRAW_ANGLE) * 1.5 * WAVE_HEIGHT, OFFSET_Y = Math.cos(DRAW_ANGLE) * 1.5 * WAVE_HEIGHT
const K2D_HEIGHT = 0.25 // k2dWaveHeightPercent
const LAST_FRAME = 256
const COLOR_JUMP = 16 // kColorJump

const PRIMARY = '#aa88ff', PRIMARY_OFF = '#4c4f52' // Widget Primary 1 / Disabled
const SECONDARY = 'rgba(159,136,255,0.4)', SECONDARY_OFF = 'rgba(102,102,102,0.13)' // Widget Secondary 1 / Disabled
const ACCENT1 = 'rgba(170,136,255,0.098)', ACCENT2 = 'rgba(170,136,255,0.098)' // Widget Accent 1 / 2 (19aa88ff in the default skin)
// The body colour (Body, 4c4f52) at the wave colour's alpha. An off oscillator's wave colour is the accent
// desaturated (white, at full brightness) then interpolated half-way to the opaque body colour, alpha
// included (Colour::interpolatedWith), with its dip at that alpha.
const BODY_DIP = 'rgba(76,79,82,0.098)', WAVE_OFF = 'rgba(166,167,169,0.549)', BODY_DIP_OFF = 'rgba(76,79,82,0.549)'
const WAVEFORM_SIZE = 2048, BACKGROUND_RESOLUTION = 128 // vital::Wavetable::kWaveformSize, kBackgroundResolution
const LINE = 2 * SCALE // Widget Line Width

/** Raw frames of oscillator `osc`'s table (128 points each), re-read when its table or the patch changes. */
function useTableFrames(osc: number): Float32Array[] | null {
  const { engine } = useEngine()
  const api = useVital()
  const table = (api.ui[`osc_${osc + 1}_table`] as string | undefined) ?? 'Init'
  const rev = api.ui[`osc_${osc + 1}_tableRev`] // bumped when the table changes in place (the wavetable editor)
  const [frames, setFrames] = useState<Float32Array[] | null>(null)
  useEffect(() => {
    if (!engine) return
    let live = true
    // Wait a tick: this effect runs before EngineSync's sends the new table, and the port is FIFO.
    const timer = setTimeout(() => void engine.wavetableFrames(osc, 128).then(({ count, points, data }) => {
      if (live) setFrames(Array.from({ length: count }, (_, f) => data.subarray(f * points, (f + 1) * points)))
    }))
    return () => { live = false; clearTimeout(timer) }
  }, [engine, osc, table, rev, api.patch.id])
  return frames
}

/** A knob's [left, right] values as the display reads them (Wavetable3d::getOutputsTotal): modulated
 *  while the oscillator is on, else as set. */
function useShown(id: string, on: boolean): [number, number] {
  const api = useVital()
  const base = api.v[id] ?? 0
  const lanes = useLanesOr(id, base)
  return on ? lanes : [base, base]
}

type Display = { wave: Float32Array; spectrum: Float32Array }

/** The engine's display frames for oscillator `osc`, left and right: each wave and its harmonic
 *  magnitudes. */
function useDisplayFrame(osc: number, on: boolean) {
  const { engine } = useEngine()
  const api = useVital()
  const pre = `osc_${osc + 1}`
  const frame = useShown(`${pre}_wave_frame`, on)
  const morph = useShown(`${pre}_spectral_morph_amount`, on)
  const distortion = useShown(`${pre}_distortion_amount`, on)
  const distortionPhase = useShown(`${pre}_distortion_phase`, on)
  const morphType = Math.round(api.v[`${pre}_spectral_morph_type`] ?? 0)
  const distortionType = Math.round(api.v[`${pre}_distortion_type`] ?? 0)
  const table = (api.ui[`${pre}_table`] as string | undefined) ?? 'Init'
  const rev = api.ui[`${pre}_tableRev`]
  const [out, setOut] = useState<[Display, Display] | null>(null)
  const busy = useRef(false), again = useRef(false)
  const args = { frame, morphType, morph, distortionType, distortion, distortionPhase }
  const latest = useRef(args)
  latest.current = args
  const key = JSON.stringify(args)
  useEffect(() => {
    if (!engine) return
    const run = () => {
      if (busy.current) { again.current = true; return }
      busy.current = true
      const a = latest.current
      const lane = (i: 0 | 1) => engine.oscDisplay(osc, { frame: a.frame[i], morphType: a.morphType, morph: a.morph[i], distortionType: a.distortionType, distortion: a.distortion[i], distortionPhase: a.distortionPhase[i] })
      void Promise.all([lane(0), lane(1)]).then((r) => {
        busy.current = false
        setOut([r[0], r[1]])
        if (again.current) { again.current = false; run() }
      })
    }
    const timer = setTimeout(run)
    return () => clearTimeout(timer)
  }, [engine, osc, key, table, rev, api.patch.id]) // eslint-disable-line react-hooks/exhaustive-deps
  return { out, frame }
}

/** Points along the current frame, `n` of the 2048 samples (Vital draws them all; 256 is plenty here). */
function framePath(wave: Float32Array, x: (t: number) => number, y: (t: number, v: number) => number, n = 256) {
  let d = ''
  for (let k = 0; k <= n; k++) {
    const t = k / n, v = wave[Math.min(wave.length - 1, Math.floor(t * wave.length))]
    d += `${k ? 'L' : 'M'}${x(t).toFixed(2)} ${y(t, v).toFixed(2)}`
  }
  return d
}

export function WaveDisplay({ osc, view, on }: { osc: number; view: number; on: boolean }) {
  const frames = useTableFrames(osc)
  const { out, frame } = useDisplayFrame(osc, on)
  const line = on ? PRIMARY : PRIMARY_OFF

  // 3D background (paint3dBackground): all 257 frames, back to front, each stroked 1 pt wide with a
  // gradient from the wave colour (Widget Accent 1 every 16th frame, Accent 2 otherwise; greyed and
  // half-way to the body colour when the oscillator is off) at the stack's start to the body colour
  // offset down-and-left by 1.5 × the wave height, so troughs fall into shade.
  const background = useMemo(() => {
    if (!frames || view !== 0) return null
    const paths: { d: string; color: string; dip: string; x1: number; y1: number; x2: number; y2: number }[] = []
    const inc = WAVEFORM_SIZE / BACKGROUND_RESOLUTION
    for (let f = frames.length - 1; f >= 0; f--) {
      const ft = f / LAST_FRAME, sx = START_X + ft * FRAME_RANGE_X, sy = START_Y + ft * FRAME_RANGE_Y
      const b = frames[f]
      const loop = -WAVE_HEIGHT * 0.5 * (b[0] + b[b.length - 1])
      let d = `M${(sx * W).toFixed(1)} ${((sy + loop) * H).toFixed(1)}`
      for (let i = 0; i < b.length; i++) {
        const wt = (i * inc) / (WAVEFORM_SIZE - 1)
        d += `L${((sx + wt * WAVE_RANGE_X) * W).toFixed(1)} ${((sy + wt * WAVE_RANGE_Y - WAVE_HEIGHT * b[i]) * H).toFixed(1)}`
      }
      d += `L${((sx + WAVE_RANGE_X) * W).toFixed(1)} ${((sy + WAVE_RANGE_Y + loop) * H).toFixed(1)}`
      const color = on ? (f % COLOR_JUMP ? ACCENT2 : ACCENT1) : WAVE_OFF
      paths.push({ d, color, dip: on ? BODY_DIP : BODY_DIP_OFF, x1: sx * W, y1: START_Y * H, x2: (sx + OFFSET_X) * W, y2: (START_Y + OFFSET_Y) * H })
    }
    return paths
  }, [frames, view, on])
  const gradient = useId()

  if (!out) return null
  if (view === 2) {
    // loadSpectrumData: log-spaced harmonics, +3 dB/octave tilt, −30…50 dB, mirrored about the centre;
    // the right channel's, then the left's over it.
    const spectrum = (mags: Float32Array) => {
      const n = Math.min(Math.round(W / SCALE), 1024), scale = 1 / n, center = H / 2
      const top: string[] = [], bottom: string[] = []
      let last = 0
      for (let i = 0; i <= n; i++) {
        const t = i / n, position = Math.pow(2, t * 10), f = Math.min(Math.floor(position), 1022), ft = position - f
        let amp = (mags[f] * (1 - ft) + mags[f + 1] * ft) * scale
        for (let k = last + 1; k < f; k++) amp = Math.max(mags[k] * scale, amp)
        last = f
        const db = 20 * Math.log10(Math.max(amp, 1e-9)) + t * 11 * 3
        const y = Math.max(db + 30, 0) / 80
        const x = (t * W).toFixed(2)
        top.push(`${x} ${(center - y * center).toFixed(2)}`)
        bottom.unshift(`${x} ${(center + y * center).toFixed(2)}`)
      }
      return `M${top.join('L')}L${bottom.join('L')}Z`
    }
    return <>{[1, 0].map((c) => <path key={c} d={spectrum(out[c].spectrum)} fill={on ? SECONDARY : SECONDARY_OFF} stroke={line} strokeWidth={2.5 * SCALE} strokeLinejoin="round" />)}</>
  }

  if (view === 1) {
    // The left channel's frame, then the right's over it, each filled to the centre.
    const mid = H / 2, h = K2D_HEIGHT * H
    return <>{[0, 1].map((c) => {
      const d = framePath(out[c].wave, (t) => t * W, (_t, v) => mid - v * h)
      return <g key={c}>
        <path d={`${d}L${W} ${mid}L0 ${mid}Z`} fill={on ? SECONDARY : SECONDARY_OFF} />
        <path d={d} fill="none" stroke={line} strokeWidth={LINE} strokeLinejoin="round" />
      </g>
    })}</>
  }

  // 3D: each channel's frame along its place in the stack (left, then right), then Vital's end caps
  // (drawPosition: right, then left).
  const place = (c: 0 | 1) => {
    const ft = Math.max(0, Math.min(1, frame[c] / LAST_FRAME))
    const sx = (START_X + FRAME_RANGE_X * ft) * W, sy = (START_Y + FRAME_RANGE_Y * ft) * H
    const x = (t: number) => sx + t * WAVE_RANGE_X * W
    const y = (t: number, v: number) => sy - v * WAVE_HEIGHT * H + t * WAVE_RANGE_Y * H
    return { x, y, d: framePath(out[c].wave, x, y) }
  }
  const lanes = [place(0), place(1)] as const
  const cap = 1.8 * LINE
  return <>
    <defs>
      {background?.map((p, k) => (
        <linearGradient key={k} id={`${gradient}${k}`} gradientUnits="userSpaceOnUse" x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2}>
          <stop offset="0" stopColor={p.color} /><stop offset="1" stopColor={p.dip} />
        </linearGradient>
      ))}
    </defs>
    {background?.map((p, k) => <path key={k} d={p.d} fill="none" stroke={`url(#${gradient}${k})`} strokeWidth={SCALE} strokeLinejoin="bevel" />)}
    {lanes.map((l, c) => <path key={c} d={l.d} fill="none" stroke={line} strokeWidth={LINE} strokeLinejoin="round" />)}
    {([1, 0] as const).map((c) => {
      const { x, y } = lanes[c], wave = out[c].wave
      return <g key={c}>
        <circle cx={x(0)} cy={y(0, wave[0])} r={cap / 2} fill={line} />
        <circle cx={x(1)} cy={y(1, wave[wave.length - 1])} r={cap / 2} fill={line} />
      </g>
    })}
  </>
}
