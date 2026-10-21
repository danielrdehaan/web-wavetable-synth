// Loads a preset file natively and renders a note (for debugging presets with sanitizers).
#include <cstdio>
#include <fstream>
#include <sstream>
extern "C" { void vs_init(int); int vs_load_preset(const char*); void vs_note_on(int, float); void vs_process(int); float* vs_left(); }
int main(int argc, char** argv) {
  std::ifstream f(argv[1]); std::stringstream ss; ss << f.rdbuf();
  vs_init(44100);
  int ok = vs_load_preset(ss.str().c_str());
  vs_note_on(48, 0.7f);
  float peak = 0;
  for (int b = 0; b < 44100 / 64; ++b) { vs_process(64); for (int i = 0; i < 64; ++i) peak = std::max(peak, std::abs(vs_left()[i])); }
  std::printf("loaded %d peak %.3f\n", ok, peak);
}
