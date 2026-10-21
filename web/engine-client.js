// Page-side handle on the synth engine: the audio worklet that plays it (engine-worklet.js) and the
// table worker that renders its wavetables and samples (table-worker.js). Everything is
// fire-and-forget except the calls that return engine state, which resolve a Promise. Anything that
// renders a table or band-limits a sample runs in the worker; the finished data is handed to the
// worklet as a job it copies in between audio blocks, so the audio thread never stalls on it.

export class SynthEngine {
  /** @param {AudioContext} ctx  @param {string} base  URL of the folder holding engine-worklet.js */
  static async create(ctx, base = new URL('.', import.meta.url).href) {
    await ctx.audioWorklet.addModule(new URL('engine-worklet.js', base))
    const node = new AudioWorkletNode(ctx, 'synth-engine', { numberOfInputs: 0, outputChannelCount: [2] })
    const worker = new Worker(new URL('table-worker.js', base), { type: 'module' })
    const engine = new SynthEngine(node, worker, ctx)
    await engine.ready
    return engine
  }

  constructor(node, worker, ctx) {
    this.node = node
    this.port = node.port
    this.ctx = ctx
    this.worker = worker
    this.workPending = new Map()
    this.params = []
    this.byId = {}
    this.pending = new Map()
    this.nextId = 1
    this.onModsFailed = null
    /** Called ~30 times a second with the watched status outputs' values (see watch()). */
    this.onStatus = null
    this.watched = []
    this.watchedTotals = []
    /** Each routing's engine slot, keyed "source>destination" (see onSlots). */
    this.slots = new Map()
    this.onSlots = null
    const workerReady = new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        const msg = e.data
        if (msg.type === 'ready') resolve()
        else if (msg.type === 'error') reject(new Error(msg.message))
        else if (msg.id && this.workPending.has(msg.id)) { this.workPending.get(msg.id)(msg); this.workPending.delete(msg.id) }
      }
      worker.onerror = (e) => reject(new Error(e.message))
      worker.postMessage({ type: 'start', rate: ctx.sampleRate })
    })
    this.ready = new Promise((resolve, reject) => {
      this.port.onmessage = (e) => {
        const msg = e.data
        if (msg.type === 'ready') {
          this.params = msg.params
          this.lanes = msg.lanes
          for (const p of msg.params) this.byId[p.id] = p
          workerReady.then(() => resolve(this), reject)
        } else if (msg.type === 'error') reject(new Error(msg.message))
        else if (msg.type === 'modsFailed') this.onModsFailed?.(msg.keys)
        else if (msg.type === 'midiFollow') this.onMidiFollow?.(msg)
        else if (msg.type === 'status') this.onStatus?.(msg.values, this.watched, msg.totals, this.watchedTotals)
        else if (msg.type === 'slots') { this.slots = new Map(msg.slots.map(([src, dst, slot]) => [`${src}>${dst}`, slot])); this.onSlots?.(this.slots) }
        else if (msg.id && this.pending.has(msg.id)) {
          if (msg.error) console.error('engine:', msg.error)
          this.pending.get(msg.id)(msg)
          this.pending.delete(msg.id)
        }
      }
    })
  }

  post(msg) { this.port.postMessage(msg) }
  ask(msg, transfer = []) {
    const id = this.nextId++
    return new Promise((resolve) => { this.pending.set(id, resolve); this.port.postMessage({ ...msg, id }, transfer) })
  }
  /** A request to the table worker. */
  work(msg, transfer = []) {
    const id = this.nextId++
    return new Promise((resolve) => { this.workPending.set(id, resolve); this.worker.postMessage({ ...msg, id }, transfer) })
  }
  /** Hands the worker's finished tables / sample (and a light preset or Initialize) to the worklet,
   *  which copies them in over the next audio blocks; resolves once they play. While the context is
   *  suspended no blocks run, so the worklet takes them at once. */
  job(job) {
    const transfer = [...(job.tables ?? []).flatMap((t) => t.arrays.map((a) => a.buffer)),
      ...(job.sample ? job.sample.buffers.map((a) => a.buffer) : []), ...(job.frame ? [job.frame.data.buffer] : [])]
    return this.ask({ type: 'job', ...job, immediate: this.ctx.state !== 'running' }, transfer)
  }

  noteOn(note, velocity = 0.8) { this.post({ type: 'noteOn', note, velocity }) }
  noteOff(note) { this.post({ type: 'noteOff', note }) }
  /** One raw MIDI message through the engine's MidiManager port (every channel, MPE zones). */
  midi(status, data1 = 0, data2 = 0) { this.post({ type: 'midi', status, data1, data2 }) }
  /** MPE ENABLED: member channels bend, press and slide their own notes. */
  setMpe(on) { this.post({ type: 'mpe', on }) }
  /** Loads a tuning from a file's text (kind 0 = .scl, 1 = .kbm, 2 = .tun); `name` names it (empty: the
   *  name set first, for the built-in scales). Resolves {name, isDefault}. */
  loadTuning(kind, text, name = '', setName = '') { return this.ask({ type: 'tuning', kind, text, name, setName }) }
  /** Back to 12-tone equal temperament. Resolves {name, isDefault}. */
  clearTuning() { return this.ask({ type: 'tuning', clear: true }) }
  allNotesOff() { this.post({ type: 'allNotesOff' }) }
  modWheel(value) { this.post({ type: 'modWheel', value }) }
  sustain(on) { this.post({ type: 'sustain', on }) }
  /** Runs a modulation source while it's selected, even unconnected (SynthBase::forceShowModulation). */
  forceShow(source, on) { this.post({ type: 'forceShow', source, on }) }
  /** Re-syncs tempo-locked modulators to song time `seconds` (Vital's standalone Space key uses 0). */
  correctToTime(seconds) { this.post({ type: 'correctToTime', seconds }) }
  pitchWheel(value) { this.post({ type: 'pitchWheel', value }) }
  setBpm(bpm) { this.post({ type: 'bpm', bpm }) }
  set(id, value) { this.post({ type: 'set', id, value }) }
  setMany(values) { this.post({ type: 'setMany', values }) }
  /** Replaces every modulation routing with `list` [{src, dst, amt, bipolar, stereo, bypass, power}]. */
  setMods(list) { this.post({ type: 'mods', list }) }
  /** Back to the init patch (both engines); resolves with every control's value. */
  async init() {
    const r = await this.work({ type: 'init' })
    return this.job({ init: true, tables: r.tables, sample: r.sample, ids: this.params.map((p) => p.id) })
  }
  /** Loads a .vital preset's JSON text; resolves {ok, values, mods, tables, sample, lfos}. The worker
   *  reads it and renders its tables and sample; the worklet takes those and the rest. */
  async loadPreset(text) {
    const r = await this.work({ type: 'preset', text })
    if (!r.ok) return { ok: false, values: {}, mods: [] }
    return this.job({ tables: r.tables, sample: r.sample, light: r.light, ids: this.params.map((p) => p.id) })
  }
  /** The oscillator display as Vital computes it: the frame nearest `frame` (0–256), spectrally morphed
   *  and phase-distorted. Resolves {wave: 2048 samples, spectrum: 1024 harmonic magnitudes}. */
  oscDisplay(osc, { frame, morphType, morph, distortionType, distortion, distortionPhase }) {
    return this.ask({ type: 'oscDisplay', osc, frame, morphType, morph, distortionType, distortion, distortionPhase })
  }
  /** A filter's response as Vital's display computes it: 512 levels (−1…1 = −30…20 dB) from MIDI note 8 to
   *  137. On the formant model pass formant transpose / resonance / spread as transpose / resonance / blend. */
  async filterResponse({ model, style, cutoff, resonance, blend, transpose, formantX, formantY, mix, combPeriod, driveOverride, xMin, xMax }) {
    return (await this.ask({ type: 'filterResponse', model, style, cutoff, resonance, blend, transpose, formantX, formantY, mix, combPeriod, driveOverride, xMin, xMax })).data
  }
  /** The distortion's transfer curve: `points` outputs (× 0.9) for inputs −1…1 at that type and drive. */
  async distortionCurve(distortionType, drive, points = 128) { return (await this.ask({ type: 'distortionCurve', distortionType, drive, points })).data }
  /** The distortion filter's display: 256 levels (−1…1 = −30…20 dB). */
  async distortionFilter(cutoff, resonance, blend, minCutoff) { return (await this.ask({ type: 'distortionFilter', cutoff, resonance, blend, minCutoff })).data }
  /** The equalizer display: `bands` = [low, band, high], each {cutoff, resonance, gain, pass} where `pass`
   *  is the low band's high-pass, the band's notch, the high band's low-pass. Resolves 128 dB values. */
  /** The oscilloscope window, or with `spectrogram` ({ id, source, minDb, maxDb, minFreq, maxFreq }) one
   *  frame of that spectrogram display. */
  async scope(spectrogram = null) { return (await this.ask({ type: 'scope', spectrogram })).data }
  async eqResponse(bands) { return (await this.ask({ type: 'eqResponse', bands })).data }
  /** Every raw frame of an oscillator's wavetable, `points` samples each; resolves {count, points, data}. */
  wavetableFrames(osc, points = 128) { return this.ask({ type: 'wavetableFrames', osc, points }) }
  /** One 2048-sample frame of an oscillator's wavetable at position 0..1. */
  async frame(osc, position) { return (await this.ask({ type: 'frame', osc, position })).data }
  /** Replaces oscillator `osc`'s (0–2) wavetable with WavetableCreator JSON; resolves {ok}. */
  async setWavetable(osc, data) {
    const r = await this.work({ type: 'setWavetable', osc, data })
    if (r.ok) await this.job({ tables: [r.table] })
    return { ok: !!r.ok }
  }
  /** The whole patch as .vital preset text. `meta`: {preset_name, author, comments, preset_style, macro1…4}.
   *  The worklet writes the controls, routings and LFOs; the worker adds the wavetables and sample. */
  async savePreset(meta = {}) {
    const light = (await this.ask({ type: 'save', meta })).text
    return (await this.work({ type: 'merge', text: light })).text
  }
  /** Loads the sampler's audio: `left` (and `right` for stereo) Float32Arrays at `sampleRate`, named
   *  `name`. Resolves {length, name}: the samples kept and the sample's name. */
  async loadSample(left, right, sampleRate, name) {
    const r = await this.work({ type: 'loadSample', left, right: right ?? null, sampleRate, name }, [left.buffer, ...(right ? [right.buffer] : [])])
    if (r.sample) await this.job({ sample: r.sample })
    return { length: r.length, name: r.name }
  }
  /** The sampler's sample: {length, name, peaks: 256 bins of the left channel's largest value}. */
  sampleInfo() { return this.work({ type: 'sampleInfo' }) }
  /** Resynthesize Preset to Wavetable for oscillator `osc`: the worker plays the current patch (the
   *  worklet's controls and routings) and splices it. Resolves {ok}. */
  async resynthesize(osc) {
    const light = (await this.ask({ type: 'save', meta: {} })).text
    const r = await this.work({ type: 'resynthesize', osc, light })
    await this.job({ tables: [r.table] })
    return { ok: !!r.ok }
  }
  /** Makes oscillator `osc`'s wavetable from audio (one channel at its own rate): `style` 1 = wavetable
   *  splice, 2 = vocoded, 4 = pitch splice; `fade` the splice's fade style (0 blend, 1 none, 2 time,
   *  3 frequency). Resolves {ok}. */
  async wavetableFromAudio(osc, data, sampleRate, style, fade, name, author = '') {
    const r = await this.work({ type: 'wavetableAudio', osc, data, sampleRate, style, fade, name, author }, [data.buffer])
    await this.job({ tables: [r.table] })
    return { ok: !!r.ok }
  }
  /** One wavetable-editor call on an oscillator's WavetableCreator (`op` names a vs_wt_* glue function:
   *  layout, keyframe, setKeyframe, setComponent, insert, remove, move, repositionAll, addSource,
   *  addModifier, removeComponent, moveComponent, reset, flags, render, renderBuffer, waveFrame,
   *  waveTime, waveFreq, line, fileLoad, filePeaks), with that function's arguments. Runs in the
   *  worker; a table it rendered reaches the worklet before this resolves, a single frame just after. */
  async wavetableEdit(op, ...args) {
    const r = await this.work({ type: 'wt', op, args })
    if (r.table) await this.job({ tables: [r.table] })
    else if (r.frame) void this.job({ frame: r.frame })
    const { table: _t, frame: _f, ...result } = r
    return result
  }
  /** Oscillator `osc`'s wavetable as WavetableCreator JSON. */
  async wavetableJson(osc) { return (await this.work({ type: 'wavetableJson', osc })).data }
  /** Sets the remap curve of the src → dst routing (LineGenerator JSON, y 0 = top); resolves {ok}. */
  setRemap(src, dst, data) { return this.ask({ type: 'remap', src, dst, data }) }
  /** Replaces LFO `index`'s (0–7) shape with LineGenerator JSON (y 0 = top); resolves {ok}. */
  setLfo(index, data) { return this.ask({ type: 'lfo', index, data }) }
  /** Every control's current value and the routings, as the engine holds them. */
  values() { return this.ask({ type: 'values', ids: this.params.map((p) => p.id) }) }
  stats() { return this.ask({ type: 'stats' }) }
  /** Streams these status outputs ("lfo_1_phase", "env_1_phase", "num_voices", "peak_meter",
   *  "chorus_delays1"…) to onStatus as a Float32Array, `lanes` values per name in the same order. A
   *  cleared output (no voice playing) reads as about −2.1e9. Replaces any earlier watch. */
  watch(names) { this.watched = [...names]; this.post({ type: 'watch', names: this.watched }) }
  /** Streams these modulation destinations' live values (in the control's own units, as Vital's knob
   *  meters show them) to onStatus's third argument, in this order. Replaces any earlier list. */
  watchTotals(names) { this.watchedTotals = [...names]; this.post({ type: 'watchTotals', names: this.watchedTotals }) }
}
