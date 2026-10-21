import { useEffect, useMemo, useRef, useState } from 'react'
import { useEngine } from '../engine/EngineContext'
import { noteVelocity } from '../engine/velocity'
import { useVital } from '../sim/vital/ctx'
import { PARAMS } from '../sim/vital/params'
import { remapKey } from '../sim/vital/MatrixPage'
import { loadPresetText } from '../sim/vital/presetIO'
import { allowedOrigin, PROTOCOL_VERSION, targetSelector, type HostMessage, type SynthMessage, type SynthState, type Target } from './protocol'

// The synth's end of the embedding protocol (protocol.ts): it announces itself to the framing page,
// reports its state when it changes, and does what the page asks (load a lesson patch, set controls,
// highlight or lock controls, play notes, pause). It talks only to `host`, and only if that origin is
// allowed; without one it does nothing and the synth is simply shown.

const STATE_EVERY = 100 // ms between state reports at most

/** A message before its version is stamped on. */
type Outgoing = SynthMessage extends infer T ? (T extends unknown ? Omit<T, 'v'> : never) : never

export function EmbedBridge({ host, parts }: { host: string | null; parts: string[] }) {
  const api = useVital()
  const { engine, ctx, status, start } = useEngine()
  const origin = useMemo(() => (host && allowedOrigin(host) ? host : null), [host])
  const [highlights, setHighlights] = useState<Target[]>([])
  const [locks, setLocks] = useState<Target[]>([])
  const [paused, setPaused] = useState(false)
  const pendingPreset = useRef<string | null>(null)
  /** A synth:load is in: the next state report says it's where the lesson starts. */
  const startAck = useRef(false)
  const latest = useRef({ api, engine, ctx })
  latest.current = { api, engine, ctx }

  const send = (msg: Outgoing) => {
    if (origin && window.parent !== window) window.parent.postMessage({ ...msg, v: PROTOCOL_VERSION }, origin)
  }

  const snapshot = (): SynthState => {
    const { api: a } = latest.current
    return {
      values: a.v,
      mods: a.mods.map((m) => {
        const d = PARAMS[m.dst]
        return { src: m.src, dst: m.dst, amount: m.amt, depth: m.amt * (d ? d.max - d.min : 1), bipolar: m.bipolar, stereo: m.stereo, bypass: m.bypass }
      }),
      held: [...a.notes],
      running: status === 'on' && !paused,
      tables: [0, 1, 2].map((i) => (a.ui[`osc_${i + 1}_table`] as string | undefined) ?? 'Init'),
    }
  }

  // Announce, then answer the page.
  useEffect(() => {
    if (!origin) return
    send({ type: 'synth:ready', parts })
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== window.parent) return
      const msg = e.data as HostMessage | null
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || !msg.type.startsWith('synth:')) return
      if (msg.v !== PROTOCOL_VERSION) { send({ type: 'synth:error', message: `protocol version ${String(msg.v)} isn't ${PROTOCOL_VERSION}` }); return }
      const { api: a, engine: en, ctx: c } = latest.current
      switch (msg.type) {
        case 'synth:hello': send({ type: 'synth:ready', parts }); break
        case 'synth:get': send({ type: 'synth:state', state: snapshot() }); break
        case 'synth:set':
          for (const [id, value] of Object.entries(msg.values ?? {})) if (PARAMS[id] && typeof value === 'number') a.set(id, value)
          break
        case 'synth:load': {
          const patch = msg.patch
          startAck.current = true
          if ('preset' in patch) {
            if (en) void loadPresetText(a, en, patch.preset, 'Lesson')
            else pendingPreset.current = patch.preset
            break
          }
          // The init patch, then the lesson's values and routings.
          a.init()
          for (const [id, value] of Object.entries(patch.values ?? {})) if (PARAMS[id] && typeof value === 'number') a.set(id, value)
          const ui: Record<string, unknown> = {}
          ;(patch.mods ?? []).forEach((m, i) => {
            a.addMod(m.src, m.dst)
            a.setMod(i, { amt: Math.max(-1, Math.min(1, m.amount ?? 0)), bipolar: !!m.bipolar })
            const pts = m.remap?.points?.filter((p) => Array.isArray(p) && p.length === 2).map(([x, y]) => [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))] as [number, number])
            if (pts && pts.length >= 2) ui[remapKey(m)] = { name: 'Lesson', pts, pw: pts.map((_, k) => m.remap?.powers?.[k] ?? 0), smooth: !!m.remap?.smooth }
          })
          const order = patch.ui?.fxOrder
          if (Array.isArray(order) && order.length === 9 && [...order].sort().join() === '0,1,2,3,4,5,6,7,8') ui.fxOrder = order
          if (typeof patch.ui?.mxSel === 'number') ui.mxSel = patch.ui.mxSel
          if (Object.keys(ui).length) a.setUi(ui)
          break
        }
        case 'synth:highlight': setHighlights(Array.isArray(msg.targets) ? msg.targets : []); break
        case 'synth:lock': setLocks(Array.isArray(msg.targets) ? msg.targets : []); break
        case 'synth:note': {
          const n = Math.round(msg.note)
          if (!(n >= 0 && n < 128)) break
          if (msg.on) noteVelocity.set(n, Math.max(1 / 127, Math.min(1, msg.velocity ?? 0.8)))
          else noteVelocity.delete(n)
          a.setNote(n, !!msg.on)
          break
        }
        case 'synth:pause': setPaused(true); void c?.suspend(); break
        case 'synth:resume': setPaused(false); void c?.resume(); break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [origin]) // eslint-disable-line react-hooks/exhaustive-deps

  // A preset that came before the engine loads once it's running.
  useEffect(() => {
    if (!engine || pendingPreset.current === null) return
    const text = pendingPreset.current
    pendingPreset.current = null
    void loadPresetText(api, engine, text, 'Lesson')
  }, [engine]) // eslint-disable-line react-hooks/exhaustive-deps

  // State reports, at most every STATE_EVERY ms, only when something the page sees changed.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const last = useRef(0)
  useEffect(() => {
    if (!origin) return
    const report = () => {
      timer.current = null; last.current = performance.now()
      send({ type: 'synth:state', state: snapshot(), ...(startAck.current ? { start: true } : {}) })
      startAck.current = false
    }
    if (timer.current) return
    const wait = Math.max(0, STATE_EVERY - (performance.now() - last.current))
    timer.current = setTimeout(report, wait)
  }, [origin, api.v, api.mods, api.notes, api.ui, status, paused]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); timer.current = null }, [])

  useEffect(() => { if (origin && status === 'on') send({ type: 'synth:started' }) }, [origin, status]) // eslint-disable-line react-hooks/exhaustive-deps

  // The content's size, so the page can make the frame fit it.
  useEffect(() => {
    if (!origin) return
    const el = document.documentElement
    const post = () => send({ type: 'synth:size', width: el.scrollWidth, height: Math.ceil(document.body.getBoundingClientRect().height) })
    const ro = new ResizeObserver(post)
    ro.observe(document.body)
    post()
    return () => ro.disconnect()
  }, [origin]) // eslint-disable-line react-hooks/exhaustive-deps

  // A paused synth comes back on the reader's next press (the page paused it for another lab).
  useEffect(() => {
    if (!paused) return
    const back = () => { setPaused(false); void latest.current.ctx?.resume(); if (status === 'off') start() }
    window.addEventListener('pointerdown', back, { capture: true, once: true })
    return () => window.removeEventListener('pointerdown', back, { capture: true })
  }, [paused, status, start])

  const css = [
    ...highlights.map(targetSelector).filter(Boolean).map((s) => `${s} { outline: 2px solid #ffd54f; outline-offset: 2px; animation: vt-embed-pulse 1.4s ease-in-out infinite; }`),
    ...locks.map(targetSelector).filter(Boolean).map((s) => `${s} { pointer-events: none !important; filter: saturate(0.3) brightness(0.75); }`),
  ].join('\n')
  return css ? <style>{css}</style> : null
}
