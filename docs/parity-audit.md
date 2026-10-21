# Parity audit: the web synth vs Vital

Started 2026-10-20. Four read-only audits compared `app/src/sim/vital/*` with Vital 1.0.6's interface source
(`vital-src/src/interface/`) and the 1.5.5 capture (`~/Documents/DAW-Reference/CAPTURED-synths.md`, Vital
section). Each item says what Vital does, what we did, and what fixing it needs. Mark items `[x]` when
fixed and verified; add the commit or note.

Engine-side limits that no UI work can fix: the engine is Vital 1.0.6 (see PLAN.md, "the big caveat").

## Done outside the audits

- [x] Drag-to-modulate: live connection while hovering, removed on leave, kept on release; default depth
      `max(1 − position, 0.25)`; any modifier = bipolar at `max(2·min(p, 1 − p), 0.25)`; wheel adjusts depth
      mid-drag (modulation_manager.cpp: modulationDragged, modulationDraggedToComponent).
- [x] Oscillator display computed by the engine as Wavetable3d does (vs_osc_display: runSpectralMorph,
      adjustPhase, getPhaseWindow); 3D background of all frames (vs_wavetable_frames); 2D fill; SP spectrum
      mapping (loadSpectrumData); skin geometry and colours.
- [x] Filter responses: vs_filter_response (each model's setupFilter + its shader, ported) drawn by
      FilterCurve on filters 1, 2 and FX with live values; matches the capture's −6 dB passband / +1 dB peak.
      Still mono (one line), see O38 / item 8.
- [x] When popups close (2026-10-21, from popup_browser.cpp, modulation_matrix.cpp, about/save/delete
      sections; checked headless). The rules:
      - **One-column menus (PopupSelector)** close on a pick or a press elsewhere. Our morph and warp
        menus had stayed open; fixed.
      - **Two-column menus (DualPopupSelector:** the matrix destination, the filter model) keep their
        menu open on a pick. The left column changes on a click, not a hover. A double-click on the
        current item, or a press elsewhere, closes them. Ours closed on a pick and switched columns on
        hover; fixed.
      - **The matrix's menus were unstyled underneath the rows** (a stray selector in `matrix.css`),
        so a click in them closed them; fixed.
      - **The matrix source menu** is one column.
      - **File browsers (PopupBrowser):**
        - picking a file loads it and leaves the browser open;
        - double-clicking the chosen file, Escape, ×, or a press outside the browser and its section
          closes it;
        - presses on that section reach it. Ours had swallowed them; fixed with four closing areas.
        - Escape in the search box only clears it.
      - **Preset browser:**
        - a pick loads and stays open;
        - Escape closes it, but Escape in its search box clears it;
        - the arrow keys load the previous or next preset.
        - Ours had taken the focus from its search box on every render; fixed.
      - **Save and delete boxes** close on Save / Delete / Cancel or a release outside the box.
      - **About** closes on a release outside its box; the size buttons don't close it.
      - **The transpose snap callout** closes on a press outside it or Escape (Escape added).

## Effects page

1. [x] (lanes done: vs_status_read returns all 4; effect outputs are watched; modulated controls report left and right totals) Status reads return lane 0 only (`vs_status_read`); chorus needs 4 lanes × 4 outputs, stereo displays
       need lanes 0/1. Effects panels don't subscribe to status/live values at all.
2. [x] Compressor meters from `compressor_{low,band,high}_{input,output}` (sqrt of mean square → dB, −80…0;
       L/R bars ⅕ band width; input = 2 px line Primary2, output = bar Primary1) — compressor_editor.cpp renderCompressor.
3. [x] Chorus viewer: voices×4 bars at x = 1/chorus_delaysN[lane] over 0–70 ms, width 0.3, middle half
       height, Secondary1 additive — chorus_section.cpp ChorusViewer::drawBars.
4. [x] Flanger: comb shader over 3× width, slid by MIDI note of flanger_delay_frequency[lane]; resonance
       0.5 + 0.5·feedback; mix = modulated dry/wet — flanger_section.cpp renderLineResponse.
5. [x] Phaser: cutoff from phaser_cutoff[lane], phaser response shader with PhaserFilter peaks, db24, mix —
       phaser_section.cpp setupFilterState.
6. [x] EQ spectrogram behind the curve from getEqualizerMemory() (needs a new engine API: audio memory).
7. [x] Displays must read modulated values (trigger_value totals) — delay, chorus/delay filter, distortion,
       distortion filter, EQ, FX filter, flanger, phaser.
8. [x] Stereo: right line (Primary2/Secondary2) under left (Primary1/Secondary1) on every response display.
   Each display asks the engine for both lanes (`vs_mod_total_read` writes left and right). The fills stack
   even in mono, as in Vital: the FILTER 1 capture's fill matches two 0x64 layers, not one. The delay filter
   draws left first and keeps both layers while off (DelayFilterViewer::render).
9. [x] Chorus/delay band filter: one-pole HP × LP, gain = ratio(high − low) + 1, radius = spread·8 oct·12,
       MIDI 8–132, −18…+6 dB full height, filled — delay_section.h DelayFilterViewer::drawLines.
10. [x] Delay taps: 50 bars over 4 s from x = −1; bar 0 = dry equalPowerFade(1 − mix), then wet·fb^k with
        wet = equalPowerFade(mix); L up from centre (Primary1), R down (Primary2); ping-pong interleaves;
        width min(1, n·inc/2); tempo 2^−(round(tempo) − 6) × dotted/triplet, no BPM — DelayViewer::drawBars.
11. [x] Distortion transfer: exact linearFold / sinFold / bitCrush / downsample (distortion.cpp, getDriveValue);
        mix not applied; fill to centre; L/R.
12. [x] Distortion filter: digital SVF response shader with blend stages.
13. [x] EQ curve: DigitalSvf at 100 kHz, 128 points; low Shelving or 12 dB blend 2; band Shelving or
        NotchPassSwap; high Shelving or 12 dB blend 0; filled to 0 dB; ±15 dB + 20 % buffer —
        equalizer_response.cpp computeFilterCoefficients + kEqFilterResponseVertexShader.
14. [x] Reverb EQ: same EqualizerResponse, 0.4 dB buffer (reverb_section.h:27), no frequency lines.
15. [x] FX filter curve: FilterResponse per model (shared with the voice filter).
16. [x] Compressor hit-test: band width (1 − 0.05·4)/3, 5 % dead gaps, disabled low/high → band column,
        8 px grab, upper wins ties; above upper = upper ratio, below lower = lower ratio, between = none.
17. [x] Compressor ratio drag: delta = dy_down/h; upper ratio += 0.6·delta; lower −= 0.6·delta.
18. [x] Compressor Shift-drag moves all six thresholds together.
19. [x] Threshold clamp −79…−1 dB; upper pushes lower and vice versa.
20. [x] Double-click a ratio region resets it to 0.
21. [x] Compressor hover highlight (2 px Center Line), ratio-line brightness ×2 on hover, resize cursor only
        over a point, dB popup below while dragging.
22. [x] Compressor rendering: colour by ratio sign (Secondary1 / Secondary2 / disabled); 14 ratio lines per
        region from the 10 dB grid, 4 px FadeSquare at (14 − i)·mult/14; 7 background grid lines; disabled band
        removed and band column widened.
23. [x] EQ absolute drag: nearest node within 0.06·width anywhere; cutoff = x/width, gain = (y − 0.1h)/(0.8h).
24. [x] EQ mouse wheel over a node = that band's resonance.
25. [x] EQ popups (cutoff, gain) while dragging; halo radius 0.18h (Lighten Screen); handles 0.06h,
        unselected = 1 px rings.
26. [x] EQ: no double-click reset in Vital (remove ours).
27. [x] EQ gain knob greyed in HP / notch / LP modes (setGainActive).
28. [x] EQ mode buttons: fixed shape per button, coloured when on, grey when off (check the capture).
29. [x] Delay viewer drag: vertical only, feedback −= dy·range/width (remove our horizontal tempo drag).
30. [x] FX filter screen: no double-click and wheel done; cutoff/resonance popups still to do on FX.
31. [x] Formant / comb control swaps (showModelKnobs, setLabelText): formant X/Y replace cutoff/resonance,
        TRANSPOSE replaces blend (not on "The Mouth"), PEAK replaces DRIVE, SPREAD replaces KEY TRK; comb
        "CUT" replaces DRIVE.
32. [x] Blend-bar end icons per model/style (getLeftMorphPath / getRightMorphPath).
33. [x] Formant has 3 styles: AOIE, AIUO, The Mouth. (1.0.6's menu lists two, AOIE and AIUO; The Mouth is named when a preset sets it.)
34. [x] No Shift = fine on display drags (except compressor move-all).
35. [x] Flanger feedback drag: full −1…1 per display height.
36. [x] Delay Mono → Stereo copies tempo, sync and frequency into the aux controls. Also: every mode but Mono shows the aux tempo (we showed it for Stereo only).
37. [x] Effect list hover grip: two 3×2 dot grids on the hovered tile (Lighten Screen ×1.5).
38. [x] Live reorder while dragging (engine and panels move as the cursor crosses a slot).
39. [x] Tile drag: starts on mouse-down, clamped to the list, slot from cursor y.
40. [x] Connector strip behind the tiles (10 % of list width, right of centre, Lighten Screen).
41. [x] Scrollbar in the right gutter; wheel scrolls only while content overflows.
42. [x] Phaser BLEND bipolar bar snapping to centre.
43. [x] Distortion filter None: still a filled curve in disabled colours (check capture).

## Shared control gestures (every knob, slider and text value)

Scale: Vital's window is 1440 pt wide at 100 %, the stage 1000 px, so 1 stage px ≈ 1.44 pt.

V1. [x] Fine drag is Cmd/Ctrl ×0.1 (kSlowDragMultiplier); Shift does nothing except where
        setShiftIndexAmount applies (transpose: ±12) — synth_slider.cpp mouseDrag. We use Shift = fine.
V2. [x] Knobs and text values drag both ways (RotaryHorizontalVerticalDrag: right/up adds). We read dy only.
V3. [x] Sensitivity: rotary full range = 200 pt (≈139 stage px) ÷ sensitivity; transpose sensitivity 0.2
        (≈694 px). Ours: 160 / 200.
V4. [x] Shift-drag and Shift-wheel on transpose jump octaves (setShiftIndexAmount(12)).
V5. [x] Mouse wheel on every control (indexed values step; wave frame wheel movement 8; displays forward it).
V6. [x] Value popup only on press / drag / wheel / double-click, never on hover (except modulation amount
        knobs). Ours shows on hover.
V7. [x] Hover feedback: knob arc ×1.4 thicker, linear slider bar thicker (OpenGlSlider::redoImage).
V8. [x] Popup placement per control (knobs below; cutoff, formant X below; blend above; resonance,
        formant Y, wave frame right) and prefixes ("Cutoff: ", "Resonance: ", "Blend: ", "Frame: ",
        "Spectral Morph: ", "Wave Morph: ", "Formant X: ", "Formant Transpose: ", "Unison Detune Power: ");
        text values show their display name while dragging.
V9. [x] Alt-click opens inline text entry (ours: only Enter Value via prompt).
V10. [x] Snap: blend snaps to 1.0; filter keytrack, formant_transpose, formant_spread snap to 0 within 5 %.
V11. [x] Vertical sliders (wave frame, resonance) and text values need the modulation range and live meter. — Done: linear meters on the vertical sliders and the text values (controls.tsx LinearMeter, TextValue meterLeft), with the rings.
V12. [x] Indexed poly-mod controls are drop targets (osc_N_transpose, osc_N_unison_voices, sample_transpose). — Done: modulatable flag from the engine's own lists (modLists.json via tools/modlists.mjs), so these take drops.
V13. [x] Right-click "Disconnect all modulations" when more than one connection exists.

## Voice page

O14. [x] Destination menu/arrows offer only Filter 1 · Filter 2 · Filter 1+2 · Effects · Direct Out (wrap at
         kNumSourceDestinations); menu opens below the selector's left edge. Same for SMP.
O15. [x] Warp labels name the other oscillators ("FM <- Osc 2"…), separators after None and before FM.
O16. [x] Morph/warp menus: separator after None; closed selector shows short uppercase names
         (VOCODE, FORM SCALE, HARM STRETCH, INHARMONIC, RAND AMP, PHASE DISP, TIME SKEW, SYNC…).
         1.5.5's four extra morphs are engine-blocked.
O17. [x] Morph/warp amount knobs bipolar per type, double-click → 0.5 if bipolar else 0, fully inactive
         when the type is None.
O18. [x] Distortion-phase bar under the display for Sync/Formant/Quantize/Bend/Squeeze/Pulse; display shrinks.
O19. [x] Display gestures: press + vertical drag sets frame (full range per height), "Frame:" popup, wheel →
         frame slider.
O20. [x] Display right-click: Save to Wavetables · Copy · Paste · — · Initialize · (Text to Wavetable: needs
         Vital's server, skip) · Resynthesize Preset to Wavetable (needs an engine export).
   Save to Wavetables downloads a .vitaltable; Copy / Paste use an in-app clipboard; Text to Wavetable and Resynthesize are left out.
O21. [x] Audio-file drop: WAVETABLE / VOCODE / PITCH SPLICE zones (needs engine audio → wavetable). — Done: vs_wavetable_from_audio; the drop zones split the display 3/8 · 1/4 · 3/8; a WAV's clm chunk picks the fade style and author.
O22. [x] 3D/2D/SP button cycles backwards (render_type + 2) % 3.
O23. [x] Wavetable browser window (folders, stars) and ‹ › step through the folder. — Done: PopupBrowser (folders, Favorites, Add Folder, search, stars) at the capture's bounds; ‹ › use shiftedFile.
O24. [x] Wavetable editor (pencil). — Done: WavetableEditor.tsx over vs_wt_* (web_synth.cpp): frame, harmonics and phases with power/amplitude scale and zoom; every overlay (wave, line and audio-file sources; phase, window, filter, slew, fold, warp); playhead; component list menus; organizer select / box-select / drag / double-click / menus; NORMALIZE TABLE, REMOVE DC; Save As / Import / Export / .wav / Synthesize. Verified headless (create, drag, remove keyframes; fold; file drop).
O25. [x] Unison viewer bars (voices, detune, detune power; animated); invisible detune_power drag over it.
O26. [x] Transpose snap callout: 12 large dots, drag-paint, hover, Global Snap (bit 12 = +4096).
O27. [x] WaveDisplay: L/R lines, 3D background gradient fill toward body colour, ring end caps.
   The 3D background is now all 257 frames with paint3dBackground's gradient shading (Daniel's 2026-10-20 report: it was flat and only the table's own frames). Each channel's frame comes from the engine at its own lane of frame / morph / distortion; 2D and SP stack both layers.
O29. [x] Sampler: sample load into the engine (`vs_load_sample`): the file decoded at the audio context's rate,
   both channels when stereo. Vital caps mono at 1764000 samples; stereo is capped at 3528000 here (memory).
O30. [x] Sample waveform: 256-bin max-peak envelope, mirrored, line + fill (`vs_sample_peaks`, `SampleViewer.tsx`).
O31. [x] Sample playhead glow from `sample_phase` status (the shared line boost, `lineBoost.ts`).
O32. [x] Sample browser; ‹ › steps; audio-file drop on the viewer. — Done: sample browser, ‹ › steps, drops on the viewer (vs_load_sample, stereo).
   Drop on the viewer (with the Overlay Screen) and the name opening a file picker are done; ‹ › step
   through the files picked together. Vital's popup sample browser (folders, favourites) is not built.
O34. [x] Sampler toggle icons (Paths::keyboard/shuffle/loop/bounce) with hover/on colours.
O35. [x] Filter model control swaps (formant: X/Y bars, TRANSPOSE bar, PEAK, SPREAD; comb: CUT replaces DRIVE).
O36. [x] Blend-bar icons per model/style.
O37. [x] FIL1/FIL2 serial buttons mutually exclusive (filterSerialSelected).
O38. [x] Filter graph from the engine response (vs_filter_response) with live values, L/R.
O39. [x] Filter graph gestures: no fine mode, no double-click, wheel x → cutoff / y → resonance, popups.
O40. [x] Filter model menu: dual popup at the section's right edge; style names per 1.0.6.
O41. [x] Cutoff popup in Hz when ADVANCED → Frequency Units = Hz.
O43. [x] PARAMS defaults match Vital's overrides (osc_1_on 1, osc_2_destination 1, osc_3_destination 3,
         filter_1_osc1_input 1, filter_2_osc2_input 1) so Set to Default / double-click agree.

## Modulators and modulation

D1. [x] Current modulator chosen on press (not hover), rounded border (2.6 px while dragging); pressing an
        unrelated control clears it.
   D1–D12 are in `SourceButton.tsx`, `DragGhost.tsx`, `store.tsx` (beginSourceDrag, focus loss) and the engine's `vs_force_show`.
D2. [x] Rings: only the current modulator's at rest; hovering a control shows the others' in a centred row.
D3. [x] Drag starts when the pointer leaves the source button (not a 4 px threshold).
D4. [x] Drag ghost: ring under the cursor (radius 0.022·width) filled by the source's live value.
D5. [x] Target highlight excludes the source's own control and already-connected targets, only active sections.
D6. [x] Four-way drag handle on hover while the source has no connections.
D7. [x] Source meters: live bar of the source's value in each tab / macro / MIDI cell (watch the sources).
D8. [x] Source right-click: Disconnect from <dest> per connection, Disconnect all (≥ 2).
D9. [x] Source amount knobs: 3×2 grid, callout past the limit.
D10. [x] Source-side knob popup names the destination ("Filter 1 Cutoff: 64.00") and highlights its range.
D11. [x] Tabs: minimum (3 env, 4 LFO, 2 rand) plus one past the highest connected; shrink to fit, no scrolling.
D12. [x] Selecting a source forces it to run and animate (forceShowModulation) — engine message.
D13. [x] BUG: double-click on a ring removes the connection (ours resets the knob underneath).
D14. [x] Middle-click on a ring toggles bypass.
D15. [x] Ring drag: 200 pt for −1…1, up or right adds, Cmd fine.
D16. [x] Meter live only (knob → modulated value, L/R colours); static range only while hovering/dragging a ring.
   The meter runs from the set value to each lane: both lanes Modulation Meter #1de9b6, left only #1de952, right
   only #1dc2e9 (the rotary / linear modulation shaders); 3 pt at 39 pt across on knobs. The hovered range is
   Modulation Meter too, 2 pt just outside. Mono totals show with no voice playing (a macro moves its meter).
D17. [x] Text and curve controls get a 2 px meter and rings; SLOPE is a drop target.
D18. [x] Ring visuals: ring thickness 1.0 → 1.8 on hover; source-side knobs in the destination's arc colour.
D24. [x] BUG: envelope powers mirrored — Vital: attack ps(t, −ap), decay 1 − (1 − s)·ps(t, +dp), release
         s·(1 − ps(t, +rp)) (envelope.cpp:82–90).
D25. [x] Envelope power drag: 0.06 per px upward for all three handles.
D26. [x] Double-click a power handle resets it to 0.
D27. [x] Delay and hold points drawn and draggable when non-zero. (In Vital the delay point is draggable but not drawn; ported that way.)
D28. [x] Envelope point picking: nearest point anywhere, hover ring, drag circle, absolute position.
D29. [x] Hide power handles on segments under 3 px.
D30. [x] Envelope window: fixed 4 s, grows only when dragging past the edge (0.125–64 s); wheel zoom ×2;
         magnifier vertical-drag zoom, double-click fits release + 25 %.
   Done in `EnvelopeEditor.tsx`. The wheel uses JUCE's 0.5 / 256 per scrolled pixel, so one mouse notch zooms about 1.14×, not 2×.
D31. [x] Ruler: base-4 grid, fading sub lines and labels.
D32. [x] Envelope redrawn from modulated stage times, L/R lines, glow trail, fading ring playhead.
D33. [x] LFO right-click: Set Start Point · Remove Point · Enter Point Phase · Enter Point Value · Reset Power ·
         Copy · Paste · Save to LFOs · Flip Horizontal · Flip Vertical · Import LFO · Export LFO.
   Done in the shared `LineEditor.tsx`; "Save to LFOs" is left out (no LFO library in a browser build) and Copy / Paste use an in-app clipboard (reading the system one needs a permission).
D34. [x] LFO power handle double-click resets it; Shift + double-click resets all.
D35. [x] LFO power drag: 9 units per editor height, direction-aware; Shift all, Alt alternate.
D36. [x] LFO points snap to grid (0.02 x, 0.04 y; Alt off); equal first/last y move together.
D37. [x] Smooth keeps powers and handles.
D38. [x] Wrap-segment power (last → first) kept and draggable; handles hidden on flat segments.
D39. [x] Paint: Cmd temporary toggle, hovered cell, y-snap within 0.04 (Alt off), pattern scaled bottom → cursor.
D40. [x] Wheel over the LFO editor: grid X, or paint pattern while painting.
D41. [x] Grid boxes: drag sliders (sensitivity 0.2), double-click default 8 / 1, Y max 24, "X Grid" popup.
D42. [x] Paint pattern: text selector (list, wheel), dimmed until painting.
D43. [x] LFO phase slider is a full SynthSlider (drop target, rings, menu, default, popup above).
D44. [x] SMOOTH ↔ FADE IN dropdown (smooth_mode), swapping smooth_time / fade_time.
D45. [x] Keytrack sync shows transpose | tune; Shift steps an octave.
D46. [x] MODE / sync menus open at the control's bottom-left; right-click gives the slider menu.
D47. [x] LFO shape list: Vital's own simple shapes (Saw Down, Saw Up, Sin, Square, Staircase Down, Triangle); — Done: LFO name opens the browser over the built-in shapes and user files; ‹ › step.
         user-file browser.
D48. [x] LFO playhead: L/R rings, glow trail, stereo line.
D49. [ ] Point Cycle mode (1.5.5 only) — engine-blocked.
D50. [x] Random display: scrolling 64-sample history of random_N, filled, stereo line.
D51. [x] SPREAD ↔ ROTATE dropdown (stereo_mode).
D52. [x] VOICES / BEND text sensitivity 0.2.
D53. [x] SLOPE: draw ps(t, −value) in the arc colour; full SynthSlider (200 px, menu, popup, modulatable).
D54. [x] Macro rename: select-all, Escape cancels, empty keeps the old name; preset load restores macro names.
D55. [x] Macro popup to the right.
D56. [x] Wheels: SynthSlider sensitivity 0.5, popup above, menu, rotating ridges.
D57. [x] Keyboard velocity from click height (top soft → bottom loud, black keys ×0.7), hover, glissando.

## Matrix, Advanced, header, generic controls

M1. [x] Matrix # cell is a bypass button (shows "X" when bypassed); rows have no right-click menu.
M2. [x] Matrix live meters: 2 px bar under each destination from `modulation_amount_N` (L/R colours).
M3. [x] MORPH icon: power = −value, S-curve when bipolar, disabled colour when inactive.
M4. [x] Amount display multiply = range only for linear/indexed destinations, else 1 (updateDisplayValue);
        affects shownAmount, Enter Value, ring popups.
M5. [x] Amount slider: full SynthSlider menu (Set to Default · Enter Value · Learn MIDI); popup on drag only.
M6. [x] Source/destination menus open under the clicked box (dual menu 420 wide). — Done: SUBMENUS open under the box; the destination menu is the dual list.
M7. [x] Destination list = the engine's modulatable outputs, natural sort by id (export vs_destinations). — Done: MOD_LISTS from vs_modulation_lists_json, in the engine's order.
M8. [x] Sort: by id index, connected rows first.
M11. [x] Remap editor animates the live input (modulation_source_N, L/R dots, glow trail).
M12. [x] Line-editor right-click: Remove Point · Enter Point Phase · Enter Point Value · Reset Power · Copy ·
         Paste · Save to LFOs · Initialize · Flip Horizontal · Flip Vertical (LFO editor too).
   Done in the shared `LineEditor.tsx`; "Save to LFOs" is left out (no LFO library in a browser build) and Copy / Paste use an in-app clipboard (reading the system one needs a permission).
M13. [x] Point drags snap to the grid unless Alt; paint y-snap respects Alt.
M14. [x] Smooth and curve powers coexist (smoothTransition then powerScale).
M15. [x] Cmd held = temporary paint toggle.
M16. [x] Power drag: Shift = all segments, Alt = alternate; Shift + double-click resets all powers.
M17. [x] Hover highlight of point / power handle / paint cell.
M18. [x] Wheel over a line editor: grid X, or paint pattern while painting.
M19. [x] Grid boxes: X 1–32, Y 1–24, double-click resets 8 / 1, sensitivity 0.2, wheel ±1.
M20. [x] Paint pattern selector inactive unless painting.
M22. [x] Inactive line editor keeps its line in disabled colours.
A23. [x] TUNING: Default / Just 7 / Just 5 / Pythagorean + Load Tuning File (scl/tun/kbm) — needs engine tuning API. — Done: glue/tuning_port.cpp (Tuning without JUCE), vs_tuning_*; built-in tunings and scl/tun/kbm files.
A24. [x] MPE ENABLED — needs a MIDI manager (per-channel bend, pressure, slide, lift). — Done: engine/midi.ts over vs_midi (MPE zones, RPN bend range); MPE toggle → vs_set_mpe.
A25. [x] Unison spread visualiser: three rows (wave frame, spectral morph, distortion) per voice, live totals; — Done: SpreadDisplay ported, live totals.
         nothing when voices ≤ 2.
A26. [x] ANALYSIS oscilloscope from engine oscilloscope memory (pitch-synced, L/R, filled).
A27. [x] ANALYSIS spectrogram (Hann FFT, log axis, dB/oct slope, decay, L/R, decade grid).
A28. [x] FREQUENCY UNITS Hz changes every frequency readout.
A30. [x] Text selector boxes drag and wheel through values; right-click gives the slider menu. — Done: ParamMenuBox and MenuBox drag/wheel and the slider menu.
H33. [x] Preset name: left-click toggles the preset browser, right-click opens the menu. — Done.
H34. [x] ‹ › load previous / next preset in the browser folder (user library). — Done: jumpPreset over the library folder.
H35. [x] "*" prefix once the patch is modified.
H36. [x] Preset browser (folders, search, style filters, sortable columns, info pane) over a user library. — Done: PresetBrowser over IndexedDB + File System Access folders.
H37. [x] Save overlay: NAME, AUTHOR, STYLE, COMMENTS, Save / Cancel, overwrite confirm. — Done: SaveOverlay (630 × 450 pt), overwrite confirm.
H38. [x] Menu: Clear Tuning item; Export doesn't rename the session preset. — Done.
H39. [x] Temporary tab "X <name>" while an overlay is open. — Done: temptab with ×.
H40. [x] Logo → About (version, window size). — Done: About with WINDOW SIZE.
H41. [x] Volume meter: L/R, position ((dB + 80)/86)², peak-hold tick (peak_meter_memory), latched clip
         decaying 0.014/frame, shaded area above 0 dB, ticks every 6 dB −66…+6.
H42. [x] Volume drag: popup below, Cmd fine.
H43. [x] Header scope: pitch-synced engine oscilloscope memory, L/R, filled.
H44. [x] Clicking the scope toggles `view_spectrogram` (−40…0 dB, no grid).
S47. [x] Inline text entry (centred, select-all, Enter / blur commits, "%" of range, full precision).
S49. [x] Popup default position below, per-control overrides. — Done: Bubble placement per control.
S53. [x] Plain clicks shouldn't add undo steps.
S54. [x] Double-click to default shows the value popup.
K55. [x] Computer keyboard: velocity 1.0; octave change releases held notes; offset 0–120; Space = correctToTime(0).
K56. [x] On-screen keyboard: velocity from click height (black keys vs 0.7·h), lift 0, hover highlight,
         black keys 0.7 of height — lift needs a vs_note_off lift argument.
