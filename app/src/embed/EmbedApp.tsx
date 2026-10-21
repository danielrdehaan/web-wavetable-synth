import { ComputerKeyboard } from '../engine/ComputerKeyboard'
import { EngineProvider, useEngine } from '../engine/EngineContext'
import { EngineSync } from '../engine/EngineSync'
import { VitalSim } from '../sim/VitalSim'
import { parsePart, PARTS } from '../sim/vital/parts'
import { EmbedBridge } from './EmbedBridge'
import './embed.css'

// The synth framed in another page (`?embed=1`): the whole window, or only the sections in `parts`
// (comma separated, see sim/vital/parts.tsx) down a column or across a row (`layout=row`), or each at
// its own place (`osc1@0:0`), filling the frame's width; `flow=1` draws the signal flow between them. `host` is the framing page's origin, for the protocol (EmbedBridge). Sound starts on
// the first click or key press inside the frame.

export function EmbedApp({ params }: { params: URLSearchParams }) {
  const parts = (params.get('parts') ?? '').split(',').map((s) => s.trim()).filter((p) => parsePart(p).id in PARTS)
  const layout = params.get('layout') === 'row' ? 'row' : 'column'
  return (
    <EngineProvider>
      <main className="embed">
        <VitalSim parts={parts.length ? parts : undefined} layout={layout} flow={params.get('flow') === '1'}>
          <EngineSync />
          <ComputerKeyboard />
          <EmbedBridge host={params.get('host')} parts={parts} />
        </VitalSim>
        <SoundHint />
      </main>
    </EngineProvider>
  )
}

function SoundHint() {
  const { status, error } = useEngine()
  if (status === 'on') return null
  const text = { off: 'Click to turn the sound on', loading: 'Starting…', error: `The synth couldn't start: ${error ?? 'unknown error'}` }[status]
  return <p className={`embed-hint ${status}`} role="status">{text}</p>
}
