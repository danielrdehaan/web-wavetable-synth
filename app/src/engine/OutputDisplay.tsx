import { useEffect, useId, useRef } from 'react'
import type { SpectrogramSpec } from '../../../web/engine-client.js'
import { useEngine } from './EngineContext'

// Vital's output displays (oscilloscope.cpp), drawn from the engine: the Oscilloscope reads SynthBase's
// oscilloscope memory (a window restarted every period of the last note played) and fills to its centre
// line; a Spectrogram reads the last 2^14 samples of the output (or the equalizer's), decays toward each
// new frame and fills to the bottom. Both draw the right channel, then the left, as a Widget Primary 1
// line over a Widget Primary 2 fill faded by Widget Fill Fade toward the fill centre. Drawn in the
// SVG's own units (`w` × `h`): its own <svg> that the parent sizes, or with `group` a <g> inside the
// parent's SVG (the EQ draws its spectrogram behind its curve).

export interface OutputSkin { line: string; fill: string; fillFade: number }
/** The Header and Advanced skin sections: Widget Primary 1 / Primary 2. */
export const OUTPUT_SKIN: OutputSkin = { line: '#aa88ff', fill: 'rgba(170,136,255,0.39)', fillFade: 0.3 }

const fade = (c: string, mult: number) => {
  const m = c.match(/[\d.]+/g)!.map(Number)
  return `rgba(${m[0]},${m[1]},${m[2]},${((m[3] ?? 1) * mult).toFixed(3)})`
}

const SVG_STYLE = { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' } as const

export function OutputDisplay({ spectrogram, w, h, lineWidth, skin = OUTPUT_SKIN, group = false }: {
  /** null for the oscilloscope. */
  spectrogram: SpectrogramSpec | null
  w: number
  h: number
  /** In the SVG's units. */
  lineWidth: number
  skin?: OutputSkin
  group?: boolean
}) {
  const { engine } = useEngine()
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
          const base = spec ? h + 2 : h / 2
          lines[c].current?.setAttribute('d', d)
          fills[c].current?.setAttribute('d', `${d}L${w} ${base}L0 ${base}Z`)
        }
      })
    }
    draw()
    return () => { live = false; cancelAnimationFrame(raf) }
  }, [engine, key, w, h]) // eslint-disable-line react-hooks/exhaustive-deps
  const gradient = useId()
  const from = fade(skin.fill, 1 - skin.fillFade)
  const body = (
    <>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2={h} gradientUnits="userSpaceOnUse">
          {spectrogram
            ? <><stop offset="0" stopColor={skin.fill} /><stop offset="1" stopColor={from} /></>
            : <><stop offset="0" stopColor={skin.fill} /><stop offset="0.5" stopColor={from} /><stop offset="1" stopColor={skin.fill} /></>}
        </linearGradient>
      </defs>
      {[1, 0].map((c) => (
        <g key={c}>
          <path ref={fills[c]} fill={`url(#${gradient})`} />
          <path ref={lines[c]} fill="none" stroke={skin.line} strokeWidth={lineWidth} strokeLinejoin="round" />
        </g>
      ))}
    </>
  )
  return group ? <g>{body}</g> : <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={SVG_STYLE}>{body}</svg>
}

/** Spectrogram::paintBackground's grid: a line at every 1–9 × 10^n Hz from the minimum frequency up,
 *  the decades drawn twice, in Lighten Screen at half strength. */
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
  const lines = xs.filter(({ x }) => x >= 0 && x <= w).map(({ x }, i) => <rect key={i} x={x} y={0} width={px} height={h} fill="rgba(255,255,255,0.067)" />)
  return group ? <g>{lines}</g> : <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={SVG_STYLE}>{lines}</svg>
}
