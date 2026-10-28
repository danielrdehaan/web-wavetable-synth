import { useEffect, useMemo, type ReactNode } from 'react'
import { Region, Stage } from './kit'
import { useSim } from './simContext'
import { useVital } from './vital/ctx'
import { AdvancedPage } from './vital/AdvancedPage'
import { About, WINDOW_SIZE_KEY } from './vital/About'
import { PresetBrowser } from './vital/PresetBrowser'
import { BankExporter } from './vital/BankExporter'
import { PopupBrowser } from './vital/PopupBrowser'
import './vital/builtinLibrary'
import { SaveOverlay } from './vital/SaveOverlay'
import { WavetableEditor } from './vital/WavetableEditor'
import { DragGhost } from './vital/DragGhost'
import { EffectsPage } from './vital/EffectsPage'
import { Header, Keyboard, Macros, type Page } from './vital/Frame'
import { R } from './vital/hooks'
import { setFrequencyUnits } from './vital/params'
import { MatrixPage } from './vital/MatrixPage'
import { EnvSection, GlideBox, LfoSection, MidiSources, RandSection, VoiceBox } from './vital/ModColumn'
import { MenuLayer, VitalProvider } from './vital/store'
import { VoicePage } from './vital/VoicePage'
import { layoutParts, makePartsFrame, PartsContext } from './vital/parts'
import { FlowLayer } from './vital/FlowLayer'
import { SkinProvider, SkinStyle } from './vital/skin'
import './vital.css'
import './vital/browsers.css'

// Vital 1.5.5's interface, redrawn and working, played by Vital's own engine: children render inside
// the store, and the app passes the engine link that way. Every position is measured from the deep capture (~/Documents/DAW-Reference/synths/vital/, CAPTURED-synths.md
// "Vital") in its 2000 × 1211 frame and halved; colours and the knob's proportions come from Vital's
// default skin (github.com/mtytel/vital, default.vitalskin); parameter ranges, defaults and menu names
// from its parameter table (vital/params.ts). The header mark is a neutral one, not Vital's logo.
//
// The macro column (left) and the modulator column (right) stay on every page; the centre is VOICE,
// EFFECTS, MATRIX or ADVANCED. A modulator connects Vital's way: drag its tab (or a macro, wheel or
// MIDI source) onto a control, then drag the ring that appears for the depth. The widget's connection
// task is LFO 1 → a filter's cutoff at a depth of at least 40 semitones.

/** `parts` shows only those sections (see vital/parts.tsx), laid out down a column or across a row
 *  (or each at its own place, `id@x:y`), instead of the whole window; `flow` draws the signal flow
 *  between them (FlowLayer). The wavetable editor still opens over the whole window. `skin` picks the
 *  skin by name (vital/skin.tsx) over the one chosen in THEME. */
export function VitalSim({ children, parts, layout, flow, skin }: { children?: ReactNode; parts?: string[]; layout?: 'column' | 'row'; flow?: boolean; skin?: string | null }) {
  return <VitalProvider><SkinProvider initial={skin}><VitalBody parts={parts} layout={layout} flow={flow} /></SkinProvider>{children}</VitalProvider>
}

/** The About box's WINDOW SIZE: 100 % is Vital's 1440-point window at one CSS pixel per point (1.44 ×
 *  the 1000-px stage); until one is chosen the stage fits the page up to 1.25 ×. */
function maxScale(chosen: unknown): number {
  let m = typeof chosen === 'number' ? chosen : NaN
  if (Number.isNaN(m)) { try { m = parseFloat(localStorage.getItem(WINDOW_SIZE_KEY) ?? '') } catch { /* storage unavailable */ } }
  return Number.isFinite(m) ? 1.44 * m : 1.25
}

function VitalBody({ parts, layout, flow }: { parts?: string[]; layout?: 'column' | 'row'; flow?: boolean }) {
  const { mechDone } = useSim()
  const api = useVital()
  const partsBody = usePartsBody(parts, layout, flow)
  const page = (api.ui.page as Page) ?? 'voice'
  const exporting = !!api.ui.bankExporter
  const browsing = !!api.ui.presetBrowser || exporting
  setFrequencyUnits(api.ui.advFreqUnits) // read by every popup's formatting below
  const connected = api.mods.some((m) => m.src === 'lfo_1' && /^filter_[12]_cutoff$/.test(m.dst) && Math.abs(m.amt) * 128 >= 40)
  useEffect(() => { if (connected) mechDone() }, [connected, mechDone])

  if (partsBody && !api.ui.wtEdit) return partsBody
  return (
    <Stage w={1000} h={606} maxScale={maxScale(api.ui.windowSize)} className={`vt${api.dragSrc ? ' vt-dragging' : ''}`}>
      <div className="vt-root" ref={api.rootRef} onContextMenu={(e) => e.preventDefault()}>
        <SkinStyle />
        <Header />
        <Macros />
        {browsing && (exporting ? <BankExporter /> : <PresetBrowser />)}
        {!browsing && page === 'voice' && <VoicePage />}
        {!browsing && page === 'effects' && <Region tags={['effects']} className="vt-page" style={R(127, 108, 1131, 1140)} label="EFFECTS page"><EffectsPage /></Region>}
        {!browsing && page === 'matrix' && <Region tags={['mod']} className="vt-page" style={R(127, 108, 1131, 1140)} label="MATRIX page"><MatrixPage /></Region>}
        {!browsing && page === 'advanced' && <div className="vt-page" style={R(127, 108, 1131, 1140)}><AdvancedPage /></div>}
        {!browsing && <><EnvSection />
          <LfoSection />
          <RandSection />
          <MidiSources />
          <VoiceBox />
          <GlideBox /></>}
        <Keyboard />
        <WavetableEditor />
        <DragGhost />
        <PopupBrowser />
        <SaveOverlay />
        <About />
        <MenuLayer />
      </div>
    </Stage>
  )
}

/** The parts view: each part at its place in the layout (a container shifted so the section draws at
 *  its own frame position), with the overlays the parts can open. */
function usePartsBody(parts: string[] | undefined, layout: 'column' | 'row' = 'column', flow = false) {
  const api = useVital()
  const key = parts?.join(',') ?? ''
  const { placed, w, h } = useMemo(() => layoutParts(parts ?? [], layout), [key, layout]) // eslint-disable-line react-hooks/exhaustive-deps
  const frame = useMemo(() => makePartsFrame(placed, w, h), [placed, w, h])
  // Each part's tab (which envelope, LFO or random source shows), again after Initialize or a load.
  useEffect(() => {
    const patch: Record<string, unknown> = {}
    for (const p of placed) Object.assign(patch, p.spec.ui)
    if (Object.keys(patch).length) api.setUi(patch)
  }, [key, api.patch.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!placed.length) return null
  return (
    <PartsContext.Provider value={frame}>
      <Stage w={w / 2} h={h / 2} maxScale={2} className={`vt vt-partsview${api.dragSrc ? ' vt-dragging' : ''}`}>
        <div className="vt-root" ref={api.rootRef} onContextMenu={(e) => e.preventDefault()}>
          <SkinStyle />
          {placed.map((p) => (
            <div key={p.id} className="vt-part" data-part={p.id} aria-label={p.spec.label} style={R(p.x, p.y, p.x + p.w, p.y + p.h)}>
              <div className="vt-partin" style={{ left: -p.spec.rect[0] / 2, top: -p.spec.rect[1] / 2 }}>{p.spec.render()}</div>
            </div>
          ))}
          {flow && <FlowLayer placed={placed} w={w} h={h} />}
          <DragGhost />
          <PopupBrowser />
          <SaveOverlay />
          <MenuLayer />
        </div>
      </Stage>
    </PartsContext.Provider>
  )
}
