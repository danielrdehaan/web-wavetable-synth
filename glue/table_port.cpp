// Handing finished wavetables and samples from the table worker's engine to the audio worklet's, so
// the audio thread never renders a table or band-limits a sample. The worker's instance exports a
// table's frames (Wavetable::WavetableData: samples, amplitudes, normalized frequencies, phases) or a
// sample's buffers (Sample::SampleData: the upsampled, original and halved copies, each with its loop
// copy); the worklet's instance stages an empty copy of that shape, fills it in slices between audio
// blocks, then commits it with a pointer swap, as Wavetable::setNumFrames and Sample::loadSample do.
#define protected public
#include "wavetable.h"
#include "sample_source.h"
#undef protected
#include "synth_constants.h"

#include <cstdint>
#include <cstring>
#include <memory>
#include <string>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT extern "C"
#endif

vital::Wavetable* vsWavetable(int oscillator);
vital::Sample* vsSample();

namespace {
  using vital::Wavetable;
  using vital::Sample;
  constexpr int kWaveFloats = Wavetable::kWaveformSize;
  constexpr int kFrequencyFloats = Wavetable::kPolyFrequencySize * vital::poly_float::kSize;

  // Without the zeroing make_unique does: every value is written before the commit.
  std::unique_ptr<Wavetable::WavetableData> newTableData(int frames, int version) {
    auto data = std::make_unique<Wavetable::WavetableData>(frames, version);
    data->wave_data.reset(new vital::mono_float[frames][kWaveFloats]);
    data->frequency_amplitudes.reset(new vital::poly_float[frames][Wavetable::kPolyFrequencySize]);
    data->normalized_frequencies.reset(new vital::poly_float[frames][Wavetable::kPolyFrequencySize]);
    data->phases.reset(new vital::poly_float[frames][Wavetable::kPolyFrequencySize]);
    return data;
  }

  void tablePointers(Wavetable::WavetableData* data, uint32_t* out) {
    out[0] = reinterpret_cast<uintptr_t>(data->wave_data.get());
    out[1] = reinterpret_cast<uintptr_t>(data->frequency_amplitudes.get());
    out[2] = reinterpret_cast<uintptr_t>(data->normalized_frequencies.get());
    out[3] = reinterpret_cast<uintptr_t>(data->phases.get());
  }

  std::unique_ptr<Wavetable::WavetableData> staged_tables[3];

  // createBandLimitedBuffers' sizes: kUpsampleTimes doublings, the original, then halvings while at
  // least kMinSize, each with kBufferSamples of padding either side.
  int sampleSizes(int length, int* sizes) {
    int n = 0;
    for (int i = Sample::kUpsampleTimes; i > 0; --i)
      sizes[n++] = length * (1 << i) + 2 * Sample::kBufferSamples;
    sizes[n++] = length + 2 * Sample::kBufferSamples;
    for (int size = length; size >= Sample::kMinSize; ) {
      size = (size + 1) / 2;
      sizes[n++] = size + 2 * Sample::kBufferSamples;
    }
    return n;
  }

  std::unique_ptr<Sample::SampleData> staged_sample;
}

// ── The worker's side: what a table or sample is made of ──

// The oscillator's table: writes the four arrays' addresses (each frames × its row length, rows of
// 2048 samples then 2056 floats for the three spectra) and returns the frame count.
EXPORT int vs_table_export(int oscillator, uint32_t* pointers) {
  Wavetable* table = vsWavetable(oscillator);
  if (table == nullptr)
    return 0;
  Wavetable::WavetableData* data = table->current_data_;
  tablePointers(data, pointers);
  return data->num_frames;
}

EXPORT float vs_table_frequency_ratio(int oscillator) { return vsWavetable(oscillator)->current_data_->frequency_ratio; }
EXPORT float vs_table_sample_rate(int oscillator) { return vsWavetable(oscillator)->current_data_->sample_rate; }
EXPORT int vs_table_shepard(int oscillator) { return vsWavetable(oscillator)->isShepardTable() ? 1 : 0; }
EXPORT int vs_table_row_floats(int which) { return which == 0 ? kWaveFloats : kFrequencyFloats; }
EXPORT const char* vs_table_author(int oscillator) {
  static std::string author;
  author = vsWavetable(oscillator)->getAuthor();
  return author.c_str();
}

// The sample: writes each buffer's address and size in floats (left buffers, left loop buffers, then the
// right ones when stereo) and returns how many; its length, rate and stereo flag through the getters.
EXPORT int vs_sample_export(uint32_t* pointers, int* sizes) {
  Sample::SampleData* data = vsSample()->current_data_;
  int levels = sampleSizes(data->length, sizes);
  int n = 0;
  auto add = [&](std::vector<std::unique_ptr<vital::mono_float[]>>& buffers) {
    for (int i = 0; i < levels; ++i) {
      pointers[n] = reinterpret_cast<uintptr_t>(buffers[i].get());
      sizes[n] = sizes[i];
      n++;
    }
  };
  add(data->left_buffers);
  add(data->left_loop_buffers);
  if (data->stereo) {
    add(data->right_buffers);
    add(data->right_loop_buffers);
  }
  return n;
}

EXPORT int vs_sample_length() { return vsSample()->current_data_->length; }
EXPORT int vs_sample_rate() { return vsSample()->current_data_->sample_rate; }
EXPORT int vs_sample_stereo() { return vsSample()->current_data_->stereo ? 1 : 0; }

// ── The worklet's side: stage, fill, commit ──

// An empty table of `frames` frames for the oscillator; writes its arrays' addresses.
EXPORT int vs_table_stage(int oscillator, int frames, uint32_t* pointers) {
  if (vsWavetable(oscillator) == nullptr || frames < 1 || frames > vital::kNumOscillatorWaveFrames)
    return 0;
  staged_tables[oscillator] = newTableData(frames, 0);
  tablePointers(staged_tables[oscillator].get(), pointers);
  return 1;
}

// The staged table becomes the oscillator's (a new version, so the oscillator resets its buffers).
// Call between audio blocks.
EXPORT void vs_table_commit(int oscillator, float frequency_ratio, float sample_rate, int shepard,
                            const char* name, const char* author) {
  Wavetable* table = vsWavetable(oscillator);
  if (table == nullptr || !staged_tables[oscillator])
    return;
  std::unique_ptr<Wavetable::WavetableData> data = std::move(staged_tables[oscillator]);
  data->version = table->current_data_->version + 1;
  data->frequency_ratio = frequency_ratio;
  data->sample_rate = sample_rate;
  std::unique_ptr<Wavetable::WavetableData> old = std::move(table->data_);
  table->data_ = std::move(data);
  table->current_data_ = table->data_.get();
  table->setShepardTable(shepard != 0);
  table->setName(name);
  table->setAuthor(author);
}

EXPORT void vs_table_discard(int oscillator) {
  if (oscillator >= 0 && oscillator < 3)
    staged_tables[oscillator].reset();
}

// One frame written into the oscillator's current table in place (a drag in the wavetable editor
// renders only the frame at the playhead): `data` holds its 2048 samples then the three 2056-float
// spectra. Returns 0 when the table has no such frame.
EXPORT int vs_table_frame(int oscillator, int index, const float* data) {
  Wavetable* table = vsWavetable(oscillator);
  if (table == nullptr || index < 0 || index >= table->current_data_->num_frames)
    return 0;
  Wavetable::WavetableData* current = table->current_data_;
  std::memcpy(current->wave_data[index], data, kWaveFloats * sizeof(float));
  std::memcpy(current->frequency_amplitudes[index], data + kWaveFloats, kFrequencyFloats * sizeof(float));
  std::memcpy(current->normalized_frequencies[index], data + kWaveFloats + kFrequencyFloats, kFrequencyFloats * sizeof(float));
  std::memcpy(current->phases[index], data + kWaveFloats + 2 * kFrequencyFloats, kFrequencyFloats * sizeof(float));
  return 1;
}

// The worker's side of that: the frame's four rows, one after another, into `out`.
EXPORT int vs_table_frame_export(int oscillator, int index, float* out) {
  Wavetable* table = vsWavetable(oscillator);
  if (table == nullptr || index < 0 || index >= table->current_data_->num_frames)
    return 0;
  Wavetable::WavetableData* current = table->current_data_;
  std::memcpy(out, current->wave_data[index], kWaveFloats * sizeof(float));
  std::memcpy(out + kWaveFloats, current->frequency_amplitudes[index], kFrequencyFloats * sizeof(float));
  std::memcpy(out + kWaveFloats + kFrequencyFloats, current->normalized_frequencies[index], kFrequencyFloats * sizeof(float));
  std::memcpy(out + kWaveFloats + 2 * kFrequencyFloats, current->phases[index], kFrequencyFloats * sizeof(float));
  return 1;
}

EXPORT int vs_table_frames() { return vital::kNumOscillatorWaveFrames; }

// An empty sample of that shape; writes the buffers' addresses and sizes as vs_sample_export does.
EXPORT int vs_sample_stage(int length, int sample_rate, int stereo, uint32_t* pointers, int* sizes) {
  if (length < Sample::kMinSize)
    return 0;
  staged_sample = std::make_unique<Sample::SampleData>(length, sample_rate, stereo != 0);
  int levels = sampleSizes(length, sizes);
  int n = 0;
  auto add = [&](std::vector<std::unique_ptr<vital::mono_float[]>>& buffers) {
    for (int i = 0; i < levels; ++i) {
      buffers.emplace_back(new vital::mono_float[sizes[i]]);
      pointers[n] = reinterpret_cast<uintptr_t>(buffers.back().get());
      sizes[n] = sizes[i];
      n++;
    }
  };
  add(staged_sample->left_buffers);
  add(staged_sample->left_loop_buffers);
  if (stereo) {
    add(staged_sample->right_buffers);
    add(staged_sample->right_loop_buffers);
  }
  return n;
}

EXPORT void vs_sample_commit(const char* name) {
  Sample* sample = vsSample();
  if (sample == nullptr || !staged_sample)
    return;
  std::unique_ptr<Sample::SampleData> old = std::move(sample->data_);
  sample->data_ = std::move(staged_sample);
  sample->current_data_ = sample->data_.get();
  sample->setName(name);
}

EXPORT void vs_sample_discard() { staged_sample.reset(); }
