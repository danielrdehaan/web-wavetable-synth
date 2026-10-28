import { useEffect, useMemo, useState } from 'react'
import { statusLanes } from '../../engine/status'
import { skinColor } from './controls'
import { useVital } from './ctx'
import { mix } from './LineEditor'
import { skinVar, useSkin, type ColorKey, type Skin, type SkinSection, type ValueKey } from './skin'

// ModulationManager::drawDraggingModulation: while a source is dragged and isn't over a control it
// would connect to, a ring follows the cursor (radius 0.022 of the interface's width, thickness 0.003),
// in Modulation Meter Control, filled from Widget Background toward it by the source's live value; the
// ModulationManager draws with the Modulation Drag Drop skin.

const RADIUS = 0.022 * 1000, THICKNESS = 0.003 * 1000

/** The skin layers vital.css reads as --vt-mdd-* and --vt-pb-*: a section's override, else the global, on
 *  the window, for the components Vital parents to the whole interface (the ModulationManager's rings
 *  and drop targets, the PopupDisplay's value popups) wherever they sit in the page here. */
const LAYERS: { prefix: string; section: SkinSection; colors: ColorKey[]; values: ValueKey[] }[] = [
  { prefix: 'mdd', section: 'Modulation Drag Drop', colors: ['Rotary Arc', 'Widget Background', 'Lighten Screen', 'Modulation Meter Control'], values: ['Label Rounding'] },
  { prefix: 'pb', section: 'Popup Browser', colors: ['Body', 'Border', 'Body Text'], values: ['Body Rounding'] },
]

function layerCss(skin: Skin): string {
  const decls: string[] = []
  for (const l of LAYERS) {
    const own = skin.overrides[l.section]
    const name = (k: string) => skinVar(k as ColorKey).replace('--sk-', `--vt-${l.prefix}-`)
    for (const k of l.colors) decls.push(`${name(k)}: ${own?.colors[k] ?? `var(${skinVar(k)})`};`)
    for (const k of l.values) decls.push(`${name(k)}: ${own?.values[k] ?? `var(${skinVar(k)})`};`)
  }
  return `.vt { ${decls.join(' ')} }`
}

export function DragGhost() {
  const api = useVital()
  const { skin } = useSkin()
  const css = useMemo(() => layerCss(skin), [skin])
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
  const v = src ? statusLanes(src)?.[0] : undefined
  const t = v !== undefined && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0
  const section = 'Modulation Drag Drop'
  return (
    <>
      <style>{css}</style>
      {src && pos && !pos.hidden && (
        <span className="vt-dragghost" data-skin={section} style={{
          left: pos.x - RADIUS, top: pos.y - RADIUS, width: 2 * RADIUS, height: 2 * RADIUS,
          borderWidth: THICKNESS, background: mix(skinColor(skin, section, 'Widget Background'), skinColor(skin, section, 'Modulation Meter Control'), t),
        }} />
      )}
    </>
  )
}
