// The table worker: a second instance of the engine, in a Worker, that owns the oscillators'
// wavetables (their WavetableCreators) and the sampler's sample. Everything that renders a table or
// band-limits a sample happens here: preset loads, wavetable files and audio, resynthesis, sample
// files and the wavetable editor. Finished tables and samples go back to the page as their engine
// data (see glue/table_port.cpp), and the page hands them to the audio worklet, which copies them in
// between audio blocks. Messages: { id, type, ... } → { id, ... } (see engine-client.js).
import createEngine from './engine.mjs'

/** A table's rows: 2048 samples, then three spectra of kPolyFrequencySize poly floats (2056 floats). */
const ROWS = [2048, 2056, 2056, 2056]
const FRAME_FLOATS = ROWS.reduce((a, b) => a + b)

let m = null
const scratch = { ptrs: 0, sizes: 0 }
const queue = []

self.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'start') {
    createEngine().then((engine) => {
      m = engine
      m.ccall('vs_init', null, ['number'], [msg.rate])
      scratch.ptrs = m._malloc(4 * 256)
      scratch.sizes = m._malloc(4 * 256)
      self.postMessage({ type: 'ready' })
      for (const q of queue) run(q)
      queue.length = 0
    }).catch((err) => self.postMessage({ type: 'error', message: String(err) }))
    return
  }
  if (m) run(msg)
  else queue.push(msg)
}

function run(msg) {
  let result, transfer = []
  try { [result, transfer] = handle(msg) } catch (err) { result = { error: String(err) } }
  self.postMessage({ id: msg.id, ...result }, transfer)
}

const withText = (fn, ...args) => {
  const text = args.pop()
  const ptr = m.stringToNewUTF8(text)
  const r = fn(...args, ptr)
  m._free(ptr)
  return r
}

/** Oscillator `osc`'s table as its engine data: frame count, the four arrays, ratio, rate, names. */
function exportTable(osc) {
  const frames = m._vs_table_export(osc, scratch.ptrs)
  const ptrs = m.HEAPU32.slice(scratch.ptrs >> 2, (scratch.ptrs >> 2) + 4)
  return {
    osc, frames,
    arrays: ROWS.map((row, k) => m.HEAPF32.slice(ptrs[k] >> 2, (ptrs[k] >> 2) + frames * row)),
    ratio: m._vs_table_frequency_ratio(osc), rate: m._vs_table_sample_rate(osc), shepard: m._vs_table_shepard(osc),
    name: m.UTF8ToString(m._vs_wavetable_name(osc)), author: m.UTF8ToString(m._vs_table_author(osc)),
  }
}

/** One frame of a table (its four rows end to end), after the editor rendered only that frame. */
function exportFrame(osc, index) {
  const ptr = m._malloc(4 * FRAME_FLOATS)
  const ok = m._vs_table_frame_export(osc, index, ptr)
  const data = m.HEAPF32.slice(ptr >> 2, (ptr >> 2) + FRAME_FLOATS)
  m._free(ptr)
  return ok ? { osc, index, data } : null
}

/** The sample's band-limited buffers, with its length, rate, channels and name. */
function exportSample() {
  const n = m._vs_sample_export(scratch.ptrs, scratch.sizes)
  const ptrs = m.HEAPU32.slice(scratch.ptrs >> 2, (scratch.ptrs >> 2) + n)
  const sizes = new Int32Array(m.HEAPU32.buffer, scratch.sizes, n).slice()
  return {
    length: m._vs_sample_length(), rate: m._vs_sample_rate(), stereo: m._vs_sample_stereo(),
    buffers: Array.from(ptrs, (p, k) => m.HEAPF32.slice(p >> 2, (p >> 2) + sizes[k])),
    name: m.UTF8ToString(m._vs_sample_name()),
  }
}

const tableBuffers = (t) => t.arrays.map((a) => a.buffer)
const sampleBuffers = (s) => s.buffers.map((a) => a.buffer)

/** The preset with its wavetables and sample taken out (the worklet loads the rest). */
function lightText(data) {
  delete data.settings.wavetables
  delete data.settings.sample
  return JSON.stringify(data)
}

function handle(msg) {
  switch (msg.type) {
    case 'preset': {
      const ok = withText(m._vs_load_preset, msg.text)
      if (!ok) return [{ ok: false }]
      const data = JSON.parse(msg.text)
      const hasSample = !!data.settings?.sample
      const tables = [0, 1, 2].map(exportTable)
      const sample = hasSample ? exportSample() : null
      return [{ ok: true, light: lightText(data), tables, sample }, [...tables.flatMap(tableBuffers), ...(sample ? sampleBuffers(sample) : [])]]
    }
    case 'init': {
      m._vs_init_preset()
      const tables = [0, 1, 2].map(exportTable)
      const sample = exportSample()
      return [{ tables, sample }, [...tables.flatMap(tableBuffers), ...sampleBuffers(sample)]]
    }
    case 'setWavetable': {
      const ok = withText(m._vs_set_wavetable, msg.osc, JSON.stringify(msg.data))
      if (!ok) return [{ ok: false }]
      const table = exportTable(msg.osc)
      return [{ ok: true, table }, tableBuffers(table)]
    }
    case 'wavetableAudio': {
      const { osc, data, sampleRate, style, fade, name, author } = msg
      const ptr = m._malloc(4 * data.length)
      m.HEAPF32.set(data, ptr >> 2)
      const n = m.stringToNewUTF8(name ?? ''), a = m.stringToNewUTF8(author ?? '')
      const ok = m._vs_wavetable_from_audio(osc, ptr, data.length, sampleRate, style, fade ?? 3, n, a)
      m._free(ptr); m._free(n); m._free(a)
      const table = exportTable(osc)
      return [{ ok: !!ok, table }, tableBuffers(table)]
    }
    case 'resynthesize': {
      // The worklet's patch (its controls and routings) first, so the render plays what the page plays.
      if (msg.light) withText(m._vs_load_preset, msg.light)
      const ok = m._vs_resynthesize(msg.osc)
      const table = exportTable(msg.osc)
      return [{ ok: !!ok, table }, tableBuffers(table)]
    }
    case 'loadSample': {
      const { left, right, sampleRate, name } = msg
      const size = left.length
      const l = m._malloc(4 * size), r = right ? m._malloc(4 * size) : 0
      m.HEAPF32.set(left, l >> 2)
      if (right) m.HEAPF32.set(right.subarray(0, size), r >> 2)
      const namePtr = m.stringToNewUTF8(name ?? '')
      const length = m._vs_load_sample(l, r, size, sampleRate, namePtr)
      m._free(namePtr); m._free(l); if (r) m._free(r)
      const sample = length ? exportSample() : null
      return [{ length, name: m.UTF8ToString(m._vs_sample_name()), sample }, sample ? sampleBuffers(sample) : []]
    }
    case 'sampleInfo': {
      const ptr = m._malloc(4 * 256)
      const length = m._vs_sample_peaks(ptr)
      const peaks = m.HEAPF32.slice(ptr >> 2, (ptr >> 2) + 256)
      m._free(ptr)
      return [{ length, name: m.UTF8ToString(m._vs_sample_name()), peaks }, [peaks.buffer]]
    }
    case 'wavetableJson':
      return [{ data: JSON.parse(m.UTF8ToString(m._vs_wavetable_json(msg.osc))) }]
    case 'merge': {
      // The worklet's preset without tables and sample, completed with this instance's.
      const meta = m.stringToNewUTF8('{}')
      const full = JSON.parse(m.UTF8ToString(m._vs_save_preset(meta)))
      m._free(meta)
      const data = JSON.parse(msg.text)
      const settings = { ...data.settings, wavetables: full.settings.wavetables, sample: full.settings.sample }
      // nlohmann::json keeps object keys sorted; so does a file desktop Vital writes.
      data.settings = Object.fromEntries(Object.keys(settings).sort().map((k) => [k, settings[k]]))
      return [{ text: JSON.stringify(data) }]
    }
    case 'wt': return wavetableEdit(msg.op, msg.args ?? [])
    default: return [{ error: `unknown ${msg.type}` }]
  }
}

/** Where an editor call left the oscillator's table: −1 rendered all of it, a frame index rendered
 *  only that frame, anything else rendered nothing. */
function renderedBy(op, args) {
  switch (op) {
    case 'setKeyframe': return args[5]
    case 'setComponent': return args[4]
    case 'waveTime': return args[7]
    case 'waveFreq': return args[6]
    case 'line': return args[7]
    case 'render': return args[1]
    case 'move': return args[5] ? -1 : -2
    case 'insert': case 'remove': case 'addSource': case 'addModifier': case 'removeComponent':
    case 'moveComponent': case 'reset': case 'repositionAll': case 'fileLoad': return -1
    default: return -2
  }
}

/** The wavetable editor's calls on oscillator args[0]'s WavetableCreator (vs_wt_* in web_synth.cpp),
 *  answered with the call's result and the table (or frame) it rendered, for the worklet. */
function wavetableEdit(op, args) {
  const result = editCall(op, args)
  const transfer = result.data instanceof Float32Array ? [result.data.buffer] : []
  const rendered = renderedBy(op, args)
  if (rendered === -1) {
    result.table = exportTable(args[0])
    transfer.push(...tableBuffers(result.table))
  } else if (rendered >= 0) {
    const frames = m._vs_table_export(args[0], scratch.ptrs)
    result.frame = exportFrame(args[0], Math.min(rendered, frames - 1))
    if (result.frame) transfer.push(result.frame.data.buffer)
  }
  return [result, transfer]
}

function editCall(op, args) {
  const text = (s) => m.stringToNewUTF8(typeof s === 'string' ? s : JSON.stringify(s))
  const floats = (n, fill) => { const ptr = m._malloc(4 * n); if (fill) m.HEAPF32.set(fill, ptr >> 2); return ptr }
  const read = (ptr, n) => { const out = m.HEAPF32.slice(ptr >> 2, (ptr >> 2) + n); m._free(ptr); return out }
  const waveFrame = (o, g, c, i) => { const out = floats(2048 + 2 * 1025); m._vs_wt_wave_frame(o, g, c, i, out); return read(out, 2048 + 2 * 1025) }
  switch (op) {
    case 'layout': return { data: JSON.parse(m.UTF8ToString(m._vs_wt_layout(args[0]))) }
    case 'keyframe': return { data: JSON.parse(m.UTF8ToString(m._vs_wt_keyframe(...args))) }
    case 'setKeyframe': { const [o, g, c, i, patch, pos] = args; const t = text(patch); const ok = m._vs_wt_set_keyframe(o, g, c, i, t, pos); m._free(t); return { ok: !!ok } }
    case 'setComponent': { const [o, g, c, patch, pos] = args; const t = text(patch); const ok = m._vs_wt_set_component(o, g, c, t, pos); m._free(t); return { ok: !!ok } }
    case 'insert': return { index: m._vs_wt_insert_keyframe(...args) }
    case 'remove': m._vs_wt_remove_keyframe(...args); return {}
    case 'move': return { index: m._vs_wt_move_keyframe(...args) }
    case 'repositionAll': m._vs_wt_reposition_all(...args); return {}
    case 'addSource': m._vs_wt_add_source(...args); return {}
    case 'addModifier': m._vs_wt_add_modifier(...args); return {}
    case 'removeComponent': m._vs_wt_remove_component(...args); return {}
    case 'moveComponent': m._vs_wt_move_component(...args); return {}
    case 'reset': m._vs_wt_reset_component(...args); return {}
    case 'flags': m._vs_wt_flags(...args); return {}
    case 'render': { const ptr = floats(4096); m._vs_wt_render(args[0], args[1], args[2], ptr); return { data: read(ptr, 4096) } }
    case 'waveFrame': return { data: waveFrame(...args) }
    case 'waveTime': {
      const [o, g, c, i, data, start, end, pos] = args
      const ptr = floats(2048, data); m._vs_wt_wave_time(o, g, c, i, ptr, start, end, pos); m._free(ptr)
      return { data: waveFrame(o, g, c, i) }
    }
    case 'waveFreq': {
      const [o, g, c, i, amps, phases, pos] = args
      const a = floats(1025, amps), p = floats(1025, phases)
      m._vs_wt_wave_freq(o, g, c, i, a, p, pos); m._free(a); m._free(p)
      return { data: waveFrame(o, g, c, i) }
    }
    case 'line': { const [o, g, c, i, line, index, added, pos] = args; const t = text(line); const ok = m._vs_wt_line(o, g, c, i, t, index, added, pos); m._free(t); return { ok: !!ok } }
    case 'fileLoad': { const [o, g, c, data, rate] = args; const ptr = floats(data.length, data); m._vs_wt_file_load(o, g, c, ptr, data.length, rate); m._free(ptr); return {} }
    case 'filePeaks': { const ptr = floats(256); const length = m._vs_wt_file_peaks(...args, ptr); return { length, data: read(ptr, 256) } }
    case 'renderBuffer': { const n = args[1] * 2048; const ptr = floats(n); m._vs_wt_render_buffer(args[0], args[1], ptr); return { data: read(ptr, n) } }
    default: return {}
  }
}
