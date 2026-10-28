import { useEffect, useRef, useState } from 'react'

// Vital's SelectionList (popup_browser.cpp), the list in its browsers: one row per entry, its icon on
// the left (a star for files, filled when a favourite; a folder outline; a dashed folder for Add
// Folder), the name after it; the selected row from Widget Primary 1, the hovered one Lighten Screen (each
// the skin's colour for the section the list sits in, Preset Browser or Popup Browser),
// an added folder's row showing an × to remove it while hovered. Clicking the star toggles the favourite,
// clicking elsewhere selects; double-clicking the selected file confirms it. Rows are 42.5 units of the
// capture's frame (s0e, s4e).

export const ROW_H = 21.25

/** Paths::star: JUCE addStar(centre 0.5, 5 points, inner 0.2, outer 0.4) from 12 o'clock. */
export const STAR = Array.from({ length: 10 }, (_, i) => {
  const a = (i * Math.PI) / 5, r = i % 2 ? 0.2 : 0.4
  return `${i ? 'L' : 'M'}${(0.5 + r * Math.sin(a)).toFixed(4)} ${(0.5 - r * Math.cos(a)).toFixed(4)}`
}).join(' ') + 'Z'

/** Paths::folder (folder.svg, 20 × 20). */
export const FOLDER = 'M0 4c0-1.1.9-2 2-2h7l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V4z'

export interface ListRow {
  key: string
  name: string
  icon: 'star' | 'folder' | 'add' | 'none'
  favorite?: boolean
  /** Shows the remove × while hovered (a folder the user added). */
  removable?: boolean
  dim?: boolean
}

export function StarIcon({ on, size }: { on: boolean; size: number }) {
  return (
    <svg className={`vt-sl-star${on ? ' on' : ''}`} viewBox="0.1 0.1 0.8 0.8" style={{ width: size, height: size }} aria-hidden="true">
      <path d={STAR} strokeWidth={0.8 / (size * 1)} />
    </svg>
  )
}

export function SelectionList({ rows, selected, onSelect, onIcon, onRemove, onConfirm, style }: {
  rows: ListRow[]
  selected: string | null
  onSelect: (key: string) => void
  onIcon?: (key: string) => void
  onRemove?: (key: string) => void
  onConfirm?: (key: string) => void
  style?: React.CSSProperties
}) {
  const [hover, setHover] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  // Keep the selection in view when it changes from outside (arrow keys, ‹ ›).
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('.vt-sl-row.sel')
    if (el && box.current) {
      const top = el.offsetTop, bottom = top + el.offsetHeight
      if (top < box.current.scrollTop) box.current.scrollTop = top
      else if (bottom > box.current.scrollTop + box.current.clientHeight) box.current.scrollTop = bottom - box.current.clientHeight
    }
  }, [selected])
  const pad = ROW_H * 0.25
  return (
    <div ref={box} className="vt-sl" style={style} onPointerLeave={() => setHover(null)}>
      {rows.map((r) => (
        <div key={r.key} className={`vt-sl-row${r.key === selected ? ' sel' : ''}${r.key === hover ? ' hover' : ''}${r.dim ? ' dim' : ''}`} style={{ height: ROW_H }}
          onPointerEnter={() => setHover(r.key)}
          onClick={(e) => {
            const x = e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left
            const scale = (e.currentTarget as HTMLElement).getBoundingClientRect().width / (e.currentTarget as HTMLElement).offsetWidth || 1
            if (r.icon === 'star' && x / scale < ROW_H + pad && onIcon) onIcon(r.key)
            else onSelect(r.key)
          }}
          onDoubleClick={() => { if (r.key === selected) onConfirm?.(r.key) }}>
          <span className="vt-sl-icon" style={{ left: pad, width: ROW_H }}>
            {r.icon === 'star' && <StarIcon on={!!r.favorite} size={ROW_H * 0.8} />}
            {(r.icon === 'folder' || r.icon === 'add') && (
              <svg className={`vt-sl-folder${r.icon === 'add' ? ' add' : ''}`} viewBox="-1 -1 22 22" style={{ width: ROW_H * 0.6, height: ROW_H * 0.6 }} aria-hidden="true"><path d={FOLDER} /></svg>
            )}
          </span>
          <span className="vt-sl-name" style={{ left: pad * 2 + ROW_H, fontSize: ROW_H * 0.55 }}>{r.name}</span>
          {r.removable && r.key === hover && onRemove && (
            <span className="vt-sl-x" style={{ width: ROW_H }} title="Remove folder" onClick={(e) => { e.stopPropagation(); onRemove(r.key) }}>
              <svg viewBox="0 0 1 1"><path d="M0.25 0.25 L0.75 0.75 M0.25 0.75 L0.75 0.25" /></svg>
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
