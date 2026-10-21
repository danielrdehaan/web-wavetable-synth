import { useEffect } from 'react'
import { useVital } from '../sim/vital/ctx'
import { useEngine } from './EngineContext'
import { bindMidi, connectMidi, useMidi } from './midi'

// The page's MIDI button and status (the routing itself is engine/midi.ts). Browsers ask before
// granting MIDI, so it starts from a button rather than on load.

export function MidiInput() {
  const api = useVital()
  const { engine } = useEngine()
  const { status, inputs } = useMidi()
  useEffect(() => { bindMidi(api, engine) })
  if (status === 'unsupported') return <span className="app-midi">This browser has no MIDI input.</span>
  if (status === 'denied') return <span className="app-midi">MIDI access was refused.</span>
  if (status === 'on') return <span className="app-midi">MIDI: {inputs.length ? inputs.map((i) => i.name).join(', ') : 'no keyboard connected'}</span>
  return <button type="button" className="app-midi-btn" onClick={() => void connectMidi()}>Connect a MIDI keyboard</button>
}
