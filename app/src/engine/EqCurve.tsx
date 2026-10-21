import { useEffect, useId, useRef, useState } from 'react'
import { useVital } from '../sim/vital/ctx'
import { PARAMS } from '../sim/vital/params'
import { useEngine } from './EngineContext'
import { useLiveLanes } from './status'

// The equalizer response as Vital draws it (equalizer_response.cpp), computed by the engine
// (vs_eq_response): low / band / high DigitalSvf filters at 100 kHz, 128 points, the gain range plus a
// buffer (20 % for the Equalizer, 0.4 for the Reverb) over the height, filled to the 0 dB line. Values
// are the controls' modulated ones while the engine reports them (getOutputTotal). The Equalizer's
// three nodes sit at each band's cutoff and gain.

export interface EqBandIds { cutoff: string; resonance?: string; gain: string; mode?: string }
const SCALE = 1000 / 1440

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
 *  … 2), the right only while on (EqualizerResponse::render). */
export function EqCurve({ data, w, h, axis, line, fill, line2 = line, fill2 = fill, on, px = 1 }: {
  data: Float32Array[]; w: number; h: number; axis: { min: number; max: number }; line: string; fill: string; line2?: string; fill2?: string; on: boolean
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
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={f} /><stop offset="1" stopColor={f} stopOpacity={0.7} /></linearGradient>
      </defs>
      <path d={`${d}L${w} ${zero}L0 ${zero}Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={stroke} strokeWidth={2 * SCALE * px} strokeLinejoin="round" />
    </>
  )
  return (
    <>
      {on && layer(path(data[1]), line2, fill2, `${gradient}r`)}
      {layer(path(data[0]), on ? line : '#666666', on ? fill : 'rgba(76,76,76,0.6)', `${gradient}l`)}
    </>
  )
}
