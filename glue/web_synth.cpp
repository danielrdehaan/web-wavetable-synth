// Browser-facing wrapper around Vital's SoundEngine: a cut-down SynthBase with no JUCE,
// no GUI, no MIDI manager and no threads. The AudioWorklet owns the only instance and calls
// these C functions from the audio thread, so modulation changes apply immediately instead
// of going through SynthBase's lock-free queue.

#include "line_generator.h"
#include "modulation_connection_processor.h"
#include "sample_source.h"
#include "sound_engine.h"
#include "synth_parameters.h"
#include "synth_types.h"
#include "wavetable.h"
#include "wavetable_creator.h"
#include "synth_oscillator.h"
#include "fourier_transform.h"
#include "comb_filter.h"
#include "digital_svf.h"
#include "diode_filter.h"
#include "dirty_filter.h"
#include "formant_filter.h"
#include "ladder_filter.h"
#include "phaser_filter.h"
#include "sallen_key_filter.h"
#include "distortion.h"
#include "tuning.h"
#include "wavetable_group.h"
#include "wavetable_component_factory.h"
#include "wave_source.h"
#include "wave_line_source.h"
#include "file_source.h"

#include <complex>

#include <cstdlib>
#include <cstring>
#include <string>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT extern "C"
#endif

namespace {
  struct WebSynth {
    std::unique_ptr<vital::SoundEngine> engine;
    std::unique_ptr<WavetableCreator> wavetable_creators[vital::kNumOscillators];
    vital::control_map controls;
    std::vector<vital::ModulationConnection*> connections;
    float left[vital::kMaxBufferSize];
    float right[vital::kMaxBufferSize];
    std::string scratch;

    // The header displays' sources, as SynthBase keeps them (updateMemoryOutput): the last
    // kAudioMemorySamples of output for the spectrogram, and the oscilloscope's window of the output,
    // restarted every period of the last played note.
    std::unique_ptr<vital::StereoMemory> audio_memory;
    vital::poly_float oscilloscope_memory[2 * vital::kOscilloscopeMemoryResolution];
    vital::poly_float oscilloscope_memory_write[2 * vital::kOscilloscopeMemoryResolution];
    float last_played_note = 0.0f, memory_reset_period = vital::kOscilloscopeMemoryResolution;
    int last_num_pressed = 0, memory_input_offset = 0, memory_index = 0;

    // SynthBase's tuning: global, not part of a preset.
    Tuning tuning;
  };

  WebSynth* synth = nullptr;

  vital::modulation_change createChange(vital::ModulationConnection* connection) {
    vital::SoundEngine* engine = synth->engine.get();
    vital::modulation_change change;
    change.source = engine->getModulationSource(connection->source_name);
    change.mono_destination = engine->getMonoModulationDestination(connection->destination_name);
    change.mono_modulation_switch = engine->getMonoModulationSwitch(connection->destination_name);
    change.destination_scale = vital::Parameters::getParameterRange(connection->destination_name);
    change.poly_modulation_switch = engine->getPolyModulationSwitch(connection->destination_name);
    change.poly_destination = engine->getPolyModulationDestination(connection->destination_name);
    change.modulation_processor = connection->modulation_processor.get();

    int num_audio_rate = 0;
    vital::ModulationConnectionBank& bank = engine->getModulationBank();
    for (int i = 0; i < vital::kMaxModulationConnections; ++i) {
      if (bank.atIndex(i)->source_name == connection->source_name &&
          bank.atIndex(i)->destination_name != connection->destination_name &&
          !bank.atIndex(i)->modulation_processor->isControlRate()) {
        num_audio_rate++;
      }
    }
    change.num_audio_rate = num_audio_rate;
    return change;
  }

  bool isConnected(vital::ModulationConnection* connection) {
    return std::find(synth->connections.begin(), synth->connections.end(), connection) != synth->connections.end();
  }

  // Returns the connection's bank index, or -1 when it can't be made.
  int connect(vital::ModulationConnection* connection) {
    vital::SoundEngine* engine = synth->engine.get();
    if (engine->getModulationSource(connection->source_name) == nullptr ||
        engine->getMonoModulationDestination(connection->destination_name) == nullptr) {
      connection->source_name = "";
      connection->destination_name = "";
      return -1;
    }

    vital::modulation_change change = createChange(connection);
    if (change.poly_destination && change.poly_destination->router() == change.modulation_processor) {
      connection->source_name = "";
      connection->destination_name = "";
      return -1;
    }
    if (!isConnected(connection)) {
      change.disconnecting = false;
      synth->connections.push_back(connection);
      engine->connectModulation(change);
    }
    vital::ModulationConnectionBank& bank = engine->getModulationBank();
    for (int i = 0; i < vital::kMaxModulationConnections; ++i) {
      if (bank.atIndex(i) == connection)
        return i;
    }
    return -1;
  }

  void disconnect(vital::ModulationConnection* connection) {
    if (!isConnected(connection))
      return;
    vital::modulation_change change = createChange(connection);
    change.disconnecting = true;
    synth->engine->disconnectModulation(change);
    connection->source_name = "";
    connection->destination_name = "";
    synth->connections.erase(std::find(synth->connections.begin(), synth->connections.end(), connection));
  }

  void clearModulations() {
    while (!synth->connections.empty())
      disconnect(synth->connections.back());

    vital::ModulationConnectionBank& bank = synth->engine->getModulationBank();
    for (size_t i = 0; i < bank.numConnections(); ++i)
      bank.atIndex(static_cast<int>(i))->modulation_processor->lineMapGenerator()->initLinear();
    synth->engine->disableUnnecessaryModSources();
  }

  vital::ModulationConnection* findConnection(const std::string& source, const std::string& destination) {
    for (vital::ModulationConnection* connection : synth->connections) {
      if (connection->source_name == source && connection->destination_name == destination)
        return connection;
    }
    return nullptr;
  }

  void initEngine() {
    clearModulations();
    for (int i = 0; i < vital::kNumOscillators; ++i)
      synth->wavetable_creators[i]->init();
    synth->engine->getSample()->init();
    for (int i = 0; i < vital::kNumLfos; ++i)
      synth->engine->getLfoSource(i)->initTriangle();
    for (auto& control : synth->controls)
      control.second->set(vital::Parameters::getDetails(control.first).default_value);
    synth->engine->checkOversampling();
  }

  const char* keep(const std::string& s) {
    synth->scratch = s;
    return synth->scratch.c_str();
  }
}

// MidiManager::processMidiMessage, from raw bytes: notes, polyphonic and channel pressure, pitch bend,
// slide, sustain and sostenuto, the mod wheel, all-notes / all-sounds off, every per channel, with MPE
// zones (JUCE's MPEZoneLayout: the lower zone defaults to 15 member channels; an RPN 6 on the first or
// last channel sets a zone's member count). Returns what the interface should follow: 1 = the mod
// wheel moved (MidiManager's modWheelMidiChanged), 2 = the pitch wheel (pitchWheelMidiChanged), 4 = a
// controller that reaches MIDI learn (midiInput).
namespace {
  constexpr int kMidiControlBits = 7;
  constexpr float kHighResolutionMax = (1 << (2 * kMidiControlBits)) - 1.0f;
  constexpr float kControlMax = (1 << kMidiControlBits) - 1.0f;

  float toHighResolutionValue(int msb, int lsb) {
    if (lsb < 0)
      return msb / kControlMax;
    return ((msb << kMidiControlBits) + lsb) / kHighResolutionMax;
  }

  struct MidiPort {
    bool mpe_enabled = false;
    int lower_members = vital::kNumMidiChannels - 1;
    int upper_members = 0;
    int msb_pressure[vital::kNumMidiChannels] = {};
    int lsb_pressure[vital::kNumMidiChannels];
    int msb_slide[vital::kNumMidiChannels] = {};
    int lsb_slide[vital::kNumMidiChannels];
    int rpn_msb[vital::kNumMidiChannels];
    int rpn_lsb[vital::kNumMidiChannels];

    MidiPort() {
      for (int i = 0; i < vital::kNumMidiChannels; ++i)
        lsb_pressure[i] = lsb_slide[i] = rpn_msb[i] = rpn_lsb[i] = -1;
    }

    bool lowerActive() const { return lower_members > 0; }
    bool upperActive() const { return upper_members > 0; }
    int lowerMaster() const { return 0; }
    int upperMaster() const { return vital::kNumMidiChannels - 1; }
    int lowerStart() const { return 1; }
    int lowerEnd() const { return lower_members; }
    int upperStart() const { return vital::kNumMidiChannels - 1 - upper_members; }
    int upperEnd() const { return vital::kNumMidiChannels - 2; }
    bool masterLower(int channel) const { return mpe_enabled && lowerActive() && channel == lowerMaster(); }
    bool masterUpper(int channel) const { return mpe_enabled && upperActive() && channel == upperMaster(); }

    // MPEZoneLayout::processNextMidiEvent: RPN 6 (MPE configuration) sets a zone's member count, the
    // other zone giving way when the two would overlap.
    void readMpeMessage(int channel, int controller, int value) {
      if (controller == 101) { rpn_msb[channel] = value; return; }
      if (controller == 100) { rpn_lsb[channel] = value; return; }
      if (controller != 6 || rpn_msb[channel] != 0 || rpn_lsb[channel] != 6 || value >= vital::kNumMidiChannels)
        return;
      if (channel == 0) {
        lower_members = value;
        if (upperActive() && lower_members + upper_members >= vital::kNumMidiChannels - 1)
          upper_members = std::max(0, vital::kNumMidiChannels - 2 - lower_members);
      }
      else if (channel == vital::kNumMidiChannels - 1) {
        upper_members = value;
        if (lowerActive() && lower_members + upper_members >= vital::kNumMidiChannels - 1)
          lower_members = std::max(0, vital::kNumMidiChannels - 2 - upper_members);
      }
    }
  };

  MidiPort midi_port;
}

EXPORT void vs_set_mpe(int enabled) { midi_port.mpe_enabled = enabled; }

EXPORT int vs_midi(int status, int data1, int data2) {
  vital::SoundEngine* engine = synth->engine.get();
  MidiPort& port = midi_port;
  int channel = status & 0x0f;
  int type = status & 0xf0;
  if (type == 0xb0)
    port.readMpeMessage(channel, data1, data2);

  switch (type) {
    case 0x90:
      if (data2)
        engine->noteOn(data1, data2 / kControlMax, 0, channel);
      else
        engine->noteOff(data1, data2 / kControlMax, 0, channel);
      return 0;
    case 0x80:
      engine->noteOff(data1, data2 / kControlMax, 0, channel);
      return 0;
    case 0xa0:
      engine->setAftertouch(data1, data2 / kControlMax, 0, channel);
      return 0;
    case 0xd0: {
      port.msb_pressure[channel] = data1;
      float value = toHighResolutionValue(port.msb_pressure[channel], port.lsb_pressure[channel]);
      if (port.masterLower(channel))
        engine->setChannelRangeAftertouch(port.lowerStart(), port.lowerEnd(), value, 0);
      else if (port.masterUpper(channel))
        engine->setChannelRangeAftertouch(port.upperStart(), port.upperEnd(), value, 0);
      else
        engine->setChannelAftertouch(channel, value, 0);
      return 0;
    }
    case 0xe0: {
      float value = 2.0f * (((data2 << 7) | data1) / kHighResolutionMax) - 1.0f;
      if (port.masterLower(channel)) {
        engine->setZonedPitchWheel(value, port.lowerMaster(), port.lowerMaster() + 1);
        engine->setZonedPitchWheel(value, port.lowerStart(), port.lowerEnd());
        return 2;
      }
      if (port.masterUpper(channel)) {
        engine->setZonedPitchWheel(value, port.upperMaster(), port.upperMaster() + 1);
        engine->setZonedPitchWheel(value, port.upperStart(), port.upperEnd());
        return 2;
      }
      if (port.mpe_enabled) {
        engine->setPitchWheel(value, channel);
        return 0;
      }
      engine->setZonedPitchWheel(value, channel, channel);
      return 2;
    }
    case 0xb0: {
      auto slide = [&]() {
        float value = toHighResolutionValue(port.msb_slide[channel], port.lsb_slide[channel]);
        // MidiManager::processSlide passes the range calls' arguments in this order.
        if (port.masterLower(channel))
          engine->setChannelRangeSlide(value, port.lowerStart(), port.lowerEnd(), 0);
        else if (port.masterUpper(channel))
          engine->setChannelRangeSlide(value, port.upperStart(), port.upperEnd(), 0);
        else
          engine->setChannelSlide(channel, value, 0);
      };
      auto pressure = [&]() {
        float value = toHighResolutionValue(port.msb_pressure[channel], port.lsb_pressure[channel]);
        if (port.masterLower(channel))
          engine->setChannelRangeAftertouch(port.lowerStart(), port.lowerEnd(), value, 0);
        else if (port.masterUpper(channel))
          engine->setChannelRangeAftertouch(port.upperStart(), port.upperEnd(), value, 0);
        else
          engine->setChannelAftertouch(channel, value, 0);
      };
      bool on = data2 >= 64;
      switch (data1) {
        case 0x4a: port.msb_slide[channel] = data2; slide(); break;
        case 0x66: port.lsb_pressure[channel] = data2; pressure(); break;
        case 0x6a: port.lsb_slide[channel] = data2; slide(); break;
        case 0x40:
          if (port.masterLower(channel)) {
            if (on) engine->sustainOnRange(port.lowerStart(), port.lowerEnd());
            else engine->sustainOffRange(0, port.lowerStart(), port.lowerEnd());
          }
          else if (port.masterUpper(channel)) {
            if (on) engine->sustainOnRange(port.upperStart(), port.upperEnd());
            else engine->sustainOffRange(0, port.upperStart(), port.upperEnd());
          }
          else if (on) engine->sustainOn(channel);
          else engine->sustainOff(0, channel);
          break;
        case 0x42:
          if (port.masterLower(channel)) {
            if (on) engine->sostenutoOnRange(port.lowerStart(), port.lowerEnd());
            else engine->sostenutoOffRange(0, port.lowerStart(), port.lowerEnd());
          }
          else if (port.masterUpper(channel)) {
            if (on) engine->sostenutoOnRange(port.upperStart(), port.upperEnd());
            else engine->sostenutoOffRange(0, port.upperStart(), port.upperEnd());
          }
          else if (on) engine->sostenutoOn(channel);
          else engine->sostenutoOff(0, channel);
          break;
        case 0x43: break;
        case 0x01:
          engine->setModWheel(data2 / kControlMax, channel);
          return 1 | 4;
        case 0x7b:
        case 0x79:
          if (port.masterLower(channel)) engine->allNotesOffRange(0, port.lowerStart(), port.lowerEnd());
          else if (port.masterUpper(channel)) engine->allNotesOffRange(0, port.upperStart(), port.upperEnd());
          else engine->allNotesOff(0, channel);
          return 0;
        case 0x78: engine->allSoundsOff(); break;
        case 0x00:
        case 0x20:
          return 0;
      }
      return 4;
    }
  }
  return 0;
}

void loadScalaLines(Tuning& tuning, const std::vector<std::string>& lines);
void loadKeyboardMapLines(Tuning& tuning, const std::vector<std::string>& lines);
void loadTunLines(Tuning& tuning, const std::vector<std::string>& lines);
void nameTuningFile(Tuning& tuning, bool mapping, const std::string& name);

// SynthBase::loadTuningFile / TuningSelector::loadTuning, from a file's text: `kind` 0 = Scala (.scl),
// 1 = keyboard map (.kbm), 2 = .tun. A Scala or .tun file names the tuning, a keyboard map its
// mapping; `name` empty keeps the current name (the built-in scales are named first, then read).
EXPORT void vs_tuning_load(int kind, const char* text, const char* name) {
  std::vector<std::string> lines;
  std::string line;
  for (const char* c = text; ; ++c) {
    if (*c == '\n' || *c == 0) {
      if (!line.empty() && line.back() == '\r')
        line.pop_back();
      lines.push_back(line);
      line.clear();
      if (*c == 0)
        break;
    }
    else
      line += *c;
  }
  Tuning& tuning = synth->tuning;
  if (kind == 1) {
    loadKeyboardMapLines(tuning, lines);
    if (*name)
      nameTuningFile(tuning, true, name);
  }
  else {
    if (kind == 2)
      loadTunLines(tuning, lines);
    else
      loadScalaLines(tuning, lines);
    if (*name)
      nameTuningFile(tuning, false, name);
  }
}

EXPORT void vs_tuning_name_set(const char* name) { synth->tuning.setName(name); }
EXPORT void vs_tuning_default() { synth->tuning.setDefaultTuning(); }
EXPORT const char* vs_tuning_name() { return keep(synth->tuning.getName()); }
EXPORT int vs_tuning_is_default() { return synth->tuning.isDefault(); }
EXPORT float vs_tuning_note(int note) { return synth->tuning.convertMidiNote(note); }

EXPORT void vs_init(int sample_rate) {
  if (synth)
    return;
  synth = new WebSynth();
  synth->engine = std::make_unique<vital::SoundEngine>();
  synth->engine->setTuning(&synth->tuning);
  for (int i = 0; i < vital::kNumOscillators; ++i) {
    synth->wavetable_creators[i] = std::make_unique<WavetableCreator>(synth->engine->getWavetable(i));
    synth->wavetable_creators[i]->init();
  }
  synth->controls = synth->engine->getControls();
  synth->engine->setSampleRate(sample_rate);
  initEngine();
  synth->engine->setSampleRate(sample_rate);
  synth->engine->updateAllModulationSwitches();
  synth->audio_memory = std::make_unique<vital::StereoMemory>(vital::kAudioMemorySamples);
  std::memset(synth->oscilloscope_memory, 0, sizeof(synth->oscilloscope_memory));
  std::memset(synth->oscilloscope_memory_write, 0, sizeof(synth->oscilloscope_memory_write));
}

namespace {
  // SynthBase::updateMemoryOutput, unchanged.
  void updateMemoryOutput(int samples, const vital::poly_float* audio) {
    constexpr float kOutputWindowMinNote = 16.0f, kOutputWindowMaxNote = 128.0f; // SynthBase
    WebSynth& s = *synth;
    for (int i = 0; i < samples; ++i)
      s.audio_memory->push(audio[i]);

    vital::mono_float last_played = s.engine->getLastActiveNote();
    last_played = vital::utils::clamp(last_played, kOutputWindowMinNote, kOutputWindowMaxNote);

    int num_pressed = s.engine->getNumPressedNotes();
    int output_inc = std::max<int>(1, s.engine->getSampleRate() / vital::kOscilloscopeMemorySampleRate);
    int oscilloscope_samples = 2 * vital::kOscilloscopeMemoryResolution;

    if (last_played && (s.last_played_note != last_played || num_pressed > s.last_num_pressed)) {
      s.last_played_note = last_played;
      vital::mono_float frequency = vital::utils::midiNoteToFrequency(s.last_played_note);
      vital::mono_float period = s.engine->getSampleRate() / frequency;
      int window_length = output_inc * vital::kOscilloscopeMemoryResolution;

      s.memory_reset_period = period;
      while (s.memory_reset_period < window_length)
        s.memory_reset_period += s.memory_reset_period;

      s.memory_reset_period = std::min(s.memory_reset_period, 2.0f * window_length);
      s.memory_index = 0;
      vital::utils::copyBuffer(s.oscilloscope_memory, s.oscilloscope_memory_write, oscilloscope_samples);
    }
    s.last_num_pressed = num_pressed;

    for (; s.memory_input_offset < samples; s.memory_input_offset += output_inc) {
      int input_index = vital::utils::iclamp(s.memory_input_offset, 0, samples);
      s.memory_index = vital::utils::iclamp(s.memory_index, 0, oscilloscope_samples - 1);
      s.oscilloscope_memory_write[s.memory_index++] = audio[input_index];

      if (s.memory_index * output_inc >= s.memory_reset_period) {
        s.memory_input_offset += s.memory_reset_period - s.memory_index * output_inc;
        s.memory_index = 0;
        vital::utils::copyBuffer(s.oscilloscope_memory, s.oscilloscope_memory_write, oscilloscope_samples);
      }
    }

    s.memory_input_offset -= samples;
  }
}

// Renders `samples` (<= 128) frames; read them back with vs_left()/vs_right().
EXPORT void vs_process(int samples) {
  synth->engine->process(samples);
  const vital::mono_float* out = reinterpret_cast<const vital::mono_float*>(synth->engine->output(0)->buffer);
  for (int i = 0; i < samples; ++i) {
    synth->left[i] = out[vital::poly_float::kSize * i];
    synth->right[i] = out[vital::poly_float::kSize * i + 1];
  }
  updateMemoryOutput(samples, synth->engine->output(0)->buffer);
}

// The oscilloscope (Oscilloscope::drawWaveform): kResolution = 512 points of the memory window, left
// then right, each −1 … 1 (drawn at y = (1 − v) × height / 2).
EXPORT void vs_scope(float* out) {
  constexpr int kResolution = 512;
  for (int i = 0; i < kResolution; ++i) {
    float spot = (1.0f * i * vital::kOscilloscopeMemoryResolution) / kResolution;
    int index = spot;
    float t = spot - index;
    for (int c = 0; c < 2; ++c)
      out[c * kResolution + i] = vital::utils::interpolate(synth->oscilloscope_memory[index][c],
                                                           synth->oscilloscope_memory[index + 1][c], t);
  }
}

// A spectrogram display (Spectrogram::updateAmplitudes then drawWaveform): a Hann-windowed 2^14-point
// FFT of the last audio, read on kResolution = 300 log-spaced points from `min_freq` to `max_freq`, each
// point decaying toward the new level, tilted +3 dB an octave. `source` 0 is the synth's output (the
// header and ANALYSIS displays), 1 the equalizer's own memory (the EQ display, at the oversampled rate).
// Each display keeps its own decaying levels (`id` 0–3); each call is one display frame. Writes left
// then right as heights 0 … 1 over `min_db` … `max_db`.
namespace {
  struct SpectrogramState {
    static constexpr int kResolution = 300, kBits = 14, kAudioSize = 1 << kBits;
    static constexpr float kDecayMult = 0.008f, kDbSlopePerOctave = 3.0f;
    float transform_buffer[2 * kAudioSize];
    float amps[2][kAudioSize];
    vital::FourierTransform transform { kBits };
    SpectrogramState() {
      for (int c = 0; c < 2; ++c)
        for (int i = 0; i < kAudioSize; ++i)
          amps[c][i] = 0.000001f;
    }

    void applyWindow() {
      constexpr double kRadianIncrement = vital::kPi / (kAudioSize - 1.0);
      double real = -1.0, imag = 0.0;
      double real_mult = cos(kRadianIncrement), imag_mult = sin(kRadianIncrement);
      for (int i = 0; i < kAudioSize; ++i) {
        transform_buffer[i] *= 0.5f * (real + 1.0f);
        double next_real = real * real_mult - imag * imag_mult;
        double next_imag = imag * real_mult + real * imag_mult;
        real = next_real;
        imag = next_imag;
      }
    }

    void update(const vital::StereoMemory* memory, int index, float sample_rate, float min_freq, float max_freq,
                int oversample) {
      constexpr float kMinAmp = 0.000001f, kStartScaleAmp = 0.001f, kMinDecay = 0.06f;
      float* a = amps[index];
      float min_frequency = min_freq / oversample, max_frequency = max_freq / oversample;
      float sample_hz = sample_rate / kAudioSize;
      float start_octave = log2f(min_frequency / sample_hz);
      float end_octave = std::min<float>(kBits - start_octave + 1.0f, log2f(max_frequency / sample_hz));
      float num_octaves = end_octave - start_octave;

      memory->readSamples(transform_buffer, kAudioSize, 0, index);
      applyWindow();
      transform.transformRealForward(transform_buffer);
      std::complex<float>* frequency_data = (std::complex<float>*)transform_buffer;

      float last_bin = powf(2.0f, start_octave);
      for (int i = 0; i < kResolution; ++i) {
        float t = i / (kResolution - 1.0f);
        float octave = num_octaves * t + start_octave;
        float bin = powf(2.0f, octave);

        int bin_index = last_bin;
        float bin_t = last_bin - bin_index;
        float prev_amplitude = std::abs(frequency_data[bin_index]);
        float next_amplitude = std::abs(frequency_data[bin_index + 1]);
        float amplitude = vital::utils::interpolate(prev_amplitude, next_amplitude, bin_t);
        if (bin - last_bin > 1.0f) {
          for (int j = last_bin + 1; j < bin; ++j)
            amplitude = std::max(amplitude, std::abs(frequency_data[j]));
        }
        last_bin = bin;

        amplitude = std::max(kMinAmp, 2.0f * amplitude / kAudioSize);
        float db = vital::utils::magnitudeToDb(std::max(amplitude, a[i]) / kStartScaleAmp);
        db += octave * kDbSlopePerOctave;
        float decay = std::max(kMinDecay, std::min(1.0f, kDecayMult * db));
        a[i] = std::max(kMinAmp, vital::utils::interpolate(a[i], amplitude, decay));
      }
    }
  };
  SpectrogramState* spectrograms[4] = {};
}

EXPORT void vs_spectrogram(int id, int source, float min_db, float max_db, float min_freq, float max_freq, float* out) {
  using S = SpectrogramState;
  if (id < 0 || id >= 4)
    return;
  if (spectrograms[id] == nullptr)
    spectrograms[id] = new SpectrogramState();
  S& state = *spectrograms[id];
  const vital::StereoMemory* memory = source == 1 ? synth->engine->getEqualizerMemory() : synth->audio_memory.get();
  int oversample = source == 1 ? std::max(1, synth->engine->getOversamplingAmount()) : 1;
  if (memory == nullptr)
    return;
  float sample_rate = synth->engine->getSampleRate();
  float range_mult = 1.0f / (max_db - min_db);
  float num_octaves = log2f(max_freq / min_freq);
  for (int c = 0; c < 2; ++c) {
    state.update(memory, c, sample_rate, min_freq, max_freq, oversample);
    for (int i = 0; i < S::kResolution; ++i) {
      float t = i / (S::kResolution - 1.0f);
      float db = vital::utils::magnitudeToDb(state.amps[c][i]);
      db += t * num_octaves * S::kDbSlopePerOctave;
      out[c * S::kResolution + i] = (db - min_db) * range_mult;
    }
  }
}

EXPORT float* vs_left() { return synth->left; }
EXPORT float* vs_right() { return synth->right; }

EXPORT void vs_note_on(int note, float velocity) { synth->engine->noteOn(note, velocity, 0, 0); }
EXPORT void vs_note_off(int note) { synth->engine->noteOff(note, 0.5f, 0, 0); }
EXPORT void vs_all_notes_off() { synth->engine->allSoundsOff(); }
EXPORT void vs_mod_wheel(float value) { synth->engine->setModWheelAllChannels(value); }
EXPORT void vs_pitch_wheel(float value) { synth->engine->setZonedPitchWheel(value, 0, vital::kNumMidiChannels - 1); }
EXPORT void vs_set_bpm(float bpm) { synth->engine->setBpm(bpm); }
EXPORT int vs_active_voices() { return synth->engine->getNumActiveVoices(); }

EXPORT int vs_set_param(const char* name, float value) {
  auto found = synth->controls.find(name);
  if (found == synth->controls.end())
    return 0;
  found->second->set(value);
  if (std::strcmp(name, "oversampling") == 0)
    synth->engine->checkOversampling();
  return 1;
}

EXPORT float vs_get_param(const char* name) {
  auto found = synth->controls.find(name);
  return found == synth->controls.end() ? 0.0f : found->second->value();
}

// Every engine control with its range, default, unit and display name, as a JSON array.
EXPORT const char* vs_params_json() {
  json list = json::array();
  for (auto& control : synth->controls) {
    vital::ValueDetails details = vital::Parameters::getDetails(control.first);
    json entry;
    entry["id"] = control.first;
    entry["name"] = details.display_name;
    entry["min"] = details.min;
    entry["max"] = details.max;
    entry["default"] = details.default_value;
    entry["scale"] = static_cast<int>(details.value_scale);
    entry["units"] = details.display_units;
    entry["multiply"] = details.display_multiply;
    entry["post_offset"] = details.post_offset;
    entry["invert"] = details.display_invert;
    // Filter styles and oscillator destinations have more values than their name tables
    // (Vital's UI picks a table per filter model / build), so reading them would overrun.
    bool short_table = control.first.find("_style") != std::string::npos && control.first.find("filter_") == 0;
    short_table = short_table || control.first.find("_destination") != std::string::npos;
    if (details.string_lookup && !short_table) {
      json options = json::array();
      for (int i = 0; i <= static_cast<int>(details.max - details.min); ++i)
        options.push_back(details.string_lookup[i]);
      entry["options"] = options;
    }
    list.push_back(entry);
  }
  return keep(list.dump());
}

// FullInterface's matrix lists: every modulation source (getModulationSources) and every destination a
// modulation can reach (getMonoModulations), each destination with its display name and its local
// description (what the per-section submenus show).
EXPORT const char* vs_modulation_lists_json() {
  json sources = json::array();
  for (auto& source : synth->engine->getModulationSources())
    sources.push_back(source.first);
  json destinations = json::array();
  for (auto& destination : synth->engine->getMonoModulations()) {
    json entry;
    entry["id"] = destination.first;
    if (vital::Parameters::isParameter(destination.first)) {
      const vital::ValueDetails& details = vital::Parameters::getDetails(destination.first);
      entry["name"] = details.display_name;
      entry["local"] = details.local_description;
    }
    destinations.push_back(entry);
  }
  json result;
  result["sources"] = sources;
  result["destinations"] = destinations;
  return keep(result.dump());
}

EXPORT void vs_init_preset() {
  synth->engine->allSoundsOff();
  initEngine();
}

// Initialize without the wavetables and sample (the table worker renders those and hands them over):
// routings cleared, LFOs back to triangles, every control at its default.
EXPORT void vs_init_controls() {
  synth->engine->allSoundsOff();
  clearModulations();
  for (int i = 0; i < vital::kNumLfos; ++i)
    synth->engine->getLfoSource(i)->initTriangle();
  for (auto& control : synth->controls)
    control.second->set(vital::Parameters::getDetails(control.first).default_value);
  synth->engine->checkOversampling();
}

// Loads a .vital preset (its JSON text). Mirrors LoadSave::jsonToState minus the
// old-version upgrade path. Returns 1 on success, 0 on a parse error.
EXPORT int vs_load_preset(const char* text) {
  try {
    json data = json::parse(text);
    json settings = data["settings"];
    synth->engine->allSoundsOff();

    for (auto& control : synth->controls) {
      if (settings.count(control.first))
        control.second->set(settings[control.first].get<float>());
      else
        control.second->set(vital::Parameters::getDetails(control.first).default_value);
    }
    synth->engine->setModWheelAllChannels(synth->controls["mod_wheel"]->value());

    clearModulations();
    vital::ModulationConnectionBank& bank = synth->engine->getModulationBank();
    int index = 0;
    for (const json& modulation : settings["modulations"]) {
      vital::ModulationConnection* connection = bank.atIndex(index++);
      std::string source = modulation["source"];
      std::string destination = modulation["destination"];
      if (source.empty() || destination.empty())
        continue;
      connection->source_name = source;
      connection->destination_name = destination;
      if (connect(connection) < 0)
        continue;
      if (modulation.count("line_mapping"))
        connection->modulation_processor->lineMapGenerator()->jsonToState(modulation["line_mapping"]);
      else
        connection->modulation_processor->lineMapGenerator()->initLinear();
    }

    if (settings.count("sample"))
      synth->engine->getSample()->jsonToState(settings["sample"]);

    int i = 0;
    for (const json& wavetable : settings["wavetables"]) {
      if (i >= vital::kNumOscillators)
        break;
      synth->wavetable_creators[i]->jsonToState(wavetable); // renders the table
      i++;
    }

    i = 0;
    for (const json& lfo : settings["lfos"]) {
      if (i >= vital::kNumLfos)
        break;
      synth->engine->getLfoSource(i)->jsonToState(lfo);
      synth->engine->getLfoSource(i)->render();
      i++;
    }

    synth->engine->checkOversampling();
    return 1;
  }
  catch (const std::exception&) {
    return 0;
  }
}

// SampleSection::loadFile: the sampler's audio (one channel, or two for stereo) at its own sample rate,
// named after its file. Vital caps a mono file at 1764000 samples; a stereo one is capped here at twice
// that (Vital's 17640000 would need more memory than the engine may grow to). Returns the length kept.
EXPORT int vs_load_sample(const float* left, const float* right, int size, int sample_rate, const char* name) {
  static constexpr int kMaxStereoSamples = 3528000;
  vital::Sample* sample = synth->engine->getSample();
  if (size < vital::Sample::kMinSize)
    return 0;
  if (right)
    sample->loadSample(left, right, std::min(size, kMaxStereoSamples), sample_rate);
  else
    sample->loadSample(left, size, sample_rate);
  sample->setName(name);
  return sample->originalLength();
}

EXPORT const char* vs_sample_name() { return keep(synth->engine->getSample()->getName()); }

// SampleViewer::setLinePositions: the sample's left channel in 256 bins, each bin's largest value.
EXPORT int vs_sample_peaks(float* out) {
  static constexpr int kResolution = 256;
  vital::Sample* sample = synth->engine->getSample();
  double sample_length = sample->originalLength();
  const vital::mono_float* buffer = sample->buffer();
  for (int i = 0; i < kResolution; ++i) {
    int start_index = std::min<int>(sample_length * i / kResolution, sample_length);
    int end_index = std::min<int>((sample_length * (i + 1) + kResolution - 1) / kResolution, sample_length);
    float max = buffer[start_index];
    for (int j = start_index + 1; j < end_index; ++j)
      max = std::max(max, buffer[j]);
    out[i] = max;
  }
  return sample->originalLength();
}

// SynthBase::forceShowModulation: while a source is selected in the interface it runs even when
// nothing uses it (so its display animates); deselected, it stops again unless it's connected.
EXPORT void vs_force_show(const char* source, int force) {
  std::string name = source;
  if (force) {
    synth->engine->enableModSource(name);
    return;
  }
  for (vital::ModulationConnection* connection : synth->connections) {
    if (connection->source_name == name)
      return;
  }
  synth->engine->disableModSource(name);
}

// Connects source → destination (e.g. "lfo_1" → "filter_1_cutoff"). Returns the slot
// number N for the "modulation_N_amount" control, or 0 when the pair is invalid.
EXPORT int vs_connect(const char* source, const char* destination) {
  vital::ModulationConnection* connection = findConnection(source, destination);
  if (connection == nullptr)
    connection = synth->engine->getModulationBank().createConnection(source, destination);
  if (connection == nullptr)
    return 0;
  int index = connect(connection);
  return index < 0 ? 0 : index + 1;
}

EXPORT void vs_disconnect(const char* source, const char* destination) {
  vital::ModulationConnection* connection = findConnection(source, destination);
  if (connection)
    disconnect(connection);
}

// Current modulation routings as JSON [{source, destination, slot}].
EXPORT const char* vs_modulations_json() {
  json list = json::array();
  vital::ModulationConnectionBank& bank = synth->engine->getModulationBank();
  for (int i = 0; i < vital::kMaxModulationConnections; ++i) {
    vital::ModulationConnection* connection = bank.atIndex(i);
    if (!isConnected(connection))
      continue;
    list.push_back({ { "source", connection->source_name },
                     { "destination", connection->destination_name },
                     { "slot", i + 1 } });
  }
  return keep(list.dump());
}

// One frame of an oscillator's wavetable at `position` (0..1): kWaveformSize floats of the
// time-domain shape the wavetable editor would draw at that frame.
EXPORT const float* vs_wavetable_frame(int oscillator, float position) {
  static vital::WaveFrame combined;
  static vital::WaveFrame frame;
  WavetableCreator* creator = synth->wavetable_creators[oscillator].get();
  float index = position * (vital::kNumOscillatorWaveFrames - 1);
  combined.clear();
  combined.index = index;
  frame.index = index;
  for (int g = 0; g < creator->numGroups(); ++g) {
    creator->getGroup(g)->render(&frame, index);
    combined.addFrom(&frame);
  }
  return combined.time_domain;
}

// Status outputs (what Vital's displays read: "lfo_1_phase", "env_1_phase", "modulation_amount_3",
// "num_voices", "peak_meter"…). Resolve a name to a handle once, then read many handles per display
// frame without any string work on the audio thread. A handle of 0 means no such output.
EXPORT const vital::StatusOutput* vs_status_handle(const char* name) {
  return synth->engine->getStatusOutput(name);
}

// Writes all poly_float::kSize lanes of each of `count` handles into `out` (count × kSize floats). For
// voice outputs lane 0/1 are the first voice's left/right; the chorus delays use all four. A cleared
// output (no voice playing) reads as StatusOutput::kClearValue.
EXPORT void vs_status_read(const vital::StatusOutput* const* handles, int count, float* out) {
  constexpr int lanes = vital::poly_float::kSize;
  for (int i = 0; i < count; ++i) {
    for (int lane = 0; lane < lanes; ++lane)
      out[i * lanes + lane] = handles[i] ? handles[i]->value()[lane] : vital::StatusOutput::kClearValue;
  }
}

EXPORT int vs_status_lanes() { return vital::poly_float::kSize; }

// Re-syncs tempo-locked modulators to an absolute song time in seconds.
EXPORT void vs_correct_to_time(double seconds) { synth->engine->correctToTime(seconds); }

#ifdef __EMSCRIPTEN__
#include <malloc.h>
// Bytes currently allocated on the WASM heap (for leak checks).
EXPORT int vs_heap_used() { return static_cast<int>(mallinfo().uordblks); }
#endif

// Replaces an oscillator's wavetable with a WavetableCreator JSON document (the "wavetables[n]" entry of
// a .vital preset: groups of components with keyframes) and renders it. Returns 1, or 0 on bad JSON.
EXPORT int vs_set_wavetable(int oscillator, const char* text) {
  if (oscillator < 0 || oscillator >= vital::kNumOscillators)
    return 0;
  try {
    synth->wavetable_creators[oscillator]->jsonToState(json::parse(text));
    return 1;
  }
  catch (const std::exception&) {
    return 0;
  }
}

// FullInterface::loadAudioAsWavetable (WavetableEditSection): audio (the file's first channel, at its
// own sample rate) made into oscillator `oscillator`'s wavetable by WavetableCreator::initFromAudioFile:
// `style` 1 = wavetable splice, 2 = vocoded, 4 = pitch splice; `fade` the splice's FileSource fade style
// (a Serum-style "clm " chunk's choice); then named, credited and rendered.
EXPORT int vs_wavetable_from_audio(int oscillator, const float* data, int samples, int sample_rate, int style,
                                   int fade, const char* name, const char* author) {
  if (oscillator < 0 || oscillator >= vital::kNumOscillators || samples <= 0)
    return 0;
  WavetableCreator* creator = synth->wavetable_creators[oscillator].get();
  creator->initFromAudioFile(data, samples, sample_rate, static_cast<WavetableCreator::AudioFileLoadStyle>(style),
                             static_cast<FileSource::FadeStyle>(fade));
  creator->setName(name);
  creator->setAuthor(author);
  creator->render();
  return 1;
}

// WavetableEditSection::resynthesizeToWavetable: four seconds of the patch playing MIDI note 16
// (SynthBase::renderAudioForResynthesis, a second of silence first, normalized), pitch-spliced into
// oscillator `oscillator`'s wavetable with one window per period. The note is released afterwards.
EXPORT int vs_resynthesize(int oscillator) {
  static constexpr float kResynthesizeTime = 4.0f;
  static constexpr int kResynthesizeNote = 16;
  static constexpr int kPreProcessSamples = 44100;
  static constexpr int kBufferSize = 64;
  if (oscillator < 0 || oscillator >= vital::kNumOscillators)
    return 0;
  vital::SoundEngine* engine = synth->engine.get();
  int sample_rate = engine->getSampleRate();
  int samples = sample_rate * kResynthesizeTime;
  std::unique_ptr<float[]> data = std::make_unique<float[]>(samples);

  double sample_time = 1.0 / sample_rate;
  double current_time = -kPreProcessSamples * sample_time;
  engine->allSoundsOff();
  for (int s = 0; s < kPreProcessSamples; s += kBufferSize) {
    engine->correctToTime(current_time);
    current_time += kBufferSize * sample_time;
    engine->process(kBufferSize);
  }
  engine->noteOn(kResynthesizeNote, 0.7f, 0, 0);
  const vital::poly_float* output = engine->output(0)->buffer;
  float max_value = 0.01f;
  for (int s = 0; s < samples; s += kBufferSize) {
    int num_samples = std::min(samples - s, kBufferSize);
    engine->correctToTime(current_time);
    current_time += num_samples * sample_time;
    engine->process(num_samples);
    for (int i = 0; i < num_samples; ++i) {
      float sample = output[i][0];
      data[s + i] = sample;
      max_value = std::max(max_value, fabsf(sample));
    }
  }
  engine->allSoundsOff();
  float scale = 1.0f / max_value;
  for (int s = 0; s < samples; ++s)
    data[s] *= scale;

  WavetableCreator* creator = synth->wavetable_creators[oscillator].get();
  creator->initFromAudioFile(data.get(), samples, sample_rate, WavetableCreator::kPitched, FileSource::kWaveBlend);
  creator->setName("Resynthesize");
  FileSource* file_source = dynamic_cast<FileSource*>(creator->getGroup(0)->getComponent(0));
  if (file_source)
    file_source->setWindowSize(sample_rate / vital::utils::midiNoteToFrequency(kResynthesizeNote));
  creator->render();
  return 1;
}


// ── The wavetable editor (WavetableEditSection and its organizer, component list and overlays) ──
// working on oscillator `osc`'s WavetableCreator itself: its layout, each keyframe's and component's
// state, keyframes added, moved and removed, components added, reordered and reset, a wave source's
// frame edited in time or frequency, and the rendered frame at the playhead with its spectrum.
namespace {
  WavetableCreator* wtCreator(int osc) {
    if (osc < 0 || osc >= vital::kNumOscillators)
      return nullptr;
    return synth->wavetable_creators[osc].get();
  }

  WavetableComponent* wtComponent(int osc, int g, int c) {
    WavetableCreator* creator = wtCreator(osc);
    if (creator == nullptr || g < 0 || g >= creator->numGroups())
      return nullptr;
    WavetableGroup* group = creator->getGroup(g);
    if (c < 0 || c >= group->numComponents())
      return nullptr;
    return group->getComponent(c);
  }

  WavetableKeyframe* wtKeyframe(int osc, int g, int c, int i) {
    WavetableComponent* component = wtComponent(osc, g, c);
    if (component == nullptr || i < 0 || i >= component->numFrames())
      return nullptr;
    return component->getFrameAt(i);
  }

  void wtRender(int osc, int position) {
    WavetableCreator* creator = wtCreator(osc);
    if (creator == nullptr)
      return;
    if (position >= 0)
      creator->render(position);
    else if (position == -1)
      creator->render();
  }

  void mergeJson(json& target, const json& patch) {
    for (auto it = patch.begin(); it != patch.end(); ++it)
      target[it.key()] = it.value();
  }
}

EXPORT const char* vs_wt_layout(int osc) {
  WavetableCreator* creator = wtCreator(osc);
  json result;
  if (creator == nullptr)
    return keep(result.dump());
  json state = creator->stateToJson();
  result["name"] = creator->getName();
  result["author"] = creator->getAuthor();
  result["remove_all_dc"] = state.count("remove_all_dc") ? state["remove_all_dc"] : json(true);
  result["full_normalize"] = state.count("full_normalize") ? state["full_normalize"] : json(true);
  result["frames"] = creator->getWavetable()->numFrames();
  json groups = json::array();
  for (int g = 0; g < creator->numGroups(); ++g) {
    WavetableGroup* group = creator->getGroup(g);
    json components = json::array();
    for (int c = 0; c < group->numComponents(); ++c) {
      WavetableComponent* component = group->getComponent(c);
      json data = component->stateToJson();
      data.erase("keyframes");
      data.erase("audio_file");
      data["type_index"] = static_cast<int>(component->getType());
      data["name"] = WavetableComponentFactory::getComponentName(component->getType());
      data["has_keyframes"] = component->hasKeyframes();
      json positions = json::array();
      for (int i = 0; i < component->numFrames(); ++i)
        positions.push_back(component->getFrameAt(i)->position());
      data["positions"] = positions;
      if (FileSource* file = dynamic_cast<FileSource*>(component)) {
        data["samples"] = file->buffer()->size;
        data["sample_rate"] = file->buffer()->sample_rate;
      }
      components.push_back(data);
    }
    groups.push_back(components);
  }
  result["groups"] = groups;
  return keep(result.dump());
}

EXPORT const char* vs_wt_keyframe(int osc, int g, int c, int i) {
  WavetableKeyframe* keyframe = wtKeyframe(osc, g, c, i);
  if (keyframe == nullptr)
    return keep("{}");
  return keep(keyframe->stateToJson().dump());
}

// A keyframe's state merged with `patch` (its own fields, e.g. {"phase": 1.2}), then rendered: the
// one frame at `position` while dragging, the whole table when `position` is negative.
EXPORT int vs_wt_set_keyframe(int osc, int g, int c, int i, const char* patch, int position) {
  WavetableKeyframe* keyframe = wtKeyframe(osc, g, c, i);
  if (keyframe == nullptr)
    return 0;
  try {
    json data = keyframe->stateToJson();
    mergeJson(data, json::parse(patch));
    keyframe->jsonToState(data);
  }
  catch (const std::exception&) {
    return 0;
  }
  wtRender(osc, position);
  return 1;
}

// A component's own settings merged with `patch` (interpolation, styles, normalize …). A file source
// takes its settings through its setters (its state carries the whole audio file).
EXPORT int vs_wt_set_component(int osc, int g, int c, const char* patch, int position) {
  WavetableComponent* component = wtComponent(osc, g, c);
  if (component == nullptr)
    return 0;
  try {
    json changes = json::parse(patch);
    if (FileSource* file = dynamic_cast<FileSource*>(component)) {
      if (changes.count("window_size"))
        file->setWindowSize(changes["window_size"].get<double>());
      if (changes.count("fade_style"))
        file->setFadeStyle(static_cast<FileSource::FadeStyle>(changes["fade_style"].get<int>()));
      if (changes.count("phase_style"))
        file->setPhaseStyle(static_cast<FileSource::PhaseStyle>(changes["phase_style"].get<int>()));
      if (changes.count("normalize_gain"))
        file->setNormalizeGain(changes["normalize_gain"].get<bool>());
      if (changes.count("interpolation_style"))
        file->setInterpolationStyle(static_cast<WavetableComponent::InterpolationStyle>(changes["interpolation_style"].get<int>()));
    }
    else {
      json data = component->stateToJson();
      mergeJson(data, changes);
      component->jsonToState(data);
    }
  }
  catch (const std::exception&) {
    return 0;
  }
  wtRender(osc, position);
  return 1;
}

// WavetableOrganizer::createKeyframeAtPosition: a keyframe interpolated from its neighbours.
EXPORT int vs_wt_insert_keyframe(int osc, int g, int c, int position) {
  WavetableComponent* component = wtComponent(osc, g, c);
  if (component == nullptr)
    return -1;
  WavetableKeyframe* keyframe = component->insertNewKeyframe(vital::utils::iclamp(position, 0, vital::kNumOscillatorWaveFrames - 1));
  wtRender(osc, -1);
  return component->indexOf(keyframe);
}

EXPORT void vs_wt_remove_keyframe(int osc, int g, int c, int i) {
  WavetableKeyframe* keyframe = wtKeyframe(osc, g, c, i);
  if (keyframe == nullptr)
    return;
  keyframe->owner()->remove(keyframe);
  wtRender(osc, -1);
}

// A dragged keyframe's position; `final` re-sorts it among the others (mouse up). Returns its index.
EXPORT int vs_wt_move_keyframe(int osc, int g, int c, int i, int position, int final) {
  WavetableKeyframe* keyframe = wtKeyframe(osc, g, c, i);
  if (keyframe == nullptr)
    return -1;
  keyframe->setPosition(vital::utils::iclamp(position, 0, vital::kNumOscillatorWaveFrames - 1));
  if (final) {
    keyframe->owner()->reposition(keyframe);
    wtRender(osc, -1);
  }
  return keyframe->owner()->indexOf(keyframe);
}

// WavetableOrganizer::mouseUp after a drag: every keyframe settles into order by position
// (reposition), then the table renders.
EXPORT void vs_wt_reposition_all(int osc) {
  WavetableCreator* creator = wtCreator(osc);
  if (creator == nullptr)
    return;
  for (int g = 0; g < creator->numGroups(); ++g) {
    WavetableGroup* group = creator->getGroup(g);
    for (int c = 0; c < group->numComponents(); ++c) {
      WavetableComponent* component = group->getComponent(c);
      std::vector<WavetableKeyframe*> keyframes;
      for (int i = 0; i < component->numFrames(); ++i)
        keyframes.push_back(component->getFrameAt(i));
      for (WavetableKeyframe* keyframe : keyframes)
        component->reposition(keyframe);
    }
  }
  wtRender(osc, -1);
}

// WavetableComponentList::addSource / addComponent: a new group with a source, or a modifier at the
// end of group `g`, each with one keyframe at 0.
EXPORT void vs_wt_add_source(int osc, int type) {
  WavetableCreator* creator = wtCreator(osc);
  if (creator == nullptr || type < 0 || type >= WavetableComponentFactory::numSourceTypes())
    return;
  WavetableComponent* component = WavetableComponentFactory::createComponent(WavetableComponentFactory::getSourceType(type));
  component->insertNewKeyframe(0);
  WavetableGroup* group = new WavetableGroup();
  group->addComponent(component);
  creator->addGroup(group);
  wtRender(osc, -1);
}

EXPORT void vs_wt_add_modifier(int osc, int g, int type) {
  WavetableCreator* creator = wtCreator(osc);
  if (creator == nullptr || g < 0 || g >= creator->numGroups() || type < 0 || type >= WavetableComponentFactory::numModifierTypes())
    return;
  WavetableComponent* component = WavetableComponentFactory::createComponent(WavetableComponentFactory::getModifierType(type));
  component->insertNewKeyframe(0);
  creator->getGroup(g)->addComponent(component);
  wtRender(osc, -1);
}

// Remove: a group's source removes the whole group; a modifier only itself.
EXPORT void vs_wt_remove_component(int osc, int g, int c) {
  WavetableCreator* creator = wtCreator(osc);
  if (wtComponent(osc, g, c) == nullptr)
    return;
  if (c == 0)
    creator->removeGroup(g);
  else
    creator->getGroup(g)->removeComponent(c);
  wtRender(osc, -1);
}

// Move Up / Down: a group (c 0) among the groups, a modifier within its group.
EXPORT void vs_wt_move_component(int osc, int g, int c, int up) {
  WavetableCreator* creator = wtCreator(osc);
  if (wtComponent(osc, g, c) == nullptr)
    return;
  if (c == 0) {
    if (up && g > 0)
      creator->moveUp(g);
    else if (!up && g < creator->numGroups() - 1)
      creator->moveDown(g);
  }
  else {
    WavetableGroup* group = creator->getGroup(g);
    if (up && c > 1)
      group->moveUp(c);
    else if (!up && c < group->numComponents() - 1)
      group->moveDown(c);
  }
  wtRender(osc, -1);
}

EXPORT void vs_wt_reset_component(int osc, int g, int c) {
  WavetableComponent* component = wtComponent(osc, g, c);
  if (component == nullptr)
    return;
  component->reset();
  wtRender(osc, -1);
}

// The table's NORMALIZE TABLE / REMOVE DC (full_normalize, remove_all_dc), through its own state.
EXPORT void vs_wt_flags(int osc, int normalize, int remove_dc) {
  WavetableCreator* creator = wtCreator(osc);
  if (creator == nullptr)
    return;
  json data = creator->stateToJson();
  if (normalize >= 0)
    data["full_normalize"] = normalize != 0;
  if (remove_dc >= 0)
    data["remove_all_dc"] = remove_dc != 0;
  creator->jsonToState(data);
}

// WavetableEditSection::render / updateGlDisplay: render (one frame, all when `position` is −1,
// none when it's below that), then the frame at the playhead: 2048 samples, then 1024 amplitudes (|X| / 2048) and 1024
// phases (−1…1; −0.5 where there's no amplitude, and −1 for a phase at π).
EXPORT void vs_wt_render(int osc, int position, int playhead, float* out) {
  static constexpr float kAmplitudeEpsilon = 0.0000001f;
  static constexpr float kPhaseEpsilon = 0.0001f;
  WavetableCreator* creator = wtCreator(osc);
  if (creator == nullptr)
    return;
  wtRender(osc, position);
  int max_frame = std::max(0, creator->getWavetable()->numFrames() - 1);
  int at = vital::utils::iclamp(playhead, 0, max_frame);
  float* buffer = creator->getWavetable()->getBuffer(at);
  vital::WaveFrame frame;
  frame.loadTimeDomain(buffer);
  for (int i = 0; i < vital::WaveFrame::kWaveformSize; ++i)
    out[i] = buffer[i];
  for (int i = 0; i < vital::WaveFrame::kWaveformSize / 2; ++i) {
    std::complex<float> value = frame.frequency_domain[i];
    float amplitude = std::abs(value) / vital::WaveFrame::kWaveformSize;
    float phase = amplitude > kAmplitudeEpsilon ? std::arg(value) : -vital::kPi / 2.0f;
    if (phase >= vital::kPi - kPhaseEpsilon)
      phase = -vital::kPi;
    out[vital::WaveFrame::kWaveformSize + i] = amplitude;
    out[vital::WaveFrame::kWaveformSize + vital::WaveFrame::kWaveformSize / 2 + i] = phase / vital::kPi;
  }
}

namespace {
  vital::WaveFrame* wtWaveFrame(int osc, int g, int c, int i) {
    WaveSource* source = dynamic_cast<WaveSource*>(wtComponent(osc, g, c));
    if (source == nullptr || i < 0 || i >= source->numFrames())
      return nullptr;
    return source->getWaveFrame(i);
  }
}

// WaveSourceOverlay::frameSelected: a wave source keyframe's samples (2048), then its 1025 bar
// amplitudes (|X| / 2048) and phases (arg / π, −0.5 where there's no amplitude).
EXPORT void vs_wt_wave_frame(int osc, int g, int c, int i, float* out) {
  vital::WaveFrame* frame = wtWaveFrame(osc, g, c, i);
  if (frame == nullptr)
    return;
  for (int s = 0; s < vital::WaveFrame::kWaveformSize; ++s)
    out[s] = frame->time_domain[s];
  for (int b = 0; b < vital::WaveFrame::kNumRealComplex; ++b) {
    std::complex<float> value = frame->frequency_domain[b];
    float amplitude = std::abs(value);
    out[vital::WaveFrame::kWaveformSize + b] = amplitude / vital::WaveFrame::kWaveformSize;
    out[vital::WaveFrame::kWaveformSize + vital::WaveFrame::kNumRealComplex + b] =
        amplitude ? std::arg(value) / vital::kPi : -0.5f;
  }
}

// WaveSourceOverlay::valuesChanged: samples start…end drawn in, then the frame's spectrum follows.
EXPORT void vs_wt_wave_time(int osc, int g, int c, int i, const float* data, int start, int end, int position) {
  vital::WaveFrame* frame = wtWaveFrame(osc, g, c, i);
  if (frame == nullptr)
    return;
  for (int s = std::max(0, start); s <= std::min(end, vital::WaveFrame::kWaveformSize - 1); ++s)
    frame->time_domain[s] = data[s];
  frame->toFrequencyDomain();
  wtRender(osc, position);
}

// WaveSourceOverlay::loadFrequencyDomain: the bars (amplitude × 2048, phase × π) as the spectrum, then
// back to samples, normalized.
EXPORT void vs_wt_wave_freq(int osc, int g, int c, int i, const float* amplitudes, const float* phases, int position) {
  vital::WaveFrame* frame = wtWaveFrame(osc, g, c, i);
  if (frame == nullptr)
    return;
  for (int b = 0; b < vital::WaveFrame::kNumRealComplex; ++b)
    frame->frequency_domain[b] = std::polar(amplitudes[b] * vital::WaveFrame::kWaveformSize, vital::kPi * phases[b]);
  frame->toTimeDomain();
  frame->normalize();
  frame->toFrequencyDomain();
  wtRender(osc, position);
}

// WaveLineSourceOverlay: the edited keyframe's line (LineGenerator JSON); when it gained or lost
// points (`added` > 0 or < 0 at `index`), every other keyframe gains a middle point or loses that one
// so they keep the same count (pointAdded / pointRemoved).
EXPORT int vs_wt_line(int osc, int g, int c, int i, const char* line, int index, int added, int position) {
  WaveLineSource* source = dynamic_cast<WaveLineSource*>(wtComponent(osc, g, c));
  if (source == nullptr || i < 0 || i >= source->numFrames())
    return 0;
  WaveLineSource::WaveLineSourceKeyframe* current = source->getKeyframe(i);
  try {
    current->getLineGenerator()->jsonToState(json::parse(line));
  }
  catch (const std::exception&) {
    return 0;
  }
  if (added) {
    source->setNumPoints(current->getNumPoints());
    for (int k = 0; k < source->numFrames(); ++k) {
      WaveLineSource::WaveLineSourceKeyframe* keyframe = source->getKeyframe(k);
      if (keyframe == current)
        continue;
      for (int p = 0; p < std::abs(added); ++p) {
        if (added > 0)
          keyframe->addMiddlePoint(std::min(index + p, keyframe->getNumPoints() - 1));
        else
          keyframe->removePoint(index);
      }
    }
  }
  wtRender(osc, position);
  return 1;
}

// WavetableEditSection::exportToWav: the table rendered as `frames` frames of 2048 samples (normalized
// to a peak of at most 1), into `out`.
EXPORT void vs_wt_render_buffer(int osc, int frames, float* out) {
  WavetableCreator* creator = wtCreator(osc);
  if (creator == nullptr)
    return;
  creator->renderToBuffer(out, frames, vital::WaveFrame::kWaveformSize);
}

// FileSourceOverlay::loadFile: audio (its first channel, at most 176400 samples) into a file source,
// pitch-detected for its window.
EXPORT void vs_wt_file_load(int osc, int g, int c, const float* data, int samples, int sample_rate) {
  FileSource* source = dynamic_cast<FileSource*>(wtComponent(osc, g, c));
  if (source == nullptr)
    return;
  source->loadBuffer(data, std::min<int>(samples, FileSource::kMaxFileSourceSamples), sample_rate);
  source->detectPitch();
  wtRender(osc, -1);
}

// AudioFileViewer::setAudioPositions: a file source's audio in 256 bins, each bin's largest sample.
EXPORT int vs_wt_file_peaks(int osc, int g, int c, float* out) {
  static constexpr int kResolution = 256;
  FileSource* source = dynamic_cast<FileSource*>(wtComponent(osc, g, c));
  if (source == nullptr || source->buffer()->size == 0 || source->buffer()->data == nullptr)
    return 0;
  const float* buffer = source->buffer()->data.get();
  int length = source->buffer()->size;
  for (int i = 0; i < kResolution; ++i) {
    int start = std::min<int>(length * i / kResolution, length);
    int end = std::min<int>((length * (i + 1) + kResolution - 1) / kResolution, length);
    float max = buffer[start];
    for (int s = start + 1; s < end; ++s)
      max = std::max(max, buffer[s]);
    out[i] = max;
  }
  return length;
}

EXPORT const char* vs_wavetable_name(int oscillator) {
  return keep(synth->engine->getWavetable(oscillator)->getName());
}

// Replaces LFO `index`'s shape with LineGenerator JSON {num_points, points: [x0, y0, x1, y1…], powers,
// smooth, name}; y runs 0 (top) to 1 (bottom), as in .vital files. Returns 1, or 0 on bad JSON.
EXPORT int vs_set_lfo(int index, const char* text) {
  if (index < 0 || index >= vital::kNumLfos)
    return 0;
  try {
    json data = json::parse(text);
    if (!LineGenerator::isValidJson(data))
      return 0;
    synth->engine->getLfoSource(index)->jsonToState(data);
    return 1;
  }
  catch (const std::exception&) {
    return 0;
  }
}

EXPORT const char* vs_lfo_json(int index) {
  return keep(synth->engine->getLfoSource(index)->stateToJson().dump());
}

// An oscillator's wavetable as WavetableCreator JSON (what a .vital preset stores for it).
EXPORT const char* vs_wavetable_json(int oscillator) {
  return keep(synth->wavetable_creators[oscillator]->stateToJson().dump());
}

// The whole patch as a .vital preset (LoadSave::stateToJson's layout: every control, all 64 modulation
// slots, the sample, three wavetables and eight LFO shapes). `meta_text` is JSON with the preset's
// preset_name, author, comments, preset_style and macro1…macro4 names; missing fields save empty.
namespace {
  std::string savePreset(const char* meta_text, bool tables_and_sample);
}

EXPORT const char* vs_save_preset(const char* meta_text) {
  return keep(savePreset(meta_text, true));
}

// The preset without its wavetables and sample (the table worker adds those: they live there).
EXPORT const char* vs_save_preset_light(const char* meta_text) {
  return keep(savePreset(meta_text, false));
}

namespace {
std::string savePreset(const char* meta_text, bool tables_and_sample) {
  json meta = json::object();
  try {
    meta = json::parse(meta_text);
  }
  catch (const std::exception&) { }

  json settings;
  for (auto& control : synth->controls)
    settings[control.first] = control.second->value();
  if (tables_and_sample)
    settings["sample"] = synth->engine->getSample()->stateToJson();

  json modulations;
  vital::ModulationConnectionBank& bank = synth->engine->getModulationBank();
  for (int i = 0; i < vital::kMaxModulationConnections; ++i) {
    vital::ModulationConnection* connection = bank.atIndex(i);
    json modulation;
    modulation["source"] = connection->source_name;
    modulation["destination"] = connection->destination_name;
    LineGenerator* line_mapping = connection->modulation_processor->lineMapGenerator();
    if (!line_mapping->linear())
      modulation["line_mapping"] = line_mapping->stateToJson();
    modulations.push_back(modulation);
  }
  settings["modulations"] = modulations;

  if (tables_and_sample) {
    json wavetables;
    for (int i = 0; i < vital::kNumOscillators; ++i)
      wavetables.push_back(synth->wavetable_creators[i]->stateToJson());
    settings["wavetables"] = wavetables;
  }

  json lfos;
  for (int i = 0; i < vital::kNumLfos; ++i)
    lfos.push_back(synth->engine->getLfoSource(i)->stateToJson());
  settings["lfos"] = lfos;

  auto text = [&](const char* key) { return meta.count(key) && meta[key].is_string() ? meta[key].get<std::string>() : std::string(); };
  json data;
  data["synth_version"] = ProjectInfo::versionString;
  data["preset_name"] = text("preset_name");
  data["author"] = text("author");
  data["comments"] = text("comments");
  data["preset_style"] = text("preset_style");
  for (int i = 0; i < vital::kNumMacros; ++i) {
    std::string key = "macro" + std::to_string(i + 1);
    data[key] = text(key.c_str());
  }
  data["settings"] = settings;
  return data.dump();
}
}

// Sustain pedal (MIDI CC 64) on every channel.
EXPORT void vs_sustain(int on) {
  if (on)
    synth->engine->sustainOnRange(0, vital::kNumMidiChannels - 1);
  else
    synth->engine->sustainOffRange(0, 0, vital::kNumMidiChannels - 1);
}

// A modulated control's live value (what Vital's knob meters draw): the engine keeps a mono and a poly
// total per modulation destination, in the control's own units. Resolve a destination name once to a
// handle (0 = not a destination), then read many per display frame.
EXPORT const vital::Output* vs_mod_total_handle(const char* name, int poly) {
  vital::output_map& totals = poly ? synth->engine->getPolyModulations() : synth->engine->getMonoModulations();
  auto found = totals.find(name);
  return found == totals.end() ? nullptr : found->second;
}

// out[2i], out[2i + 1] = the left and right lanes of the mono total, plus the poly total while any voice
// plays (getOutputsTotal: the meters and displays read lane 0 for the left, 1 for the right).
EXPORT void vs_mod_total_read(const vital::Output* const* mono, const vital::Output* const* poly, int count, float* out) {
  bool voices = synth->engine->getNumActiveVoices() > 0;
  for (int i = 0; i < count; ++i) {
    for (int lane = 0; lane < 2; ++lane) {
      float value = mono[i] ? mono[i]->trigger_value[lane] : 0.0f;
      if (voices && poly[i])
        value += poly[i]->trigger_value[lane];
      out[2 * i + lane] = value;
    }
  }
}

// A modulation slot's remap curve (Matrix page): LineGenerator JSON, x the source's value, y 0 (top)
// … 1 (bottom) the mapped value. `slot` is the 1-based N of modulation_N_*. Returns 1, or 0 on bad input.
EXPORT int vs_set_remap(int slot, const char* text) {
  if (slot < 1 || slot > vital::kMaxModulationConnections)
    return 0;
  try {
    json data = json::parse(text);
    if (!LineGenerator::isValidJson(data))
      return 0;
    synth->engine->getModulationBank().atIndex(slot - 1)->modulation_processor->lineMapGenerator()->jsonToState(data);
    return 1;
  }
  catch (const std::exception&) {
    return 0;
  }
}

EXPORT const char* vs_remap_json(int slot) {
  if (slot < 1 || slot > vital::kMaxModulationConnections)
    return keep("null");
  return keep(synth->engine->getModulationBank().atIndex(slot - 1)->modulation_processor->lineMapGenerator()->stateToJson().dump());
}

// The oscillator display, computed the way Vital's Wavetable3d does it (loadIntoTimeDomain): the frame
// nearest `frame` (0…256), spectrally morphed, then read through the phase distortion. `morph` and
// `distortion` are the knobs' 0…1 values (modulated, if they are) and `distortion_phase` 0…1; the
// type numbers are the menus'. Writes kWaveformSize samples to vs_display_wave(), and that frame's
// harmonic magnitudes (kWaveformSize / 2) to vs_display_spectrum().
namespace {
  struct Display {
    vital::WaveFrame frame;
    vital::FourierTransform transform { vital::WaveFrame::kWaveformBits };
    vital::poly_float wave_data[vital::SynthOscillator::kSpectralBufferSize];
    float spectrum[vital::WaveFrame::kWaveformSize / 2];
  };
  Display* display = nullptr;
}

EXPORT void vs_osc_display(int oscillator, float frame, int morph_type, float morph, int distortion_type,
                           float distortion, float distortion_phase) {
  if (display == nullptr)
    display = new Display();
  using Osc = vital::SynthOscillator;
  const vital::Wavetable::WavetableData* data = synth->engine->getWavetable(oscillator)->getAllData();
  int index = std::max(0, std::min<int>(std::round(frame), data->num_frames - 1));

  Osc::SpectralMorph morph_kind = static_cast<Osc::SpectralMorph>(morph_type);
  vital::poly_float morph_value = vital::utils::clamp(morph, 0.0f, 1.0f);
  Osc::setSpectralMorphValues(morph_kind, &morph_value, 1, false);
  memset(display->wave_data, 0, sizeof(display->wave_data));
  Osc::runSpectralMorph(morph_kind, morph_value[0], data, index, display->wave_data, &display->transform);

  Osc::DistortionType distortion_kind = static_cast<Osc::DistortionType>(distortion_type);
  vital::poly_float distortion_value = vital::utils::clamp(distortion, 0.0f, 1.0f);
  Osc::setDistortionValues(distortion_kind, &distortion_value, 1, false);
  vital::poly_int phase_offset = 0;
  if (Osc::usesDistortionPhase(distortion_kind))
    phase_offset = vital::utils::toInt(vital::poly_float(distortion_phase) * UINT_MAX - INT_MAX);

  const int size = vital::WaveFrame::kWaveformSize;
  vital::poly_float spread(1.0f, 2.0f, 3.0f, 4.0f);
  float delta = 1.0f / size;
  float* buffer = reinterpret_cast<float*>(display->wave_data + 1);
  float* time_domain = display->frame.time_domain;
  for (int i = 0; i < size - vital::poly_float::kSize + 1; i += vital::poly_float::kSize) {
    vital::poly_float t = (spread + i) * delta;
    vital::poly_int original_phase = vital::utils::toInt(t * UINT_MAX - INT_MAX) + INT_MAX;
    vital::poly_int adjusted_phase = Osc::adjustPhase(distortion_kind, original_phase, distortion_value[0], phase_offset);
    vital::poly_float window = Osc::getPhaseWindow(distortion_kind, original_phase, adjusted_phase);
    adjusted_phase += phase_offset;
    vital::poly_float value = window * Osc::interpolate(buffer, adjusted_phase);
    for (int v = 0; v < vital::poly_float::kSize; ++v)
      time_domain[i + v] = value[v];
  }

  // toFrequencyDomain overwrites the frame's spectrum, not its time domain.
  display->frame.toFrequencyDomain();
  for (int k = 0; k < size / 2; ++k)
    display->spectrum[k] = std::abs(display->frame.frequency_domain[k]);
}

EXPORT const float* vs_display_wave() { return display ? display->frame.time_domain : nullptr; }
EXPORT const float* vs_display_spectrum() { return display ? display->spectrum : nullptr; }

// Every display frame of oscillator `oscillator`'s table (kNumOscillatorWaveFrames = 257, as
// Wavetable3d::paint3dBackground draws them: getBuffer clamps, so a shorter table repeats its last
// frame), raw (no morph or warp), `points` samples each (every kWaveformSize / points-th; Vital's
// background uses kBackgroundResolution = 128). Returns the frame count.
EXPORT int vs_wavetable_frames(int oscillator, int points, float* out) {
  vital::Wavetable* wavetable = synth->engine->getWavetable(oscillator);
  int frames = vital::kNumOscillatorWaveFrames;
  int inc = vital::WaveFrame::kWaveformSize / points;
  for (int f = 0; f < frames; ++f) {
    const float* buffer = wavetable->getBuffer(f);
    for (int i = 0; i < points; ++i)
      out[f * points + i] = buffer[i * inc];
  }
  return frames;
}

// The filter display, computed as Vital's FilterResponse does it: the model's own filter class turns
// the settings into coefficients (setupFilter at a 200 kHz visual sample rate, loadShader), then the
// model's response shader (interface/look_and_feel/shaders.cpp), ported here, gives the level at each
// of kResolution = 512 points from MIDI note 8 to 137. Writes the shader's output (−1 … 1, −30 … 20 dB)
// to `out`. On the formant model pass formant transpose, resonance and spread as transpose,
// resonance and blend, as FilterResponse does. Drive isn't an input: Vital's display ignores it.
// `comb_period` is the comb shaders' alternating-sample period (3 for the filters, 2 for the flanger);
// `drive_override` > 0 replaces the model's drive (the flanger uses 1). The points run from x = `x_min` to
// `x_max` in the shader's −1 … 1 frequency space (the filters use −1 … 1; the flanger −4 … 2, three widths).
namespace {
  using cfloat = std::complex<float>;
  constexpr int kResponsePoints = 512;
  constexpr float kMinMidiNote = 8.0f, kMaxMidiNote = 137.0f, kMinDb = -30.0f, kMaxDb = 20.0f;
  constexpr float kResponsePi = 3.14159265359f;

  struct ResponseFilters {
    vital::SallenKeyFilter analog;
    vital::CombFilter comb { 1 };
    vital::DigitalSvf digital;
    vital::DiodeFilter diode;
    vital::DirtyFilter dirty;
    vital::FormantFilter formant;
    vital::LadderFilter ladder;
    vital::PhaserFilter phaser { false };
    ResponseFilters() {
      const int rate = 200000; // FilterResponse::kDefaultVisualSampleRate
      analog.setSampleRate(rate); comb.setSampleRate(rate); digital.setSampleRate(rate); diode.setSampleRate(rate);
      dirty.setSampleRate(rate); formant.setSampleRate(rate); ladder.setSampleRate(rate); phaser.setSampleRate(rate);
    }
  };
  ResponseFilters* response_filters = nullptr;

  cfloat onePole(float cutoff) { return 1.0f / cfloat(1.0f, cutoff); }
  float cutoffRatio(float x, float midi_cutoff) {
    float midi_note = kMinMidiNote + 0.5f * (x + 1.0f) * (kMaxMidiNote - kMinMidiNote);
    return std::pow(2.0f, std::min((midi_note - midi_cutoff) / 12.0f, 8.0f));
  }
  float yForResponse(cfloat response) {
    float db = 8.685889638065037f * std::log(std::abs(response));
    return 2.0f * (db - kMinDb) / (kMaxDb - kMinDb) - 1.0f;
  }
  float step(float edge, float x) { return x < edge ? 0.0f : 1.0f; }
  float lengthOf(cfloat c) { return std::abs(c); }

  struct Uniforms { float midi_cutoff = 0, resonance = 0, drive = 1, mix = 1, db24 = 0, stage[5] = { 0, 0, 0, 0, 0 }; };
}

EXPORT void vs_filter_response(int model, int style, float cutoff, float resonance, float blend, float transpose,
                               float formant_x, float formant_y, float mix, int comb_period, float drive_override,
                               float x_min, float x_max, float* out) {
  if (response_filters == nullptr)
    response_filters = new ResponseFilters();
  ResponseFilters& f = *response_filters;

  vital::SynthFilter::FilterState state;
  state.midi_cutoff = std::max(cutoff, 0.0f);
  state.resonance_percent = resonance;
  state.pass_blend = vital::utils::clamp(blend, 0.0f, 2.0f);
  state.transpose = transpose;
  state.interpolate_x = formant_x;
  state.interpolate_y = formant_y;
  state.style = style;

  Uniforms u;
  u.midi_cutoff = state.midi_cutoff[0];
  u.mix = vital::utils::clamp(mix, 0.0f, 1.0f);
  float formant_cutoff[4] = {}, formant_resonance[4] = {}, low[4] = {}, band[4] = {}, high[4] = {};
  auto db24 = [&]() { return style != vital::SynthFilter::k12Db ? 1.0f : 0.0f; };

  switch (model) {
    case vital::constants::kAnalog:
      f.analog.setupFilter(state);
      u.resonance = vital::utils::clamp(f.analog.getResonance()[0], 0.0f, 2.0f);
      u.drive = f.analog.getDrive()[0]; u.db24 = db24();
      u.stage[0] = f.analog.getLowAmount()[0]; u.stage[1] = f.analog.getBandAmount()[0]; u.stage[2] = f.analog.getHighAmount()[0];
      u.stage[3] = f.analog.getLowAmount24(style)[0]; u.stage[4] = f.analog.getHighAmount24(style)[0];
      break;
    case vital::constants::kComb:
      f.comb.setupFilter(state);
      u.resonance = vital::utils::clamp(f.comb.getResonance()[0], -0.99f, 0.99f);
      u.drive = f.comb.getDrive()[0];
      u.stage[0] = f.comb.getLowAmount()[0]; u.stage[1] = f.comb.getHighAmount()[0];
      u.stage[2] = f.comb.getFilterMidiCutoff()[0]; u.stage[3] = f.comb.getFilter2MidiCutoff()[0];
      break;
    case vital::constants::kDigital:
      f.digital.setupFilter(state);
      u.midi_cutoff = f.digital.getMidiCutoff()[0];
      u.resonance = vital::utils::clamp(f.digital.getResonance()[0], 0.0f, 2.0f);
      u.drive = f.digital.getDrive()[0]; u.db24 = db24();
      u.stage[0] = f.digital.getLowAmount()[0]; u.stage[1] = f.digital.getBandAmount()[0]; u.stage[2] = f.digital.getHighAmount()[0];
      u.stage[3] = f.digital.getLowAmount24(style)[0]; u.stage[4] = f.digital.getHighAmount24(style)[0];
      break;
    case vital::constants::kDiode:
      f.diode.setupFilter(state);
      u.resonance = f.diode.getResonance()[0]; u.drive = f.diode.getDrive()[0];
      u.db24 = f.diode.getHighPassAmount()[0]; u.stage[0] = f.diode.getHighPassRatio()[0];
      break;
    case vital::constants::kDirty:
      f.dirty.setupFilter(state);
      u.resonance = vital::utils::clamp(f.dirty.getResonance()[0], 0.0f, 2.0f);
      u.drive = f.dirty.getDrive()[0]; u.db24 = db24();
      u.stage[0] = f.dirty.getLowAmount()[0]; u.stage[1] = f.dirty.getBandAmount()[0]; u.stage[2] = f.dirty.getHighAmount()[0];
      u.stage[3] = f.dirty.getLowAmount24(style)[0]; u.stage[4] = f.dirty.getHighAmount24(style)[0];
      break;
    case vital::constants::kFormant:
      f.formant.setupFilter(state);
      for (int i = 0; i < 4; ++i) {
        vital::DigitalSvf* formant = f.formant.getFormant(i);
        float drive = formant->getDrive()[0];
        formant_cutoff[i] = formant->getMidiCutoff()[0];
        formant_resonance[i] = formant->getResonance()[0];
        low[i] = formant->getLowAmount()[0] * drive;
        band[i] = formant->getBandAmount()[0] * drive;
        high[i] = formant->getHighAmount()[0] * drive;
      }
      break;
    case vital::constants::kLadder:
      f.ladder.setupFilter(state);
      u.resonance = f.ladder.getResonance()[0]; u.drive = f.ladder.getDrive()[0];
      for (int s = 0; s < 5; ++s)
        u.stage[s] = f.ladder.getStageScale(s)[0];
      break;
    case vital::constants::kPhase:
      f.phaser.setupFilter(state);
      u.resonance = f.phaser.getResonance()[0]; u.db24 = db24();
      u.stage[0] = f.phaser.getPeak1Amount()[0]; u.stage[1] = f.phaser.getPeak3Amount()[0]; u.stage[2] = f.phaser.getPeak5Amount()[0];
      break;
  }

  // The flanger display drives its comb shader at 1 instead of the filter's drive (FlangerResponse::loadShader).
  if (drive_override > 0.0f)
    u.drive = drive_override;
  const cfloat one(1.0f, 0.0f);
  auto finish = [&](cfloat response) { return yForResponse(u.mix * response + cfloat(1.0f - u.mix, 0.0f)); };
  vital::CombFilter::FeedbackStyle comb_style = vital::CombFilter::getFeedbackStyle(style);

  for (int i = 0; i < kResponsePoints; ++i) {
    float x = x_min + (x_max - x_min) * i / (kResponsePoints - 1.0f);
    float position_y = static_cast<float>((i / std::max(1, comb_period)) % 2); // kCombAlternatePeriod
    float* st = u.stage;
    cfloat response;

    if (model == vital::constants::kAnalog || model == vital::constants::kDirty) {
      cfloat one_pole = onePole(cutoffRatio(x, u.midi_cutoff));
      cfloat low_c = one_pole * one_pole;
      cfloat band_c = one_pole - low_c;
      cfloat high_c = one - one_pole - band_c;
      cfloat two_stage_pre = st[3] * low_c + st[1] * band_c + st[4] * high_c;
      cfloat two_stage = st[0] * low_c + st[1] * band_c + st[2] * high_c;
      cfloat feedback = one_pole * (one - one_pole);
      cfloat response_pre = two_stage_pre / (one - feedback);
      cfloat r;
      if (model == vital::constants::kAnalog)
        r = u.drive * (two_stage / (one - u.resonance * feedback));
      else {
        cfloat resonance_loop = band_c / (cfloat(1.0f / u.resonance, 0.0f) - feedback);
        r = u.drive * (two_stage * (one + resonance_loop));
      }
      response = r + u.db24 * (response_pre * r - r);
    }
    else if (model == vital::constants::kComb && comb_style == vital::CombFilter::kComb) {
      float ratio = cutoffRatio(x, u.midi_cutoff);
      float ratio_diff = cutoffRatio(x + 0.02f, u.midi_cutoff) - ratio;
      float max_step = step(6.0f, ratio);
      cfloat tick = u.resonance * cfloat(std::cos(2.0f * kResponsePi * ratio), -std::sin(2.0f * kResponsePi * ratio));
      cfloat low_pass = onePole(cutoffRatio(x, st[2]));
      cfloat one_pole = st[0] * low_pass + st[1] * (one - low_pass);
      cfloat high_pass2 = one - onePole(cutoffRatio(x, st[3]));
      cfloat filter_input = cfloat(1.0f - 0.5f * std::abs(u.resonance), 0.0f) * one_pole * high_pass2;
      cfloat denominator = one - tick * one_pole * high_pass2;
      float round_value = (one_pole * high_pass2).real() * std::abs(u.resonance);
      cfloat round_d(1.0f - round_value, 0.0f), round_down(1.0f + round_value, 0.0f);
      float mult = 1.0f - position_y;
      denominator = max_step * (mult * round_d + (1.0f - mult) * round_down) + (1.0f - max_step) * denominator;
      float round_step = 1.0f - std::max(max_step, step(ratio_diff, lengthOf(denominator)));
      denominator = round_step * round_d + (1.0f - round_step) * denominator;
      response = (u.drive * filter_input) / denominator;
    }
    else if (model == vital::constants::kComb) {
      bool positive = comb_style == vital::CombFilter::kPositiveFlange;
      float ratio = cutoffRatio(x, positive ? u.midi_cutoff : u.midi_cutoff + 12.0f);
      float ratio_diff = cutoffRatio(x + 0.02f, u.midi_cutoff) - ratio;
      float max_step = step(8.0f, ratio);
      cfloat delay(std::cos(2.0f * kResponsePi * ratio), -std::sin(2.0f * kResponsePi * ratio));
      cfloat tick = (positive ? u.resonance : -u.resonance) * delay;
      cfloat low_pass = onePole(cutoffRatio(x, st[2]));
      cfloat one_pole = st[0] * low_pass + st[1] * (one - low_pass);
      cfloat high_pass2 = one - onePole(cutoffRatio(x, st[3]));
      cfloat filter_input(0.70710678119f, 0.0f);
      cfloat delay_input = filter_input * one_pole * high_pass2;
      cfloat denominator = positive ? one - tick : one - tick * (one_pole * high_pass2);
      cfloat round_value = (positive ? 1.0f : -1.0f) * (one_pole * high_pass2) * u.resonance;
      cfloat round_d = delay * (one - round_value), round_down = -delay * (one + round_value);
      float mult = 1.0f - position_y;
      denominator = max_step * (mult * round_d + (1.0f - mult) * round_down) + (1.0f - max_step) * denominator;
      if (positive) {
        float round_step = 1.0f - std::max(max_step, step(ratio_diff, lengthOf(denominator)));
        denominator = round_step * round_d + (1.0f - round_step) * denominator;
        response = filter_input * u.drive + (delay_input / denominator) * delay;
      }
      else
        response = filter_input * u.drive - (delay_input / denominator) * delay;
    }
    else if (model == vital::constants::kDigital) {
      float g = cutoffRatio(x, u.midi_cutoff);
      cfloat g2(g * g, 0.0f);
      cfloat denominator = g2 + cfloat(0.0f, g * u.resonance) + cfloat(-1.0f, 0.0f);
      cfloat numerator = -st[0] * one + st[1] * cfloat(0.0f, g) + st[2] * g2;
      cfloat numerator_pre = -st[3] * one + st[1] * cfloat(0.0f, g) + st[4] * g2;
      cfloat r = numerator / denominator;
      cfloat pre = numerator_pre / (g2 + cfloat(0.0f, g) + cfloat(-1.0f, 0.0f));
      r = r + u.db24 * (r * pre - r);
      response = r * u.drive;
    }
    else if (model == vital::constants::kDiode) {
      float ratio = cutoffRatio(x, u.midi_cutoff);
      cfloat one_pole = onePole(ratio);
      cfloat hp = onePole(ratio / st[0]);
      cfloat high_c = one - hp * 2.0f + hp * hp;
      cfloat high_response = high_c / (one - hp * (one - hp));
      high_response = one + u.db24 * (high_response - one);
      cfloat loop = one_pole * one_pole;
      cfloat series = 0.125f * (loop * loop);
      cfloat chain = series / (one + series - loop);
      cfloat r = (u.drive * chain) / (one + u.resonance * chain);
      out[i] = yForResponse((u.mix * r + cfloat(1.0f - u.mix, 0.0f)) * high_response);
      continue;
    }
    else if (model == vital::constants::kFormant) {
      response = 0.0f;
      for (int k = 0; k < 4; ++k) {
        float g = cutoffRatio(x, formant_cutoff[k]);
        cfloat g_sqr(g * g, 0.0f);
        cfloat denominator = g_sqr + cfloat(0.0f, g * formant_resonance[k]) + cfloat(-1.0f, 0.0f);
        cfloat numerator = -low[k] * one + band[k] * cfloat(0.0f, g) + high[k] * g_sqr;
        response += numerator / denominator;
      }
    }
    else if (model == vital::constants::kLadder) {
      cfloat inv1(1.0f, cutoffRatio(x, u.midi_cutoff));
      cfloat inv2 = inv1 * inv1, inv3 = inv1 * inv2, inv4 = inv1 * inv3;
      cfloat numerator = u.drive * (st[0] * inv4 + st[1] * inv3 + st[2] * inv2 + st[3] * inv1 + cfloat(st[4], 0.0f));
      response = numerator / (inv4 + cfloat(u.resonance, 0.0f));
    }
    else if (model == vital::constants::kPhase) {
      float g = cutoffRatio(x, u.midi_cutoff);
      cfloat all_pass = one - 2.0f * onePole(g);
      cfloat half_peak = all_pass * all_pass;
      cfloat peak1 = half_peak * half_peak, peak3 = peak1 * peak1, peak5 = peak3 * peak1;
      cfloat chain = st[0] * peak1 + st[1] * peak3 + st[2] * peak5;
      float invert_mult = 1.0f - 2.0f * u.db24;
      cfloat feedback_chain = chain * onePole(0.05f * g) * (one - onePole(20.0f * g));
      cfloat phase_response = chain / (one - invert_mult * u.resonance * feedback_chain);
      response = cfloat(0.5f, 0.0f) + 0.5f * invert_mult * phase_response;
    }
    out[i] = finish(response);
  }
}

// The equalizer display (EqualizerResponse::computeFilterCoefficients + kEqFilterResponseVertexShader):
// three DigitalSvf filters at 100 kHz — low (shelf, or 12 dB high-pass when `high_pass`), band (shelf,
// or notch when `notch`), high (shelf, or 12 dB low-pass when `low_pass`) — multiplied, at kResolution
// = 128 points from MIDI note 8 to 136. Writes dB to `out`. The reverb's display is the same with the
// band's values at 0.
EXPORT void vs_eq_response(float low_cutoff, float low_resonance, float low_gain, int high_pass,
                           float band_cutoff, float band_resonance, float band_gain, int notch,
                           float high_cutoff, float high_resonance, float high_gain, int low_pass, float* out) {
  static vital::DigitalSvf* filters = nullptr;
  if (filters == nullptr) {
    filters = new vital::DigitalSvf[3];
    for (int i = 0; i < 3; ++i)
      filters[i].setSampleRate(100000);
  }
  vital::SynthFilter::FilterState low, band, high;
  low.midi_cutoff = low_cutoff; low.resonance_percent = low_resonance; low.gain = low_gain;
  low.style = high_pass ? vital::DigitalSvf::k12Db : vital::DigitalSvf::kShelving;
  low.pass_blend = high_pass ? 2.0f : 0.0f;
  band.midi_cutoff = band_cutoff; band.resonance_percent = band_resonance; band.gain = band_gain;
  band.pass_blend = 1.0f;
  band.style = notch ? vital::DigitalSvf::kNotchPassSwap : vital::DigitalSvf::kShelving;
  high.midi_cutoff = high_cutoff; high.resonance_percent = high_resonance; high.gain = high_gain;
  high.style = low_pass ? vital::DigitalSvf::k12Db : vital::DigitalSvf::kShelving;
  high.pass_blend = low_pass ? 0.0f : 2.0f;
  filters[0].setupFilter(low);
  filters[1].setupFilter(band);
  filters[2].setupFilter(high);

  const cfloat one(1.0f, 0.0f);
  constexpr int kPoints = 128;
  for (int i = 0; i < kPoints; ++i) {
    float x = 2.0f * i / (kPoints - 1.0f) - 1.0f;
    cfloat numerator = one, denominator = one;
    for (int k = 0; k < 3; ++k) {
      float midi_note = 8.0f + 0.5f * (x + 1.0f) * (136.0f - 8.0f);
      float g = std::pow(2.0f, std::min((midi_note - filters[k].getMidiCutoff()[0]) / 12.0f, 8.0f));
      cfloat g_sqr(g * g, 0.0f);
      denominator *= g_sqr + cfloat(0.0f, g * filters[k].getResonance()[0]) + cfloat(-1.0f, 0.0f);
      numerator *= -filters[k].getLowAmount()[0] * one + filters[k].getBandAmount()[0] * cfloat(0.0f, g) +
                   filters[k].getHighAmount()[0] * g_sqr;
    }
    out[i] = 8.685889638065037f * std::log(std::abs(numerator / denominator));
  }
}

// The distortion's transfer curve (distortion_section.cpp DistortionViewer): Distortion::getDrivenValue
// over inputs −1…1 at Distortion::getDriveValue(type, drive), × kDrawPercent 0.9. Writes `points` values.
EXPORT void vs_distortion_curve(int type, float drive, int points, float* out) {
  vital::poly_float driven = vital::Distortion::getDriveValue(type, drive);
  for (int i = 0; i < points; ++i) {
    float t = i / (points - 1.0f);
    out[i] = 0.9f * vital::Distortion::getDrivenValue(type, 2.0f * t - 1.0f, driven)[0];
  }
}

// The distortion's filter display (DistortionFilterResponse): a DigitalSvf at 200 kHz drawn with the
// digital response shader, cutoff held just above `min_cutoff`, mix 1; 256 points (−1…1 = −30…20 dB).
EXPORT void vs_distortion_filter_response(float cutoff, float resonance, float blend, float min_cutoff, float* out) {
  static vital::DigitalSvf* filter = nullptr;
  if (filter == nullptr) {
    filter = new vital::DigitalSvf();
    filter->setSampleRate(200000);
  }
  vital::SynthFilter::FilterState state;
  state.midi_cutoff = cutoff;
  state.resonance_percent = resonance;
  state.pass_blend = blend;
  filter->setupFilter(state);
  float midi_cutoff = std::max(min_cutoff + 0.001f, cutoff);
  float res = vital::utils::clamp(filter->getResonance()[0], 0.0f, 2.0f);
  float drive = filter->getDrive()[0];
  float st[5] = { filter->getLowAmount()[0], filter->getBandAmount()[0], filter->getHighAmount()[0],
                  filter->getLowAmount24(0)[0], filter->getHighAmount24(0)[0] };
  const int points = 256;
  for (int i = 0; i < points; ++i) {
    float x = 2.0f * i / (points - 1.0f) - 1.0f;
    float g = cutoffRatio(x, midi_cutoff);
    cfloat g2(g * g, 0.0f);
    cfloat denominator = g2 + cfloat(0.0f, g * res) + cfloat(-1.0f, 0.0f);
    cfloat numerator = -st[0] + st[1] * cfloat(0.0f, g) + st[2] * g2;
    cfloat r = (numerator / denominator) * drive;
    out[i] = yForResponse(r);
  }
}

// The engine's oscillator wavetables and sample, for glue/table_port.cpp (the worker ↔ worklet hand-over).
vital::Wavetable* vsWavetable(int oscillator) {
  if (synth == nullptr || oscillator < 0 || oscillator >= vital::kNumOscillators)
    return nullptr;
  return synth->engine->getWavetable(oscillator);
}

vital::Sample* vsSample() {
  return synth ? synth->engine->getSample() : nullptr;
}
