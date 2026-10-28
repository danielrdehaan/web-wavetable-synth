import { useEffect, useMemo, useRef, useState } from 'react'
import { useEngine } from '../../engine/EngineContext'
import {
  addFolder, cachedPresetInfo, deleteUserFile, filesOf, foldersOf, grantFolder, isFavorite, loadLibrary, presetInfo,
  removeFolder, renameUserFile, siblingsOf, toggleFavorite, useLibraryVersion, type LibFile,
} from '../../engine/library'
import { useVital, type VitalApi } from './ctx'
import { R } from './hooks'
import { loadPresetText } from './presetIO'
import { ROW_H, SelectionList, StarIcon, type ListRow } from './SelectionList'

// Vital's PresetBrowser (preset_browser.cpp), laid out as the 1.5.5 capture s0e shows it: over the
// centre and the modulator column, the info panel (the loaded preset's name, author and comments), the
// search box, the nine style filters and the folder list (All, Favorites, User, the added folders and
// Add Folder) on the left, and the preset list on the right: star, Name, Style, Author and Date, sorted
// by a column's header (again to reverse), the search matching every word against the name or the
// author. Clicking a preset loads it and keeps the browser open; Escape closes it; the arrow keys load
// the previous or next preset; right-click renames or deletes a User preset.

export const PRESET_STYLES = ['Bass', 'Lead', 'Keys', 'Pad', 'Percussion', 'Sequence', 'Experiment', 'SFX', 'Template']
type Column = 'star' | 'name' | 'style' | 'author' | 'date'
const COLS: { key: Column; label: string; pct: number }[] = [
  { key: 'star', label: '', pct: 0.04 }, { key: 'name', label: 'Name', pct: 0.35 }, { key: 'style', label: 'Style', pct: 0.18 },
  { key: 'author', label: 'Author', pct: 0.25 }, { key: 'date', label: 'Date', pct: 0.18 },
]
const LIST_W = 1986 - 713
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dateText = (t: number) => { if (!t) return ''; const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` }

/** The presets the browser lists now (folder, search and styles applied, sorted), for ‹ › and the keys. */
let listed: LibFile[] = []

/** Loads a library preset as PresetBrowser::loadFromFile does: values, the file's name as the preset
 *  name, its author and comments. */
export async function loadLibraryPreset(api: VitalApi, engine: NonNullable<ReturnType<typeof useEngine>['engine']>, f: LibFile) {
  const text = await (await f.file()).text()
  if (await loadPresetText(api, engine, text, f.name)) api.setUi({ presetFile: f.key, presetExternal: undefined })
}

/** PresetBrowser::jumpToPreset: an externally opened preset steps through its own folder; otherwise the
 *  browser's list (wrapping). */
export async function jumpPreset(api: VitalApi, engine: NonNullable<ReturnType<typeof useEngine>['engine']>, step: number) {
  await loadLibrary()
  const current = api.ui.presetFile as string | undefined
  let list = listed
  if (!list.length) list = filesOf('preset', 'all').sort((a, b) => natural(a.name, b.name))
  const at = list.findIndex((f) => f.key === current)
  const here = at >= 0 ? list[at] : undefined
  if (here && api.ui.presetExternal) list = siblingsOf(here)
  if (!list.length) return
  const i = list.findIndex((f) => f.key === current)
  const next = list[((i < 0 ? (step > 0 ? -1 : 0) : i) + step + list.length) % list.length]
  await loadLibraryPreset(api, engine, next)
}

export function PresetBrowser() {
  const api = useVital()
  const { engine } = useEngine()
  useLibraryVersion()
  const [search, setSearch] = useState('')
  const [styles, setStyles] = useState<Set<string>>(new Set())
  const [folder, setFolder] = useState<string>('all')
  const [sort, setSort] = useState<{ col: Column; asc: boolean }>({ col: 'name', asc: true })
  const [infoTick, setInfoTick] = useState(0)
  const [hover, setHover] = useState<number>(-1)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<LibFile | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { void loadLibrary() }, [])

  const all = folder === 'favorites' ? filesOf('preset', 'all').filter((f) => isFavorite(f.key)) : filesOf('preset', folder)
  // PresetInfoCache: authors and styles read from each file (sorting and filtering need them).
  useEffect(() => {
    let live = true
    const missing = all.filter((f) => !cachedPresetInfo(f.key))
    if (!missing.length) return
    void (async () => {
      for (let i = 0; i < missing.length; i += 24) {
        await Promise.all(missing.slice(i, i + 24).map(presetInfo))
        if (!live) return
        setInfoTick((t) => t + 1)
      }
    })()
    return () => { live = false }
  }, [all.length, folder]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const info = (f: LibFile) => cachedPresetInfo(f.key) ?? { author: '', style: '', comments: '' }
    const cmp: Record<Column, (a: LibFile, b: LibFile) => number> = {
      star: (a, b) => Number(isFavorite(b.key)) - Number(isFavorite(a.key)),
      name: (a, b) => natural(a.name, b.name),
      style: (a, b) => natural(info(a).style.toLowerCase(), info(b).style.toLowerCase()),
      author: (a, b) => natural(info(a).author, info(b).author),
      date: (a, b) => a.lastModified - b.lastModified,
    }
    const sorted = [...all].sort((a, b) => cmp[sort.col](a, b) * (sort.asc ? 1 : -1))
    const tokens = search.toLowerCase().split(' ').filter(Boolean)
    return sorted.filter((f) => {
      if (styles.size && !styles.has(info(f).style.toLowerCase())) return false
      const name = f.name.toLowerCase(), author = info(f).author.toLowerCase()
      return tokens.every((t) => name.includes(t) || author.includes(t))
    })
  }, [all, search, styles, sort, infoTick]) // eslint-disable-line react-hooks/exhaustive-deps
  listed = rows

  const close = () => api.setUi({ presetBrowser: undefined })
  const load = (f: LibFile) => { if (engine) void loadLibraryPreset(api, engine, f) }
  // Focus once, when it opens (every render would take the focus from the search box as it's typed in).
  useEffect(() => { root.current?.focus() }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // Escape in the search box clears it (PresetBrowser::textEditorEscapeKeyPressed); in the rename box its
      // own handler cancels the rename.
      if ((e.target as HTMLElement).closest('input, textarea')) { if (e.key === 'Escape' && (e.target as HTMLElement).classList.contains('vt-pb-input')) setSearch(''); return }
      if (e.key === 'Escape') { e.preventDefault(); close() }
      else if ((e.key === 'ArrowUp' || e.key === 'ArrowLeft') && engine) { e.preventDefault(); void jumpPreset(api, engine, -1) }
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowRight') && engine) { e.preventDefault(); void jumpPreset(api, engine, 1) }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }) // the handlers read this render's list

  const folders = foldersOf('preset')
  const folderRows: ListRow[] = [
    { key: 'all', name: 'All', icon: 'none' },
    { key: 'favorites', name: 'Favorites', icon: 'star' },
    ...folders.map((f): ListRow => ({ key: f.key, name: f.needsAccess ? `${f.name} (click to allow)` : f.name, icon: 'folder', removable: f.added })),
    { key: 'add', name: 'Add Folder', icon: 'add' },
  ]
  const pickFolder = (key: string) => {
    if (key === 'add') { void addFolder(); return }
    const f = folders.find((x) => x.key === key)
    if (f?.needsAccess) { void grantFolder(key); return }
    setFolder(key)
  }
  const current = api.ui.presetFile as string | undefined
  const name = (api.ui.preset_name as string | undefined) ?? ''
  const author = (api.ui.preset_author as string | undefined) ?? ''
  const comments = (api.ui.preset_comments as string | undefined) ?? ''
  const colX = (c: Column) => COLS.slice(0, COLS.findIndex((x) => x.key === c)).reduce((s, x) => s + x.pct * LIST_W, 0)

  const rowMenu = (e: React.MouseEvent, f: LibFile) => {
    e.preventDefault(); e.stopPropagation()
    api.openMenu({ w: 120, items: [
      { label: 'Open File Location', dim: true },
      ...(f.user ? [{ label: 'Rename', act: () => setRenaming(f.key) }, { label: 'Delete', act: () => setDeleting(f) }] : []),
    ] }, e)
  }

  return (
    <>
      <div className="vt-pb" data-skin="Preset Browser" ref={root} tabIndex={-1} style={R(127, 108, 1986, 1140)}>
        <div className="vt-pb-info" style={R(1, 0, 571, 442)}>
          <span className={`vt-pb-name${name && name !== 'Init Preset' ? '' : ' empty'}`} style={R(34, 22, 537, 84)}>{name && name !== 'Init Preset' ? name : 'Preset name'}</span>
          <i className="vt-pb-rule" style={R(34, 92, 537, 93)} />
          <span className={`vt-pb-author${author ? '' : ' empty'}`} style={R(34, 106, 537, 146)}>{author || 'Author'}</span>
          <i className="vt-pb-rule" style={R(34, 160, 537, 161)} />
          <div className="vt-pb-comments" style={R(34, 184, 537, 409)}>{comments}</div>
        </div>
        <div className="vt-pb-search" style={R(1, 459, 571, 1032)}>
          <input className="vt-pb-input" style={R(34, 33, 537, 88)} placeholder="Search" value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
          {PRESET_STYLES.map((s, i) => {
            const x0 = [34, 204.5, 375][i % 3], y0 = [122, 172.5, 223][Math.floor(i / 3)]
            const on = styles.has(s.toLowerCase())
            return (
              <button key={s} type="button" className={`vt-pb-style${on ? ' on' : ''}`} style={R(x0, y0, x0 + 161, y0 + 42)}
                onClick={() => setStyles((p) => { const n = new Set(p); if (on) n.delete(s.toLowerCase()); else n.add(s.toLowerCase()); return n })}>{s}</button>
            )
          })}
          <SelectionList rows={folderRows} selected={folder} onSelect={pickFolder} onIcon={pickFolder} onRemove={(k) => { void removeFolder(k); if (folder === k) setFolder('all') }}
            style={R(34, 300, 537, 538)} />
        </div>
        <div className="vt-pb-list" style={R(586, 0, 1859, 1032)}>
          <div className="vt-pb-head" style={{ height: 45 / 2 }}>
            {COLS.map((c) => (
              <span key={c.key} className={`vt-pb-col ${c.key}${sort.col === c.key ? ' sorted' : ''}`} style={{ left: colX(c.key) / 2, width: (c.pct * LIST_W) / 2 }}
                onClick={() => setSort((s) => ({ col: c.key, asc: s.col === c.key ? !s.asc : true }))}>
                {c.key === 'star' ? <StarIcon on size={ROW_H * 0.8} /> : c.label}
                {sort.col === c.key && c.key !== 'star' && <i className={`vt-pb-arrow${sort.asc ? '' : ' up'}`} />}
              </span>
            ))}
          </div>
          <div className="vt-pb-rows" onPointerLeave={() => setHover(-1)}>
            {rows.map((f, k) => {
              const info = cachedPresetInfo(f.key)
              const style = info?.style ? info.style[0].toUpperCase() + info.style.slice(1).toLowerCase() : ''
              return (
                <div key={f.key} className={`vt-pb-row${f.key === current ? ' sel' : ''}${k === hover ? ' hover' : ''}`} style={{ height: ROW_H }}
                  onPointerEnter={() => setHover(k)} onContextMenu={(e) => rowMenu(e, f)}
                  onClick={(e) => {
                    const x = (e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left) / ((e.currentTarget as HTMLElement).getBoundingClientRect().width / (e.currentTarget as HTMLElement).offsetWidth || 1)
                    if (x < (0.04 * LIST_W) / 2) toggleFavorite(f.key)
                    else load(f)
                  }}>
                  <span className="vt-pb-cell star" style={{ left: 0, width: (0.04 * LIST_W) / 2 }}><StarIcon on={isFavorite(f.key)} size={ROW_H * 0.8} /></span>
                  {renaming === f.key
                    ? <input className="vt-pb-rename" autoFocus defaultValue={f.name} style={{ left: colX('name') / 2, width: (0.35 * LIST_W) / 2 }}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(null) }}
                      onBlur={(e) => { const t = e.currentTarget.value.replace(/[<>?*/|\\[\]":]/g, '').trim(); setRenaming(null); if (t && t !== f.name) void renameUserFile(f.key, t) }} />
                    : <span className="vt-pb-cell" style={{ left: colX('name') / 2 + ROW_H / 2, width: (0.35 * LIST_W) / 2 - ROW_H }}>{f.name}</span>}
                  <span className="vt-pb-cell" style={{ left: colX('style') / 2 + ROW_H / 2, width: (0.18 * LIST_W) / 2 - ROW_H }}>{style}</span>
                  <span className="vt-pb-cell" style={{ left: colX('author') / 2 + ROW_H / 2, width: (0.25 * LIST_W) / 2 - ROW_H }}>{info?.author ?? ''}</span>
                  <span className="vt-pb-cell date" style={{ right: ROW_H / 2, width: (0.18 * LIST_W) / 2 - ROW_H }}>{dateText(f.lastModified)}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
      {/* DeleteSection: an Overlay over the whole interface (Overlays skin), not part of the browser. */}
      {deleting && (
        <div className="vt-overlay" data-skin="Overlays" onPointerDown={(e) => { if (e.target === e.currentTarget) setDeleting(null) }}>
          <div className="vt-ovbox" style={{ width: 340 * 0.694, height: 140 * 0.694 }}>
            <span className="vt-ovtext" style={{ top: 20 * 0.694 }}>Are you sure you want to delete this preset?</span>
            <span className="vt-ovtext" style={{ top: 50 * 0.694 }}>{deleting.name}</span>
            <button type="button" className="vt-uibtn" style={{ left: 25 * 0.694, bottom: 20 * 0.694, width: 132.5 * 0.694, height: 30 * 0.694 }} onClick={() => setDeleting(null)}>Cancel</button>
            <button type="button" className="vt-uibtn primary" style={{ right: 25 * 0.694, bottom: 20 * 0.694, width: 132.5 * 0.694, height: 30 * 0.694 }}
              onClick={() => { void deleteUserFile(deleting.key); setDeleting(null) }}>Delete</button>
          </div>
        </div>
      )}
    </>
  )
}
