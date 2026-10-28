import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { SourceSlot } from '../../engine/SourceSlot'
import { Box, ModRing, useArcColor } from './controls'
import { useVital } from './ctx'
import { PARAMS } from './params'
import { sk } from './skin'

// A modulation source's button (modulation_button.cpp) and the depth knobs it carries
// (ModulationManager::positionModulationAmountSliders): press to make it the current modulator, drag
// it out onto a control to connect it, right-click to disconnect. While it has no connections a
// four-way drag handle fades in on hover. Its connections' knobs sit in a three-column grid along the
// bottom of its modulation area; past what fits there, the area becomes an expand button that drops a
// box of all of them below the source.

const PT_PX = 1000 / 1440 // stage px per Vital point
const COLUMNS = 3 // ModulationButton::kModulationKnobColumns
const WIDGET_MARGIN = 5.5 * PT_PX
const RING = 12 // a source's depth knobs are drawn at its grid cell's size, about 12 stage px
const RIGHT_POPUP_X = 150 * PT_PX // kRightPopupPositionX
const CALLOUT_CELL = 30 * PT_PX, CALLOUT_PADDING = 5 * PT_PX

/** getModulationAreaBounds, in the button's stage px. */
function modulationArea(w: number, h: number) {
  const meter = Math.max(4 * PT_PX, Math.round((w * 0.05) / 2) * 2)
  const width = w - meter
  let widgetWidth = width - 2 * WIDGET_MARGIN
  const knob = Math.floor(widgetWidth / COLUMNS)
  widgetWidth = knob * COLUMNS
  const x = meter + (width - widgetWidth) / 2
  const minY = 0.3 * width
  const maxHeight = Math.ceil((widgetWidth * 2) / 3)
  let y = Math.max(minY, h - WIDGET_MARGIN - maxHeight)
  let height = h - y - WIDGET_MARGIN
  const center = y + height / 2
  height = Math.max(height, (widgetWidth + 2) / 3)
  y = center - height / 2
  return { x, y, w: widgetWidth, h: height, knob }
}

export function SourceButton({ src, at, className, title, selected = false, onClick, children }: {
  src: string
  at: [number, number, number, number]
  className: string
  title: string
  selected?: boolean
  onClick?: () => void
  children?: ReactNode
}) {
  const api = useVital()
  const arcColor = useArcColor()
  const [hover, setHover] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const used = api.mods.map((m, j) => ({ m, j })).filter(({ m }) => m.src === src)
  const expanded = api.ui.srcExpanded === src
  const w = (at[2] - at[0]) / 2, h = (at[3] - at[1]) / 2
  const area = modulationArea(w, h)
  const rows = Math.max(0, Math.floor((COLUMNS * area.h) / Math.max(1, area.w)))
  const inside = used.length <= COLUMNS * rows
  const current = api.focusSrc === src

  // getSourceConnections → "Disconnect from <destination>" per connection, then "Disconnect all".
  const menu = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    if (!used.length) return
    const remove = (dsts: string[]) => () => {
      api.checkpoint()
      for (const dst of dsts) { const k = api.mods.findIndex((m) => m.src === src && m.dst === dst); if (k >= 0) api.removeMod(k) }
    }
    api.openMenu({ w: 150, items: [
      ...used.map(({ m }) => ({ label: `Disconnect from ${PARAMS[m.dst]?.name ?? m.dst}`, act: remove([m.dst]) })),
      ...(used.length > 1 ? [{ label: 'Disconnect all', act: remove(used.map(({ m }) => m.dst)) }] : []),
    ] }, e)
  }

  return (
    <Box ref={box} at={at} className={`${className} drag vt-srcbtn${selected ? ' sel' : ''}${current ? ' current' : ''}${current && api.dragSrc === src ? ' dragging' : ''}`}
      data-src={src} title={title} onContextMenu={menu}
      onPointerDown={(e) => { if (e.button === 0) api.beginSourceDrag(src, e, onClick) }}
      onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
      <SourceSlot src={src} used={used.length > 0} />
      {children}
      {/* The drag handle (Paths::dragDropArrows in Lighten Screen) while nothing is connected. */}
      <svg className={`vt-draghandle${hover && !used.length ? ' on' : ''}`} viewBox="0 0 24 24" aria-hidden="true"
        style={{ left: area.x + area.w * 0.2, top: area.y + area.h * 0.2 - 2, width: area.w * 0.6, height: area.h * 0.6 + 4 }}>
        <path d="M12 2 L15.5 6 H13 V11 H18 V8.5 L22 12 L18 15.5 V13 H13 V18 H15.5 L12 22 L8.5 18 H11 V13 H6 V15.5 L2 12 L6 8.5 V11 H11 V6 H8.5 Z" />
      </svg>
      {inside
        ? used.map(({ j }, q) => {
          const col = q % COLUMNS, row = Math.floor(q / COLUMNS)
          const x = area.x + (area.w * col) / COLUMNS, y = area.y + area.h - area.knob * (row + 1)
          // positionModulationAmountSlidersInside: popups below, to the right within 150 pt of the left
          // edge, to the left within 150 pt of the right.
          const sx = at[0] / 2 + x
          const popup = sx < RIGHT_POPUP_X ? 'right' : 1000 - (sx + area.knob) < RIGHT_POPUP_X ? 'left' : 'below'
          return <ModRing key={j} i={j} side="source" popup={popup} style={{ left: x + (area.knob - RING) / 2, top: y + (area.knob - RING) / 2, width: RING, height: RING }} />
        })
        : (
          <span className={`vt-srcexpand${expanded ? ' on' : ''}`} style={{ left: area.x, top: area.y, width: area.w, height: area.h }}
            title={`${used.length} modulations`}
            onPointerDown={(e) => { e.stopPropagation(); api.setUi({ srcExpanded: expanded ? undefined : src }) }}>
            <ExpandPreview colors={used.map(({ m }) => (m.bypass ? sk('Widget Primary Disabled') : arcColor(m.dst)))} w={area.w} h={area.h} />
          </span>
        )}
      {!inside && expanded && <Callout src={src} anchor={box.current} rings={used.map(({ j }) => j)} w={w} ratio={area.h / area.w} />}
    </Box>
  )
}

/** ExpandModulationButton's face: a small ring per connection in the destination's colour, the grid as
 *  wide as getNumColumns gives and centred vertically. */
function ExpandPreview({ colors, w, h }: { colors: string[]; w: number; h: number }) {
  let columns = 1
  while (columns * Math.floor((h / w) * columns) < colors.length) columns++
  const cell = w / columns, rows = Math.ceil(colors.length / columns), yOffset = (h - rows * cell) / 2
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
      {colors.map((c, i) => {
        const col = i % columns, row = Math.floor(i / columns)
        return <circle key={i} cx={col * cell + cell / 2} cy={h - yOffset - (row + 1) * cell + cell / 2} r={cell * 0.3} fill="none" style={{ stroke: c }} strokeWidth={1.4} />
      })}
    </svg>
  )
}

/** showModulationAmountCallout: every knob in a box below the source, 30-pt cells, filled from the
 *  bottom row, as many columns as the expand button's shape asks for (getNumColumns). */
function Callout({ src, anchor, rings, w, ratio }: { src: string; anchor: HTMLElement | null; rings: number[]; w: number; ratio: number }) {
  const api = useVital()
  const root = api.rootRef.current
  if (!anchor || !root) return null
  let columns = 1
  while (columns * Math.floor(ratio * columns) < rings.length) columns++
  const rowCount = Math.ceil(rings.length / columns)
  const bw = CALLOUT_CELL * columns + 2 * CALLOUT_PADDING, bh = CALLOUT_CELL * rowCount + 2 * CALLOUT_PADDING
  // Drawn over the whole interface (it can't be clipped by the tabs), below the button, kept on screen.
  const r = anchor.getBoundingClientRect()
  const topLeft = api.toStage(r.left, r.bottom)
  const left = Math.min(root.offsetWidth - bw, Math.max(0, topLeft.x + (w - bw) / 2)), top = Math.min(root.offsetHeight - bh, topLeft.y)
  return createPortal(
    <div className="vt-srccallout" data-src={src} style={{ left, top, width: bw, height: bh }} onPointerDown={(e) => e.stopPropagation()}>
      {rings.map((i, k) => {
        const col = k % columns, row = Math.floor(k / columns)
        return <ModRing key={i} i={i} side="source" style={{ left: CALLOUT_PADDING + col * CALLOUT_CELL + (CALLOUT_CELL - RING) / 2, top: bh - CALLOUT_PADDING - (row + 1) * CALLOUT_CELL + (CALLOUT_CELL - RING) / 2, width: RING, height: RING }} />
      })}
    </div>,
    root,
  )
}
