import { useEffect, useMemo, useState } from 'react'
import {
  addFolder, filesOf, foldersOf, grantFolder, isFavorite, loadLibrary, removeFolder, toggleFavorite, useLibraryVersion,
  type Kind, type LibFile,
} from '../../engine/library'
import { useVital } from './ctx'
import { R } from './hooks'
import { SelectionList, type ListRow } from './SelectionList'
import { usePartsFrame } from './parts'

// Vital's PopupBrowser (popup_browser.cpp): the LFO, wavetable, sample and remap file browser, opened
// from a section's name box at the bounds that section asks for (the 1.5.5 captures s4e, s1f, s1j). The
// search box and × along the top; the folders on the left (All, Favorites, each folder, Add Folder),
// the files of the selected folder on the right with their stars. Choosing a file loads it at once and
// leaves the browser open; double-clicking the chosen file, Escape, × or a click outside the browser and
// its section closes it; the arrow keys choose the previous or next file.

/** Each opener's loader, keyed by owner (the store keeps only which owner opened it). */
const owners = new Map<string, { load: (f: LibFile) => void; current: () => string | undefined }>()

export interface PopupRequest {
  owner: string
  kind: Kind
  /** The browser's bounds in the capture's 2000-wide frame. */
  at: [number, number, number, number]
  /** The section's own bounds (clicks there don't close it). */
  ignore?: [number, number, number, number]
}

export function openPopupBrowser(api: { setUi: (u: Record<string, unknown>) => void }, req: PopupRequest,
  load: (f: LibFile) => void, current: () => string | undefined) {
  owners.set(req.owner, { load, current })
  void loadLibrary()
  api.setUi({ popupBrowser: req })
}

export function PopupBrowser() {
  const api = useVital()
  useLibraryVersion()
  const parts = usePartsFrame()
  const req = api.ui.popupBrowser as PopupRequest | undefined
  const [folder, setFolder] = useState<string>('all')
  const [search, setSearch] = useState('')
  const owner = req ? owners.get(req.owner) : undefined
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  useEffect(() => { setSearch(''); setChosen(owner?.current()) }, [req?.owner]) // eslint-disable-line react-hooks/exhaustive-deps

  const files = useMemo(() => {
    if (!req) return []
    const list = folder === 'favorites' ? filesOf(req.kind, 'all').filter((f) => isFavorite(f.key)) : filesOf(req.kind, folder)
    const tokens = search.toLowerCase().split(' ').filter(Boolean)
    return list.filter((f) => tokens.every((t) => f.name.toLowerCase().includes(t)))
      .sort((a, b) => `${a.folder}/${a.name}`.localeCompare(`${b.folder}/${b.name}`, undefined, { numeric: true, sensitivity: 'base' }))
  }, [req, folder, search, api.ui]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => api.setUi({ popupBrowser: undefined })
  const choose = (f: LibFile) => { setChosen(f.key); owner?.load(f) }
  useEffect(() => {
    if (!req) return
    const key = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest?.('input')
      // Escape in the search box clears it (textEditorEscapeKeyPressed); anywhere else it closes.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (typing) setSearch(''); else close(); return }
      if (typing) return
      const step = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : 0
      if (!step || !files.length) return
      e.preventDefault(); e.stopPropagation()
      // SelectionList::selectNext / selectPrev.
      const i = files.findIndex((f) => f.key === chosen), n = files.length
      choose(files[step > 0 ? (i + 1) % n : (Math.max(0, i) - 1 + n) % n])
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })
  if (!req) return null

  const folders = foldersOf(req.kind)
  const folderRows: ListRow[] = [
    { key: 'all', name: 'All', icon: 'none' },
    { key: 'favorites', name: 'Favorites', icon: 'star' },
    ...folders.map((f): ListRow => ({ key: f.key, name: f.needsAccess ? `${f.name} (click to allow)` : f.name, icon: 'folder', removable: f.added })),
    { key: 'add', name: 'Add Folder', icon: 'add' },
  ]
  const pickFolder = (key: string) => {
    if (key === 'add') { void addFolder(); return }
    if (folders.find((x) => x.key === key)?.needsAccess) { void grantFolder(key); return }
    setFolder(key)
  }
  const fileRows: ListRow[] = files.map((f) => ({ key: f.key, name: f.name, icon: 'star', favorite: isFavorite(f.key) }))
  // Among embedded parts the browser moves with the section that opened it and stays inside them.
  const [x0, y0, x1, y1] = parts ? parts.place(req.at, req.ignore) : req.at
  const top = 38 * 2000 / 1440, half = (x1 - x0) / 2
  // PopupClosingArea: four areas round the section that opened the browser (its passthrough bounds) close
  // it when pressed outside the browser; presses on the section itself reach the section.
  const ig = req.ignore ? (parts ? parts.place(req.ignore, req.ignore) : req.ignore) : null
  const W = (api.rootRef.current?.offsetWidth ?? 1000) * 2, H = (api.rootRef.current?.offsetHeight ?? 606) * 2
  const areas: [number, number, number, number][] = ig
    ? [[0, 0, ig[0], H], [ig[2], 0, W, H], [ig[0], 0, ig[2], ig[1]], [ig[0], ig[3], ig[2], H]]
    : [[0, 0, W, H]]
  return (
    <>
      {areas.map((a, i) => <div key={i} className="vt-popclose" style={R(...a)} onPointerDown={close} />)}
      <div className="vt-popbrowser" data-skin="Popup Browser" style={R(x0, y0, x1, y1)} onPointerDown={(e) => e.stopPropagation()}>
        <input className="vt-popsearch" style={R(5.6, 5.6, half - 5.6, top - 5.6)} placeholder="Search" value={search}
          onChange={(e) => setSearch(e.currentTarget.value)} />
        <svg className="vt-popx" style={R(x1 - x0 - top, 0, x1 - x0, top)} viewBox="0 0 1 1" onClick={close} aria-label="Close">
          <path d="M0.25 0.25 L0.75 0.75 M0.25 0.75 L0.75 0.25" />
        </svg>
        <i className="vt-popdiv h" style={R(1.4, top - 1.4, x1 - x0 - 1.4, top)} />
        <i className="vt-popdiv v" style={R(half, top, half + 1.4, y1 - y0 - 1.4)} />
        <SelectionList rows={folderRows} selected={folder} onSelect={pickFolder} onIcon={pickFolder}
          onRemove={(k) => { void removeFolder(k); if (folder === k) setFolder('all') }} style={R(0, top + 1.4, half - 1.4, y1 - y0 - 1.4)} />
        <SelectionList rows={fileRows} selected={chosen ?? null}
          onSelect={(k) => { const f = files.find((x) => x.key === k); if (f) choose(f) }}
          onIcon={(k) => toggleFavorite(k)} onConfirm={close} style={R(half + 1.4, top + 1.4, x1 - x0 - 4.2, y1 - y0 - 1.4)} />
      </div>
    </>
  )
}
