# Web wavetable synth

The synthesis engine from [mtytel/vital](https://github.com/mtytel/vital) compiled to WebAssembly
and run in an AudioWorklet, played through a redrawn Vital interface (`app/`). The sound is the real
engine, not an imitation.

This is a standalone GPLv3 project, kept apart from StemShare on purpose (see Licensing). It is not
made by, endorsed by or affiliated with Vital Audio.
`PLAN.md` is the build plan for a fully working browser synth on top of it.

## Layout

| Path | What it is |
|---|---|
| `vital-src/` | git submodule: Vital's source, pinned. Only `src/synthesis` and parts of `src/common` are compiled. |
| `shim/JuceHeader.h` | Stand-in for the few JUCE pieces the engine touches (leak-detector macros, `String`, `Base64`, `MemoryOutputStream`, `Random`, denormal control). JUCE itself isn't built. |
| `shim/load_save.h` | The slice of `LoadSave` the wavetable code calls (version compares, PCM/float conversion). |
| `glue/web_synth.cpp` | The C API the browser calls (`vs_*`): a cut-down `SynthBase` with init, note on/off, sustain, set/get parameter, modulation connect/disconnect, `.vital` preset load and save, wavetable and LFO shape set/read, wavetable frame readback, status outputs (LFO phases, voices, peak). |
| `glue/tuning_port.cpp` | Vital's microtuning without JUCE: `.scl`, `.kbm`, `.tun` and the built-in scales. |
| `glue/table_port.cpp` | Hands finished wavetables and samples from one engine instance to another: export, stage, commit. |
| `web/engine-worklet.js` | AudioWorklet processor that hosts the engine that plays. Finished tables and samples arrive as jobs it copies in between audio blocks. |
| `web/table-worker.js` | A Worker running a second engine instance that owns the wavetables and the sample: preset loads, wavetable files and audio, resynthesis, sample files, the wavetable editor. Nothing that renders a table runs on the audio thread. |
| `web/engine-client.js` | Page-side `SynthEngine` class: port messages to the worklet, requests to the worker, and the hand-over between them. |
| `web/demo.html` | Plain engine demo: keyboard, quick controls, all 772 engine controls, preset file loader, scope, a tutorial-style task list. |
| `web/engine-client.d.ts` | Types for the client. |
| `app/` | The synth app (Vite + React): the Vital interface from StemShare's Foundations of Synthesis sim (`app/src/sim/`), played by the engine (`app/src/engine/`). |
| `app/src/embed/` | Framed mode (`?embed=1`): the whole synth or only some of its sections (`parts`, see `app/src/sim/vital/parts.tsx`), and the versioned postMessage protocol a page uses to drive it. See `docs/embed-protocol.md`. |
| `app/src/sim/vital/skin.tsx` | Vital's skins (`.vitalskin`): each colour and size becomes a `--sk-*` CSS variable, section overrides go on the elements marked `data-skin`, and ADVANCED → THEME picks Vital's default, the bundled Make Things Dark and Light (`app/src/sim/vital/skins/`), or a skin file the reader loads. |
| `web/_headers` | The deployment's headers: which pages may frame the synth. |
| `app/src/engine/EngineSync.tsx` | Keeps the engine matching the interface's state: values, routings, wavetables, LFO shapes, notes. |
| `tools/` | `bench.mjs` (realtime factor), `sweep.mjs` (load and play every preset in a folder), `roundtrip.mjs` (save → load every preset in a folder and compare), `render.mjs` (offline render to WAV, matching desktop Vital's `--render`), `cdp.mjs` (headless Chromium over the DevTools protocol, for checks when no visible browser paints), `skinshots.mjs` + `skindiff.py` (every page and overlay in one skin, and a pixel diff between two sets). |

## Build

Clone with the submodule (Vital's source):

```bash
git clone --recursive https://github.com/danielrdehaan/web-wavetable-synth.git
```

`web/engine.mjs` is built, not committed. It needs Emscripten (`brew install emscripten`; built with 6.0.13) and Xcode's clang for the native build.

```bash
./build.sh wasm      # → web/engine.mjs (single file, wasm inlined; ~1.5 MB, ~330 KB gzipped)
./build.sh native    # → build/native/native_test (renders a note, prints peak/RMS)
```

```bash
npm install
npm run dev          # the synth app on http://localhost:5291 (web/ is served at the site root)
npm run typecheck
npm run build        # → dist/ (static: host it anywhere that serves .mjs as JavaScript)
```

The plain demo is at http://localhost:5291/demo.html in dev.

## Licensing — read before publishing anything

- Vital's source is **GPLv3**. Anything that links or bundles this engine (the wasm, the worklet,
  and any UI shipped in the same program) must be offered under GPLv3 with source. This is why
  it lives in its own repo, not inside StemShare.
- Vital's README forbids using the names **"Vital", "Vital Audio", "Tytel" or "Matt Tytel"** to
  name or market a distribution of binaries built from this source. Name the published project
  something neutral. Teaching articles that describe Vital are a separate matter (nominative use),
  but the hosted synth itself must not be branded Vital.
- **Don't distribute Vital's factory presets** (separate licence). The engine loads any `.vital` file a user
  supplies, but the presets and wavetables shipped with the site must be our own.
- The bundled skins are our own (Make Things); Vital's default skin comes from its GPL source. Don't bundle
  Vital's paid skin packs.
- Don't connect to vital.audio services from builds.
- The public source is **Vital 1.0.6** (Feb 2021; repo last synced 2022), not the current 1.5.5.
