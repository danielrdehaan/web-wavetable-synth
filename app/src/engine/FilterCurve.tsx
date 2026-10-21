import { useEffect, useId, useRef, useState } from 'react'
import { useVital } from '../sim/vital/ctx'
import { useEngine } from './EngineContext'
import { useLanesOr } from './status'

// A filter's response as Vital draws it (filter_response.cpp), computed by the engine (vs_filter_response:
// the model's own setupFilter, then its response shader ported): 512 points from MIDI note 8 to 137,
// −30 … 20 dB over the height, filled to the bottom (Widget Fill Center −1) in the Filter skin's colours.
// It reads the controls' modulated values (getOutputsTotal: mono totals, plus poly ones while a voice
// plays), per channel, so it moves with the modulation; on the formant model transpose, resonance and blend come from the formant controls.

const SCALE = 1000 / 1440 // the drawing's 1000-wide stage vs Vital's 1440 pt window
// Widget Primary 1 / 2 and Secondary 1 / 2 of the Filter and Effects Filter skins: the left channel's
// line and fill, the right's.
const SKINS = {
  filter: { l: '#ffb74d', r: '#ff8180', lf: 'rgba(255,183,77,0.39)', rf: 'rgba(255,138,128,0.39)' },
  fx: { l: '#ffb74d', r: '#ff8180', lf: 'rgba(255,183,77,0.39)', rf: 'rgba(255,129,128,0.39)' },
}
const LINE_OFF = '#4c4f52', FILL_OFF = 'rgba(102,102,102,0.13)' // Widget Primary / Secondary Disabled
const FILL_FADE = 0.3 // Widget Fill Fade

type Lanes = [number, number]

/** FilterResponse::getOutputsTotal: the modulated lanes while the section is on, else the control's value. */
function useValue(id: string, fallback: number, on: boolean): Lanes {
  const api = useVital()
  const lanes = useLanesOr(id, api.v[id] ?? fallback)
  return on ? lanes : [api.v[id] ?? fallback, api.v[id] ?? fallback]
}

/** Draws the right channel's response (lane 1) under the left's (lane 0), as drawFilterResponse does;
 *  while the filter is off only the left one, in the disabled colours. */
export function FilterCurve({ pre, w, h, on, px = 1, fx = false }: { pre: string; w: number; h: number; on: boolean; px?: number; fx?: boolean }) {
  const { engine } = useEngine()
  const api = useVital()
  const model = Math.round(api.v[`${pre}_model`] ?? 0), style = Math.round(api.v[`${pre}_style`] ?? 0)
  const formant = model === 5
  const cutoff = useValue(`${pre}_cutoff`, 60, on)
  const mix = useValue(`${pre}_mix`, 1, on)
  const resonance = useValue(formant ? `${pre}_formant_resonance` : `${pre}_resonance`, 0.5, on)
  const blend = useValue(formant ? `${pre}_formant_spread` : `${pre}_blend`, 0, on)
  const transpose = useValue(formant ? `${pre}_formant_transpose` : `${pre}_blend_transpose`, 0, on)
  const formantX = useValue(`${pre}_formant_x`, 0.5, on)
  const formantY = useValue(`${pre}_formant_y`, 0.5, on)
  const [data, setData] = useState<Float32Array[] | null>(null)
  const busy = useRef(false), again = useRef(false)
  const args = { model, style, cutoff, resonance, blend, transpose, formantX, formantY, mix }
  const latest = useRef(args)
  latest.current = args
  const key = JSON.stringify(args)
  useEffect(() => {
    if (!engine) return
    const run = () => {
      if (busy.current) { again.current = true; return }
      busy.current = true
      const a = latest.current
      const lane = (i: 0 | 1) => ({ model: a.model, style: a.style, cutoff: a.cutoff[i], resonance: a.resonance[i], blend: a.blend[i], transpose: a.transpose[i], formantX: a.formantX[i], formantY: a.formantY[i], mix: a.mix[i] })
      void Promise.all([engine.filterResponse(lane(0)), engine.filterResponse(lane(1))]).then((r) => {
        busy.current = false
        setData(r)
        if (again.current) { again.current = false; run() }
      })
    }
    run()
  }, [engine, key]) // eslint-disable-line react-hooks/exhaustive-deps
  const gradient = useId()
  if (!data) return null
  const path = (curve: Float32Array) => {
    let d = ''
    for (let i = 0; i < curve.length; i++) {
      const y = (h / 2) * (1 - curve[i])
      d += `${i ? 'L' : 'M'}${((i / (curve.length - 1)) * w).toFixed(2)} ${Math.max(-2, Math.min(h + 2, y)).toFixed(2)}`
    }
    return d
  }
  const skin = SKINS[fx ? 'fx' : 'filter']
  const layer = (d: string, line: string, fill: string, id: string) => (
    <>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={fill} />
          <stop offset="1" stopColor={fill} stopOpacity={1 - FILL_FADE} />
        </linearGradient>
      </defs>
      <path d={`${d}L${w} ${h + 2}L0 ${h + 2}Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={line} strokeWidth={2 * SCALE * px} strokeLinejoin="round" />
    </>
  )
  return (
    <>
      {on && layer(path(data[1]), skin.r, skin.rf, `${gradient}r`)}
      {layer(path(data[0]), on ? skin.l : LINE_OFF, on ? skin.lf : FILL_OFF, `${gradient}l`)}
    </>
  )
}
