# Embedding the synth: parts and the protocol (version 1)

A page can frame the synth, whole or as a few of its sections, and drive it: load a lesson patch, set
controls, point at a control, lock controls, play notes, and read the synth's state to check a
lesson's tasks. StemShare's `wavetableLab` KB widget (`src/components/kb-widgets/KbWavetableLab.tsx`
in the StemShare repo) is the first such page. The synth is a separate GPL program on its own origin,
so the two share only this protocol, never code.

Code: `app/src/embed/` (`EmbedApp.tsx`, `EmbedBridge.tsx`, `protocol.ts`), and the parts in
`app/src/sim/vital/parts.tsx`.

## The frame's URL

`https://<synth>/?embed=1&parts=osc1,filter1,lfo1,keys&layout=column&host=https://<page origin>`

| Parameter | Meaning |
| --- | --- |
| `embed` | Framed mode: no page chrome, the interface filling the frame's width. Required. |
| `parts` | The sections to show, comma separated (below). Without it the whole window is shown. |
| `layout` | `column` (default) stacks the parts top to bottom; `row` puts them side by side. A part written `id@x:y` goes exactly there instead (frame units, the capture's 2000-wide frame; its top-left corner). |
| `flow` | `1` draws the signal flow between the parts (below). |
| `host` | The framing page's origin. The synth talks only to it, and only if the origin is allowed. |
| `skin` | The skin, by name or file name: `make-things-dark`, `make-things-light`, or `default` (Vital's). Without it, the one last chosen in ADVANCED → THEME in that browser, else the default. |

**Parts:** `osc1`–`osc3`, `sampler`, `filter1`, `filter2`, `env1`–`env3`, `lfo1`–`lfo8`,
`random1`, `random2`, `midi`, `voice`, `glide`, `macros`, `keyboard` (all 128 keys), `keys` (four
octaves, MIDI 36–84), `effects`, `matrix`, `modrows` (the matrix's routing rows), `remap` (the
matrix's remap editor for the selected row), `advanced`, `output` (the volume meter, labelled), and one
effect panel each: `chorus`, `compressor`, `delay`, `distortion`, `eq`, `fxfilter`, `flanger`,
`phaser`, `reverb`.

How parts behave:
- **They're the real sections.** Each part is the same component as in the full window, drawn in a
  shifted container. Menus, rings, callouts and browsers all work as they do there; a browser moves
  with its section and stays inside the frame.
- **Parts that share a section share its tab.** For example, `lfo1` and `lfo2` together show one LFO
  section.
- **The wavetable editor** (an oscillator's pencil) opens over the whole window while it's open.

**The signal flow** (`flow=1`, `app/src/sim/vital/FlowLayer.tsx`) is drawn from the patch as it is,
and only between parts that are shown:
- **Audio:**
  - each oscillator and the sampler to its destination: a filter, both, the effects, one effect, or
    the output (Direct Out, dashed), labelled with the destination;
  - a filter into the other (FIL1 / FIL2);
  - the filters into the effects;
  - the switched-on effect panels in chain order, the last one to `output`.
- **Modulation** (teal, dashed): from the source's part to each control it moves. A routing whose
  remap curve isn't linear goes through the `remap` part.
- **Layout:** a line runs right to left from part edge to part edge, or top to bottom to a part below,
  so place parts left to right in signal order.

`kb-preview-harness/fixtures/wavetable-lab/signal-flow.md` in the StemShare repo is a worked layout:
- four sources on four paths: two filters, straight to the effects, and Direct Out;
- delay into reverb;
- LFO 1 through a stepped remap to both cutoffs, and directly to the reverb's mix and the sampler's
  level.

**Sound** starts on the reader's first click or key press inside the frame, as browsers require. Until
then a small "Click to turn the sound on" note shows.

## Origins

The synth answers only the `host` origin, and only when it's allowed:
- **Allowed:** `https://stems.makethings.audio`, anything in `VITE_EMBED_ORIGINS` (comma separated,
  set at build time), and in dev builds any `localhost` / `127.0.0.1` origin.
- **Sending:** it posts to that exact origin, never to `'*'`.
- **Receiving:** it ignores messages from any other origin or window.

The deployment's `web/_headers` limits who may frame it (`frame-ancestors`). Keep that list in step
with the allowlist.

## Messages

Every message is an object `{ type: 'synth:…', v: 1, … }` sent with `postMessage`. A message with
another `v` gets a `synth:error`.

From the synth to the page:

| Type | Fields | When |
| --- | --- | --- |
| `synth:ready` | `parts` | When it loads, and in answer to `synth:hello`. |
| `synth:state` | `state`, `start?` | When anything the page sees changes (at most every 100 ms), and in answer to `synth:get`. `start: true` marks the first report after a `synth:load` took effect: where a lesson starts. |
| `synth:started` | | The sound came on. |
| `synth:size` | `width`, `height` | The content's size changed (so the page can fit the frame to it). |
| `synth:error` | `message` | A message it couldn't take. |

The `state` object:
- **`values`:** every control's value in the engine's own units: cutoff in semitones, levels 0…1, menus
  as indices. The ids are Vital's parameter names (`filter_1_cutoff`, `lfo_1_frequency`, …).
- **`mods`:** each routing as `{src, dst, amount, depth, bipolar, stereo, bypass}`. `amount` is −1…1 of
  the destination's range; `depth` is the same in its units, e.g. 40 semitones of cutoff.
- **`held`:** the notes held: on-screen keys, computer keys, MIDI, or `synth:note`.
- **`running`:** the sound is on and not paused.
- **`tables`:** each oscillator's wavetable name.

From the page to the synth:

| Type | Fields | Does |
| --- | --- | --- |
| `synth:hello` | | Asks for `synth:ready` (for a page that missed the first one). |
| `synth:get` | | Asks for `synth:state` now. |
| `synth:set` | `values: {id: value}` | Sets controls (engine units). |
| `synth:load` | `patch: {values?, mods?: [{src, dst, amount?, bipolar?, remap?}], ui?}` or `patch: {preset: "<.vital text>"}` | The init patch then those values and routings, or a whole preset. A routing's `remap` is its curve: `{points: [[x, y], …], powers?, smooth?}`, x and y 0…1, 1 at the top. `ui` may set `fxOrder` (the effect chain, a permutation of 0–8) and `mxSel` (the matrix row the `remap` part shows). |
| `synth:highlight` | `targets` | Outlines those controls (an empty list clears it). |
| `synth:lock` | `targets` | Makes those controls unusable (dimmed); an empty list unlocks them all. |
| `synth:note` | `note`, `on`, `velocity?` | Plays or releases a note. |
| `synth:pause` / `synth:resume` | | Suspends or resumes the sound. A paused synth also resumes on the reader's next press. |

A **target** is `{param: "filter_1_cutoff"}`, `{source: "lfo_1"}` (a modulation source's button or
tab), or `{part: "filter1"}` (a shown part).

## Lesson checks (the page's side)

StemShare checks tasks against `synth:state` with `src/lib/wavetableLab/lessonChecks.ts`:
`{mod: {src, dst, minDepth?, maxDepth?, bipolar?}}`, `{param: {id, min?, max?, equals?}}`,
`{changed: {id}}`, `{held: n}`, `{running: bool}`, `{all: […]}`, `{any: […]}`. A task's `target`
string (`param:…`, `source:…`, `part:…`) becomes a `synth:highlight` while its step shows.
`kb-preview-harness/fixtures/wavetable-lab/lfo-cutoff.md` (and `signal-flow.md`) in the StemShare repo is a whole
lesson (LFO 1 → cutoff).
