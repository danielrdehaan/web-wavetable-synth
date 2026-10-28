import { useEffect, useRef } from 'react'
import { onStatusPacket, statusLanes } from '../../engine/status'
import { anyBoost, boostLane, boostRange, decayBoosts, fillGradient } from './lineBoost'
import { useLineSkin } from './LineEditor'

// The sampler's waveform (sample_viewer.cpp): the sample's left channel in 256 bins, each bin's largest
// value drawn up from the centre line and mirrored below it, each half filled to the centre. It's drawn
// twice, Widget Primary / Secondary 2 and then 1 over it, and while a voice plays the sample the line
// widens and the fill brightens behind the playhead (sample_phase), the trail decaying faster the faster
// the playhead moves.

const RESOLUTION = 256 // SampleViewer::kResolution
const BOOST_DECAY = 0.9, SPEED_DECAY_MULT = 5 // kBoostDecay, kSpeedDecayMult
const PHASE_ENCODING = 0.9 // vital::utils::kPhaseEncodingMultiplier
const FRAMES_PER_PACKET = 2 // Vital redraws at 60 fps; the status arrives ~31 times a second
const PT = 1000 / 1440 // stage px per Vital point

export function SampleViewer({ peaks, on, style }: { peaks: Float32Array | null; on: boolean; style: React.CSSProperties }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  // The Sample section's skin: Widget Primary / Secondary 1 and 2 (and Disabled), Line Width, Line Boost,
  // Fill Boost (2.5 in the default skin's Sample override), Fill Fade.
  const skin = useLineSkin(canvas)
  const st = useRef({
    skin, peaks, on, lanes: [boostLane(RESOLUTION), boostLane(RESOLUTION)], lastPhase: [0, 0], lastVoice: [NaN, NaN], dirty: true,
  })
  st.current.skin = skin
  st.current.peaks = peaks
  st.current.on = on
  st.current.dirty = true

  // SampleViewer::render's playhead: per channel, a voice change restarts the trail at the new phase;
  // a moving playhead boosts the points it passed (ramping up from this frame's decay) while the boosts
  // decay by 1 − 5 × the distance moved (at least 0.9); no playhead, they decay by 0.9.
  useEffect(() => onStatusPacket(() => {
    const s = st.current
    const encoded = statusLanes('sample_phase')
    for (let lane = 0; lane < 2; lane++) {
      const raw = encoded?.[lane]
      const playing = raw !== undefined && Number.isFinite(raw) && raw !== 0
      const enc = playing ? raw : 0
      const modulo = enc - Math.floor(enc)
      const phase = modulo / PHASE_ENCODING, voice = enc - modulo
      if (voice !== s.lastVoice[lane]) s.lastPhase[lane] = Math.max(0, phase)
      if (playing) {
        const d = Math.max(BOOST_DECAY, Math.min(1, 1 - Math.abs(phase - s.lastPhase[lane]) * SPEED_DECAY_MULT))
        decayBoosts(s.lanes[lane], d ** FRAMES_PER_PACKET)
        boostRange(s.lanes[lane], s.lastPhase[lane], phase, 0, d)
      } else decayBoosts(s.lanes[lane], BOOST_DECAY ** FRAMES_PER_PACKET)
      s.lastPhase[lane] = phase
      s.lastVoice[lane] = voice
    }
    s.dirty = true
  }), [])

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const s = st.current, c = canvas.current
      if (!c || !s.dirty) return
      s.dirty = false
      const W = c.clientWidth, H = c.clientHeight
      const dpr = (window.devicePixelRatio || 1) * (c.getBoundingClientRect().width / W || 1)
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr) }
      const g = c.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      const p = s.peaks
      if (!p) return
      const center = H / 2
      const xs = Array.from({ length: RESOLUTION }, (_, i) => (W * i) / (RESOLUTION - 1))
      const SKIN = s.skin
      const lineW = SKIN.lineWidth * PT
      // One half (top: sign −1, bottom: +1) of one layer, its boosts from `lane`.
      const half = (sign: number, line: string, fill: string, b: Float32Array) => {
        const ys = Array.from(p, (m) => center + sign * m * center)
        const plain = fillGradient(g, fill, SKIN.fillFade, sign < 0 ? 0 : H, center)
        for (let i = 0; i < RESOLUTION - 1; i++) {
          const fb = (SKIN.fillBoost * (b[i] + b[i + 1])) / 2
          g.fillStyle = fb > 0.001 ? fillGradient(g, fill, SKIN.fillFade, sign < 0 ? 0 : H, center, fb) : plain
          g.beginPath(); g.moveTo(xs[i], ys[i]); g.lineTo(xs[i + 1], ys[i + 1]); g.lineTo(xs[i + 1], center); g.lineTo(xs[i], center); g.closePath(); g.fill()
        }
        g.strokeStyle = line; g.lineCap = 'round'; g.lineJoin = 'round'
        for (let i = 0; i < RESOLUTION - 1; i++) {
          g.lineWidth = lineW * (1 + SKIN.lineBoost * Math.max(b[i], b[i + 1]))
          g.beginPath(); g.moveTo(xs[i], ys[i]); g.lineTo(xs[i + 1], ys[i + 1]); g.stroke()
        }
      }
      // The right channel's layer (drawLines(false)), then the left's with its boosts once it has any.
      const right = s.lanes[1].boosts, left = anyBoost(s.lanes[0]) ? s.lanes[0].boosts : right
      for (const [layer, b] of [[1, right], [0, left]] as const) {
        const line = s.on ? (layer ? SKIN.primary2 : SKIN.primary1) : SKIN.primaryDisabled
        const fill = s.on ? (layer ? SKIN.secondary2 : SKIN.secondary1) : SKIN.secondaryDisabled
        half(-1, line, fill, b)
        half(1, line, fill, b)
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={canvas} style={{ position: 'absolute', ...style }} />
}
