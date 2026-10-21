import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { SynthEngine } from '../../../web/engine-client.js'
import { startStatus } from './status'

// The audio side of the app: one AudioContext and one engine (WASM in an AudioWorklet), started by
// the first click or key press anywhere (browsers only allow audio after a gesture). The engine's
// worklet and module are served from the site root (web/ is Vite's public dir).

export type EngineStatus = 'off' | 'loading' | 'on' | 'error'

export interface EngineHandle {
  status: EngineStatus
  error: string | null
  engine: SynthEngine | null
  ctx: AudioContext | null
  start: () => void
}

const Ctx = createContext<EngineHandle>({ status: 'off', error: null, engine: null, ctx: null, start: () => {} })
export const useEngine = () => useContext(Ctx)

export function EngineProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<EngineHandle, 'start'>>({ status: 'off', error: null, engine: null, ctx: null })
  const starting = useRef(false)

  const start = useCallback(() => {
    if (starting.current) return
    starting.current = true
    // Created inside the gesture so it starts running rather than suspended.
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    setState((s) => ({ ...s, status: 'loading', ctx }))
    SynthEngine.create(ctx, new URL('/', location.href).href).then((engine) => {
      // Dev only: ?mute keeps the engine running (its displays need it) but silent.
      const mute = import.meta.env.DEV && new URLSearchParams(location.search).has('mute')
      if (mute) { const silent = ctx.createGain(); silent.gain.value = 0; engine.node.connect(silent); silent.connect(ctx.destination) }
      else engine.node.connect(ctx.destination)
      engine.onModsFailed = (keys) => console.warn('engine refused modulations:', keys)
      startStatus(engine)
      if (import.meta.env.DEV) Object.assign(window, { __synth: { engine, ctx } })
      setState({ status: 'on', error: null, engine, ctx })
    }).catch((err: unknown) => {
      starting.current = false
      setState({ status: 'error', error: String(err), engine: null, ctx: null })
    })
  }, [])

  useEffect(() => {
    if (state.status !== 'off') return
    const go = () => start()
    window.addEventListener('pointerdown', go, { capture: true, once: true })
    window.addEventListener('keydown', go, { capture: true, once: true })
    return () => {
      window.removeEventListener('pointerdown', go, { capture: true })
      window.removeEventListener('keydown', go, { capture: true })
    }
  }, [state.status, start])

  return <Ctx.Provider value={{ ...state, start }}>{children}</Ctx.Provider>
}
