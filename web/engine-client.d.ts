// Types for engine-client.js.

export interface EngineParam {
  id: string
  name: string
  min: number
  max: number
  default: number
  /** vital::ValueDetails::ValueScale: 0 indexed, 1 linear, 2 quadratic, 3 cubic, 4 quartic, 5 sqrt, 6 exponential. */
  scale: number
  units: string
  multiply: number
  post_offset: number
  invert: boolean
  options?: string[]
}

export interface EngineMod {
  src: string
  dst: string
  amt: number
  bipolar: boolean
  stereo: boolean
  bypass: boolean
  power: number
  /** The routing's remap curve (only in state read back from the engine). */
  remap?: LineShape
}

/** Vital's LineGenerator JSON: points flattened [x0, y0, x1, y1…] with y 0 = top, one power per point. */
export interface LineShape {
  num_points: number
  points: number[]
  powers: number[]
  smooth?: boolean
  name?: string
}

export interface EngineState {
  ok?: boolean
  values: Record<string, number>
  mods: EngineMod[]
  /** Each oscillator's wavetable name. */
  tables?: string[]
  /** The sampler's sample name. */
  sample?: string
  /** Each LFO's shape. */
  lfos?: LineShape[]
}

export interface SpectrogramSpec { id: number; source?: 0 | 1; minDb?: number; maxDb?: number; minFreq?: number; maxFreq?: number }

export class SynthEngine {
  static create(ctx: BaseAudioContext, base?: string): Promise<SynthEngine>
  readonly node: AudioWorkletNode
  readonly params: EngineParam[]
  readonly byId: Record<string, EngineParam>
  /** Values per status output (poly_float lanes): 4 in this build. */
  readonly lanes: number
  onModsFailed: ((keys: string[]) => void) | null
  /** `totals` holds each watched control's left then right modulated value (2 per name). */
  onStatus: ((values: Float32Array, names: string[], totals: Float32Array, totalNames: string[]) => void) | null
  /** Each routing's engine slot (1-based: its modulation_source_N / modulation_amount_N status), keyed
   *  "source>destination"; onSlots fires whenever the routings change. */
  readonly slots: Map<string, number>
  onSlots: ((slots: Map<string, number>) => void) | null
  watch(names: string[]): void
  watchTotals(names: string[]): void
  noteOn(note: number, velocity?: number): void
  noteOff(note: number): void
  allNotesOff(): void
  modWheel(value: number): void
  sustain(on: boolean): void
  /** Runs a modulation source while it's selected, even unconnected (SynthBase::forceShowModulation). */
  forceShow(source: string, on: boolean): void
  correctToTime(seconds: number): void
  pitchWheel(value: number): void
  setBpm(bpm: number): void
  set(id: string, value: number): void
  setMany(values: Record<string, number>): void
  setMods(list: EngineMod[]): void
  init(): Promise<EngineState>
  loadPreset(text: string): Promise<EngineState>
  savePreset(meta?: { preset_name?: string; author?: string; comments?: string; preset_style?: string; macro1?: string; macro2?: string; macro3?: string; macro4?: string }): Promise<string>
  frame(osc: number, position: number): Promise<Float32Array>
  oscDisplay(osc: number, values: { frame: number; morphType: number; morph: number; distortionType: number; distortion: number; distortionPhase: number }): Promise<{ wave: Float32Array; spectrum: Float32Array }>
  filterResponse(values: { model: number; style: number; cutoff: number; resonance: number; blend: number; transpose: number; formantX: number; formantY: number; mix: number; combPeriod?: number; driveOverride?: number; xMin?: number; xMax?: number }): Promise<Float32Array>
  distortionCurve(distortionType: number, drive: number, points?: number): Promise<Float32Array>
  distortionFilter(cutoff: number, resonance: number, blend: number, minCutoff: number): Promise<Float32Array>
  /** The oscilloscope window (512 left then 512 right, −1 … 1), or with `spectrogram` one frame of that
   *  spectrogram display (300 left then 300 right heights, 0 … 1 over minDb … maxDb). Each `id` (0–3)
   *  keeps its own decaying levels; `source` 1 reads the equalizer's memory instead of the output. */
  scope(spectrogram?: SpectrogramSpec | null): Promise<Float32Array>
  eqResponse(bands: { cutoff: number; resonance: number; gain: number; pass: boolean }[]): Promise<Float32Array>
  wavetableFrames(osc: number, points?: number): Promise<{ count: number; points: number; data: Float32Array }>
  setWavetable(osc: number, data: unknown): Promise<{ ok: boolean }>
  wavetableJson(osc: number): Promise<unknown>
  /** One wavetable-editor call (see engine-client.js): resolves {data?, ok?, index?, length?}. */
  wavetableEdit(op: string, ...args: unknown[]): Promise<{ data?: any; ok?: boolean; index?: number; length?: number }>
  loadSample(left: Float32Array, right: Float32Array | null, sampleRate: number, name: string): Promise<{ length: number; name: string }>
  sampleInfo(): Promise<{ length: number; name: string; peaks: Float32Array }>
  setLfo(index: number, data: LineShape): Promise<{ ok: boolean }>
  setRemap(src: string, dst: string, data: LineShape): Promise<{ ok: boolean }>
  values(): Promise<EngineState>
  /** Voices playing, and the longest render call and message handler on the audio thread since the last call. */
  stats(): Promise<{ voices: number; longestBlockMs: number; longestMessageMs: number }>
  midi(status: number, data1?: number, data2?: number): void
  setMpe(on: boolean): void
  /** The interface should follow a MIDI message: follow 1 = mod wheel, 2 = pitch wheel, 4 = MIDI learn. */
  onMidiFollow?: (msg: { follow: number; status: number; data1: number; data2: number }) => void
  loadTuning(kind: number, text: string, name?: string, setName?: string): Promise<{ name: string; isDefault: boolean }>
  clearTuning(): Promise<{ name: string; isDefault: boolean }>
  resynthesize(osc: number): Promise<{ ok: boolean }>
  wavetableFromAudio(osc: number, data: Float32Array, sampleRate: number, style: number, fade: number, name: string, author?: string): Promise<{ ok: boolean }>
}
