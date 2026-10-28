import { useEffect, useId, useRef, useState } from 'react'
import { useVital } from '../sim/vital/ctx'
import { PARAMS } from '../sim/vital/params'
import { sk } from '../sim/vital/skin'
import { useEngine } from './EngineContext'
import { useLiveLanes } from './status'

// The equalizer response as Vital draws it (equalizer_response.cpp), computed by the engine
// (vs_eq_response): low / band / high DigitalSvf filters at 100 kHz, 128 points, the gain range plus a
// buffer (20 % for the Equalizer, 0.4 for the Reverb) over the height, filled to the 0 dB line. Values
// are the controls' modulated ones while the engine reports them (getOutputTotal). The Equalizer's
// three nodes sit at each band's cutoff and gain.

export interface EqBandIds { cutoff: string; resonance?: string; gain: string; mode?: string }
const SCALE = 1000 / 1440
/** The fill's opacity away from the line: 1 − Widget Fill Fade. */
const FADE = 'calc(1 - var(--sk-widget-fill-fade))'
const OFF_FILL = 'rgb(from var(--sk-widget-secondary-disabled) r g b / calc(alpha * 0.6))'

/** A control's modulated left and right values while modulated, else its value; 0 when the band has no
 *  such control. */
function useValue(id: string | undefined): [number, number] {
  const api = useVital()
  const live = useLiveLanes(id ?? '')
  if (!id) return [0, 0]
  const base = api.v[id] ?? PARAMS[id]?.def ?? 0
  return live ?? [base, base]
}

/** The dB axis: the gain control's range widened by `buffer` of it on each side (setLowSliders). */
export function eqAxis(gainId: string, buffer: number) {
  const d = PARAMS[gainId]
  const range = d.max - d.min
  return { min: d.min - range * buffer, max: d.max + range * buffer }
}

/** One band's modulated cutoff, resonance and gain, and whether its pass mode is on. */
function useBand(b: EqBandIds | null) {
  const api = useVital()
  return {
    cutoff: useValue(b?.cutoff), resonance: useValue(b?.resonance), gain: useValue(b?.gain),
    pass: !!b?.mode && Math.round(api.v[b.mode] ?? 0) === 1,
  }
}

/** The equalizer's three bands (low, band, high; a missing one is null). */
export function useEqResponse(bands: [EqBandIds | null, EqBandIds | null, EqBandIds | null]) {
  const { engine } = useEngine()
  const vals = [useBand(bands[0]), useBand(bands[1]), useBand(bands[2])]
  const [data, setData] = useState<Float32Array[] | null>(null)
  const busy = useRef(false), again = useRef(false), latest = useRef(vals)
  latest.current = vals
  const key = JSON.stringify(vals)
  useEffect(() => {
    if (!engine) return
    const run = () => {
      if (busy.current) { again.current = true; return }
      busy.current = true
      const lane = (i: 0 | 1) => latest.current.map((b) => ({ cutoff: b.cutoff[i], resonance: b.resonance[i], gain: b.gain[i], pass: b.pass }))
      void Promise.all([engine.eqResponse(lane(0)), engine.eqResponse(lane(1))]).then((r) => {
        busy.current = false
        setData(r)
        if (again.current) { again.current = false; run() }
      })
    }
    run()
  }, [engine, key])
  return data
}

/** The left channel's response (`data[0]`, Widget Primary / Secondary 1) over the right's (`data[1]`,
 *  … 2), the right only while on (EqualizerResponse::render); off, the left in Widget Primary Disabled
 *  over Widget Secondary Disabled at 60 %. Lines are Widget Line Width wide and fills fade by Widget Fill
 *  Fade, from the skin section the curve is drawn in. */
export function EqCurve({ data, w, h, axis, on, px = 1 }: {
  data: Float32Array[]; w: number; h: number; axis: { min: number; max: number }; on: boolean
  /** Drawing units per stage px (2 inside the effect screens' frame-unit SVGs), for the line width. */
  px?: number
}) {
  const gradient = useId()
  const range = axis.max - axis.min
  const y = (db: number) => (axis.max - db) * (h / range)
  const path = (curve: Float32Array) => {
    let d = ''
    for (let i = 0; i < curve.length; i++) d += `${i ? 'L' : 'M'}${((i / (curve.length - 1)) * w).toFixed(2)} ${Math.max(-2, Math.min(h + 2, y(curve[i]))).toFixed(2)}`
    return d
  }
  const zero = y(0)
  const layer = (d: string, stroke: string, f: string, id: string) => (
    <>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: f }} /><stop offset="1" style={{ stopColor: f, stopOpacity: FADE }} /></linearGradient>
      </defs>
      <path d={`${d}L${w} ${zero}L0 ${zero}Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" style={{ stroke, strokeWidth: `calc(var(--sk-widget-line-width) * ${+(SCALE * px).toFixed(5)})` }} strokeLinejoin="round" />
    </>
  )
  return (
    <>
      {on && layer(path(data[1]), sk('Widget Primary 2'), sk('Widget Secondary 2'), `${gradient}r`)}
      {layer(path(data[0]), sk(on ? 'Widget Primary 1' : 'Widget Primary Disabled'), on ? sk('Widget Secondary 1') : OFF_FILL, `${gradient}l`)}
    </>
  )
}
