import { useEngine } from '../../engine/EngineContext'
import { toggleMidiInput, useMidi } from '../../engine/midi'
import { APP_NAME } from '../../name'
import { useVital } from './ctx'
import { R } from './hooks'

// The about box (about_section.cpp, laid out as the 1.5.5 capture s0f shows it): opened from the logo,
// over the blurred interface, closed by a click outside it. The mark and name are this build's own
// (it mustn't be called Vital); the version is the engine's. WINDOW SIZE scales the interface (100 %
// = Vital's 1440-point window at one CSS pixel per point); the audio rows describe the browser's
// output; MIDI INPUTS lists the keyboards the page can hear, each dot turning one on or off. Drawn in the
// Overlays section of the skin, as AboutSection is an Overlay.

export const WINDOW_SIZES = [0.4, 0.6, 0.8, 1, 1.2]
export const WINDOW_SIZE_KEY = 'vt.windowSize'

const ROWS: [string, number, number][] = [['Audio Driver:', 607, 667], ['Audio Output:', 682, 742], ['Sample Rate:', 757, 817], ['Buffer Size:', 832, 892]]

export function About() {
  const api = useVital()
  const { ctx } = useEngine()
  const midi = useMidi()
  if (!api.ui.about) return null
  const close = () => api.setUi({ about: undefined })
  const setSize = (m: number) => {
    try { localStorage.setItem(WINDOW_SIZE_KEY, String(m)) } catch { /* storage unavailable */ }
    api.setUi({ windowSize: m })
  }
  const rate = ctx?.sampleRate
  const buffer = ctx ? Math.max(128, Math.round((ctx.baseLatency || 0) * ctx.sampleRate)) : null
  const values = ['Web Audio', 'Default Output', rate ? String(rate) : '—', buffer ? String(buffer) : '—']
  return (
    <div className="vt-about" data-skin="Overlays" onPointerUp={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="vt-aboutbox" style={R(622, 194, 1377, 1056)} onPointerUp={(e) => e.stopPropagation()}>
        <svg className="vt-aboutmark" style={R(768 - 622, 293 - 194, 907 - 622, 437 - 194)} viewBox="0 0 52 56" aria-hidden="true">
          <circle cx={26} cy={28} r={21} fill="none" strokeWidth={3} />
          <path d="M9 28 C 15 12, 20 12, 26 28 S 37 44, 43 28" fill="none" strokeWidth={3} strokeLinecap="round" />
        </svg>
        <span className="vt-aboutname" style={R(860 - 622, 320 - 194, 1316 - 622, 392 - 194)}>{APP_NAME}</span>
        <span className="vt-aboutver" style={R(860 - 622, 404 - 194, 1316 - 622, 436 - 194)}>version 1.0.6</span>
        <span className="vt-aboutlbl" style={R(0, 521 - 194, 813 - 622, 577 - 194)}>Window Size:</span>
        {WINDOW_SIZES.map((m, i) => {
          const x = [829, 934, 1040, 1145, 1251][i]
          return <button key={m} type="button" className="vt-aboutbtn" style={R(x - 622, 521 - 194, x + 97.5 - 622, 577 - 194)} onClick={() => setSize(m)}>{Math.round(m * 100)}%</button>
        })}
        {ROWS.map(([label, y0, y1], i) => (
          <div key={label}>
            <span className="vt-aboutlbl" style={R(0, y0 - 194, 813 - 622, y1 - 194)}>{label}</span>
            <span className="vt-aboutfield" style={R(829 - 622, y0 - 194, 1348 - 622, y1 - 194)}>{values[i]}</span>
          </div>
        ))}
        <span className="vt-aboutlbl" style={R(0, 907 - 194, 813 - 622, 1027 - 194)}>MIDI Inputs:</span>
        <div className="vt-aboutmidi" style={R(829 - 622, 907 - 194, 1348 - 622, 1027 - 194)}>
          {midi.inputs.map((input) => (
            <button key={input.id} type="button" className={`vt-aboutin${input.enabled ? ' on' : ''}`} onClick={() => toggleMidiInput(input.id)}>
              <i />{input.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
