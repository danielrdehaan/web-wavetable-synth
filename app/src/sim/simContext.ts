import { createContext, useContext, useEffect, useRef } from 'react'
import type { Tag } from './tags'
import { capturePointer } from './pointer'

// The synth sims' context and pointer helper (see kit.tsx for the drawing kit).

export interface SimCtx {
  /** The question being asked now (the reader's current task), or null. */
  asking: Tag | null
  /** Questions already answered: their regions stay lit. */
  found: ReadonlySet<Tag>
  /** A region was clicked. */
  pick: (tags: readonly Tag[]) => void
  /** The reader made the LFO 1 → cutoff connection. */
  mechDone: () => void
}

/** When a drag last ended: the click the browser sends after it isn't a pick. */
let lastDragEnd = 0
export const markDragEnd = () => { lastDragEnd = performance.now() }
export const justDragged = () => performance.now() - lastDragEnd < 300

export const SynthSimContext = createContext<SimCtx>({ asking: null, found: new Set(), pick: () => {}, mechDone: () => {} })
export const useSim = () => useContext(SynthSimContext)

/** Vertical drag: calls `onDrag(dy)` with upward movement in stage pixels (screen pixels ÷ scale). */
export function useVerticalDrag(onDrag: (dy: number) => void) {
  const last = useRef<number | null>(null)
  const cb = useRef(onDrag)
  useEffect(() => { cb.current = onDrag })
  return {
    onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); e.stopPropagation(); last.current = e.clientY; capturePointer(e) },
    onPointerMove: (e: React.PointerEvent) => { if (last.current === null) return; const dy = last.current - e.clientY; last.current = e.clientY; if (dy) cb.current(dy) },
    onPointerUp: () => { if (last.current !== null) markDragEnd(); last.current = null },
    onPointerCancel: () => { last.current = null },
  }
}
