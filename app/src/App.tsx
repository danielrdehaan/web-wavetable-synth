import { ComputerKeyboard } from './engine/ComputerKeyboard'
import { EngineProvider, useEngine } from './engine/EngineContext'
import { EngineSync } from './engine/EngineSync'
import { MidiInput } from './engine/MidiInput'
import { APP_NAME } from './name'
import { VitalSim } from './sim/VitalSim'
import './sim/synthSim.css'

// The synth on its own page: the redrawn interface, played by the engine. Sound starts on the first
// click or key press (see EngineContext).

export function App() {
  return (
    <EngineProvider>
      <main className="app">
        <VitalSim>
          <EngineSync />
          <ComputerKeyboard />
          <div className="app-bar"><SoundStatus /><MidiInput /></div>
        </VitalSim>
        <footer className="app-foot">
          {APP_NAME} runs the synthesis engine from <a href="https://github.com/mtytel/vital">Vital</a>'s
          open-source code (version 1.0.6), compiled for the browser. Free software under the GNU GPL v3.
          Not made by or affiliated with Vital Audio.
        </footer>
      </main>
    </EngineProvider>
  )
}

function SoundStatus() {
  const { status, error } = useEngine()
  const text = {
    off: 'Click anywhere or press a key to turn the sound on. Play with the on-screen keys or A W S E D F T G Y H U J K (Z / X change octave).',
    loading: 'Starting the engine…',
    on: 'Sound is on. Keys: A W S E D F T G Y H U J K O L P (Z / X change octave).',
    error: `The engine couldn't start: ${error ?? 'unknown error'}`,
  }[status]
  return <p className={`app-status ${status}`} role="status">{text}</p>
}
