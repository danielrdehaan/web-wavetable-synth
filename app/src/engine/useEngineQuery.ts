import { useEffect, useRef, useState } from 'react'
import type { SynthEngine } from '../../../web/engine-client.js'
import { useEngine } from './EngineContext'

/** The latest answer to an engine query (a display curve), re-asked when `key` changes. At most one
 *  request is in flight; a change while one is pending asks once more when it returns. Null before the
 *  engine runs or answers. */
export function useEngineQuery<T>(key: string, ask: (engine: SynthEngine) => Promise<T>): T | null {
  const { engine } = useEngine()
  const [value, setValue] = useState<T | null>(null)
  const latest = useRef(ask)
  latest.current = ask
  const busy = useRef(false), again = useRef(false)
  useEffect(() => {
    if (!engine) return
    const run = () => {
      if (busy.current) { again.current = true; return }
      busy.current = true
      void latest.current(engine).then((v) => {
        busy.current = false
        setValue(v)
        if (again.current) { again.current = false; run() }
      })
    }
    run()
  }, [engine, key])
  return value
}
