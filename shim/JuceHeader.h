// Minimal stand-in for JUCE so Vital's DSP engine (src/synthesis + parts of src/common)
// compiles without the JUCE framework. Only what the engine and wavetable code touch.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <map>
#include <memory>
#include <random>
#include <string>
#include <vector>
#if defined(__SSE2__) && !defined(__EMSCRIPTEN__)
#include <xmmintrin.h>
#endif

#define JUCE_LEAK_DETECTOR(Class)
#define JUCE_DECLARE_NON_COPYABLE(Class) \
  Class(const Class&) = delete;          \
  Class& operator=(const Class&) = delete;
#define JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(Class) JUCE_DECLARE_NON_COPYABLE(Class)
#define jassert(x) ((void)0)
#define jassertfalse ((void)0)
#define JUCE_MODULE_AVAILABLE_juce_graphics 0
#define JUCE_MODULE_AVAILABLE_juce_dsp 0

class String {
 public:
  String() = default;
  String(const char* s) : s_(s ? s : "") {}
  String(const std::string& s) : s_(s) {}
  String(int v) : s_(std::to_string(v)) {}
  const std::string& toStdString() const { return s_; }
  bool isEmpty() const { return s_.empty(); }
  int length() const { return (int)s_.size(); }
  const char* toRawUTF8() const { return s_.c_str(); }
  operator std::string() const { return s_; }
  bool operator==(const String& o) const { return s_ == o.s_; }
  bool operator!=(const String& o) const { return s_ != o.s_; }
  String operator+(const String& o) const { return String(s_ + o.s_); }
  float getFloatValue() const { return std::strtof(s_.c_str(), nullptr); }
  int getIntValue() const { return std::atoi(s_.c_str()); }

 private:
  std::string s_;
};

class StringArray {
 public:
  std::vector<String> strings;
};

// File is only named in signatures the engine never calls; it carries no behaviour here.
class File {
 public:
  File() = default;
  bool exists() const { return false; }
  String getFileNameWithoutExtension() const { return {}; }
  String getFullPathName() const { return {}; }
};

class MemoryOutputStream {
 public:
  explicit MemoryOutputStream(size_t reserve = 256) { data_.reserve(reserve); }
  bool write(const void* data, size_t size) {
    const char* c = static_cast<const char*>(data);
    data_.insert(data_.end(), c, c + size);
    return true;
  }
  const void* getData() const { return data_.data(); }
  size_t getDataSize() const { return data_.size(); }
  void reset() { data_.clear(); }

 private:
  std::vector<char> data_;
};

struct Base64 {
  static String toBase64(const void* data, size_t size) {
    static const char* kChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const unsigned char* in = static_cast<const unsigned char*>(data);
    std::string out;
    out.reserve(((size + 2) / 3) * 4);
    for (size_t i = 0; i < size; i += 3) {
      uint32_t n = in[i] << 16;
      if (i + 1 < size) n |= in[i + 1] << 8;
      if (i + 2 < size) n |= in[i + 2];
      out += kChars[(n >> 18) & 63];
      out += kChars[(n >> 12) & 63];
      out += i + 1 < size ? kChars[(n >> 6) & 63] : '=';
      out += i + 2 < size ? kChars[n & 63] : '=';
    }
    return String(out);
  }

  static bool convertFromBase64(MemoryOutputStream& stream, const String& base64) {
    static int kTable[256];
    static bool init = false;
    if (!init) {
      std::fill(kTable, kTable + 256, -1);
      const char* chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      for (int i = 0; i < 64; ++i) kTable[(unsigned char)chars[i]] = i;
      init = true;
    }
    uint32_t buffer = 0;
    int bits = 0;
    for (unsigned char c : base64.toStdString()) {
      int v = kTable[c];
      if (v < 0) continue;
      buffer = (buffer << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        char byte = (char)((buffer >> bits) & 0xff);
        stream.write(&byte, 1);
      }
    }
    return true;
  }
};

class Random {
 public:
  Random() : engine_(std::random_device{}()) {}
  float nextFloat() { return std::uniform_real_distribution<float>(0.0f, 1.0f)(engine_); }
  int nextInt(int max) { return std::uniform_int_distribution<int>(0, max - 1)(engine_); }

 private:
  std::mt19937 engine_;
};

namespace ProjectInfo {
  const char* const projectName = "vital-web";
  // The engine source this build compiles (written into saved presets and wavetables).
  const char* const versionString = "1.0.6";
}

// WebAssembly has no flush-to-zero switch; natively this matches JUCE's x86 behaviour.
struct FloatVectorOperations {
  static void disableDenormalisedNumberSupport() {
#if defined(__SSE2__) && !defined(__EMSCRIPTEN__)
    _mm_setcsr(_mm_getcsr() | 0x8040);
#endif
  }
};
