// Vital's Tuning (common/tuning.cpp) without JUCE's file and string classes: the same scale maths, and
// the Scala (.scl), keyboard map (.kbm) and .tun readers working on the file's text. The readers keep
// tuning.cpp's quirks (the first non-comment line of a Scala file is its description, a keyboard map
// reads its seven header values before its mapping, a .tun file reads [Tuning] / [Exact Tuning]).
#define private public
#include "tuning.h"
#undef private

#include <cctype>
#include <cmath>
#include <cstdlib>
#include <sstream>
#include <string>
#include <vector>

#include "utils.h"

namespace {
  constexpr int kDefaultMidiReference = 60;
  constexpr char kScalaKbmComment = '!';
  constexpr char kTunComment = ';';

  std::string trim(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) a++;
    while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) b--;
    return s.substr(a, b - a);
  }

  std::string lower(std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
  }

  // StringArray::addTokens(source, false)[0]: the first whitespace-separated token.
  std::string firstToken(const std::string& s) {
    std::istringstream in(s);
    std::string token;
    in >> token;
    return token;
  }

  int intValue(const std::string& s) { return std::atoi(s.c_str()); }
  float floatValue(const std::string& s) { return std::strtof(s.c_str(), nullptr); }

  float readCentsToTranspose(const std::string& cents) { return floatValue(cents) / vital::kCentsPerNote; }

  float readRatioToTranspose(const std::string& ratio) {
    size_t slash = ratio.find('/');
    float value = intValue(ratio.substr(0, slash));
    if (slash != std::string::npos && ratio.find('/', slash + 1) == std::string::npos)
      value /= intValue(ratio.substr(slash + 1));
    return vital::utils::ratioToMidiTranspose(value);
  }

  std::string beforeEquals(const std::string& line) { return line.substr(0, line.find('=')); }
  std::string afterLastEquals(const std::string& line) {
    size_t at = line.rfind('=');
    return at == std::string::npos ? line : line.substr(at + 1);
  }

  bool isBaseFrequencyAssignment(const std::string& line) { return trim(lower(beforeEquals(line))) == "basefreq"; }

  int getNoteAssignmentIndex(const std::string& line) {
    std::istringstream in(beforeEquals(line));
    std::string a, b;
    in >> a >> b;
    if (b.empty() || lower(a) != "note")
      return -1;
    int index = intValue(b);
    if (index < 0 || index >= vital::kMidiSize)
      return -1;
    return index;
  }

  float getAssignmentValue(const std::string& line) { return floatValue(trim(afterLastEquals(line))); }
}

void loadScalaLines(Tuning& t, const std::vector<std::string>& lines) {
  enum { kDescription, kScaleLength, kScaleRatios } state = kDescription;
  int scale_length = 1;
  std::vector<float> scale;
  scale.push_back(0.0f);

  for (const std::string& line : lines) {
    std::string trimmed = trim(line);
    if (trimmed.size() > 0 && trimmed[0] == kScalaKbmComment)
      continue;
    if (scale.size() >= scale_length + 1)
      break;

    switch (state) {
      case kDescription:
        state = kScaleLength;
        break;
      case kScaleLength:
        scale_length = intValue(firstToken(trimmed));
        state = kScaleRatios;
        break;
      case kScaleRatios: {
        std::string tuning = firstToken(trimmed);
        if (tuning.find('.') != std::string::npos)
          scale.push_back(readCentsToTranspose(tuning));
        else
          scale.push_back(readRatioToTranspose(tuning));
        break;
      }
    }
  }

  t.keyboard_mapping_.clear();
  for (int i = 0; i < static_cast<int>(scale.size()) - 1; ++i)
    t.keyboard_mapping_.push_back(i);
  t.scale_start_midi_note_ = kDefaultMidiReference;
  t.reference_midi_note_ = 0;
  t.loadScale(scale);
  t.default_ = false;
}

void loadKeyboardMapLines(Tuning& t, const std::vector<std::string>& lines) {
  enum { kMapSize, kStartMidi, kEndMidi, kMiddle, kReferenceNote, kReferenceFrequency, kScaleDegree };
  constexpr int kHeaderSize = 7;
  float header[kHeaderSize] = {};
  int header_position = 0, map_size = 0, last_scale_value = 0;
  t.keyboard_mapping_.clear();

  for (const std::string& line : lines) {
    std::string trimmed = trim(line);
    if (trimmed.size() > 0 && trimmed[0] == kScalaKbmComment)
      continue;

    if (header_position >= kHeaderSize) {
      std::string token = firstToken(trimmed);
      if (lower(token)[0] != 'x')
        last_scale_value = intValue(token);
      t.keyboard_mapping_.push_back(last_scale_value);
      if (static_cast<int>(t.keyboard_mapping_.size()) >= map_size)
        break;
    }
    else {
      header[header_position] = floatValue(firstToken(trimmed));
      if (header_position == kMapSize)
        map_size = header[header_position];
      header_position++;
    }
  }

  t.setStartMidiNote(header[kMiddle]);
  t.setReferenceNoteFrequency(header[kReferenceNote], header[kReferenceFrequency]);
  t.loadScale(t.scale_);
  t.default_ = false;
}

void loadTunLines(Tuning& t, const std::vector<std::string>& lines) {
  enum { kScanning, kTuning, kExactTuning } state = kScanning;
  t.keyboard_mapping_.clear();
  int last_read_note = 0;
  float base_frequency = vital::kMidi0Frequency;
  std::vector<float> scale;
  for (int i = 0; i < vital::kMidiSize; ++i)
    scale.push_back(i);

  for (const std::string& line : lines) {
    std::string trimmed = trim(line);
    if (trimmed.size() == 0 || trimmed[0] == kTunComment)
      continue;

    if (trimmed[0] == '[') {
      std::string section = lower(trimmed.substr(1, trimmed.size() - 2));
      if (section == "tuning")
        state = kTuning;
      else if (section == "exact tuning")
        state = kExactTuning;
      else
        state = kScanning;
    }
    else if (state == kTuning || state == kExactTuning) {
      if (isBaseFrequencyAssignment(trimmed))
        base_frequency = getAssignmentValue(trimmed);
      else {
        int index = getNoteAssignmentIndex(trimmed);
        last_read_note = std::max(last_read_note, index);
        if (index >= 0)
          scale[index] = getAssignmentValue(trimmed) / vital::kCentsPerNote;
      }
    }
  }

  scale.resize(last_read_note + 1);
  t.loadScale(scale);
  t.setStartMidiNote(0);
  t.setReferenceFrequency(base_frequency);
  t.default_ = false;
}

Tuning::Tuning() : default_(true) {
  scale_start_midi_note_ = kDefaultMidiReference;
  reference_midi_note_ = 0;
  setDefaultTuning();
}

void Tuning::loadScale(std::vector<float> scale) {
  scale_ = scale;
  if (scale.size() <= 1) {
    setConstantTuning(kDefaultMidiReference);
    return;
  }

  int scale_size = static_cast<int>(scale.size() - 1);
  int mapping_size = scale_size;
  if (keyboard_mapping_.size())
    mapping_size = static_cast<int>(keyboard_mapping_.size());

  float octave_offset = scale[scale_size];
  int start_octave = -kTuningCenter / mapping_size - 1;
  int mapping_position = -kTuningCenter - start_octave * mapping_size;

  float current_offset = start_octave * octave_offset;
  for (int i = 0; i < kTuningSize; ++i) {
    if (mapping_position >= mapping_size) {
      current_offset += octave_offset;
      mapping_position = 0;
    }

    int note_in_scale = mapping_position;
    if (keyboard_mapping_.size())
      note_in_scale = keyboard_mapping_[mapping_position];

    tuning_[i] = current_offset + scale[note_in_scale];
    mapping_position++;
  }
}

void Tuning::setConstantTuning(float note) {
  for (int i = 0; i < kTuningSize; ++i)
    tuning_[i] = note;
}

void Tuning::setDefaultTuning() {
  for (int i = 0; i < kTuningSize; ++i)
    tuning_[i] = i - kTuningCenter;

  scale_.clear();
  for (int i = 0; i <= vital::kNotesPerOctave; ++i)
    scale_.push_back(i);

  keyboard_mapping_.clear();
  default_ = true;
  tuning_name_ = "";
  mapping_name_ = "";
}

vital::mono_float Tuning::convertMidiNote(int note) const {
  int scale_offset = note - scale_start_midi_note_;
  return tuning_[kTuningCenter + scale_offset] + scale_start_midi_note_ + reference_midi_note_;
}

void Tuning::setReferenceFrequency(float frequency) { setReferenceNoteFrequency(0, frequency); }

void Tuning::setReferenceNoteFrequency(int midi_note, float frequency) {
  reference_midi_note_ = vital::utils::frequencyToMidiNote(frequency) - midi_note;
}

void Tuning::setReferenceRatio(float ratio) { reference_midi_note_ = vital::utils::ratioToMidiTranspose(ratio); }

// The file readers' naming: a Scala or .tun file names the tuning, a keyboard map the mapping.
void nameTuningFile(Tuning& t, bool mapping, const std::string& name) {
  if (mapping)
    t.mapping_name_ = name;
  else
    t.tuning_name_ = name;
}
