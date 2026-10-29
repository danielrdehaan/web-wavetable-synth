# Plan: a fully working browser synth on Vital's engine

Status, 2026-10-21: Phases 1–6 built (see "Progress" below, and Phase 6); the parity audit
(`docs/parity-audit.md`) has one open item, Point Cycle, which the 1.0.6 engine can't do. Phase 7's
off-thread table work is done; the rest of Phase 7 isn't started.

## Verdict: feasible

The spike compiled Vital's real synthesis engine (no JUCE) to WebAssembly and ran it in an
AudioWorklet. Measured, not estimated:

| Question | Result |
|---|---|
| Does the engine build for the web? | Yes. `src/synthesis` + the wavetable half of `src/common`, against a ~150-line JUCE shim. Download: 1.5 MB single file, **334 KB gzipped**. |
| Does it make the right sound? | Same pitch, filter and modulation behaviour as the native build of the same source. In the browser: C3 at 130 Hz; cutoff 40→130 moves the spectral centroid 174 Hz→2.1 kHz; LFO 1→cutoff makes the level swing 8× more than without it. |
| Is it fast enough? | 8 voices × 16 unison renders at **~14× realtime** in WASM (Apple silicon, Node). 1 voice ≈ 44×. Loads in ~80 ms. |
| Does it load real presets? | **All 561 `.vital` presets on this Mac** (Factory, Mr Bill, Billain, Databroth and others; versions 0.8.0–1.0.7) load and play with no silence and no NaN/Inf. |
| Does it fit the UI we already have? | **449 of the 462** parameters in the Foundations of Synthesis Vital sim (`src/components/kb-widgets/synthSim/vital/params.ts`) exist in the engine with identical ranges. The rest are listed in Phase 1. |
| Memory | 150–200 MB of WASM heap per engine (wavetables + lookup tables). Fine on laptops; a concern on phones. |

Not yet verified: listening by ear; Safari and Firefox (only Chrome-based browsers and Node so far);
an A/B against desktop Vital 1.5.5 (its own `--render` mode segfaults, so that comparison needs
renders from a DAW); the sim actually wired to the engine (Phase 1).

**The big caveat: the public source is Vital 1.0.6** (Feb 2021), not the 1.5.5 students install.
Parameter ids and ranges match almost exactly (the sim's table was taken from the repo). Known
gap: two unison stack modes ("Octave + 7", "Sub Harmonics"). Unknown: any DSP changes after 1.0.6.
Phase 0 measures it.

## Progress (2026-10-20 / 21)

Built in `app/` and verified in the browser (Chrome engine, in-app pane) unless marked otherwise:

- **Phase 1, done:** the Vital sim moved here and wired to the engine. Every value change is sent as a
  diff, and a drag-to-modulate connection creates the routing in the engine. Filter-input buttons now
  follow Vital's rule (a view of `osc_N_destination`, toggled like `toggleFilter1/2`). The stack list
  uses the engine's 11 stacks and greys out the 1.5.5-only two. Initialize resets the engine.
  Notes play from the on-screen keys and the computer keyboard (Vital's layout, Z/X octave).
  Web MIDI input with velocity, mod wheel, pitch bend and sustain is built **but not tested with a
  real keyboard**.
- **Phase 2, done:** every display reads the engine. The oscillator screens draw the engine's frames
  with its morph and warp applied (3D / 2D / spectrum). The filter, EQ, reverb EQ, flanger, phaser,
  distortion and band-filter curves come from ports of Vital's response shaders run on the engine's
  own filter classes (`vs_filter_response`, `vs_eq_response`, `vs_distortion_*`). The compressor,
  chorus, delay and random displays read their status outputs. The header has Vital's L/R peak meters
  with held peak and clip latch, and its scope is SynthBase's pitch-synced oscilloscope memory, or the
  spectrogram once clicked (`vs_scope`, `vs_spectrogram`, ported from synth_base.cpp and
  oscilloscope.cpp). Knob and slider meters read the engine's per-destination mono + poly totals. LFO
  and envelope playheads show only while the modulator runs and a voice plays, as in Vital. All of it
  was checked against the captures in the browser; motion was checked through the status data, because
  the hidden pane pauses `requestAnimationFrame`.
- **Phase 3, partly:** LFO shapes and modulation remap curves are one model (`line.ts`, LineGenerator's
  maths) edited by one port of Vital's LineEditor (`LineEditor.tsx`): point snapping, power drags
  (Shift all, Alt alternate), painting with Cmd as a temporary toggle, the right-click menu, typed point
  values, wheel on grid / pattern, the playhead glow trail (LFO) and the live input (remap, from
  `modulation_source_N`). Both reach the engine and load from presets. The envelope editor is a port
  of Vital's too (`EnvelopeEditor.tsx`): fixed 4 s window that grows past its edge, base-4 ruler, wheel
  and magnifier zoom, nearest-handle dragging, and the modulated shape with its trail and fading
  playhead. The Advanced page's ANALYSIS scope and spectrogram and the EQ's own spectrogram come from
  the engine (one decaying state per display). Drag-to-modulate follows Vital's ModulationButton and
  ModulationManager (`SourceButton.tsx`): pressing a source selects it (and makes the engine run it),
  the drag starts on leaving the button with a ghost ring at the cursor, drop highlights skip existing
  connections, rings show for the current modulator (and every connection while a control is hovered),
  sources carry their depth knobs in a 3-column grid with a callout past the limit, right-click
  disconnects, and the tab columns grow to one past the highest connected source. The VOICE page has
  Vital's display gestures (drag through frames, wheel, right-click menu), the distortion-phase bar,
  the unison viewer and the TRANSPOSE SNAP callout; the filters swap in the formant / comb controls
  and labels, draw the blend icons per model and open the model menu where Vital does (`filterUi.tsx`,
  shared with the FX filter). Gestures read the store's latest values (`api.get`), so fast pointer
  events no longer drop movement. The EFFECTS list reorders live while a tile is dragged (the engine
  and panels follow), with the hover grip and connector. The 3D wavetable display draws all 257 frames
  with Vital's shading. Macro rename, wheels, the keyboard hover, the LFO keytrack split and the
  spread / rotate menu follow Vital's code. The matrix rows have Vital's
  bypass number, live L/R amount meters (`modulation_amount_N`) and MORPH curve. The effect chain order
  reaches the engine as Vital's permutation code (matches the C++ on 2,000 random orders). The
  wavetable menu (Init, Basic Shapes, Sine, Pulse) changes the sound. Modulated controls report left
  and right totals: meters colour the left-only, right-only and shared stretches as Vital does, and every
  response display (filters, EQ, effects, oscillator) draws the right channel under the left. The
  sampler loads audio files (picker or drop) into the engine and draws Vital's waveform with its
  playhead glow. Since then: the sample, wavetable, LFO and remap browsers (`PopupBrowser.tsx` over an
  IndexedDB + File System Access library, `engine/library.ts`), audio dropped on the oscillator display
  as a wavetable (splice / vocode / pitch splice), Resynthesize Preset to Wavetable, microtuning
  (`glue/tuning_port.cpp`: Vital's Tuning without JUCE; scl / tun / kbm and the built-in scales), and MIDI
  through the engine's own MidiManager logic (MPE zones, RPN bend range, MIDI learn).
- **Phase 4, mostly:** Open External Preset (any `.vital`) loads values, routings, wavetable names
  and LFO shapes into the interface. Save/Export Preset downloads a `.vital` in desktop Vital's layout,
  stamped version 1.0.6. **All 561 local presets survive save → load unchanged** (`tools/roundtrip.mjs`
compares controls, routings, all 891 remap curves, LFO shapes and wavetable structure).
  Not yet checked: opening a saved file in desktop Vital 1.5.5 (Daniel, by hand). Since then: the
  preset browser (folders, search, styles, sortable columns, info pane), the Save box, Import / Export
  Bank (.vitalbank zips), Set as Default Preset, and the About window's sizes. Not started: our own
  starter library of presets and wavetables (Vital's factory ones can't ship).
- **Phase 5, done (2026-10-21):** the wavetable editor (`WavetableEditor.tsx`), opened from each
  oscillator's pencil, edits the oscillator's own WavetableCreator through `vs_wt_*` in `web_synth.cpp`:
  the frame at the playhead with its harmonic amplitudes and phases (power / amplitude scale, zoom),
  every overlay (wave, line and audio-file sources; phase, window, frequency filter, slew, fold, warp),
  the playhead, the component list's menus, the keyframe organizer (select, box-select, drag, double-click,
  Create / Remove Keyframe), NORMALIZE TABLE and REMOVE DC, and the menu (Save As / Import / Export
  Wavetable, Export to .wav, Synthesize Preset to Table). Verified in headless Chromium driven over the
  DevTools protocol (the in-app pane was hidden). Text to Wavetable is left out: Vital does it on its
  own server.

## Which UI

**Recommended: the real engine + the Vital interface already redrawn for Foundations of Synthesis**
(the `vital` synth sim: voice/effects/matrix/advanced pages, modulator column, drag-to-modulate,
remap curves, menus, measured from the deep capture). Today it draws from its own state and makes
no sound. Wiring it to the engine is the shortest path to a working synth. It also stays a DOM UI,
and the tutorials need one: tasks, highlights and `Region` tags can see into it.

Rejected: compiling Vital's own JUCE/OpenGL interface. JUCE 6 has no web backend, the interface is
most of Vital's code, and the result is one opaque canvas. Tutorials couldn't highlight or check
anything inside it, and it would still be the 1.0.6 interface.

## Architecture

```
GPL repo (this one), hosted on its own origin
 ├─ engine.mjs (WASM)  ── runs in ──►  engine-worklet.js (audio thread: plays)
 │                     └─ and in ───►  table-worker.js (Worker: owns the wavetables and sample)
 │   page ── params, mods, notes, light presets ──► worklet
 │   page ── presets, tables, samples, editor ops ──► worker ── finished table / sample data ──►
 │        page ──► worklet (copied in ≤ 8 MB per audio block, swapped in whole)
 │   worklet ── status packets ~30 Hz: mod values, LFO/env phases, voices, meter ──► page
 ├─ UI: the Vital sim (React), moved here from StemShare
 └─ tutorial API: postMessage protocol for an embedding page
          ▲
          │ iframe + postMessage (separate programs, so StemShare stays non-GPL)
StemShare KB widget  ── shows a lesson's tasks, reads state, sets lesson patches, highlights controls
```

Licensing rules (see README): GPLv3 with source offered, a name that isn't "Vital", no factory
presets or vital.audio services. The UI moves into the GPL program because it ships in the same
page as the engine. You own the sim code, so it can be GPL here and stay as it is in StemShare.

## Phases

Each phase ends in something usable. Sizes are relative (S < M < L).

### Phase 0: foundation and parity check (S)
- Pin Emscripten (6.0.13 changed defaults: it emits resizable-buffer code unless told not to).
  Make `build.sh` a CI job with the wasm as a release artifact.
- Tests: `tools/sweep.mjs` over a corpus of presets we can legally keep (our own, plus any CC0 ones);
  native-vs-wasm golden renders; `bench.mjs` as a performance floor.
- **Parity study:** you export 20–30 presets from desktop Vital 1.5.5 and render each one note in
  a DAW. We render the same presets with `tools/render.mjs` and compare spectra and envelopes.
  Output: a list of what differs, and a decision on whether 1.0.6 is close enough to teach "Vital".
- Port `LoadSave::updateFromOldVersion` (~750 lines of JSON upgrades). The spike skips it, so
  presets older than 1.0 load but may not sound as authored.
- **Done when:** CI builds, the sweep passes, and the parity report exists.

### Phase 1: the sim drives the engine (M)
- Move the sim (`synthSim/vital/*`, `VitalSim.tsx`, the kit pieces it uses) into this repo as a
  Vite + React app.
- Bridge: `v` diffs → `engine.setMany`, `mods` → `engine.setMods` (already declarative in the
  worklet), `notes` → note on/off. Add Web MIDI input and sustain pedal.
- Map the 13 filter-input toggles (`filter_*_osc1_input` …) to the engine's `osc_N_destination` /
  `sample_destination` / `filter_fx` routing, which is how Vital stores them.
- Stack styles: hide or disable the two 1.5.5-only modes, or implement them in the engine (a small
  patch to `synth_oscillator.cpp`). Decide after Phase 0.
- Reconcile the 3 defaults that differ (`osc_1_on`, `osc_2/3_destination`) through `initValues`.
- **Done when:** every knob, menu and drag-to-modulate gesture in the drawing changes the sound.

### Phase 2: live displays from the engine (M)
- Status packet from the worklet: current modulated value per destination (for the rings),
  LFO/envelope/random phases, voice count, output peak, last note.
- Real oscilloscope and spectrum (AnalyserNode on the output), the oscillator screens drawn from
  `vs_wavetable_frame` (3D/2D/spectral), filter response curves from the engine's settings.
- **Done when:** the drawing moves the way Vital's does while notes play.

### Phase 3: everything that isn't a parameter (M)
- LFO shapes: the sim's point editor ↔ `LineGenerator::jsonToState`/`stateToJson` (new `vs_*`
  calls). Same for modulation remap curves (per-connection line mapping).
- Effect order (`effect_chain_order`), the sampler oscillator (browser `decodeAudioData` →
  `Sample` load), microtuning (parse .scl/.tun in JS → `Tuning::loadScale`; compile `tuning.cpp`
  with a little more shim), MPE (per-channel pitch bend, pressure, slide; the engine already takes channels).
- **Done when:** a preset's full state, not just its knobs, can be shown and edited.

### Phase 4: presets (M)
- Save: port `LoadSave::stateToJson` (controls + modulations + wavetables + LFOs + sample). The
  file must open in desktop Vital, so students can carry work home.
- Load the user's own `.vital` files (already works); a preset browser; a starter library of
  presets and wavetables we author and license ourselves (Vital's factory ones can't ship).
- **Done when:** round trip works (made in the browser → opens in desktop Vital 1.5.5 → back).

### Phase 5: the wavetable editor (L, the largest single piece) — built 2026-10-21, see Progress
- Before: the sim had no editor (the pencil was "not drawn"). The engine side existed:
  `WavetableCreator` with groups, keyframes, wave/line/audio-file sources and every modifier
  compiles and loads from JSON today.
- Build the editor UI (sources, keyframe timeline, modifiers, the line-source drawing) on JSON
  edits → re-render. Add audio-file import (vocode / pitch-split / splice) through
  `initFromAudioFile`. Text-to-wavetable needs our own glyph rendering (canvas).
- **Done when:** the wavetable lessons can be taught entirely in the browser.

### Phase 6: tutorial embedding (M) — built 2026-10-21
- **Done:** the framed mode and its parts, and the protocol (`docs/embed-protocol.md`).
  - Parts: a page can show only the sections a lesson needs (`?embed=1&parts=osc1,filter1,lfo1,keys`).
  - Protocol, version 1, cross-origin: ready, state, started, size; hello, get, set, load, highlight,
    lock, note, pause, resume. It talks only to an allowed `host`.
  - StemShare's `wavetableLab` KB widget hosts it with a checklist. Its checks are in
    `src/lib/wavetableLab`, and a step's target becomes a highlight.
  - One lesson, LFO 1 → cutoff, ran end to end in StemShare's KB preview harness in headless Chromium:
    all five steps ticked, and the reading checklist counted the article as read.
  - Parts can also sit anywhere (`id@x:y`), and `flow=1` draws the signal flow between them from the
    patch: audio from each source through the filters and effects to the output, and each modulation
    to its control, through the remap editor when its curve isn't linear. A lesson patch can carry
    remap curves. The worked layout is StemShare's `kb-preview-harness/fixtures/wavetable-lab/signal-flow.md`.
  - Not done: deploying the synth to its own origin and setting `VITE_WAVETABLE_SYNTH_URL` (Daniel's
    call: name and host, "Decisions for you"), and a real article in the vault.
- The original plan, for reference:
- postMessage protocol: `getState`, `subscribe(paths)`, `loadPatch(json)`, `set`, `highlight(regionId)`,
  `lock(controls)`, `noteEvents`. Version it. Only answer origins we allow.
- A StemShare KB widget (`synthLab`-style) that hosts the iframe and runs lesson tasks against the
  state stream, the way the studio labs read `usePlayback()`.
- **Done when:** one real lesson (e.g. "LFO 1 → cutoff") runs end to end inside an article.

### Phase 7: hardening (M)
- Browsers: Safari 16.4+ (WASM SIMD + exceptions), Firefox, Chromebook, iPad. Mobile memory budget.
- **Done 2026-10-21: glitch-free preset loads and table work.** A second engine instance in a Worker
  (`web/table-worker.js`) owns the wavetable creators and the sample, so preset parsing, table
  renders (the editor's too), sample band-limiting, wavetable files and audio, and resynthesis all run
  there. The worklet gets the finished engine data (`glue/table_port.cpp`), copies at most 8 MB per audio block,
  and swaps it in whole. Measured in headless Chromium while notes play:
  - Loads of the heaviest local presets (Float Chords at 10 MB with a 1.9 M-sample stereo loop, Novel,
    Glitch Gate Shot) now hold the audio thread for at most 3–4 ms. Before, they held it for 170–430 ms.
    Playing with nothing loading also peaks at 4 ms.
  - A preset load used to render every table twice. It now renders once.
  - The worker's tables and the worklet's match exactly: bit-identical audio and frames after loads,
    editor edits, single-frame drags and Initialize.
  - The worker + worklet save matches a single engine's save on 40 of 40 presets.
  - `stats()` reports the worklet's longest block and message handler.
  - Left: a very large sample still makes the worklet heap grow (a one-off copy), and the light preset
    load (controls, routings, LFOs; 1.5–2.5 ms) still runs in one block.
- Oversampling defaults per device, CPU guard (voice cap when a block overruns), accessibility of
  the controls, offline caching of the engine.

## Decisions for you

1. **Name** for the published synth (not Vital).
2. **Where it's hosted:** decided 2026-10-28: its own Pages project (`web-wavetable-synth`) at
   `synth.makethings.audio`, framed whole at StemShare's `/wavetable-synth` (README → Deploy). Still
   to do: a source link on the page.
3. **Move the sim UI into this GPL repo** (recommended), or keep it in StemShare with only a
   thin bridge to a separately hosted engine. The second keeps one copy of the UI, but loading a
   GPL engine into a StemShare page is a legal grey area.
4. **Write to licensing@vital.audio?** Optional, but it could settle three things at once: blessing
   for a free, education-only GPL build that looks like Vital; whether 1.5.5 source might be
   shared; and naming.
5. **Is 1.0.6 close enough?** Decide after the Phase 0 parity report.

## Gotchas found in the spike

- `ccall` copies `'string'` arguments onto the 1 MB WASM stack. Presets with embedded audio are
  6–9 MB, so preset text must go through the heap (`stringToNewUTF8` + `_free`), as the worklet does.
- Fixed heap OOMs after ~120 different presets (fragmentation). Use classic memory growth:
  `-sALLOW_MEMORY_GROWTH=1 -sGROWABLE_ARRAYBUFFERS=0`. Read `HEAPF32` fresh each block (the worklet does).
- Vital uses `dynamic_cast` (keep RTTI) and exceptions in JSON parsing (`-fwasm-exceptions` on
  compile *and* link).
- 7 parameters (`filter_*_style`, `*_destination`) declare more values than their name tables
  hold. Reading the names overruns, so `vs_params_json` omits them.
- `performance.now()` doesn't exist in the AudioWorklet scope, so CPU load can't be timed there.
- Desktop Vital 1.5.5's `--headless --render` segfaults (SynthBase::renderAudioToFile) and raises a
  macOS crash dialog each time. Don't use it for comparisons.
- Two engine instances have to agree. Everything that changes a table or the sample goes through the
  worker, and the worklet's own creators are never rendered again after start-up. The worker's
  instance is a full synth: resynthesis first loads the worklet's light preset into it, so it plays
  the same patch. A message type can't be shared between the worker's bootstrap and a request
  (`start` vs `init`).
- When the in-app browser pane is hidden, the page stops painting (no rAF, stale screenshots). Headless
  Chromium driven over the DevTools protocol (Playwright's cached `chrome-headless-shell` + Node's
  `WebSocket`, `tools/cdp.mjs`) gives real screenshots and input instead.
