import { useLayoutEffect, useState } from 'react'
import { useVital } from './ctx'
import { DEFAULT_ORDER, FX } from './fxMath'
import { LINEAR } from './line'
import { remapKey } from './MatrixPage'
import { DESTINATIONS } from './params'
import type { Placed } from './parts'
import type { Line } from './line'

// The signal flow drawn over a set of parts, from the patch as it is: each oscillator and the sampler to
// where its destination sends it (a filter, both, the effects, one effect, or straight out), a filter
// fed into the other (FIL1 / FIL2), the filters into the effects, the switched-on effects in chain order,
// and the last of them (or a direct-out source) to the output; then each modulation routing from its
// source to the control it moves, through the remap part when that routing's curve isn't linear.
// Only what's shown is drawn: a connection needs both of its ends among the parts.

const AUDIO = '#aa88ff', SAMPLE = '#ffb74d', MOD = '#1de9b6', OUT = '#e8e8e8'
const FX_PART = (key: string) => (key === 'filter' ? 'fxfilter' : key)

interface Edge { from: string; to: string; color: string; label?: string; dim?: boolean; dashed?: boolean }
interface Point { x: number; y: number }
interface ModLine { from: Point; via?: { in: Point; out: Point }; to: Point; dim?: boolean }

/** A modulation source's part: lfo_1 → lfo1, env_2 → env2, random_1 → random1. */
const sourcePart = (src: string) => src.replace(/^(lfo|env|random)_(\d)$/, '$1$2')

export function FlowLayer({ placed, w, h }: { placed: Placed[]; w: number; h: number }) {
  const api = useVital()
  const v = api.v
  const has = (id: string) => placed.some((p) => p.id === id)
  const box = (id: string) => placed.find((p) => p.id === id)

  // Audio: which shown part each source and stage feeds.
  const edges: Edge[] = []
  const order = (api.ui.fxOrder as number[] | undefined) ?? DEFAULT_ORDER
  const chain = order.map((i) => FX[i]).filter((fx) => (v[fx.on] ?? 0) >= 0.5 && has(FX_PART(fx.key))).map((fx) => FX_PART(fx.key))
  const effectsIn = has('effects') ? 'effects' : chain[0] ?? null
  const fxTail = has('effects') ? 'effects' : chain[chain.length - 1] ?? null
  const target = (dest: number): string[] => {
    if (dest === 0) return ['filter1']
    if (dest === 1) return ['filter2']
    if (dest === 2) return ['filter1', 'filter2']
    if (dest === 3) return effectsIn ? [effectsIn] : ['output']
    if (dest === 4) return ['output']
    const fx = FX[dest - 5]
    return fx && has(FX_PART(fx.key)) ? [FX_PART(fx.key)] : effectsIn ? [effectsIn] : ['output']
  }
  const sources: [string, string, string, string][] = [
    ['osc1', 'osc_1_destination', 'osc_1_on', AUDIO], ['osc2', 'osc_2_destination', 'osc_2_on', AUDIO],
    ['osc3', 'osc_3_destination', 'osc_3_on', AUDIO], ['sampler', 'sample_destination', 'sample_on', SAMPLE],
  ]
  for (const [part, dest, on, color] of sources) {
    if (!has(part)) continue
    const d = Math.round(v[dest] ?? 0)
    for (const to of target(d)) edges.push({ from: part, to, color, label: DESTINATIONS[d], dim: (v[on] ?? 0) < 0.5, dashed: d === 4 })
  }
  for (const k of [1, 2]) {
    const part = `filter${k}`
    if (!has(part)) continue
    const on = (v[`filter_${k}_on`] ?? 0) >= 0.5
    // FIL1 into filter 2 (filter_2_filter_input), or FIL2 into filter 1.
    const other = k === 1 ? 2 : 1
    if ((v[`filter_${other}_filter_input`] ?? 0) >= 0.5 && has(`filter${other}`)) edges.push({ from: part, to: `filter${other}`, color: AUDIO, label: `FIL${k}`, dim: !on })
    edges.push({ from: part, to: effectsIn ?? 'output', color: AUDIO, dim: !on })
  }
  if (!has('effects')) for (let i = 0; i + 1 < chain.length; i++) edges.push({ from: chain[i], to: chain[i + 1], color: OUT })
  if (fxTail) edges.push({ from: fxTail, to: 'output', color: OUT })
  const shown = edges.filter((e) => has(e.from) && has(e.to) && e.from !== e.to)
    .filter((e, i, all) => all.findIndex((o) => o.from === e.from && o.to === e.to) === i)

  // Ports: an edge running rightwards leaves its source's right edge and reaches its target's left; one
  // to a part below and not to the right (the next effect down the chain) goes bottom to top. Each
  // side's ports are spread out in the order of the parts at their other ends, so lines don't cross.
  const across = (e: Edge) => box(e.to)!.x >= box(e.from)!.x + box(e.from)!.w * 0.5
  const outs = new Map<string, Edge[]>(), ins = new Map<string, Edge[]>()
  for (const e of shown) {
    if (!across(e)) continue
    outs.set(e.from, [...(outs.get(e.from) ?? []), e]); ins.set(e.to, [...(ins.get(e.to) ?? []), e])
  }
  const centreY = (id: string) => { const p = box(id)!; return p.y + p.h / 2 }
  for (const list of outs.values()) list.sort((a, b) => centreY(a.to) - centreY(b.to))
  for (const list of ins.values()) list.sort((a, b) => centreY(a.from) - centreY(b.from))
  const port = (id: string, e: Edge, side: 'out' | 'in'): Point => {
    const p = box(id)!
    if (!across(e)) return { x: p.x + p.w / 2, y: side === 'out' ? p.y + p.h : p.y }
    const list = (side === 'out' ? outs : ins).get(id) ?? [e]
    const k = list.indexOf(e)
    return { x: side === 'out' ? p.x + p.w : p.x, y: p.y + (p.h * (k + 1)) / (list.length + 1) }
  }

  // Modulation lines from the controls' places in the drawing, measured after it renders.
  const [mods, setMods] = useState<ModLine[]>([])
  const key = JSON.stringify([api.mods.map((m) => [m.src, m.dst, m.bypass, remapKey(m)]), api.mods.map((m) => api.ui[remapKey(m)] ? 1 : 0), api.ui.lfo, api.ui.env, api.ui.rand, placed.map((p) => [p.id, p.x, p.y])])
  useLayoutEffect(() => {
    const root = api.rootRef.current
    if (!root) return
    const center = (el: Element | null): Point | null => {
      if (!el) return null
      const r = el.getBoundingClientRect(), s = api.toStage(r.left + r.width / 2, r.top + r.height / 2)
      return { x: s.x * 2, y: s.y * 2 }
    }
    const remap = box('remap')
    const lines: ModLine[] = []
    for (const m of api.mods) {
      // From the source's part (its top edge, toward the controls above), else its button.
      const part = box(sourcePart(m.src))
      const from = part ? { x: part.x + part.w * 0.75, y: part.y } : center(root.querySelector(`[data-src="${m.src}"]`))
      const to = center(root.querySelector(`[data-param="${m.dst}"]`))
      if (!from || !to) continue
      const curve = api.ui[remapKey(m)] as Line | undefined
      const linear = !curve || JSON.stringify(curve.pts) === JSON.stringify(LINEAR.pts) && curve.pw.every((x) => !x)
      // Through the remap editor: in at its left edge, out at its top.
      const via = remap && !linear ? { in: { x: remap.x, y: remap.y + remap.h / 2 }, out: { x: remap.x + remap.w / 2, y: remap.y } } : undefined
      lines.push({ from: via && part ? { x: part.x + part.w, y: part.y + part.h / 2 } : from, to, dim: m.bypass, via })
    }
    setMods(lines)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const curve = (a: Point, b: Point) => {
    const d = Math.max(60, Math.abs(b.x - a.x) / 2)
    return `M ${a.x} ${a.y} C ${a.x + d} ${a.y}, ${b.x - d} ${b.y}, ${b.x} ${b.y}`
  }
  const bend = (a: Point, b: Point) => {
    const my = (a.y + b.y) / 2
    return `M ${a.x} ${a.y} C ${a.x} ${my}, ${b.x} ${my}, ${b.x} ${b.y}`
  }
  const down = (a: Point, b: Point) => {
    const d = Math.max(40, Math.abs(b.y - a.y) / 2)
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + d}, ${b.x} ${b.y - d}, ${b.x} ${b.y}`
  }
  /** A point a fifth of the way along `curve` (where its label goes, clear of the parts at either end). */
  const along = (a: Point, b: Point, t = 0.2) => {
    const d = Math.max(60, Math.abs(b.x - a.x) / 2), u = 1 - t
    return { x: u * u * u * a.x + 3 * u * u * t * (a.x + d) + 3 * u * t * t * (b.x - d) + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t * t * t * b.y }
  }
  const viaRemap = new Set<string>()
  return (
    <svg className="vt-flow" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        {[AUDIO, SAMPLE, OUT, MOD].map((c) => (
          <marker key={c} id={`vt-arrow-${c.slice(1)}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 Z" fill={c} />
          </marker>
        ))}
      </defs>
      {shown.map((e) => {
        const a = port(e.from, e, 'out'), b = port(e.to, e, 'in')
        const lab = along(a, b)
        return (
          <g key={`${e.from}>${e.to}`} opacity={e.dim ? 0.3 : 1}>
            <path d={across(e) ? curve(a, b) : down(a, b)} fill="none" stroke={e.color} strokeWidth={5} strokeDasharray={e.dashed ? '16 10' : undefined} markerEnd={`url(#vt-arrow-${e.color.slice(1)})`} />
            {e.label && across(e) && <text x={lab.x + 8} y={lab.y - 12} fill={e.color} fontSize={20} textAnchor="start" className="vt-flowlabel">{e.label}</text>}
          </g>
        )
      })}
      {mods.map((l, i) => {
        const first = l.via && !viaRemap.has(`${l.from.x},${l.from.y}`)
        if (l.via) viaRemap.add(`${l.from.x},${l.from.y}`)
        return (
          <g key={i} opacity={l.dim ? 0.3 : 0.9}>
            {l.via ? <>
              {first && <path d={curve(l.from, l.via.in)} fill="none" stroke={MOD} strokeWidth={4} strokeDasharray="10 8" markerEnd={`url(#vt-arrow-${MOD.slice(1)})`} />}
              <path d={bend(l.via.out, l.to)} fill="none" stroke={MOD} strokeWidth={4} strokeDasharray="10 8" markerEnd={`url(#vt-arrow-${MOD.slice(1)})`} />
            </> : <path d={bend(l.from, l.to)} fill="none" stroke={MOD} strokeWidth={4} strokeDasharray="10 8" markerEnd={`url(#vt-arrow-${MOD.slice(1)})`} />}
            <circle cx={l.to.x} cy={l.to.y} r={9} fill="none" stroke={MOD} strokeWidth={3} />
          </g>
        )
      })}
    </svg>
  )
}
