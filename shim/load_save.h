// The slice of Vital's LoadSave that the wavetable code calls (version compares and the
// PCM/float buffer conversions used when upgrading old presets). Same behaviour as
// src/common/load_save.cpp, without its file-system half.
#pragma once

#include "JuceHeader.h"
#include "json/json.h"
#include "utils.h"

using json = nlohmann::json;

class LoadSave {
 public:
  static int compareVersionStrings(std::string a, std::string b) {
    auto trim = [](std::string s) {
      size_t b0 = s.find_first_not_of(" \t\n\r"), e = s.find_last_not_of(" \t\n\r");
      return b0 == std::string::npos ? std::string() : s.substr(b0, e - b0 + 1);
    };
    a = trim(a);
    b = trim(b);
    if (a.empty() && b.empty())
      return 0;
    auto major = [](const std::string& s) {
      std::string m = s.substr(0, s.find('.'));
      if (m.empty() || m.find_first_not_of("0123456789") != std::string::npos)
        return 0;
      return std::atoi(m.c_str());
    };
    auto rest = [](const std::string& s) {
      size_t dot = s.find('.');
      return dot == std::string::npos ? std::string() : s.substr(dot + 1);
    };
    int ma = major(a), mb = major(b);
    if (ma > mb) return 1;
    if (ma < mb) return -1;
    return compareVersionStrings(rest(a), rest(b));
  }

  static void convertBufferToPcm(json& data, const std::string& field) {
    if (data.count(field) == 0)
      return;
    MemoryOutputStream decoded;
    std::string wave_data = data[field];
    Base64::convertFromBase64(decoded, wave_data);
    int size = static_cast<int>(decoded.getDataSize() / sizeof(float));
    std::unique_ptr<float[]> float_data = std::make_unique<float[]>(size);
    memcpy(float_data.get(), decoded.getData(), size * sizeof(float));
    std::unique_ptr<int16_t[]> pcm_data = std::make_unique<int16_t[]>(size);
    vital::utils::floatToPcmData(pcm_data.get(), float_data.get(), size);
    data[field] = Base64::toBase64(pcm_data.get(), sizeof(int16_t) * size).toStdString();
  }

  static void convertPcmToFloatBuffer(json& data, const std::string& field) {
    if (data.count(field) == 0)
      return;
    MemoryOutputStream decoded;
    std::string wave_data = data[field];
    Base64::convertFromBase64(decoded, wave_data);
    int size = static_cast<int>(decoded.getDataSize() / sizeof(int16_t));
    std::unique_ptr<int16_t[]> pcm_data = std::make_unique<int16_t[]>(size);
    memcpy(pcm_data.get(), decoded.getData(), size * sizeof(int16_t));
    std::unique_ptr<float[]> float_data = std::make_unique<float[]>(size);
    vital::utils::pcmToFloatData(float_data.get(), pcm_data.get(), size);
    data[field] = Base64::toBase64(float_data.get(), sizeof(float) * size).toStdString();
  }
};
