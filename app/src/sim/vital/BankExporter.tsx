import { useState } from 'react'
import { exportBank, useLibraryVersion, userContent, type Kind, type LibFile } from '../../engine/library'
import { useVital } from './ctx'
import { R } from './hooks'

// Vital's BankExporter (bank_exporter.cpp), over the centre and modulator column like the preset
// browser: the User presets on the left, the bank name and Export Bank along the top right, then the
// User wavetables, LFOs and samples. Each row's + adds the file to the bank; Export Bank (lit once the
// bank has a name) downloads <name>.vitalbank, a zip of <name>/Presets, Wavetables, LFOs and Samples.

const ROW = 26 * 1000 / 1440
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dateText = (t: number) => { if (!t) return ''; const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` }

function ContentList({ title, files, chosen, toggle, at }: { title: string; files: LibFile[]; chosen: Set<string>; toggle: (k: string) => void; at: [number, number, number, number] }) {
  const w = (at[2] - at[0]) / 2
  return (
    <div className="vt-cl" style={R(...at)}>
      <div className="vt-cl-head" style={{ height: ROW * 1.2 }}>
        <span style={{ left: 0.04 * w + ROW / 2 }}>{title} Name</span>
        <span className="date" style={{ right: ROW / 2 }}>Date</span>
      </div>
      <div className="vt-cl-rows">
        {[...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((f) => (
          <div key={f.key} className={`vt-cl-row${chosen.has(f.key) ? ' on' : ''}`} style={{ height: ROW }} onClick={() => toggle(f.key)}>
            <svg className="vt-cl-add" viewBox="0 0 1 1" style={{ left: (0.04 * w - ROW * 0.6) / 2 + 2, width: ROW * 0.6, height: ROW * 0.6 }}>
              <circle cx={0.5} cy={0.5} r={0.4} /><path d="M0.5 0.28 V0.72 M0.28 0.5 H0.72" />
            </svg>
            <span style={{ left: 0.04 * w + ROW / 2, width: 0.76 * w - ROW }}>{f.name}</span>
            <span className="date" style={{ right: ROW / 2 }}>{dateText(f.lastModified)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function BankExporter() {
  const api = useVital()
  useLibraryVersion()
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const toggle = (k: string) => setChosen((c) => { const n = new Set(c); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const list = (kind: Kind) => userContent(kind)
  const ok = name.trim() !== '' && chosen.size > 0
  const run = async () => {
    if (!ok) return
    const blob = await exportBank(name.trim(), chosen)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${name.trim().replace(/[\\/:*?"<>|]/g, '_')}.vitalbank`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    api.setUi({ bankExporter: undefined })
  }
  // resized(): the preset list takes the left half; the right half's top 8 % holds the bank name and
  // the button, the rest three equal lists.
  const W = 1859, H = 1032, pad = 10 * 2000 / 1440, half = W / 2 - pad, x2 = W - half, opts = 0.08 * H
  const third = (H - opts - 2 * pad) / 3
  const margin = 5.5 * 2000 / 1440
  return (
    <div className="vt-pb vt-bank" style={R(127, 108, 1986, 1140)}>
      <ContentList title="Preset" files={list('preset')} chosen={chosen} toggle={toggle} at={[0, 0, half, H]} />
      <input className="vt-pb-input" style={R(x2 + margin, margin, x2 + margin + (half - 3 * margin) / 2, opts - pad - margin)} placeholder="Bank Name"
        value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <button type="button" className={`vt-uibtn${ok ? ' primary' : ' off'}`} style={R(x2 + 2 * margin + (half - 3 * margin) / 2, margin, x2 + half - margin, opts - pad - margin)}
        onClick={() => void run()}>Export Bank</button>
      <ContentList title="Wavetable" files={list('wavetable')} chosen={chosen} toggle={toggle} at={[x2, opts, W, opts + third]} />
      <ContentList title="LFO" files={list('lfo')} chosen={chosen} toggle={toggle} at={[x2, opts + third + pad, W, opts + 2 * third + pad]} />
      <ContentList title="Sample" files={list('sample')} chosen={chosen} toggle={toggle} at={[x2, H - third, W, H]} />
    </div>
  )
}
