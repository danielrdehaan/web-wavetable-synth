import { useEffect, useId, useRef, useState } from 'react'
import { useVital } from '../sim/vital/ctx'
import { sk } from '../sim/vital/skin'
import { useEngine } from './EngineContext'
import { useLanesOr, useStatusLanes } from './status'

// The flanger and phaser displays as Vital draws them, from the engine:
// - Flanger (flanger_section.cpp FlangerResponse): the comb shader (cutoff 0, resonance 0.5 + 0.5 ×
//   feedback, blend 1, drive 1, alternate period 2) over 512 points from x = −4 to 2 (three widths), slid
//   sideways by the MIDI note of the engine's live flanger_delay_frequency (× width / 128 − 1.5 × width).
// - Phaser (phaser_section.cpp PhaserResponse): the phaser shader at the engine's live phaser_cutoff,
//   with feedback, blend and mix, over 256 points.
// Each draws the right channel (Widget Primary/Secondary 2) under the left (… 1), filled to the bottom,
// from the skin section it's drawn in (the Flanger or Phaser panel): lines Widget Line Width wide, fills
// faded by Widget Fill Fade; off, the left in Widget Primary Disabled over Widget Secondary Disabled at 60 %.

const SCALE = 1000 / 1440
const FADE = 'calc(1 - var(--sk-widget-fill-fade))'
const OFF_FILL = 'rgb(from var(--sk-widget-secondary-disabled) r g b / calc(alpha * 0.6))'

const midiOf = (hz: number) => 12 * Math.log2(Math.max(hz, 1e-6) / 8.1757989156)

/** A control's modulated [left, right], else its value in both. */
function useValue(id: string): [number, number] {
  const api = useVital()
  return useLanesOr(id, api.v[id] ?? 0)
}

export function ModFxCurve({ kind, w, h, on, px = 1 }: { kind: 'flanger' | 'phaser'; w: number; h: number; on: boolean; px?: number }) {
  const { engine } = useEngine()
  const api = useVital()
  const feedback = useValue(`${kind}_feedback`)
  const mix = useValue(`${kind}_dry_wet`)
  const blend = useValue('phaser_blend')
  const lanes = useStatusLanes(kind === 'flanger' ? 'flanger_delay_frequency' : 'phaser_cutoff')
  const center = api.v[`${kind}_center`] ?? 64
  const [curves, setCurves] = useState<Float32Array[] | null>(null)
  const busy = useRef(false), again = useRef(false)
  const args = { kind, feedback, mix, blend, lanes }
  const key = JSON.stringify([feedback, mix, blend])
  const latest = useRef(args)
  latest.current = args
  useEffect(() => {
    if (!engine) return
    const run = () => {
      if (busy.current) { again.current = true; return }
      busy.current = true
      const a = latest.current
      const lane = (i: number) => {
        const x = a.lanes?.[i]
        return x !== undefined && Number.isFinite(x) ? x : null
      }
      const calls = ([1, 0] as const).map((i) => a.kind === 'flanger'
        ? engine.filterResponse({ model: 6, style: 0, cutoff: 0, resonance: a.feedback[i] * 0.5 + 0.5, blend: 1, transpose: 0, formantX: 0.5, formantY: 0.5, mix: a.mix[i], combPeriod: 2, driveOverride: 1, xMin: -4, xMax: 2 })
        : engine.filterResponse({ model: 7, style: 0, cutoff: lane(i) ?? center, resonance: a.feedback[i], blend: a.blend[i], transpose: 0, formantX: 0.5, formantY: 0.5, mix: a.mix[i] }))
      void Promise.all(calls).then((r) => {
        busy.current = false
        setCurves(r)
        if (again.current) { again.current = false; run() }
      })
    }
    run()
  }, [engine, kind, key, lanes, center]) // eslint-disable-line react-hooks/exhaustive-deps
  const gradient = useId()
  if (!curves) return null
  const draw = (data: Float32Array, lane: number) => {
    const points = kind === 'flanger' ? 512 : 256
    let d = ''
    for (let i = 0; i < points; i++) {
      const j = Math.round((i / (points - 1)) * (data.length - 1))
      let x = (i / (points - 1)) * w
      if (kind === 'flanger') {
        const hz = lanes?.[lane]
        const midi = hz !== undefined && Number.isFinite(hz) ? midiOf(hz) : center
        x = 3 * w * (i / (points - 1)) + midi * (w / 128) - 1.5 * w
      }
      const y = (h / 2) * (1 - data[j])
      d += `${i ? 'L' : 'M'}${x.toFixed(2)} ${Math.max(-2, Math.min(h + 2, y)).toFixed(2)}`
    }
    return d
  }
  const right = draw(curves[0], 1), left = draw(curves[1], 0)
  const closed = (d: string) => `${d}L${kind === 'flanger' ? 2 * w : w} ${h + 2}L${kind === 'flanger' ? -w : 0} ${h + 2}Z`
  const width = `calc(var(--sk-widget-line-width) * ${+(SCALE * px).toFixed(5)})`
  const rf = on ? sk('Widget Secondary 2') : OFF_FILL, lf = on ? sk('Widget Secondary 1') : OFF_FILL
  return (
    <>
      <defs>
        <linearGradient id={`${gradient}r`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: rf }} /><stop offset="1" style={{ stopColor: rf, stopOpacity: FADE }} /></linearGradient>
        <linearGradient id={`${gradient}l`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: lf }} /><stop offset="1" style={{ stopColor: lf, stopOpacity: FADE }} /></linearGradient>
      </defs>
      {on && <><path d={closed(right)} fill={`url(#${gradient}r)`} /><path d={right} fill="none" style={{ stroke: sk('Widget Primary 2'), strokeWidth: width }} /></>}
      <path d={closed(left)} fill={`url(#${gradient}l)`} />
      <path d={left} fill="none" style={{ stroke: sk(on ? 'Widget Primary 1' : 'Widget Primary Disabled'), strokeWidth: width }} />
    </>
  )
}
