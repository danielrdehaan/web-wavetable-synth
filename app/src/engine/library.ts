import { useSyncExternalStore } from 'react'

// The files Vital's browsers list (LoadSave's data directory, in a browser): presets, wavetables, LFO
// shapes and samples from two kinds of place.
// - "User": what was saved or imported here, kept in the browser (IndexedDB), as Vital keeps its User
//   folder.
// - Folders on disk the user adds (SelectionList's "Add Folder"), read through the File System Access
//   API and remembered between visits (the browser asks again for access when a visit starts); where that
//   API is missing a folder can still be picked for the visit. A folder laid out like Vital's data folder
//   (<pack>/Presets, <pack>/Wavetables, <pack>/LFOs, <pack>/Samples) lists one folder per pack, as Vital
//   does; any other folder lists as itself.
// Nothing is fetched from anywhere else.

export type Kind = 'preset' | 'wavetable' | 'lfo' | 'sample'

/** Each kind's folder inside a pack (LoadSave's kPresetFolderName and friends) and its file types. */
export const KINDS: Record<Kind, { folder: string; ext: string[] }> = {
  preset: { folder: 'Presets', ext: ['vital'] },
  wavetable: { folder: 'Wavetables', ext: ['vitaltable', 'wav', 'flac', 'aif', 'aiff'] },
  lfo: { folder: 'LFOs', ext: ['vitallfo'] },
  sample: { folder: 'Samples', ext: ['wav', 'flac', 'aif', 'aiff', 'mp3', 'ogg', 'm4a'] },
}

export interface LibFile {
  /** Stable id (favourites, selection): 'user:<id>' or 'disk:<root>/<path>'. */
  key: string
  kind: Kind
  /** The name without its extension. */
  name: string
  /** The folder (pack) it lists under. */
  folder: string
  /** Its directory, for stepping through neighbours (‹ ›). */
  dir: string
  lastModified: number
  user: boolean
  file(): Promise<File>
}

export interface LibFolder {
  key: string
  name: string
  /** A folder the user added (it shows the remove ×). */
  added: boolean
  /** Waiting for the browser to grant access again (click asks). */
  needsAccess?: boolean
}

const extOf = (name: string) => name.toLowerCase().split('.').pop() ?? ''
const stem = (name: string) => name.replace(/\.[^.]+$/, '')

// ── IndexedDB ────────────────────────────────────────────────────────────────────────────────────

/** The permission calls Chrome adds to FileSystemHandle (not yet in TypeScript's DOM types). */
type Permissioned = { queryPermission?(o: { mode: 'read' }): Promise<PermissionState>; requestPermission?(o: { mode: 'read' }): Promise<PermissionState> }
const perms = (h: FileSystemDirectoryHandle) => h as unknown as Permissioned

/** A file kept in the browser: `folder` is 'User' for what was saved here, a bank's name for what an
 *  imported bank brought. */
interface UserRecord { id?: number; kind: Kind; name: string; ext: string; data: Blob; lastModified: number; folder?: string }
interface RootRecord { id: string; name: string; handle: FileSystemDirectoryHandle }

let dbPromise: Promise<IDBDatabase> | null = null
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('vt-library', 1)
    req.onupgradeneeded = () => {
      const d = req.result
      d.createObjectStore('files', { keyPath: 'id', autoIncrement: true })
      d.createObjectStore('roots', { keyPath: 'id' })
      d.createObjectStore('meta', { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const req = run(d.transaction(store, mode).objectStore(store))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// ── State ────────────────────────────────────────────────────────────────────────────────────────

interface Root { id: string; name: string; handle?: FileSystemDirectoryHandle; files?: File[]; granted: boolean; scanned?: ScannedRoot }
interface ScannedRoot { folders: { name: string; kind: Kind; files: LibFile[] }[] }

let userFiles: LibFile[] = []
/** Files this build makes itself, listed under "Factory" (the simple LFO shapes, the generated wavetables). */
const builtins = new Map<Kind, LibFile[]>()

/** Lists generated files under a kind's Factory folder. */
export function registerBuiltins(kind: Kind, items: { name: string; ext: string; make: () => string }[]) {
  builtins.set(kind, items.map((it) => ({
    key: `builtin:${kind}/${it.name}`, kind, name: it.name, folder: 'Factory', dir: `builtin:${kind}`, lastModified: 0, user: false,
    file: async () => new File([it.make()], `${it.name}.${it.ext}`),
  })))
  changed()
}
const roots = new Map<string, Root>()
let favorites = new Set<string>(readJson<string[]>('vt.favorites', []))
let version = 0
const listeners = new Set<() => void>()
const changed = () => { version++; for (const l of listeners) l() }

function readJson<T>(key: string, fallback: T): T {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : fallback } catch { return fallback }
}

/** Re-renders when the library changes. */
export function useLibraryVersion(): number {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => version)
}

let loaded: Promise<void> | null = null
/** Reads the User store and the remembered folders (once). */
export function loadLibrary(): Promise<void> {
  loaded ??= (async () => {
    try {
      const records = await tx<UserRecord[]>('files', 'readonly', (s) => s.getAll() as IDBRequest<UserRecord[]>)
      userFiles = records.map(userFile)
      const saved = await tx<RootRecord[]>('roots', 'readonly', (s) => s.getAll() as IDBRequest<RootRecord[]>)
      for (const r of saved) {
        let granted = false
        try { granted = (await perms(r.handle).queryPermission?.({ mode: 'read' })) === 'granted' } catch { /* not supported */ }
        roots.set(r.id, { id: r.id, name: r.name, handle: r.handle, granted })
      }
      await Promise.all([...roots.values()].filter((r) => r.granted).map(scan))
    } catch { /* no IndexedDB (private window): the library is empty */ }
    changed()
  })()
  return loaded
}

function userFile(r: UserRecord): LibFile {
  const folder = r.folder ?? 'User'
  return {
    key: `user:${r.id}`, kind: r.kind, name: r.name, folder, dir: `user:${r.kind}:${folder}`, lastModified: r.lastModified, user: true,
    file: async () => new File([r.data], `${r.name}.${r.ext}`, { lastModified: r.lastModified }),
  }
}

// ── Disk folders ─────────────────────────────────────────────────────────────────────────────────

interface Walked { path: string[]; get(): Promise<File>; lastModified?: number }

async function walkHandle(dir: FileSystemDirectoryHandle, path: string[], out: Walked[], depth = 0) {
  if (depth > 8) return
  for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (name.startsWith('.')) continue
    if (handle.kind === 'directory') await walkHandle(handle as FileSystemDirectoryHandle, [...path, name], out, depth + 1)
    else out.push({ path: [...path, name], get: () => (handle as FileSystemFileHandle).getFile() })
  }
}

/** Sorts a root's files into its folders: <pack>/<Kind folder>/… lists under the pack; otherwise a
 *  file lists under the root, its kind by extension (audio is a sample unless inside "Wavetables"). */
async function scan(root: Root) {
  const walked: Walked[] = []
  if (root.handle) await walkHandle(root.handle, [], walked)
  else for (const f of root.files ?? []) walked.push({ path: f.webkitRelativePath.split('/').slice(1), get: async () => f, lastModified: f.lastModified })
  const byFolder = new Map<string, { name: string; kind: Kind; files: LibFile[] }>()
  for (const w of walked) {
    const fileName = w.path[w.path.length - 1]
    const ext = extOf(fileName)
    const dirs = w.path.slice(0, -1)
    let kind: Kind | null = null, folder = root.name
    const kindAt = dirs.findIndex((d) => (Object.keys(KINDS) as Kind[]).some((k) => KINDS[k].folder.toLowerCase() === d.toLowerCase()))
    if (kindAt >= 0) {
      kind = (Object.keys(KINDS) as Kind[]).find((k) => KINDS[k].folder.toLowerCase() === dirs[kindAt].toLowerCase())!
      if (!KINDS[kind].ext.includes(ext)) continue
      folder = kindAt > 0 ? dirs[kindAt - 1] : root.name
    } else {
      kind = ext === 'vital' ? 'preset' : ext === 'vitaltable' ? 'wavetable' : ext === 'vitallfo' ? 'lfo' : KINDS.sample.ext.includes(ext) ? 'sample' : null
      if (!kind) continue
    }
    const id = `${kind}|${folder}`
    if (!byFolder.has(id)) byFolder.set(id, { name: folder, kind, files: [] })
    let lastModified = w.lastModified ?? 0
    const dir = `disk:${root.id}/${dirs.join('/')}`
    const entry: LibFile = {
      key: `disk:${root.id}/${w.path.join('/')}`, kind, name: stem(fileName), folder, dir, lastModified, user: false,
      file: async () => { const f = await w.get(); entry.lastModified = f.lastModified; return f },
    }
    if (!lastModified && kind === 'preset') {
      // Dates show in the preset list: read them now (cheap; the file isn't opened).
      try { lastModified = (await w.get()).lastModified; entry.lastModified = lastModified } catch { /* unreadable */ }
    }
    byFolder.get(id)!.files.push(entry)
  }
  root.scanned = { folders: [...byFolder.values()] }
}

/** SelectionList::addAdditionalFolder: a folder on disk (remembered where the browser allows). */
export async function addFolder(): Promise<void> {
  const picker = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker
  if (picker) {
    let handle: FileSystemDirectoryHandle
    try { handle = await picker({ mode: 'read' }) } catch { return }
    for (const r of roots.values()) if (r.handle && (await r.handle.isSameEntry(handle))) { window.alert('Folder already added'); return }
    const id = `${Date.now().toString(36)}`
    const root: Root = { id, name: handle.name, handle, granted: true }
    roots.set(id, root)
    try { await tx('roots', 'readwrite', (s) => s.put({ id, name: handle.name, handle })) } catch { /* kept for this visit */ }
    await scan(root)
    changed()
    return
  }
  // No File System Access: pick the folder's files for this visit.
  const input = document.createElement('input')
  input.type = 'file'
  ;(input as unknown as { webkitdirectory: boolean }).webkitdirectory = true
  input.onchange = async () => {
    const files = [...(input.files ?? [])]
    if (!files.length) return
    const id = `visit-${Date.now().toString(36)}`
    const root: Root = { id, name: files[0].webkitRelativePath.split('/')[0] || 'Folder', files, granted: true }
    roots.set(id, root)
    await scan(root)
    changed()
  }
  input.click()
}

/** SelectionList::removeAdditionalFolder. */
export async function removeFolder(key: string) {
  const id = key.replace(/^root:/, '').split('|')[0]
  roots.delete(id)
  try { await tx('roots', 'readwrite', (s) => s.delete(id)) } catch { /* not stored */ }
  changed()
}

/** Asks the browser again for a remembered folder (needs a click). */
export async function grantFolder(key: string) {
  const root = roots.get(key.replace(/^root:/, '').split('|')[0])
  if (!root?.handle) return
  try { root.granted = (await perms(root.handle).requestPermission?.({ mode: 'read' })) === 'granted' } catch { root.granted = false }
  if (root.granted) await scan(root)
  changed()
}

// ── Listing ──────────────────────────────────────────────────────────────────────────────────────

/** The folders a kind's browser lists: User (when it has any), then each added folder's packs in
 *  name order (a folder still waiting for access lists once, as itself). */
export function foldersOf(kind: Kind): LibFolder[] {
  const out: LibFolder[] = []
  const natural = (a: LibFolder, b: LibFolder) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  const disk: LibFolder[] = []
  if (builtins.get(kind)?.length) disk.push({ key: `builtin:${kind}`, name: 'Factory', added: false })
  for (const folder of new Set(userFiles.filter((f) => f.kind === kind).map((f) => f.folder))) disk.push({ key: `user:${kind}:${folder}`, name: folder, added: false })
  for (const r of roots.values()) {
    if (!r.granted || !r.scanned) { disk.push({ key: `root:${r.id}`, name: r.name, added: true, needsAccess: true }); continue }
    for (const f of r.scanned.folders) if (f.kind === kind) disk.push({ key: `root:${r.id}|${f.name}`, name: f.name, added: f.name === r.name })
  }
  return [...out, ...disk.sort(natural)]
}

/** The files under a folder, or every folder's for 'all'. */
export function filesOf(kind: Kind, folderKey: string | 'all'): LibFile[] {
  const out: LibFile[] = []
  if (folderKey === 'all' || folderKey === `builtin:${kind}`) out.push(...(builtins.get(kind) ?? []))
  out.push(...userFiles.filter((f) => f.kind === kind && (folderKey === 'all' || folderKey === `user:${kind}:${f.folder}`)))
  for (const r of roots.values()) {
    for (const f of r.scanned?.folders ?? []) {
      if (f.kind !== kind) continue
      if (folderKey === 'all' || folderKey === `root:${r.id}|${f.name}`) out.push(...f.files)
    }
  }
  return out
}

export function allFiles(kind: Kind): LibFile[] { return filesOf(kind, 'all') }

/** A file's neighbours in its own directory, by name (PresetBrowser::jumpToPreset). */
export function siblingsOf(file: LibFile): LibFile[] {
  return allFiles(file.kind).filter((f) => f.dir === file.dir).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
}

/** LoadSave::getShiftedFile: every file of the kind sorted by path; from the current one `shift` on
 *  (wrapping), or the first when the current one isn't listed. */
export function shiftedFile(kind: Kind, currentKey: string | undefined, shift: number): LibFile | undefined {
  const files = allFiles(kind).map((f) => ({ f, path: `${f.folder}/${f.key}`.toLowerCase() }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })).map((x) => x.f)
  if (!files.length) return undefined
  const i = files.findIndex((f) => f.key === currentKey)
  if (i < 0) return files[0]
  return files[(i + shift + files.length) % files.length]
}

export function findFile(key: string): LibFile | undefined {
  for (const k of Object.keys(KINDS) as Kind[]) { const f = allFiles(k).find((x) => x.key === key); if (f) return f }
  return undefined
}

// ── Favourites ───────────────────────────────────────────────────────────────────────────────────

export function isFavorite(key: string) { return favorites.has(key) }
export function toggleFavorite(key: string) {
  favorites = new Set(favorites)
  if (favorites.has(key)) favorites.delete(key); else favorites.add(key)
  try { localStorage.setItem('vt.favorites', JSON.stringify([...favorites])) } catch { /* storage unavailable */ }
  changed()
}

// ── The User store ───────────────────────────────────────────────────────────────────────────────

/** Saves into User, replacing a file of the same kind and name. Resolves its entry. */
export async function saveUserFile(kind: Kind, name: string, ext: string, data: Blob, folder = 'User'): Promise<LibFile> {
  await loadLibrary()
  const same = userFiles.find((f) => f.kind === kind && f.folder === folder && f.name.toLowerCase() === name.toLowerCase())
  const record: UserRecord = { kind, name, ext, data, lastModified: Date.now(), folder }
  if (same) record.id = Number(same.key.slice(5))
  const id = await tx<IDBValidKey>('files', 'readwrite', (s) => s.put(record))
  record.id = Number(id)
  const entry = userFile(record)
  userFiles = [...userFiles.filter((f) => f.key !== entry.key), entry]
  metaCache.delete(entry.key)
  changed()
  return entry
}

export function userFileNamed(kind: Kind, name: string): LibFile | undefined {
  return userFiles.find((f) => f.kind === kind && f.folder === 'User' && f.name.toLowerCase() === name.toLowerCase())
}

/** What Export Bank offers: the files saved here (User), by kind. */
export function userContent(kind: Kind): LibFile[] {
  return userFiles.filter((f) => f.kind === kind && f.folder === 'User')
}

/** SynthPresetSelector::importBank: a .vitalbank (a zip of <bank>/Presets, Wavetables, LFOs and
 *  Samples) unpacked into the browser, each file listed under the bank's folder. */
export async function importBank(file: File): Promise<number> {
  const { unzipSync } = await import('fflate')
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
  const fallback = file.name.replace(/\.[^.]+$/, '')
  let count = 0
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.endsWith('/') || !bytes.length) continue
    const parts = path.split('/').filter(Boolean)
    const fileName = parts[parts.length - 1], ext = extOf(fileName)
    const kindAt = parts.findIndex((d) => (Object.keys(KINDS) as Kind[]).some((k) => KINDS[k].folder.toLowerCase() === d.toLowerCase()))
    if (kindAt < 0) continue
    const kind = (Object.keys(KINDS) as Kind[]).find((k) => KINDS[k].folder.toLowerCase() === parts[kindAt].toLowerCase())!
    if (!KINDS[kind].ext.includes(ext)) continue
    const folder = kindAt > 0 ? parts[kindAt - 1] : fallback
    await saveUserFile(kind, stem(fileName), ext, new Blob([bytes.slice()]), folder)
    count++
  }
  return count
}

/** BankExporter::exportBank: the chosen files zipped as <bank>/<Kind folder>/<file>. */
export async function exportBank(bankName: string, keys: Set<string>): Promise<Blob> {
  const { zipSync } = await import('fflate')
  const out: Record<string, Uint8Array> = {}
  for (const f of userFiles) {
    if (!keys.has(f.key)) continue
    const file = await f.file()
    out[`${bankName}/${KINDS[f.kind].folder}/${file.name}`] = new Uint8Array(await file.arrayBuffer())
  }
  return new Blob([zipSync(out, { level: 9 }).slice()], { type: 'application/zip' })
}

export async function deleteUserFile(key: string) {
  if (!key.startsWith('user:')) return
  await tx('files', 'readwrite', (s) => s.delete(Number(key.slice(5))))
  userFiles = userFiles.filter((f) => f.key !== key)
  changed()
}

export async function renameUserFile(key: string, name: string) {
  const f = userFiles.find((x) => x.key === key)
  if (!f) return
  const file = await f.file()
  await deleteUserFile(key)
  await saveUserFile(f.kind, name, extOf(file.name), file)
}

// ── Preset info (PresetInfoCache) ────────────────────────────────────────────────────────────────

export interface PresetInfo { author: string; style: string; comments: string }
const metaCache = new Map<string, PresetInfo>()

/** A preset's author, style and comments, read from the file once (then remembered). */
export async function presetInfo(f: LibFile): Promise<PresetInfo> {
  const hit = metaCache.get(f.key)
  if (hit) return hit
  const stored = await tx<{ key: string; lastModified: number; info: PresetInfo } | undefined>('meta', 'readonly', (s) => s.get(f.key) as IDBRequest).catch(() => undefined)
  if (stored && stored.lastModified === f.lastModified) { metaCache.set(f.key, stored.info); return stored.info }
  let info: PresetInfo = { author: '', style: '', comments: '' }
  try {
    const j = JSON.parse(await (await f.file()).text()) as Record<string, unknown>
    const str = (k: string) => (typeof j[k] === 'string' ? (j[k] as string) : '')
    info = { author: str('author'), style: str('preset_style'), comments: str('comments') }
  } catch { /* not a preset */ }
  metaCache.set(f.key, info)
  void tx('meta', 'readwrite', (s) => s.put({ key: f.key, lastModified: f.lastModified, info })).catch(() => undefined)
  return info
}

export function cachedPresetInfo(key: string): PresetInfo | undefined { return metaCache.get(key) }
