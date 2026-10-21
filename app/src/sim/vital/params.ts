import modLists from './modLists.json'
// Vital's parameters, as data: each control's range, default, display scale and menu names, taken from
// Vital 1.5.5's parameter table (github.com/mtytel/vital, src/common/synth_parameters.cpp and
// synth_strings.h). The drawing keeps raw values in these ranges and shows them the way Vital's
// popups do (`shown`), so every number the reader reads is the one Vital would print.

export type Scale = 'lin' | 'idx' | 'quad' | 'quart' | 'exp' | 'sqrt'

export interface Param {
  min: number
  max: number
  def: number
  scale: Scale
  /** Added after scaling (before inverting and multiplying). */
  off?: number
  mult?: number
  /** Shown as 1 / value (frequencies shown as seconds). */
  inv?: boolean
  units?: string
  name: string
  opts?: readonly string[]
}

export const OFF_ON = ['Off', 'On'] as const
export const DELAY_STYLES = ['Mono', 'Stereo', 'Ping Pong', 'Mid Ping Pong'] as const
export const COMP_BANDS = ['Multiband', 'Low Band', 'High Band', 'Single Band'] as const
/** The stacks the engine implements, in its index order (Vital 1.0.6's kUnisonStackNames). Vital 1.5.5's
 *  menu adds Octave + 7 and Sub Harmonics; the Advanced page lists them greyed out. */
export const UNISON_STACKS = ['Unison', 'Center Drop 12', 'Center Drop 24', 'Octave', '2x Octave', 'Power Chord', '2x Power Chord', 'Major Chord', 'Minor Chord', 'Harmonics', 'Odd Harmonics'] as const
export const FILTER_STYLES = ['12dB', '24dB', 'Notch Blend', 'Notch Spread', 'B/P/N'] as const
export const DIODE_STYLES = ['Low Shelf', 'Low Cut'] as const
export const COMB_STYLES = ['Low High Comb', 'Low High Flange+', 'Low High Flange-', 'Band Spread Comb', 'Band Spread Flange+', 'Band Spread Flange-'] as const
export const FREQ_SYNC = ['Seconds', 'Tempo', 'Tempo Dotted', 'Tempo Triplets', 'Keytrack'] as const
export const DIST_TYPES = ['Soft Clip', 'Hard Clip', 'Linear Fold', 'Sine Fold', 'Bit Crush', 'Down Sample'] as const
export const DIST_TYPES_SHORT = ['Soft Clip', 'Hard Clip', 'Lin Fold', 'Sine Fold', 'Bit Crush', 'Down Samp'] as const
export const DIST_FILTER_ORDER = ['None', 'Pre', 'Post'] as const
export const FILTER_MODELS = ['Analog', 'Dirty', 'Ladder', 'Digital', 'Diode', 'Formant', 'Comb', 'Phaser'] as const
export const SYNCED_FREQ = ['Freeze', '32/1', '16/1', '8/1', '4/1', '2/1', '1/1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/64'] as const
export const STEREO_MODES = ['SPREAD', 'ROTATE'] as const
export const LFO_SYNC_SHORT = ['Trigger', 'Sync', 'Envelope', 'Sustain Env', 'Loop Point', 'Loop Hold'] as const
export const LFO_SYNC = ['Trigger', 'Sync', 'Envelope', 'Sustain Envelope', 'Loop Point', 'Loop Hold'] as const
export const RANDOM_SHORT = ['Perlin', 'S & H', 'Sine', 'Lorenz'] as const
export const RANDOM_NAMES = ['Perlin', 'Sample & Hold', 'Sine Interpolate', 'Lorenz Attractor'] as const
export const VOICE_PRIORITY = ['Newest', 'Oldest', 'Highest', 'Lowest', 'Round Robin'] as const
export const VOICE_OVERRIDE = ['Kill', 'Steal'] as const
export const EQ_HIGH_MODES = ['Shelf', 'Low Pass'] as const
export const EQ_BAND_MODES = ['Shelf', 'Notch'] as const
export const EQ_LOW_MODES = ['Shelf', 'High Pass'] as const
export const OVERSAMPLING = ['1x', '2x', '4x', '8x'] as const
export const DESTINATIONS = ['FILTER 1', 'FILTER 2', 'FILTER 1+2', 'EFFECTS', 'DIRECT OUT', 'CHORUS', 'COMPRESSOR', 'DELAY', 'DISTORTION', 'EQ', 'FX FILTER', 'FLANGER', 'PHASER', 'REVERB'] as const
export const DESTINATION_MENU = ['Filter 1', 'Filter 2', 'Filter 1+2', 'Effects', 'Direct Out', 'Chorus', 'Compressor', 'Delay', 'Distortion', 'Equalizer', 'Effects Filter', 'Flanger', 'Phaser', 'Reverb'] as const
export const WARP_TYPES = ['None', 'Sync', 'Formant', 'Quantize', 'Bend', 'Squeeze', 'Pulse', 'FM <- Osc', 'FM <- Osc', 'FM <- Sample', 'RM <- Osc', 'RM <- Osc', 'RM <- Sample'] as const
export const MORPH_TYPES = ['None', 'Vocode', 'Formant Scale', 'Harmonic Stretch', 'Inharmonic Stretch', 'Smear', 'Random Amplitudes', 'Low Pass', 'High Pass', 'Phase Disperse', 'Shepard Tone', 'Spectral Time Skew'] as const
export const WAVETABLE_DIMENSIONS = ['3D', '2D', 'SP'] as const

const p = (min: number, max: number, def: number, scale: Scale, name: string, x: Partial<Param> = {}): Param => ({ min, max, def, scale, name, ...x })

const GLOBAL: Record<string, Param> = {
  beats_per_minute: p(0.333333333, 5, 2, 'lin', 'Beats Per Minute', { mult: 60 }),
  delay_dry_wet: p(0, 1, 0.3334, 'lin', 'Delay Mix', { mult: 100, units: '%' }),
  delay_feedback: p(-1, 1, 0.5, 'lin', 'Delay Feedback', { mult: 100, units: '%' }),
  delay_frequency: p(-2, 9, 2, 'exp', 'Delay Frequency', { inv: true, units: ' secs' }),
  delay_aux_frequency: p(-2, 9, 2, 'exp', 'Delay Frequency 2', { inv: true, units: ' secs' }),
  delay_on: p(0, 1, 0, 'idx', 'Delay Switch', { opts: OFF_ON }),
  delay_style: p(0, 3, 0, 'idx', 'Delay Style', { opts: DELAY_STYLES }),
  delay_filter_cutoff: p(8, 136, 60, 'lin', 'Delay Filter Cutoff'),
  delay_filter_spread: p(0, 1, 1, 'lin', 'Delay Filter Spread'),
  delay_sync: p(0, 3, 1, 'idx', 'Delay Sync', { opts: FREQ_SYNC }),
  delay_tempo: p(4, 12, 9, 'idx', 'Delay Tempo', { opts: SYNCED_FREQ }),
  delay_aux_sync: p(0, 3, 1, 'idx', 'Delay Sync 2', { opts: FREQ_SYNC }),
  delay_aux_tempo: p(4, 12, 9, 'idx', 'Delay Tempo 2', { opts: SYNCED_FREQ }),
  distortion_on: p(0, 1, 0, 'idx', 'Distortion Switch', { opts: OFF_ON }),
  distortion_type: p(0, 5, 0, 'idx', 'Distortion Type', { opts: DIST_TYPES }),
  distortion_drive: p(-30, 30, 0, 'lin', 'Distortion Drive', { units: ' dB' }),
  distortion_mix: p(0, 1, 1, 'lin', 'Distortion Mix'),
  distortion_filter_order: p(0, 2, 0, 'idx', 'Distortion Filter Order', { opts: DIST_FILTER_ORDER }),
  distortion_filter_cutoff: p(8, 136, 80, 'lin', 'Distortion Filter Cutoff', { units: ' semitones' }),
  distortion_filter_resonance: p(0, 1, 0.5, 'lin', 'Distortion Filter Resonance', { mult: 100, units: '%' }),
  distortion_filter_blend: p(0, 2, 0, 'lin', 'Distortion Filter Blend'),
  legato: p(0, 1, 0, 'idx', 'Legato', { opts: OFF_ON }),
  macro_control_1: p(0, 1, 0, 'lin', 'Macro 1'),
  macro_control_2: p(0, 1, 0, 'lin', 'Macro 2'),
  macro_control_3: p(0, 1, 0, 'lin', 'Macro 3'),
  macro_control_4: p(0, 1, 0, 'lin', 'Macro 4'),
  pitch_bend_range: p(0, 48, 2, 'idx', 'Pitch Bend Range', { units: ' semitones' }),
  polyphony: p(1, 32, 8, 'idx', 'Polyphony', { units: ' voices' }),
  voice_tune: p(-1, 1, 0, 'lin', 'Voice Tune', { mult: 100, units: ' cents' }),
  voice_transpose: p(-48, 48, 0, 'idx', 'Voice Transpose'),
  voice_amplitude: p(0, 1, 1, 'lin', 'Voice Amplitude'),
  stereo_routing: p(0, 1, 1, 'lin', 'Stereo Routing', { mult: 100, units: '%' }),
  stereo_mode: p(0, 1, 0, 'idx', 'Stereo Mode', { opts: STEREO_MODES }),
  portamento_time: p(-10, 4, -10, 'exp', 'Portamento Time', { units: ' secs' }),
  portamento_slope: p(-8, 8, 0, 'lin', 'Portamento Slope'),
  portamento_force: p(0, 1, 0, 'idx', 'Portamento Force', { opts: OFF_ON }),
  portamento_scale: p(0, 1, 0, 'idx', 'Portamento Scale', { opts: OFF_ON }),
  reverb_pre_low_cutoff: p(0, 128, 0, 'lin', 'Reverb Pre Low Cutoff', { units: ' semitones' }),
  reverb_pre_high_cutoff: p(0, 128, 110, 'lin', 'Reverb Pre High Cutoff', { units: ' semitones' }),
  reverb_low_shelf_cutoff: p(0, 128, 0, 'lin', 'Reverb Low Cutoff', { units: ' semitones' }),
  reverb_low_shelf_gain: p(-6, 0, 0, 'lin', 'Reverb Low Gain', { units: ' dB' }),
  reverb_high_shelf_cutoff: p(0, 128, 90, 'lin', 'Reverb High Cutoff', { units: ' semitones' }),
  reverb_high_shelf_gain: p(-6, 0, -1, 'lin', 'Reverb High Gain', { units: ' dB' }),
  reverb_dry_wet: p(0, 1, 0.25, 'lin', 'Reverb Mix', { mult: 100, units: '%' }),
  reverb_delay: p(0, 0.3, 0, 'lin', 'Reverb Delay', { units: ' secs' }),
  reverb_decay_time: p(-6, 6, 0, 'exp', 'Reverb Decay Time', { units: ' secs' }),
  reverb_size: p(0, 1, 0.5, 'lin', 'Reverb Size', { mult: 100, units: '%' }),
  reverb_chorus_amount: p(0, 1, 0.223607, 'quad', 'Reverb Chorus Amount', { mult: 100, units: '%' }),
  reverb_chorus_frequency: p(-8, 3, -2, 'exp', 'Reverb Chorus Frequency', { units: ' Hz' }),
  reverb_on: p(0, 1, 0, 'idx', 'Reverb Switch', { opts: OFF_ON }),
  sample_on: p(0, 1, 0, 'idx', 'Sample Switch', { opts: OFF_ON }),
  sample_random_phase: p(0, 1, 0, 'idx', 'Sample Random Phase', { opts: OFF_ON }),
  sample_keytrack: p(0, 1, 0, 'idx', 'Sample Keytrack', { opts: OFF_ON }),
  sample_loop: p(0, 1, 1, 'idx', 'Sample Loop', { opts: OFF_ON }),
  sample_bounce: p(0, 1, 0, 'idx', 'Sample Bounce', { opts: OFF_ON }),
  sample_transpose: p(-48, 48, 0, 'idx', 'Sample Transpose'),
  sample_transpose_quantize: p(0, 8191, 0, 'idx', 'Sample Transpose Quantize'),
  sample_tune: p(-1, 1, 0, 'lin', 'Sample Tune', { mult: 100 }),
  sample_level: p(0, 1, 0.70710678119, 'quad', 'Sample Level'),
  sample_destination: p(0, 14, 3, 'idx', 'Sample Destination', { opts: DESTINATIONS }),
  sample_pan: p(-1, 1, 0, 'lin', 'Sample Pan', { mult: 100, units: '%' }),
  velocity_track: p(-1, 1, 0, 'lin', 'Velocity Track', { mult: 100, units: '%' }),
  volume: p(0, 7399.4404, 5473.0404, 'sqrt', 'Volume', { off: -80, units: 'dB' }),
  view_spectrogram: p(0, 2, 0, 'idx', 'View Spectrogram'),
  phaser_on: p(0, 1, 0, 'idx', 'Phaser Switch', { opts: OFF_ON }),
  phaser_dry_wet: p(0, 1, 1, 'lin', 'Phaser Mix', { mult: 100, units: '%' }),
  phaser_feedback: p(0, 1, 0.5, 'lin', 'Phaser Feedback', { mult: 100, units: '%' }),
  phaser_frequency: p(-5, 2, -3, 'exp', 'Phaser Frequency', { inv: true, units: ' secs' }),
  phaser_sync: p(0, 3, 1, 'idx', 'Phaser Sync', { opts: FREQ_SYNC }),
  phaser_tempo: p(0, 10, 3, 'idx', 'Phaser Tempo', { opts: SYNCED_FREQ }),
  phaser_center: p(8, 136, 80, 'lin', 'Phaser Center', { units: ' semitones' }),
  phaser_blend: p(0, 2, 1, 'lin', 'Phaser Blend'),
  phaser_mod_depth: p(0, 48, 24, 'lin', 'Phaser Mod Depth', { units: ' semitones' }),
  phaser_phase_offset: p(0, 1, 0.33333333, 'lin', 'Phaser Phase Offset', { mult: 360 }),
  flanger_on: p(0, 1, 0, 'idx', 'Flanger Switch', { opts: OFF_ON }),
  flanger_dry_wet: p(0, 0.5, 0.5, 'lin', 'Flanger Mix', { mult: 200, units: '%' }),
  flanger_feedback: p(-1, 1, 0.5, 'lin', 'Flanger Feedback', { mult: 100, units: '%' }),
  flanger_frequency: p(-5, 2, 2, 'exp', 'Flanger Frequency', { inv: true, units: ' secs' }),
  flanger_sync: p(0, 3, 1, 'idx', 'Flanger Sync', { opts: FREQ_SYNC }),
  flanger_tempo: p(0, 10, 4, 'idx', 'Flanger Tempo', { opts: SYNCED_FREQ }),
  flanger_center: p(8, 136, 64, 'lin', 'Flanger Center', { units: ' semitones' }),
  flanger_mod_depth: p(0, 1, 0.5, 'lin', 'Flanger Mod Depth', { mult: 100, units: '%' }),
  flanger_phase_offset: p(0, 1, 0.33333333, 'lin', 'Flanger Phase Offset', { mult: 360 }),
  chorus_on: p(0, 1, 0, 'idx', 'Chorus Switch', { opts: OFF_ON }),
  chorus_dry_wet: p(0, 1, 0.5, 'lin', 'Chorus Mix', { mult: 100, units: '%' }),
  chorus_feedback: p(-0.95, 0.95, 0.4, 'lin', 'Chorus Feedback', { mult: 100, units: '%' }),
  chorus_cutoff: p(8, 136, 60, 'lin', 'Chorus Filter Cutoff'),
  chorus_spread: p(0, 1, 1, 'lin', 'Chorus Filter Spread'),
  chorus_voices: p(1, 4, 4, 'idx', 'Chorus Voices', { mult: 4 }),
  chorus_frequency: p(-6, 3, -3, 'exp', 'Chorus Frequency', { inv: true, units: ' secs' }),
  chorus_sync: p(0, 3, 1, 'idx', 'Chorus Sync', { opts: FREQ_SYNC }),
  chorus_tempo: p(0, 10, 4, 'idx', 'Chorus Tempo', { opts: SYNCED_FREQ }),
  chorus_mod_depth: p(0, 1, 0.5, 'lin', 'Chorus Mod Depth', { mult: 100, units: '%' }),
  chorus_delay_1: p(-10, -5.64386, -9, 'exp', 'Chorus Delay 1', { mult: 1000, units: 'ms' }),
  chorus_delay_2: p(-10, -5.64386, -7, 'exp', 'Chorus Delay 2', { mult: 1000, units: ' ms' }),
  compressor_on: p(0, 1, 0, 'idx', 'Compressor Switch', { opts: OFF_ON }),
  compressor_low_upper_threshold: p(-80, 0, -28, 'lin', 'Low Upper Threshold', { units: ' dB' }),
  compressor_band_upper_threshold: p(-80, 0, -25, 'lin', 'Band Upper Threshold', { units: ' dB' }),
  compressor_high_upper_threshold: p(-80, 0, -30, 'lin', 'High Upper Threshold', { units: ' dB' }),
  compressor_low_lower_threshold: p(-80, 0, -35, 'lin', 'Low Lower Threshold', { units: ' dB' }),
  compressor_band_lower_threshold: p(-80, 0, -36, 'lin', 'Band Lower Threshold', { units: ' dB' }),
  compressor_high_lower_threshold: p(-80, 0, -35, 'lin', 'High Lower Threshold', { units: ' dB' }),
  compressor_low_upper_ratio: p(0, 1, 0.9, 'lin', 'Low Upper Ratio'),
  compressor_band_upper_ratio: p(0, 1, 0.857, 'lin', 'Band Upper Ratio'),
  compressor_high_upper_ratio: p(0, 1, 1, 'lin', 'High Upper Ratio'),
  compressor_low_lower_ratio: p(-1, 1, 0.8, 'lin', 'Low Lower Ratio'),
  compressor_band_lower_ratio: p(-1, 1, 0.8, 'lin', 'Band Lower Ratio'),
  compressor_high_lower_ratio: p(-1, 1, 0.8, 'lin', 'High Lower Ratio'),
  compressor_low_gain: p(-30, 30, 16.3, 'lin', 'Compressor Low Gain', { units: ' dB' }),
  compressor_band_gain: p(-30, 30, 11.7, 'lin', 'Compressor Band Gain', { units: ' dB' }),
  compressor_high_gain: p(-30, 30, 16.3, 'lin', 'Compressor High Gain', { units: ' dB' }),
  compressor_attack: p(0, 1, 0.5, 'lin', 'Compressor Attack', { mult: 100, units: '%' }),
  compressor_release: p(0, 1, 0.5, 'lin', 'Compressor Release', { mult: 100, units: '%' }),
  compressor_enabled_bands: p(0, 3, 0, 'idx', 'Compressor Enabled Bands', { opts: COMP_BANDS }),
  compressor_mix: p(0, 1, 1, 'lin', 'Compressor Mix'),
  eq_on: p(0, 1, 0, 'idx', 'EQ Switch', { opts: OFF_ON }),
  eq_low_mode: p(0, 1, 0, 'idx', 'EQ Low Mode', { opts: EQ_LOW_MODES }),
  eq_low_cutoff: p(8, 136, 40, 'lin', 'EQ Low Cutoff', { units: ' semitones' }),
  eq_low_gain: p(-15, 15, 0, 'lin', 'EQ Low Gain', { units: ' dB' }),
  eq_low_resonance: p(0, 1, 0.3163, 'quad', 'EQ Low Resonance', { mult: 100, units: '%' }),
  eq_band_mode: p(0, 1, 0, 'idx', 'EQ Band Mode', { opts: EQ_BAND_MODES }),
  eq_band_cutoff: p(8, 136, 80, 'lin', 'EQ Band Cutoff', { units: ' semitones' }),
  eq_band_gain: p(-15, 15, 0, 'lin', 'EQ Band Gain', { units: ' dB' }),
  eq_band_resonance: p(0, 1, 0.4473, 'quad', 'EQ Band Resonance', { mult: 100 }),
  eq_high_mode: p(0, 1, 0, 'idx', 'EQ High Mode', { opts: EQ_HIGH_MODES }),
  eq_high_cutoff: p(8, 136, 100, 'lin', 'EQ High Cutoff', { units: ' semitones' }),
  eq_high_gain: p(-15, 15, 0, 'lin', 'EQ High Gain', { units: ' dB' }),
  eq_high_resonance: p(0, 1, 0.3163, 'quad', 'EQ High Resonance', { mult: 100, units: '%' }),
  voice_priority: p(0, 4, 4, 'idx', 'Voice Priority', { opts: VOICE_PRIORITY }),
  voice_override: p(0, 1, 0, 'idx', 'Voice Override', { opts: VOICE_OVERRIDE }),
  oversampling: p(0, 3, 1, 'idx', 'Oversampling', { opts: OVERSAMPLING }),
  pitch_wheel: p(-1, 1, 0, 'lin', 'Pitch Wheel'),
  mod_wheel: p(0, 1, 0, 'lin', 'Mod Wheel'),
  mpe_enabled: p(0, 1, 0, 'idx', 'MPE Enabled', { opts: OFF_ON }),
}

const ENV: Record<string, Param> = {
  delay: p(0, 1.4142135624, 0, 'quart', 'Delay', { units: ' secs' }),
  attack: p(0, 2.37842, 0.1495, 'quart', 'Attack', { units: ' secs' }),
  hold: p(0, 1.4142135624, 0, 'quart', 'Hold', { units: ' secs' }),
  decay: p(0, 2.37842, 1, 'quart', 'Decay', { units: ' secs' }),
  release: p(0, 2.37842, 0.5476, 'quart', 'Release', { units: ' secs' }),
  attack_power: p(-20, 20, 0, 'lin', 'Attack Power'),
  decay_power: p(-20, 20, -2, 'lin', 'Decay Power'),
  release_power: p(-20, 20, -2, 'lin', 'Release Power'),
  sustain: p(0, 1, 1, 'lin', 'Sustain'),
}

const LFO: Record<string, Param> = {
  phase: p(0, 1, 0, 'lin', 'Phase'),
  sync_type: p(0, 5, 0, 'idx', 'Sync Type', { opts: LFO_SYNC }),
  frequency: p(-7, 9, 1, 'exp', 'Frequency', { inv: true, units: ' secs' }),
  sync: p(0, 4, 1, 'idx', 'Sync', { opts: FREQ_SYNC }),
  tempo: p(0, 12, 7, 'idx', 'Tempo', { opts: SYNCED_FREQ }),
  fade_time: p(0, 8, 0, 'lin', 'Fade In', { units: ' secs' }),
  smooth_mode: p(0, 1, 1, 'idx', 'Smooth Mode', { opts: OFF_ON }),
  smooth_time: p(-10, 4, -7.5, 'exp', 'Smooth Time', { units: ' secs' }),
  delay_time: p(0, 4, 0, 'lin', 'Delay', { units: ' secs' }),
  stereo: p(-0.5, 0.5, 0, 'lin', 'Stereo'),
  keytrack_transpose: p(-60, 36, -12, 'idx', 'Transpose'),
  keytrack_tune: p(-1, 1, 0, 'lin', 'Tune', { mult: 100 }),
}

const RANDOM: Record<string, Param> = {
  style: p(0, 3, 0, 'idx', 'Style', { opts: RANDOM_NAMES }),
  frequency: p(-7, 9, 1, 'exp', 'Frequency', { inv: true, units: ' secs' }),
  sync: p(0, 4, 1, 'idx', 'Sync', { opts: FREQ_SYNC }),
  tempo: p(0, 12, 8, 'idx', 'Tempo', { opts: SYNCED_FREQ }),
  stereo: p(0, 1, 0, 'idx', 'Stereo', { opts: OFF_ON }),
  sync_type: p(0, 1, 0, 'idx', 'Sync Type', { opts: OFF_ON }),
  keytrack_transpose: p(-60, 36, -12, 'idx', 'Transpose'),
  keytrack_tune: p(-1, 1, 0, 'lin', 'Tune', { mult: 100 }),
}

const FILTER: Record<string, Param> = {
  mix: p(0, 1, 1, 'lin', 'Mix', { mult: 100, units: '%' }),
  cutoff: p(8, 136, 60, 'lin', 'Cutoff', { off: -60, units: ' semitones' }),
  resonance: p(0, 1, 0.5, 'lin', 'Resonance', { mult: 100, units: '%' }),
  drive: p(0, 20, 0, 'lin', 'Drive', { units: 'dB' }),
  blend: p(0, 2, 0, 'lin', 'Blend'),
  style: p(0, 9, 0, 'idx', 'Style', { opts: FILTER_STYLES }),
  model: p(0, 7, 0, 'idx', 'Model', { opts: FILTER_MODELS }),
  on: p(0, 1, 0, 'idx', 'Switch', { opts: OFF_ON }),
  blend_transpose: p(0, 84, 42, 'lin', 'Comb Blend Offset', { units: ' semitones' }),
  keytrack: p(-1, 1, 0, 'lin', 'Key Track', { mult: 100, units: '%' }),
  formant_x: p(0, 1, 0.5, 'lin', 'Formant X'),
  formant_y: p(0, 1, 0.5, 'lin', 'Formant Y'),
  formant_transpose: p(-12, 12, 0, 'lin', 'Formant Transpose'),
  formant_resonance: p(0.3, 1, 0.85, 'lin', 'Formant Resonance', { mult: 100, units: '%' }),
  formant_spread: p(-1, 1, 0, 'lin', 'Formant Spread', { mult: 100, units: '%' }),
  osc1_input: p(0, 1, 0, 'idx', 'OSC 1 Input', { opts: OFF_ON }),
  osc2_input: p(0, 1, 0, 'idx', 'OSC 2 Input', { opts: OFF_ON }),
  osc3_input: p(0, 1, 0, 'idx', 'OSC 3 Input', { opts: OFF_ON }),
  sample_input: p(0, 1, 0, 'idx', 'SAMPLE Input', { opts: OFF_ON }),
  filter_input: p(0, 1, 0, 'idx', 'FILTER Input', { opts: OFF_ON }),
}

const OSC: Record<string, Param> = {
  on: p(0, 1, 0, 'idx', 'Switch', { opts: OFF_ON }),
  transpose: p(-48, 48, 0, 'idx', 'Transpose'),
  transpose_quantize: p(0, 8191, 0, 'idx', 'Transpose Quantize'),
  tune: p(-1, 1, 0, 'lin', 'Tune', { mult: 100 }),
  pan: p(-1, 1, 0, 'lin', 'Pan', { mult: 100, units: '%' }),
  stack_style: p(0, 10, 0, 'idx', 'Stack Style', { opts: UNISON_STACKS }),
  unison_detune: p(0, 10, 4.472135955, 'quad', 'Unison Detune', { units: '%' }),
  unison_voices: p(1, 16, 1, 'idx', 'Unison Voices', { units: 'v' }),
  unison_blend: p(0, 1, 0.8, 'lin', 'Blend', { mult: 100, units: '%' }),
  detune_power: p(-5, 5, 1.5, 'lin', 'Detune Power'),
  detune_range: p(0, 48, 2, 'lin', 'Detune Range'),
  level: p(0, 1, 0.70710678119, 'quad', 'Level'),
  midi_track: p(0, 1, 1, 'idx', 'Midi Track', { opts: OFF_ON }),
  smooth_interpolation: p(0, 1, 0, 'idx', 'Smooth Interpolation', { opts: OFF_ON }),
  spectral_unison: p(0, 1, 1, 'idx', 'Spectral Unison', { opts: OFF_ON }),
  wave_frame: p(0, 256, 0, 'lin', 'Wave Frame'),
  frame_spread: p(-128, 128, 0, 'lin', 'Unison Frame Spread'),
  stereo_spread: p(0, 1, 1, 'lin', 'Stereo Spread', { mult: 100, units: '%' }),
  phase: p(0, 1, 0.5, 'lin', 'Phase', { mult: 360 }),
  distortion_phase: p(0, 1, 0.5, 'lin', 'Distortion Phase', { mult: 360 }),
  random_phase: p(0, 1, 1, 'lin', 'Phase Randomization', { mult: 100, units: '%' }),
  distortion_type: p(0, 12, 0, 'idx', 'Distortion Type', { opts: WARP_TYPES }),
  distortion_amount: p(0, 1, 0.5, 'lin', 'Distortion Amount', { mult: 100, units: '%' }),
  distortion_spread: p(-0.5, 0.5, 0, 'lin', 'Distortion Spread', { mult: 200, units: '%' }),
  spectral_morph_type: p(0, 11, 0, 'idx', 'Frequency Morph Type', { opts: MORPH_TYPES }),
  spectral_morph_amount: p(0, 1, 0.5, 'lin', 'Frequency Morph Amount', { mult: 100, units: '%' }),
  spectral_morph_spread: p(-0.5, 0.5, 0, 'lin', 'Frequency Morph Spread', { mult: 200, units: '%' }),
  destination: p(0, 14, 0, 'idx', 'Destination', { opts: DESTINATIONS }),
  view_2d: p(0, 2, 1, 'idx', 'View 2D', { opts: WAVETABLE_DIMENSIONS }),
}

/** Vital's six envelopes, eight LFOs and four random LFOs (the tabs scroll to the ones past 3 / 4 / 2). */
export const N_ENV = 6, N_LFO = 8, N_RAND = 4

function group(prefix: string, list: Record<string, Param>, label: string): Record<string, Param> {
  return Object.fromEntries(Object.entries(list).map(([k, v]) => [`${prefix}_${k}`, { ...v, name: `${label} ${v.name}` }]))
}

export const PARAMS: Record<string, Param> = {
  ...GLOBAL,
  ...Object.assign({}, ...Array.from({ length: N_ENV }, (_, i) => group(`env_${i + 1}`, ENV, `Envelope ${i + 1}`))),
  ...Object.assign({}, ...Array.from({ length: N_LFO }, (_, i) => group(`lfo_${i + 1}`, LFO, `LFO ${i + 1}`))),
  ...Object.assign({}, ...Array.from({ length: N_RAND }, (_, i) => group(`random_${i + 1}`, RANDOM, `Random LFO ${i + 1}`))),
  ...group('filter_1', FILTER, 'Filter 1'),
  ...group('filter_2', FILTER, 'Filter 2'),
  ...group('filter_fx', FILTER, 'FX Filter'),
  ...Object.assign({}, ...[1, 2, 3].map((i) => group(`osc_${i}`, OSC, `Oscillator ${i}`))),
}

// Vital's default overrides (synth_parameters.cpp: osc 1 on, osc 2 → filter 2, osc 3 → effects), so
// "Set to Default Value" and double-click agree with Vital.
PARAMS.osc_1_on = { ...PARAMS.osc_1_on, def: 1 }
PARAMS.osc_2_destination = { ...PARAMS.osc_2_destination, def: 1 }
PARAMS.osc_3_destination = { ...PARAMS.osc_3_destination, def: 3 }

/** The factory Init patch: every default, then what Init changes (OSC 1 on into FILTER 1, the
 *  sampler and OSC 3 into EFFECTS, ENV 1 a quick organ shape). */
export function initValues(): Record<string, number> {
  const v = Object.fromEntries(Object.entries(PARAMS).map(([k, x]) => [k, x.def]))
  v.osc_1_on = 1
  v.osc_2_destination = 1
  v.osc_3_destination = 3
  v.filter_fx_on = 0
  return withInputs(v)
}

// Routing. Vital keeps one destination per source (osc_N_destination, sample_destination); a filter's
// OSC1/OSC2/OSC3/SMP buttons are a view of it, and pressing one changes the destination the way
// vital::constants::toggleFilter1/2 do.

const INPUT_SOURCES: Record<string, string> = {
  osc1_input: 'osc_1_destination', osc2_input: 'osc_2_destination', osc3_input: 'osc_3_destination', sample_input: 'sample_destination',
}
const FILTER1 = 0, FILTER2 = 1, DUAL = 2, EFFECTS = 3

/** `filter_1_osc2_input` → { filter: 1, dest: 'osc_2_destination' }; null for any other id. */
export function filterInput(id: string): { filter: 1 | 2; dest: string } | null {
  const m = /^filter_([12])_(osc[123]_input|sample_input)$/.exec(id)
  return m ? { filter: Number(m[1]) as 1 | 2, dest: INPUT_SOURCES[m[2]] } : null
}

/** The destination after turning a filter's input on or off (Vital's toggleFilter1/2). */
export function toggleRoute(dest: number, filter: 1 | 2, on: boolean): number {
  const mine = filter === 1 ? FILTER1 : FILTER2, other = filter === 1 ? FILTER2 : FILTER1
  if (on) return dest === other ? DUAL : mine
  if (dest === DUAL) return other
  if (dest === mine) return EFFECTS
  return dest
}

/** `v` with every filter input button set from the destinations it shows. */
export function withInputs(v: Record<string, number>): Record<string, number> {
  const out = { ...v }
  for (const filter of [1, 2] as const) {
    for (const [input, dest] of Object.entries(INPUT_SOURCES)) {
      const d = Math.round(v[dest] ?? 0)
      out[`filter_${filter}_${input}`] = d === DUAL || d === (filter === 1 ? FILTER1 : FILTER2) ? 1 : 0
    }
  }
  return out
}

/** The controls Vital gives a Hz display (setSliderHasHzAlternateDisplay), shown in Hz when ADVANCED →
 *  FREQUENCY UNITS is Hz: kMidi0Frequency · 2^(value / 12). */
const HZ_ALTERNATE = /^(filter_(1|2|fx)_cutoff|eq_(low|band|high)_cutoff|reverb_(pre_high|pre_low|low_shelf|high_shelf)_cutoff|phaser_center|flanger_center|distortion_filter_cutoff)$/
let frequencyUnits: 'Semitones' | 'Hz' = 'Semitones'
export const setFrequencyUnits = (units: unknown) => { frequencyUnits = units === 'Hz' ? 'Hz' : 'Semitones' }

/** Five characters of a number, as SynthSlider::formatValue cuts it. */
function fiveChars(a: number): string {
  let s = a.toFixed(5)
  s = s.substring(0, 5 + (s[0] === '-' ? 1 : 0))
  return s.endsWith('.') ? s.slice(0, -1) : s
}

/** The value Vital stores, as Vital's popup prints it (five characters, then the units). */
export function shown(id: string, v: number, withUnits = true): string {
  const d = PARAMS[id]
  if (!d) return String(v)
  if (frequencyUnits === 'Hz' && HZ_ALTERNATE.test(id)) {
    const s = fiveChars(8.1757989156 * Math.pow(2, v / 12))
    return withUnits ? `${s} Hz` : s
  }
  if (d.opts) return d.opts[Math.max(0, Math.min(d.opts.length - 1, Math.round(v)))]
  let a = v
  switch (d.scale) {
    case 'quad': a = a * a; break
    case 'quart': a = a * a * a * a; break
    case 'exp': a = Math.pow(2, a); break
    case 'sqrt': a = Math.sqrt(Math.max(a, 0)); break
  }
  a += d.off ?? 0
  if (d.inv) a = 1 / a
  a *= d.mult ?? 1
  let s: string
  if (d.scale === 'idx') s = String(Math.round(a))
  else s = fiveChars(a)
  return withUnits ? s + (d.units ?? '') : s
}

/** What a modulation amount is multiplied by for display: the destination's range when it's linear or
 *  indexed, else 1 (ModulationMatrixRow::updateDisplayValue). */
export function amountScale(dst: string): number {
  const d = PARAMS[dst]
  return d && (d.scale === 'lin' || d.scale === 'idx') ? d.max - d.min : 1
}

/** A modulation's depth as the ring's popup prints it ("Lfo 1: 64.00"). */
export function shownAmount(dst: string, amt: number): string {
  return (amountScale(dst) * amt).toFixed(2)
}

export const norm = (id: string, v: number) => { const d = PARAMS[id]; return d ? (v - d.min) / (d.max - d.min) : v }
export const denorm = (id: string, t: number) => { const d = PARAMS[id]; if (!d) return t; const v = d.min + Math.max(0, Math.min(1, t)) * (d.max - d.min); return d.scale === 'idx' ? Math.round(v) : v }

/** Modulation sources, in the order Vital's matrix menu lists them, with the names its rings print. */
export const SOURCES: { id: string; name: string }[] = [
  ...Array.from({ length: N_ENV }, (_, i) => ({ id: `env_${i + 1}`, name: `Env ${i + 1}` })),
  ...Array.from({ length: N_LFO }, (_, i) => ({ id: `lfo_${i + 1}`, name: `Lfo ${i + 1}` })),
  ...Array.from({ length: N_RAND }, (_, i) => ({ id: `random_${i + 1}`, name: `Random ${i + 1}` })),
  ...[1, 2, 3, 4].map((i) => ({ id: `macro_control_${i}`, name: `Macro ${i}` })),
  { id: 'note', name: 'Note' }, { id: 'velocity', name: 'Velocity' }, { id: 'lift', name: 'Lift' }, { id: 'note_in_octave', name: 'Oct Note' },
  { id: 'aftertouch', name: 'Pressure' }, { id: 'slide', name: 'Slide' }, { id: 'stereo', name: 'Stereo' }, { id: 'random', name: 'Random' },
  { id: 'pitch_wheel', name: 'Pitch Wheel' }, { id: 'mod_wheel', name: 'Mod Wheel' },
]
export const sourceName = (id: string) => SOURCES.find((s) => s.id === id)?.name ?? id

/** A destination's Rotary Arc colour: its section's override in Vital's default skin, else the default. */
const ARC_COLORS: [RegExp, string][] = [
  [/^(filter_1|filter_2|filter_fx)_/, '#ffb74d'], [/^compressor_/, '#1de9b6'], [/^delay_/, '#ff99e9'], [/^distortion_/, '#ff5252'],
  [/^(env|lfo|random)_/, '#64ffda'], [/^eq_/, '#fff6e1'], [/^flanger_/, '#ffd740'], [/^phaser_/, '#40cfff'], [/^reverb_/, '#8fa0ff'],
]
export const arcColor = (dst: string) => ARC_COLORS.find(([re]) => re.test(dst))?.[1] ?? '#aa88ff'

/** The engine's modulation sources and the destinations a modulation can reach (SoundEngine's
 *  getModulationSources / getMonoModulations, written by tools/modlists.mjs), each destination with
 *  Vital's display name and local description. */
export const MOD_LISTS = modLists as { sources: string[]; destinations: { id: string; name: string; local: string }[] }
const DESTINATION_IDS = new Set(MOD_LISTS.destinations.map((d) => d.id))

/** Whether a modulation can reach `id` (a drop target, a matrix destination). */
export const modulatable = (id: string) => DESTINATION_IDS.has(id)
