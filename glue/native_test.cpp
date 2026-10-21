// Renders a C3 note for 2 s through the engine and reports peak/RMS, to prove the build makes sound.
#include <cmath>
#include <cstdio>
#include <cstring>
extern "C" { void vs_init(int); void vs_process(int); float* vs_left(); float* vs_right(); void vs_note_on(int, float);
  void vs_note_off(int); int vs_set_param(const char*, float); const char* vs_params_json(); int vs_connect(const char*, const char*); int vs_active_voices(); }
int main() {
  vs_init(48000);
  std::printf("params json bytes: %zu\n", std::strlen(vs_params_json()));
  int slot = vs_connect("lfo_1", "filter_1_cutoff");
  std::printf("lfo_1 -> filter_1_cutoff slot %d\n", slot);
  vs_set_param("filter_1_on", 1);
  vs_note_on(48, 0.8f);
  double sum = 0; float peak = 0; int n = 0;
  FILE* f = std::fopen("build/native/out.raw", "wb");
  for (int b = 0; b < 48000 * 2 / 128; ++b) {
    if (b == 48000 / 128) vs_note_off(48);
    vs_process(128);
    for (int i = 0; i < 128; ++i) { float x = vs_left()[i]; peak = std::fmax(peak, std::fabs(x)); sum += x * x; n++;
      float lr[2] = { x, vs_right()[i] }; std::fwrite(lr, 4, 2, f); }
  }
  std::fclose(f);
  std::printf("peak %.3f rms %.4f voices at end %d\n", peak, std::sqrt(sum / n), vs_active_voices());
}
