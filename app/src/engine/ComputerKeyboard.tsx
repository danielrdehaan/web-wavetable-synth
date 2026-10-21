import { useEffect, useRef } from 'react'
import { useVital } from '../sim/vital/ctx'
import { useEngine } from './EngineContext'
import { noteVelocity } from './velocity'

// Vital's computer keyboard (standalone/synth_computer_keyboard.cpp): the row A W S E D F T G Y H U J
// K O L P ; ' plays from C3 (MIDI 48) up at velocity 1.0; Z and X shift an octave (the offset stays in
// 0 … 120) and release what's held; Space re-syncs tempo-locked modulators to time 0. Ignored while
// typing in a field.

const LAYOUT = "awsedftgyhujkolp;'"
const OFFSET = 48

export function ComputerKeyboard() {
  const api = useVital()
  const { engine } = useEngine()
  const setNote = useRef(api.setNote)
  const engineRef = useRef(engine)
  useEffect(() => { setNote.current = api.setNote; engineRef.current = engine })

  useEffect(() => {
    let octave = 0
    const down = new Map<string, number>()
    const releaseAll = () => { for (const note of down.values()) { setNote.current(note, false); noteVelocity.delete(note) } down.clear() }
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || typing(e)) return
      const key = e.key.toLowerCase()
      if (key === ' ') { e.preventDefault(); engineRef.current?.correctToTime(0); return }
      if (key === 'z' || key === 'x') {
        const next = Math.max(-4, Math.min(6, octave + (key === 'z' ? -1 : 1)))
        if (next !== octave) { releaseAll(); octave = next }
        return
      }
      const i = LAYOUT.indexOf(key)
      if (i < 0 || down.has(key)) return
      const note = OFFSET + octave * 12 + i
      if (note < 0 || note > 127) return
      down.set(key, note)
      noteVelocity.set(note, 1)
      setNote.current(note, true)
    }
    const onUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      const note = down.get(key)
      if (note === undefined) return
      down.delete(key)
      setNote.current(note, false)
      noteVelocity.delete(note)
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', releaseAll)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', releaseAll)
      releaseAll()
    }
  }, [])

  return null
}
