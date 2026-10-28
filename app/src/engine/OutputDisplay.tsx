import { useEffect, useId, useRef } from 'react'
import type { SpectrogramSpec } from '../../../web/engine-client.js'
import { sk, useSkinColors, useSkinValues } from '../sim/vital/skin'
import { useEngine } from './EngineContext'

// Vital's output displays (oscilloscope.cpp), drawn from the engine: the Oscilloscope reads SynthBase's
// oscilloscope memory (a window restarted every period of the last note played) and fills to its centre
// line; a Spectrogram reads the last 2^14 samples of the output (or the equalizer's), decays toward each
// new frame and fills to the bottom. Both draw the right channel, then the left, as a Widget Primary 1
// line over a Widget Primary 2 fill faded by Widget Fill Fade toward the fill centre (the oscilloscope's
// at Widget Fill Center, the spectrogram's at the bottom). The colours and values are the skin's as the
// display's own element sees them, so it follows the section it sits in (Header, Advanced, …), unless
// `skin` gives them. The oscilloscope's line is Widget Line Width points wide, the spectrogram's 2 points.
// Drawn in the SVG's own units (`w` × `h`): its own <svg> that the parent sizes, or with `group` a <g>
// inside the parent's SVG (the EQ draws its spectrogram behind its curve).

export interface OutputSkin { line: string; fill: string; fillFade: number }

const COLORS = ['Widget Primary 1', 'Widget Primary 2'] as const
const VALUES = ['Widget Line Width', 'Widget Fill Fade', 'Widget Fill Center'] as const

const SVG_STYLE = { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' } as const
const GRID_STYLE = { fill: sk('Lighten Screen'), fillOpacity: 0.5 }

export function OutputDisplay({ spectrogram, w, h, pt, lineWidth, skin, group = false }: {
  /** null for the oscilloscope. */
  spectrogram: SpectrogramSpec | null
  w: number
  h: number
  /** One Vital point in the SVG's units: the line is Widget Line Width (oscilloscope) or 2 (spectrogram)
   *  of them. */
  pt?: number
  /** A fixed line width in the SVG's units instead of the skin's (when `pt` isn't given). */
  lineWidth?: number
  /** Colours instead of the skin's. */
  skin?: OutputSkin
  group?: boolean
}) {
  const { engine } = useEngine()
  const el = useRef<SVGSVGElement & SVGGElement>(null)
  const colors = useSkinColors(el, COLORS)
  const values = useSkinValues(el, VALUES)
  const line = skin?.line ?? colors['Widget Primary 1']
  const fill = skin?.fill ?? colors['Widget Primary 2']
  const fillFade = skin?.fillFade ?? values['Widget Fill Fade']
  const width = pt !== undefined ? (spectrogram ? 2 : values['Widget Line Width']) * pt : (lineWidth ?? 1)
  // OpenGlLineRenderer's fill centre: −1 the bottom, 0 the middle, 1 the top.
  const centre = spectrogram ? 1 : Math.max(0, Math.min(1, (1 - values['Widget Fill Center']) / 2))
  const lines = [useRef<SVGPathElement>(null), useRef<SVGPathElement>(null)]
  const fills = [useRef<SVGPathElement>(null), useRef<SVGPathElement>(null)]
  const key = JSON.stringify(spectrogram)
  useEffect(() => {
    if (!engine) return
    let raf = 0, busy = false, live = true
    const spec = spectrogram
    const draw = () => {
      raf = requestAnimationFrame(draw)
      if (busy) return
      busy = true
      void engine.scope(spec).then((data) => {
        busy = false
        if (!live) return
        const n = spec ? 300 : 512
        for (const c of [1, 0]) {
          let d = ''
          for (let i = 0; i < n; i++) {
            const v = data[c * n + i]
            const y = spec ? h - v * h : (1 - v) * (h / 2)
            d += `${i ? 'L' : 'M'}${((i / (n - 1)) * w).toFixed(2)} ${Math.max(-2, Math.min(h + 2, y)).toFixed(2)}`
          }
          const base = spec ? h + 2 : centre * h
          lines[c].current?.setAttribute('d', d)
          fills[c].current?.setAttribute('d', `${d}L${w} ${base}L0 ${base}Z`)
        }
      })
    }
    draw()
    return () => { live = false; cancelAnimationFrame(raf) }
  }, [engine, key, w, h, centre]) // eslint-disable-line react-hooks/exhaustive-deps
  const gradient = useId()
  // The fill at full strength at the edges, times 1 − Widget Fill Fade at the centre (withMultipliedAlpha).
  const full = { stopColor: fill }, faded = { stopColor: fill, stopOpacity: 1 - fillFade }
  const body = (
    <>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2={h} gradientUnits="userSpaceOnUse">
          {spectrogram
            ? <><stop offset="0" style={full} /><stop offset="1" style={faded} /></>
            : <><stop offset="0" style={full} /><stop offset={centre} style={faded} /><stop offset="1" style={full} /></>}
        </linearGradient>
      </defs>
      {[1, 0].map((c) => (
        <g key={c}>
          <path ref={fills[c]} fill={`url(#${gradient})`} />
          <path ref={lines[c]} fill="none" style={{ stroke: line }} strokeWidth={width} strokeLinejoin="round" />
        </g>
      ))}
    </>
  )
  return group
    ? <g ref={el}>{body}</g>
    : <svg ref={el} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={SVG_STYLE}>{body}</svg>
}

/** Spectrogram::paintBackground's grid: a line at every 1–9 × 10^n Hz from the minimum frequency up,
 *  the decades drawn twice, in Lighten Screen at half strength (its section's). */
export function SpectrogramGrid({ w, h, minFreq = 9.2, maxFreq = 21000, px = 1, group = false }: {
  w: number; h: number; minFreq?: number; maxFreq?: number
  /** One Vital pixel in the SVG's units (the line width). */
  px?: number
  group?: boolean
}) {
  const maxOctave = Math.log2(maxFreq / minFreq)
  const xs: { x: number; decade: boolean }[] = []
  let frequency = 0, increment = 1
  while (frequency < maxFreq) {
    let x = 0
    for (let i = 0; i < 10; i++) {
      frequency += increment
      x = Math.round((Math.log2(frequency / minFreq) / maxOctave) * w)
      xs.push({ x, decade: false })
    }
    xs.push({ x, decade: true })
    increment *= 10
  }
  const lines = xs.filter(({ x }) => x >= 0 && x <= w).map(({ x }, i) => <rect key={i} x={x} y={0} width={px} height={h} style={GRID_STYLE} />)
  return group ? <g>{lines}</g> : <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={SVG_STYLE}>{lines}</svg>
}
