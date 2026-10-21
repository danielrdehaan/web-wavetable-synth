import { useEffect, useRef, useState } from 'react'
import { useEngine } from '../../engine/EngineContext'
import { saveUserFile, userFileNamed, type Kind } from '../../engine/library'
import { useVital } from './ctx'
import { PRESET_STYLES } from './PresetBrowser'

// Vital's SaveSection (save_section.cpp): a 630 × 450 pt box over the Overlay Screen with NAME,
// AUTHOR, STYLE (one of nine, or none) and COMMENTS, Cancel and Save; saving a name that's taken asks
// "Overwrite existing file?" first. A preset saves into User with its author, style and comments (the
// author is remembered for the next save); wavetables and LFO shapes save with a name and author only
// (the shorter box). Return saves; a click outside the box cancels.

const PT = 1000 / 1440
const AUTHOR_KEY = 'vt.author'

export interface SaveRequest {
  kind: Kind
  /** The file's text for a wavetable or LFO shape (its "name" and "author" are filled in on save). */
  data?: Record<string, unknown>
  ext: string
  name: string
}

/** What to do once the open save box has saved (the library entry's key): kept out of the store. */
let onSaved: ((key: string) => void) | null = null

/** Opens the save box. */
export function requestSave(api: { setUi: (u: Record<string, unknown>) => void }, req: SaveRequest, done?: (key: string) => void) {
  onSaved = done ?? null
  api.setUi({ saving: req })
}

export function SaveOverlay() {
  const api = useVital()
  const { engine } = useEngine()
  const req = api.ui.saving as SaveRequest | undefined
  const preset = req?.kind === 'preset'
  const [name, setName] = useState('')
  const [author, setAuthor] = useState('')
  const [comments, setComments] = useState('')
  const [style, setStyle] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const nameBox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!req) return
    let remembered = ''
    try { remembered = localStorage.getItem(AUTHOR_KEY) ?? '' } catch { /* storage unavailable */ }
    setName(req.name === 'Init Preset' ? '' : req.name)
    setAuthor(preset ? ((api.ui.preset_author as string | undefined) || remembered) : remembered)
    setComments(preset ? ((api.ui.preset_comments as string | undefined) ?? '') : '')
    setStyle(preset ? ((api.ui.preset_style as string | undefined) ?? '') : '')
    setOverwrite(false)
    setTimeout(() => nameBox.current?.focus())
  }, [req]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!req) return null
  const close = () => api.setUi({ saving: undefined })

  const save = async () => {
    const n = name.trim().replace(/[<>?*/|\\[\]":]/g, '')
    if (!n || !engine) return
    if (!overwrite && userFileNamed(req.kind, n)) { setOverwrite(true); return }
    let text: string
    if (preset) {
      try { localStorage.setItem(AUTHOR_KEY, author.trim()) } catch { /* storage unavailable */ }
      const meta = { preset_name: n, author: author.trim().replace(/"/g, ''), comments: comments.trim().replace(/"/g, ''), preset_style: style }
      const macros = Object.fromEntries([0, 1, 2, 3].map((m) => [`macro${m + 1}`, (api.ui[`macro_${m}_name`] as string | undefined) ?? `MACRO ${m + 1}`]))
      text = await engine.savePreset({ ...meta, ...macros })
      api.setUi({ preset_name: n, preset_author: meta.author, preset_comments: meta.comments, preset_style: style, modified: false })
    } else {
      try { localStorage.setItem(AUTHOR_KEY, author.trim()) } catch { /* storage unavailable */ }
      text = JSON.stringify({ ...(req.data ?? {}), name: n, author: author.trim() })
    }
    const entry = await saveUserFile(req.kind, n, req.ext, new Blob([text], { type: 'application/json' }))
    if (preset) api.setUi({ presetFile: entry.key, presetExternal: undefined })
    onSaved?.(entry.key)
    onSaved = null
    close()
  }

  const w = 630 * PT
  const h = (preset ? 450 : 37 * 2 + 40 + 20 * 4 + 10) * PT
  const padX = 25 * PT, padY = 25 * PT, top = 10 * PT, division = 150 * PT, editorH = 37 * PT, styleH = 24 * PT, styleGap = 4 * PT, buttonH = 40 * PT
  const editorX = padX + division, editorW = w - 2 * padX - division
  const styleY = 3 * padY + 2 * editorH + top
  const commentsY = styleY + 3 * styleH + 2 * styleGap + padY
  const buttonW = (w - 3 * padX) / 2
  const label = (text: string, y: number, height: number) => <span className="vt-savelbl" style={{ left: padX, top: y, width: division - 10 * PT, height }}>{text}</span>
  const kind = preset ? 'Preset' : req.kind === 'wavetable' ? 'Wavetable' : 'LFO'

  return (
    <div className="vt-overlay" onPointerUp={(e) => { if (e.target === e.currentTarget) close() }}
      onKeyDown={(e) => { if (e.key === 'Escape') close() }}>
      {overwrite ? (
        <div className="vt-ovbox" style={{ width: 340 * PT, height: 160 * PT }}>
          <span className="vt-ovtext" style={{ top: 34 * PT }}>Overwrite existing file?</span>
          <button type="button" className="vt-uibtn" style={{ left: padX, bottom: 20 * PT, width: (340 * PT - 3 * padX) / 2, height: buttonH }} onClick={close}>Cancel</button>
          <button type="button" className="vt-uibtn primary" style={{ right: padX, bottom: 20 * PT, width: (340 * PT - 3 * padX) / 2, height: buttonH }} onClick={() => void save()}>Overwrite</button>
        </div>
      ) : (
        <div className="vt-ovbox" style={{ width: w, height: h }}>
          {label('NAME', top + padY, editorH)}
          <input ref={nameBox} className="vt-saveedit" style={{ left: editorX, top: padY + top, width: editorW, height: editorH }} placeholder={`${kind} Name`}
            value={name} onChange={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save() }} />
          {label('AUTHOR', top + 2 * padY + editorH, editorH)}
          <input className="vt-saveedit" style={{ left: editorX, top: 2 * padY + editorH + top, width: editorW, height: editorH }} placeholder="Author"
            value={author} onChange={(e) => setAuthor(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save() }} />
          {preset && <>
            {label('STYLE', top + 3 * padY + 2 * editorH, 3 * styleH + 2 * styleGap)}
            {PRESET_STYLES.map((s, i) => {
              const col = i % 3, sw = editorW + styleGap
              const x = editorX + (sw * col) / 3, nx = editorX + (sw * (col + 1)) / 3
              return (
                <button key={s} type="button" className={`vt-pb-style${style === s ? ' on' : ''}`}
                  style={{ position: 'absolute', left: x, top: styleY + Math.floor(i / 3) * (styleH + styleGap), width: nx - x - styleGap, height: styleH }}
                  onClick={() => setStyle(style === s ? '' : s)}>{s}</button>
              )
            })}
            {label('COMMENTS', top + 4 * padY + 3 * styleH + 2 * styleGap + 2 * editorH, editorH)}
            <textarea className="vt-saveedit area" style={{ left: editorX, top: commentsY, width: editorW, height: h - padY - buttonH - commentsY - padY }} placeholder="Comments"
              value={comments} onChange={(e) => setComments(e.currentTarget.value)} />
          </>}
          <button type="button" className="vt-uibtn" style={{ left: padX, bottom: padY, width: buttonW, height: buttonH }} onClick={close}>Cancel</button>
          <button type="button" className="vt-uibtn primary" style={{ right: padX, bottom: padY, width: buttonW, height: buttonH }} onClick={() => void save()}>Save</button>
        </div>
      )}
    </div>
  )
}
