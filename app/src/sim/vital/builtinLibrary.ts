import { registerBuiltins } from '../../engine/library'
import { builtInTable, lineToEngine } from '../../engine/shapes'
import { LINE_SHAPES, type Line } from './line'

// The Factory folder's files: shapes and tables this build makes in code (never Vital's own factory
// files). LFO shapes: LineGenerator's simple shapes plus a staircase; wavetables: the generated ones
// the oscillator menu offers.

const staircase: Line = {
  name: 'Staircase Down',
  pts: [[0, 1], [0.25, 1], [0.25, 0.6667], [0.5, 0.6667], [0.5, 0.3333], [0.75, 0.3333], [0.75, 0], [1, 0]],
  pw: [0, 0, 0, 0, 0, 0, 0, 0], smooth: false,
}
const lfoShapes = [...LINE_SHAPES.filter((l) => l.name !== 'Linear'), staircase].sort((a, b) => a.name.localeCompare(b.name))

registerBuiltins('lfo', lfoShapes.map((l) => ({ name: l.name, ext: 'vitallfo', make: () => JSON.stringify(lineToEngine(l)) })))
registerBuiltins('wavetable', ['Basic Shapes', 'Pulse', 'Sine'].map((name) => ({ name, ext: 'vitaltable', make: () => JSON.stringify(builtInTable(name, null)) })))
