// The effect chain order as Vital stores it: one number, the permutation's code (effect_chain_order,
// 0 … 9! − 1). A port of vital::utils::encodeOrderToFloat / decodeFloatToOrder (synthesis/framework/
// utils.cpp); order[i] is the effect (constants::Effect: chorus, compressor, delay, distortion, eq,
// filter, flanger, phaser, reverb) at chain position i.

export function encodeOrder(order: readonly number[]): number {
  let code = 0
  for (let i = 1; i < order.length; i++) {
    let index = 0
    for (let j = 0; j < i; j++) index += order[i] < order[j] ? 1 : 0
    code = code * (i + 1) + index
  }
  return code
}

export function decodeOrder(value: number, size = 9): number[] {
  let code = Math.trunc(value)
  const order = Array.from({ length: size }, (_, i) => i)
  for (let i = 0; i < size; i++) {
    const remaining = size - i
    const index = remaining - 1
    const inversions = code % remaining
    code = Math.floor(code / remaining)
    const placement = order[index - inversions]
    for (let j = index - inversions; j < index; j++) order[j] = order[j + 1]
    order[index] = placement
  }
  return order
}
