import { useEffect, useState } from 'react'
import { statusLanes } from '../../engine/status'
import { useVital } from './ctx'
import { mix } from './LineEditor'

// ModulationManager::drawDraggingModulation: while a source is dragged and isn't over a control it
// would connect to, a ring follows the cursor (radius 0.022 of the interface's width, thickness 0.003),
// in Modulation Meter Control, filled from Widget Background toward it by the source's live value.

const RADIUS = 0.022 * 1000, THICKNESS = 0.003 * 1000

export function DragGhost() {
  const api = useVital()
  const [pos, setPos] = useState<{ x: number; y: number; hidden: boolean } | null>(null)
  const src = api.dragSrc
  useEffect(() => {
    if (!src) { setPos(null); return }
    const move = (e: PointerEvent) => {
      const p = api.toStage(e.clientX, e.clientY)
      setPos({ ...p, hidden: !!api.rootRef.current?.hasAttribute('data-temp-drop') })
    }
    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
  }, [src, api])
  if (!src || !pos || pos.hidden) return null
  const v = statusLanes(src)?.[0]
  const t = v !== undefined && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0
  return (
    <span className="vt-dragghost" style={{
      left: pos.x - RADIUS, top: pos.y - RADIUS, width: 2 * RADIUS, height: 2 * RADIUS,
      borderWidth: THICKNESS, background: mix('#1d2125', '#64ffda', t),
    }} />
  )
}
