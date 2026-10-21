#!/usr/bin/env bash
# Builds Vital's synthesis engine + glue. Usage: ./build.sh native | ./build.sh wasm
set -e
cd "$(dirname "$0")"
S=vital-src/src
INC="-include line_generator.h -include operators.h -Ishim -I$S/interface/look_and_feel -Ivital-src/third_party $(find $S/synthesis $S/common -type d | sed 's/^/-I/' | tr '\n' ' ')"
SRCS="$S/unity_build/synthesis.cpp $S/common/synth_parameters.cpp $S/common/synth_types.cpp $S/common/line_generator.cpp $(ls $S/common/wavetable/*.cpp | tr '\n' ' ') glue/web_synth.cpp glue/tuning_port.cpp glue/table_port.cpp"
MODE=${1:-native}
OUT=build/$MODE; mkdir -p $OUT
if [ "$MODE" = native ]; then CXX=clang++; FLAGS="-std=c++17 -O2 -DNDEBUG -DHEADLESS=1"
else CXX=em++; FLAGS="-std=c++17 -w -O3 -DNDEBUG -DHEADLESS=1 -msse2 -msimd128 -fwasm-exceptions"; fi
OBJS=""
pids=()
for f in $SRCS; do
  o=$OUT/$(basename $f .cpp).o; OBJS="$OBJS $o"
  if [ ! -f $o ] || [ $f -nt $o ] || [ shim/JuceHeader.h -nt $o ]; then $CXX $FLAGS $INC -c $f -o $o & pids+=($!); fi
done
fail=0; for p in "${pids[@]}"; do wait $p || fail=1; done; [ $fail = 0 ]
if [ "$MODE" = native ]; then
  $CXX $FLAGS $INC glue/native_test.cpp $OBJS -framework Accelerate -o $OUT/native_test
else
  $CXX $FLAGS $OBJS -o web/engine.mjs \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node,shell -sSINGLE_FILE=1 -sALLOW_MEMORY_GROWTH=1 -sGROWABLE_ARRAYBUFFERS=0 -sMAXIMUM_MEMORY=1GB \
    -sINITIAL_MEMORY=192MB -sSTACK_SIZE=1MB -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToNewUTF8,HEAPF32,HEAPU32 \
    -sEXPORTED_FUNCTIONS=_malloc,_free -sFILESYSTEM=0
fi
echo built $MODE
