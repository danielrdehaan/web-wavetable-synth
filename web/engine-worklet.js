// AudioWorklet processor hosting the WebAssembly synth engine that plays. The page talks to it only
// through port messages (see engine-client.js). Wavetables and the sample are rendered elsewhere (the
// table worker, table-worker.js): they arrive as jobs this processor copies in between audio blocks
// and swaps in whole (pump), so nothing here renders a table or band-limits a sample.
import createEngine from './engine.mjs'

const BLOCK = 128
/** Render blocks between status packets (~31 a second at 48 kHz). */
const STATUS_EVERY = 12
/** Floats of staged table or sample data copied into the engine per render quantum (8 MB, well under
 *  a millisecond), so a heavy preset arrives over a few blocks instead of stalling one. */
const COPY_BUDGET = 2 * 1024 * 1024

class SynthEngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.m = null
    this.queue = []
    /** Connected routings, keyed "src→dst", with the engine slot each one occupies. */
    this.routes = new Map()
    /** Watched status outputs: their names, a heap array of handles and one of values read into. */
    this.watch = null
    /** Watched modulation destinations: names, heap arrays of mono and poly total handles, values. */
    this.totals = null
    this.blocks = 0
    /** Jobs from the table worker (see pump): staged tables / sample, then a light preset or init. */
    this.jobs = []
    /** The longest render call and message handler since the last stats call, in ms (Date.now: the
     *  worklet scope has no performance.now), so the page can see the audio thread was never held up. */
    this.longest = { block: 0, message: 0 }
    this.port.onmessage = (e) => {
      if (!this.m) { this.queue.push(e.data); return }
      const t0 = Date.now()
      this.handle(e.data)
      this.longest.message = Math.max(this.longest.message, Date.now() - t0)
    }
    createEngine().then((m) => {
      this.m = m
      m.ccall('vs_init', null, ['number'], [sampleRate])
      this.lanes = m._vs_status_lanes()
      const params = JSON.parse(m.ccall('vs_params_json', 'string', [], []))
      this.port.postMessage({ type: 'ready', params, sampleRate, lanes: this.lanes })
      for (const msg of this.queue) this.handle(msg)
      this.queue = []
    }).catch((err) => this.port.postMessage({ type: 'error', message: String(err) }))
  }

  str(name, ret, args, vals) { return this.m.ccall(name, ret, args, vals) }

  set(id, value) { return this.str('vs_set_param', 'number', ['string', 'number'], [id, value]) }

  /** Makes the engine's routings match `list` [{src, dst, amt, bipolar, stereo, bypass, power}]. */
  syncMods(list) {
    const want = new Map(list.map((r) => [`${r.src}→${r.dst}`, r]))
    for (const [key, route] of this.routes) {
      if (want.has(key)) continue
      this.str('vs_disconnect', null, ['string', 'string'], [route.src, route.dst])
      this.routes.delete(key)
    }
    const failed = []
    for (const [key, r] of want) {
      let route = this.routes.get(key)
      if (!route) {
        const slot = this.str('vs_connect', 'number', ['string', 'string'], [r.src, r.dst])
        if (!slot) { failed.push(key); continue }
        route = { src: r.src, dst: r.dst, slot }
        this.routes.set(key, route)
      }
      const n = route.slot
      this.set(`modulation_${n}_amount`, r.amt ?? 0)
      this.set(`modulation_${n}_bipolar`, r.bipolar ? 1 : 0)
      this.set(`modulation_${n}_stereo`, r.stereo ? 1 : 0)
      this.set(`modulation_${n}_bypass`, r.bypass ? 1 : 0)
      this.set(`modulation_${n}_power`, r.power ?? 0)
    }
    if (failed.length) this.port.postMessage({ type: 'modsFailed', keys: failed })
    this.postSlots()
  }

  /** Tells the page which engine slot (modulation_source_N / modulation_amount_N) each routing has. */
  postSlots() {
    this.port.postMessage({ type: 'slots', slots: [...this.routes.values()].map((r) => [r.src, r.dst, r.slot]) })
  }

  readMods() {
    const list = JSON.parse(this.str('vs_modulations_json', 'string', [], []))
    this.routes = new Map(list.map((r) => [`${r.source}→${r.destination}`, { src: r.source, dst: r.destination, slot: r.slot }]))
    this.postSlots()
    return list.map((r) => ({
      src: r.source, dst: r.destination,
      amt: this.str('vs_get_param', 'number', ['string'], [`modulation_${r.slot}_amount`]),
      bipolar: !!this.str('vs_get_param', 'number', ['string'], [`modulation_${r.slot}_bipolar`]),
      stereo: !!this.str('vs_get_param', 'number', ['string'], [`modulation_${r.slot}_stereo`]),
      bypass: !!this.str('vs_get_param', 'number', ['string'], [`modulation_${r.slot}_bypass`]),
      power: this.str('vs_get_param', 'number', ['string'], [`modulation_${r.slot}_power`]),
      remap: JSON.parse(this.m.UTF8ToString(this.m._vs_remap_json(r.slot))),
    }))
  }

  /** Calls `fn(int, char*)` with `text` copied to the heap: ccall would put a 'string' on the 1 MB stack. */
  withText(fn, index, text) {
    const ptr = this.m.stringToNewUTF8(text)
    const ok = fn(index, ptr)
    this.m._free(ptr)
    return ok
  }

  /** Wavetable names and LFO shapes (LineGenerator JSON), for the drawing to show after a preset load. */
  readShapes() {
    const m = this.m
    return {
      tables: [0, 1, 2].map((i) => m.UTF8ToString(m._vs_wavetable_name(i))),
      sample: m.UTF8ToString(m._vs_sample_name()),
      lfos: Array.from({ length: 8 }, (_, i) => JSON.parse(m.UTF8ToString(m._vs_lfo_json(i)))),
    }
  }

  /** Works through the job queue in order, copying at most `budget` floats this call. A job stages
   *  its tables and sample (vs_table_stage / vs_sample_stage), fills them in slices, then commits them
   *  in one go with its single-frame updates, its light preset (controls, routings, LFOs: no tables
   *  or sample) or Initialize, and answers. A job finishes at the start of a call, never after a copy. */
  pump(budget) {
    const unlimited = budget === Infinity
    while (this.jobs.length) {
      const job = this.jobs[0]
      try { this.stepJob(job, budget, unlimited) } catch (err) {
        // A failed job answers (so nothing waits on it forever) and leaves the queue.
        this.jobs.shift()
        this.port.postMessage({ type: 'done', id: job.id, ok: false, error: String(err) })
        continue
      }
      if (!job.finished) return
      this.jobs.shift()
      if (!unlimited) return
    }
  }

  /** One call's share of a job: stage it, copy up to `budget`, then load and finish in later calls. */
  stepJob(job, budget, unlimited) {
    const m = this.m
    if (!job.tasks) this.startJob(job)
    let copied = false
    while (job.tasks.length && budget > 0) {
      const t = job.tasks[0]
      const n = Math.min(budget, t.src.length - t.done)
      m.HEAPF32.set(t.src.subarray(t.done, t.done + n), (t.dst >> 2) + t.done)
      t.done += n
      budget -= n
      copied = true
      if (t.done >= t.src.length) job.tasks.shift()
    }
    if (job.tasks.length || (copied && !unlimited)) return
    // The light preset (or Initialize) in one block, which silences every voice; the tables and
    // sample swapped in at the start of the next, so no block does both.
    if ((job.light || job.init) && !job.loaded) {
      this.loadJob(job)
      if (!unlimited) return
    }
    this.finishJob(job)
    job.finished = true
  }

  startJob(job) {
    const m = this.m
    job.tasks = []
    const ptrs = m._malloc(4 * 256), sizes = m._malloc(4 * 256)
    for (const t of job.tables ?? []) {
      if (!m._vs_table_stage(t.osc, t.frames, ptrs)) continue
      const dst = m.HEAPU32.slice(ptrs >> 2, (ptrs >> 2) + 4)
      t.arrays.forEach((src, k) => job.tasks.push({ src, dst: dst[k], done: 0 }))
      t.staged = true
    }
    const s = job.sample
    if (s) {
      const n = m._vs_sample_stage(s.length, s.rate, s.stereo, ptrs, sizes)
      const dst = m.HEAPU32.slice(ptrs >> 2, (ptrs >> 2) + n)
      s.buffers.forEach((src, k) => job.tasks.push({ src, dst: dst[k], done: 0 }))
      s.staged = n > 0
    }
    m._free(ptrs); m._free(sizes)
  }

  finishJob(job) {
    const m = this.m
    for (const t of job.tables ?? []) {
      if (!t.staged) continue
      const name = m.stringToNewUTF8(t.name ?? ''), author = m.stringToNewUTF8(t.author ?? '')
      m._vs_table_commit(t.osc, t.ratio, t.rate, t.shepard, name, author)
      m._free(name); m._free(author)
    }
    if (job.sample?.staged) {
      const name = m.stringToNewUTF8(job.sample.name ?? '')
      m._vs_sample_commit(name)
      m._free(name)
    }
    if (job.frame) {
      const ptr = m._malloc(4 * job.frame.data.length)
      m.HEAPF32.set(job.frame.data, ptr >> 2)
      m._vs_table_frame(job.frame.osc, job.frame.index, ptr)
      m._free(ptr)
    }
    if (job.init) this.port.postMessage({ type: 'state', id: job.id, ok: true, values: this.readValues(job.ids ?? []), mods: [], ...this.readShapes() })
    else if (job.light) {
      const ok = job.ok
      this.port.postMessage({ type: 'state', id: job.id, ok, values: ok ? this.readValues(job.ids ?? []) : {}, mods: ok ? this.readMods() : [], ...(ok ? this.readShapes() : {}) })
    } else if (job.id) this.port.postMessage({ type: 'done', id: job.id, ok: true })
  }

  /** A job's light preset (controls, routings, LFOs) or Initialize. */
  loadJob(job) {
    const m = this.m
    job.loaded = true
    if (job.init) {
      m._vs_init_controls(); this.routes.clear(); this.postSlots()
      return
    }
    // Presets can be large; ccall would copy a 'string' arg onto the 1 MB WASM stack, so the text goes
    // through the heap.
    const ptr = m.stringToNewUTF8(job.light)
    job.ok = !!m._vs_load_preset(ptr)
    m._free(ptr)
  }

  readValues(ids) {
    const v = {}
    for (const id of ids) v[id] = this.str('vs_get_param', 'number', ['string'], [id])
    return v
  }

  handle(msg) {
    const m = this.m
    switch (msg.type) {
      case 'noteOn': m._vs_note_on(msg.note, msg.velocity ?? 0.8); break
      case 'midi': {
        // Raw MIDI through the engine's MidiManager port; the page hears what the interface follows.
        const follow = m._vs_midi(msg.status, msg.data1 ?? 0, msg.data2 ?? 0)
        if (follow) this.port.postMessage({ type: 'midiFollow', follow, status: msg.status, data1: msg.data1 ?? 0, data2: msg.data2 ?? 0 })
        break
      }
      case 'mpe': m._vs_set_mpe(msg.on ? 1 : 0); break
      case 'noteOff': m._vs_note_off(msg.note); break
      case 'allNotesOff': m._vs_all_notes_off(); break
      case 'modWheel': m._vs_mod_wheel(msg.value); break
      case 'sustain': m._vs_sustain(msg.on ? 1 : 0); break
      case 'forceShow': this.str('vs_force_show', null, ['string', 'number'], [msg.source, msg.on ? 1 : 0]); break
      case 'correctToTime': m._vs_correct_to_time(msg.seconds ?? 0); break
      case 'pitchWheel': m._vs_pitch_wheel(msg.value); break
      case 'bpm': m._vs_set_bpm(msg.bpm); break
      case 'set': this.set(msg.id, msg.value); break
      case 'setMany': for (const id in msg.values) this.set(id, msg.values[id]); break
      case 'mods': this.syncMods(msg.list); break
      case 'job':
        this.jobs.push(msg)
        if (msg.immediate) this.pump(Infinity)
        break
      case 'frame': {
        const ptr = m._vs_wavetable_frame(msg.osc, msg.position)
        const data = new Float32Array(m.HEAPF32.buffer, ptr, 2048).slice()
        this.port.postMessage({ type: 'frame', id: msg.id, data }, [data.buffer])
        break
      }
      case 'values':
        this.port.postMessage({ type: 'state', id: msg.id, values: this.readValues(msg.ids ?? []), mods: this.readMods(), ...this.readShapes() })
        break
      case 'save': {
        // Without the wavetables and sample: the table worker owns those and completes the file.
        const ptr = m.stringToNewUTF8(JSON.stringify(msg.meta ?? {}))
        const text = m.UTF8ToString(m._vs_save_preset_light(ptr))
        m._free(ptr)
        this.port.postMessage({ type: 'done', id: msg.id, text })
        break
      }
      case 'oscDisplay': {
        m._vs_osc_display(msg.osc, msg.frame, msg.morphType, msg.morph, msg.distortionType, msg.distortion, msg.distortionPhase)
        const wave = m.HEAPF32.slice(m._vs_display_wave() >> 2, (m._vs_display_wave() >> 2) + 2048)
        const spectrum = m.HEAPF32.slice(m._vs_display_spectrum() >> 2, (m._vs_display_spectrum() >> 2) + 1024)
        this.port.postMessage({ type: 'done', id: msg.id, wave, spectrum }, [wave.buffer, spectrum.buffer])
        break
      }
      case 'filterResponse': {
        const ptr = m._malloc(4 * 512)
        m._vs_filter_response(msg.model, msg.style, msg.cutoff, msg.resonance, msg.blend, msg.transpose, msg.formantX, msg.formantY, msg.mix,
          msg.combPeriod ?? 3, msg.driveOverride ?? 0, msg.xMin ?? -1, msg.xMax ?? 1, ptr)
        const data = m.HEAPF32.slice(ptr >> 2, (ptr >> 2) + 512)
        m._free(ptr)
        this.port.postMessage({ type: 'done', id: msg.id, data }, [data.buffer])
        break
      }
      case 'distortionCurve': {
        const n = msg.points ?? 128, ptr = m._malloc(4 * n)
        m._vs_distortion_curve(msg.distortionType, msg.drive, n, ptr)
        const data = m.HEAPF32.slice(ptr >> 2, (ptr >> 2) + n)
        m._free(ptr)
        this.port.postMessage({ type: 'done', id: msg.id, data }, [data.buffer])
        break
      }
      case 'distortionFilter': {
        const ptr = m._malloc(4 * 256)
        m._vs_distortion_filter_response(msg.cutoff, msg.resonance, msg.blend, msg.minCutoff, ptr)
        const data = m.HEAPF32.slice(ptr >> 2, (ptr >> 2) + 256)
        m._free(ptr)
        this.port.postMessage({ type: 'done', id: msg.id, data }, [data.buffer])
        break
      }
      case 'eqResponse': {
        const ptr = m._malloc(4 * 128)
        const [low, band, high] = msg.bands
        m._vs_eq_response(low.cutoff, low.resonance, low.gain, low.pass ? 1 : 0, band.cutoff, band.resonance, band.gain, band.pass ? 1 : 0,
          high.cutoff, high.resonance, high.gain, high.pass ? 1 : 0, ptr)
        const data = m.HEAPF32.slice(ptr >> 2, (ptr >> 2) + 128)
        m._free(ptr)
        this.port.postMessage({ type: 'done', id: msg.id, data }, [data.buffer])
        break
      }
      case 'scope': {
        // An output display: the oscilloscope window (512 left, 512 right) or one frame of spectrogram
        // `id` (300 left, 300 right heights over minDb … maxDb; source 1 = the equalizer's memory).
        const sp = msg.spectrogram
        const n = sp ? 600 : 1024, ptr = m._malloc(4 * n)
        if (sp) m._vs_spectrogram(sp.id ?? 0, sp.source ?? 0, sp.minDb ?? -40, sp.maxDb ?? 0, sp.minFreq ?? 9.2, sp.maxFreq ?? 21000, ptr)
        else m._vs_scope(ptr)
        const data = m.HEAPF32.slice(ptr >> 2, (ptr >> 2) + n)
        m._free(ptr)
        this.port.postMessage({ type: 'done', id: msg.id, data }, [data.buffer])
        break
      }
      case 'wavetableFrames': {
        const points = msg.points ?? 128
        const ptr = m._malloc(4 * 257 * points)
        const count = m._vs_wavetable_frames(msg.osc, points, ptr)
        const data = m.HEAPF32.slice(ptr >> 2, (ptr >> 2) + count * points)
        m._free(ptr)
        this.port.postMessage({ type: 'done', id: msg.id, count, points, data }, [data.buffer])
        break
      }
      case 'tuning': {
        if (msg.clear) m._vs_tuning_default()
        else {
          if (msg.setName) { const n = m.stringToNewUTF8(msg.setName); m._vs_tuning_name_set(n); m._free(n) }
          const text = m.stringToNewUTF8(msg.text ?? ''), name = m.stringToNewUTF8(msg.name ?? '')
          m._vs_tuning_load(msg.kind ?? 0, text, name)
          m._free(text); m._free(name)
        }
        this.port.postMessage({ type: 'done', id: msg.id, name: m.UTF8ToString(m._vs_tuning_name()), isDefault: !!m._vs_tuning_is_default() })
        break
      }
      case 'remap': {
        const route = this.routes.get(`${msg.src}→${msg.dst}`)
        const ok = route ? this.withText(m._vs_set_remap, route.slot, JSON.stringify(msg.data)) : 0
        if (msg.id) this.port.postMessage({ type: 'done', id: msg.id, ok: !!ok })
        break
      }
      case 'lfo': {
        const ok = this.withText(m._vs_set_lfo, msg.index, JSON.stringify(msg.data))
        if (msg.id) this.port.postMessage({ type: 'done', id: msg.id, ok: !!ok })
        break
      }
      case 'watch': {
        if (this.watch) { m._free(this.watch.handles); m._free(this.watch.out) }
        const names = msg.names ?? []
        const handles = m._malloc(4 * Math.max(1, names.length))
        const out = m._malloc(4 * this.lanes * Math.max(1, names.length))
        names.forEach((name, i) => { m.HEAPU32[(handles >> 2) + i] = this.str('vs_status_handle', 'number', ['string'], [name]) })
        this.watch = names.length ? { names, handles, out } : null
        if (!this.watch) { m._free(handles); m._free(out) }
        break
      }
      case 'watchTotals': {
        if (this.totals) for (const k of ['mono', 'poly', 'out']) m._free(this.totals[k])
        const names = msg.names ?? []
        if (!names.length) { this.totals = null; break }
        const t = { names, mono: m._malloc(4 * names.length), poly: m._malloc(4 * names.length), out: m._malloc(8 * names.length) }
        names.forEach((name, i) => {
          m.HEAPU32[(t.mono >> 2) + i] = this.str('vs_mod_total_handle', 'number', ['string', 'number'], [name, 0])
          m.HEAPU32[(t.poly >> 2) + i] = this.str('vs_mod_total_handle', 'number', ['string', 'number'], [name, 1])
        })
        this.totals = t
        break
      }
      case 'stats':
        this.port.postMessage({ type: 'stats', id: msg.id, voices: m._vs_active_voices(), longestBlockMs: this.longest.block, longestMessageMs: this.longest.message })
        this.longest = { block: 0, message: 0 }
        break
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    if (!this.m || !out?.length) return true
    const t0 = Date.now()
    const frames = out[0].length
    for (let off = 0; off < frames; off += BLOCK) {
      const n = Math.min(BLOCK, frames - off)
      this.m._vs_process(n)
      const heap = this.m.HEAPF32
      out[0].set(heap.subarray(this.m._vs_left() >> 2, (this.m._vs_left() >> 2) + n), off)
      if (out[1]) out[1].set(heap.subarray(this.m._vs_right() >> 2, (this.m._vs_right() >> 2) + n), off)
    }
    if (this.jobs.length) this.pump(COPY_BUDGET)
    this.longest.block = Math.max(this.longest.block, Date.now() - t0)
    if ((this.watch || this.totals) && ++this.blocks >= STATUS_EVERY) {
      this.blocks = 0
      const msg = { type: 'status', values: new Float32Array(0), totals: new Float32Array(0) }
      if (this.watch) {
        const { names, handles, out: ptr } = this.watch
        this.m._vs_status_read(handles, names.length, ptr)
        msg.values = this.m.HEAPF32.slice(ptr >> 2, (ptr >> 2) + names.length * this.lanes)
      }
      if (this.totals) {
        const { names, mono, poly, out: ptr } = this.totals
        this.m._vs_mod_total_read(mono, poly, names.length, ptr)
        msg.totals = this.m.HEAPF32.slice(ptr >> 2, (ptr >> 2) + 2 * names.length) // left, right per control
      }
      this.port.postMessage(msg, [msg.values.buffer, msg.totals.buffer])
    }
    return true
  }
}

registerProcessor('synth-engine', SynthEngineProcessor)
