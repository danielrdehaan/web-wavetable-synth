import { useEffect, useRef } from 'react'
import { liveValue, onStatusPacket, statusLanes } from '../../engine/status'
import { markDragEnd } from '../simContext'
import { Box } from './controls'
import { useVital } from './ctx'
import { powerCurve } from './draw'
import { useDrag } from './hooks'
import { mix, over, useLineSkin, withAlpha } from './LineEditor'
import { PARAMS } from './params'

// Vital's envelope editor (envelope_editor.cpp) on a canvas. The window shows a fixed span of time
// (4 s to start, 0.125–64 s) that grows only when a decay or release is dragged past its edge; the
// wheel zooms it, and the magnifier drags to zoom and double-clicks to fit the release. The ruler is
// base 4: big lines every 4^n / 2 s with labels, the sub lines and labels between them fading as the
// window zooms. The pointer always grabs the nearest handle: the attack peak, hold, decay/sustain and
// release points, the delay point when there's a delay, and each curve's power handle (drag up for
// more, 0.06 per pt; double-click resets). While the envelope runs, its modulated shape is drawn in the
// left / right colours with a glow trail behind the engine's playhead, which fades out after release.

const PT = 1440 / 2000 // Vital points per drawing unit
const MARKER_WIDTH = 9, RING_THICKNESS = 0.45, POWER_MARKER_WIDTH = 7, HOVER_RADIUS = 12, GRAB_RADIUS = 20
const TAIL_DECAY = 0.965, PADDING_X = 0.018, PADDING_Y = 0.06, MIN_POINT_DISTANCE_FOR_POWER = 3
const POWER_MOUSE_MULT = 0.06, TIME_DISPLAY_SIZE = 0.05, TIME_DISPLAY_BUFFER = 0.025, RULER_DIVISION = 4
const POINTS_PER_SECTION = 98, SECTIONS = 4, TOTAL_POINTS = SECTIONS * POINTS_PER_SECTION + 1
const MIN_WINDOW = 0.125, MAX_WINDOW = 64
// vital::VoiceEvent (kInvalid 0, kVoiceIdle 1 = the delay, then these): the envelope's phase output is
// the stage plus the progress through it. The delay stage has no playhead, as in Vital.
const VOICE_ON = 2, VOICE_HOLD = 3, VOICE_DECAY = 4, VOICE_OFF = 5, VOICE_KILL = 6
const PHASE_LENGTH = VOICE_KILL - VOICE_ON
const FRAMES_PER_PACKET = 2 // Vital redraws at 60 fps; the status arrives ~31 times a second

const formatTime = (time: number) => (time < 1 ? `${Math.trunc(time * 1000)}ms` : `${Math.trunc(time * 10) / 10}s`)

type Hover = 'delay' | 'attack' | 'hold' | 'sustain' | 'release' | 'attackPower' | 'decayPower' | 'releasePower' | null

export function EnvelopeEditor({ pre, at, running }: { pre: string; at: [number, number, number, number]; running: boolean }) {
  const api = useVital()
  const canvas = useRef<HTMLCanvasElement>(null)
  const skin = useLineSkin(canvas) // the Envelope section's
  const st = useRef({
    skin, api, pre, running, window: 4, hover: null as Hover, mouseDown: false, last: { x: 0, y: 0 }, began: false,
    boosts: [new Float32Array(TOTAL_POINTS), new Float32Array(TOTAL_POINTS)], lastPhase: [0, 0], alpha: [0, 0],
    animatedBefore: false, dirty: true,
  })
  st.current.skin = skin; st.current.api = api; st.current.pre = pre; st.current.running = running; st.current.dirty = true

  const size = () => {
    const c = canvas.current!
    const W = c.clientWidth, H = c.clientHeight
    return { W, H, k: W / ((at[2] - at[0]) * PT) }
  }
  // The slider values (SynthSlider::getAdjustedValue: the times are quartic) and their modulated totals.
  const slider = (k: string) => st.current.api.get(`${st.current.pre}_${k}`) ?? PARAMS[`${st.current.pre}_${k}`]?.def ?? 0
  const total = (k: string) => {
    if (!st.current.running) return slider(k)
    return liveValue(`${st.current.pre}_${k}`) ?? slider(k)
  }
  const time = (v: number) => Math.max(0, v) ** 4
  const fromTime = (k: string, t: number) => {
    const d = PARAMS[`${st.current.pre}_${k}`]
    return Math.max(d?.min ?? 0, Math.min(d?.max ?? 2.37842, Math.max(0, t) ** 0.25))
  }

  // The geometry of one line: index −1 is the controls' own values, 0 / 1 the modulated ones.
  const geometry = (index: number, W: number, H: number) => {
    const s = st.current
    const v = (k: string) => (index < 0 ? slider(k) : total(k))
    const xOf = (t: number) => (W * t) / s.window
    const delay = time(v('delay')), attack = time(v('attack')), hold = time(v('hold')), decay = time(v('decay')), release = time(v('release'))
    const delayX = xOf(delay), attackX = delayX + xOf(attack), holdX = attackX + xOf(hold), decayX = holdX + xOf(decay), releaseX = decayX + xOf(release)
    const sustainY = H * (1 - Math.max(0, Math.min(1, v('sustain'))))
    const ap = slider('attack_power'), dp = slider('decay_power'), rp = slider('release_power')
    const attackValue = (t: number) => H * powerCurve(1 - t, ap)
    const decayValue = (t: number) => sustainY * powerCurve(t, dp)
    const releaseValue = (t: number) => sustainY + (H - sustainY) * powerCurve(t, rp)
    return { delay, attack, hold, decay, release, delayX, attackX, holdX, decayX, releaseX, sustainY, attackValue, decayValue, releaseValue }
  }
  const padX = (x: number, W: number) => x * (1 - PADDING_X) + (PADDING_X * W) / 2
  const padY = (y: number, H: number) => y * (1 - PADDING_Y / 2) + (PADDING_Y * H) / 2
  const unpadX = (x: number, W: number) => (x - (PADDING_X * W) / 2) / (1 - PADDING_X)
  const unpadY = (y: number, H: number) => (y - (PADDING_Y * H) / 2) / (1 - PADDING_Y / 2)

  const set = (k: string, value: number) => {
    const s = st.current
    if (!s.began) { s.api.checkpoint(); s.began = true }
    s.api.set(`${s.pre}_${k}`, value)
  }

  // pickHoverPosition: the nearest candidate within the editor's height; ties take every match.
  const pick = (x: number, y: number) => {
    const { W, H, k } = size()
    const px = unpadX(x, W), py = unpadY(y, H)
    const g = geometry(-1, W, H)
    const minPower = MIN_POINT_DISTANCE_FOR_POWER * k
    const pts: Record<Exclude<Hover, null>, [number, number] | null> = {
      attack: [g.attackX, 0], sustain: [g.decayX, g.sustainY], release: [g.releaseX, H],
      delay: g.delayX > 0 ? [g.delayX, H] : null,
      hold: g.holdX > g.attackX ? [g.holdX, 0] : null,
      releasePower: g.releaseX - g.decayX > minPower && g.sustainY < H ? [(g.decayX + g.releaseX) / 2, g.releaseValue(0.5)] : null,
      decayPower: g.decayX - g.attackX > minPower && g.sustainY > 0 ? [(g.holdX + g.decayX) / 2, g.decayValue(0.5)] : null,
      attackPower: g.attackX - g.delayX > minPower ? [(g.delayX + g.attackX) / 2, g.attackValue(0.5)] : null,
    }
    let best = H * H
    for (const p of Object.values(pts)) if (p) best = Math.min(best, (p[0] - px) ** 2 + (p[1] - py) ** 2)
    const d = (p: [number, number] | null) => (p ? (p[0] - px) ** 2 + (p[1] - py) ** 2 : Infinity)
    // mouseDrag's order decides which of several tied handles moves.
    const order: Exclude<Hover, null>[] = ['delay', 'release', 'sustain', 'attack', 'hold', 'attackPower', 'decayPower', 'releasePower']
    const loose = new Set(['release', 'sustain', 'attack'])
    const hit = order.find((h) => (loose.has(h) ? d(pts[h]) <= best : d(pts[h]) === best)) ?? null
    if (hit !== st.current.hover) { st.current.hover = hit; st.current.dirty = true }
  }

  const local = (e: { clientX: number; clientY: number }) => {
    // The stage is CSS-scaled to fit: client pixels → the canvas's own layout pixels.
    const c = canvas.current!, r = c.getBoundingClientRect()
    return { x: (e.clientX - r.left) * (c.clientWidth / r.width), y: (e.clientY - r.top) * (c.clientHeight / r.height) }
  }
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    try { canvas.current!.setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
    st.current.mouseDown = true
    st.current.last = local(e)
    st.current.dirty = true
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = local(e)
    const s = st.current
    if (!s.mouseDown) { pick(x, y); return }
    const { W, H, k } = size()
    const deltaPower = ((s.last.y - y) / k) * POWER_MOUSE_MULT
    s.last = { x, y }
    const g = geometry(-1, W, H)
    const timeAt = (px: number) => (px * s.window) / W
    const grow = (px: number) => { s.window = Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, Math.max(s.window, timeAt(px)))) }
    const power = (key: string, value: number) => { const d = PARAMS[`${s.pre}_${key}`]; set(key, Math.max(d?.min ?? -20, Math.min(d?.max ?? 20, value))) }
    switch (s.hover) {
      case 'delay': set('delay', fromTime('delay', timeAt(x))); break
      case 'release': set('release', fromTime('release', timeAt(x - g.decayX))); grow(x); break
      case 'sustain':
        set('decay', fromTime('decay', timeAt(x - g.holdX))); grow(x)
        set('sustain', Math.max(0, Math.min(1, 1 - y / H)))
        break
      case 'attack': set('attack', fromTime('attack', timeAt(x - g.delayX))); break
      case 'hold': set('hold', fromTime('hold', timeAt(x - g.attackX))); break
      case 'attackPower': power('attack_power', slider('attack_power') + deltaPower); break
      case 'decayPower': power('decay_power', slider('decay_power') + deltaPower); break
      case 'releasePower': power('release_power', slider('release_power') + deltaPower); break
    }
    s.dirty = true
  }
  const onPointerUp = () => {
    const s = st.current
    s.mouseDown = false
    if (s.began) markDragEnd()
    s.began = false
    s.dirty = true
  }
  const onPointerLeave = () => { if (!st.current.mouseDown) { st.current.hover = null; st.current.dirty = true } }
  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    const key = { attackPower: 'attack_power', decayPower: 'decay_power', releasePower: 'release_power' }[st.current.hover as string]
    if (key) { api.checkpoint(); api.set(`${pre}_${key}`, 0) }
  }

  const zoom = (amount: number) => {
    const s = st.current
    s.window = Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, s.window * amount))
    s.dirty = true
  }
  // mouseWheelMove: zoom(2^−deltaY), JUCE's wheel delta being 0.5 / 256 per pixel scrolled.
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const wheel = (e: WheelEvent) => {
      if (!e.deltaY) return
      e.preventDefault(); e.stopPropagation()
      zoom(2 ** ((e.deltaY * 0.5) / 256))
    }
    c.addEventListener('wheel', wheel, { passive: false })
    return () => c.removeEventListener('wheel', wheel)
  }, [])

  // The playhead and its trail, updated per status packet (EnvelopeEditor::render's phase handling).
  useEffect(() => {
    const boostRange = (lane: number, start: number, end: number, min: number) => {
      const boosts = st.current.boosts[lane]
      const n = TOTAL_POINTS
      const startIndex = Math.max(Math.ceil(start * (n - 1)), 0) % n
      const endPosition = end * (n - 1)
      const endIndex = Math.max(Math.ceil(endPosition), 0) % n
      const progress = endPosition - Math.trunc(endPosition)
      const num = endIndex - startIndex
      const delta = num ? (1 - min) / num : 0
      let val = min
      for (let i = startIndex; i !== endIndex; i = (i + n + 1) % n) {
        val = Math.min(1, val + delta)
        boosts[i] = Math.max(boosts[i], val)
      }
      boosts[endIndex] = Math.max(boosts[endIndex], progress * progress)
    }
    // getBackupPhase: where the playhead was 1/50 s ago, walking back through release, decay and attack.
    const backup = (phase: number) => {
      const decayPoint = (VOICE_DECAY - VOICE_ON) / PHASE_LENGTH, releasePoint = (VOICE_OFF - VOICE_ON) / PHASE_LENGTH
      let t = 1 / 50, current = phase
      if (current === releasePoint) return phase
      const times = { release: time(total('release')), decay: time(total('decay')), attack: time(total('attack')) + time(total('delay')) }
      if (current > releasePoint) {
        if (times.release <= 0) current = releasePoint
        else {
          const released = times.release * (current - releasePoint)
          current -= t / times.release
          if (current >= releasePoint) return current
          t -= released
          current = Math.max(current, releasePoint)
        }
      }
      if (current > decayPoint) {
        if (times.decay <= 0) current = decayPoint
        else {
          const decayed = times.decay * (current - decayPoint)
          current -= t / times.decay
          if (current >= decayPoint) return current
          t -= decayed
          current = Math.max(current, decayPoint)
        }
      }
      if (times.attack <= 0) return 0
      return Math.max(0, current - t / times.attack)
    }
    return onStatusPacket(() => {
      const s = st.current
      s.dirty = true
      const input = statusLanes(`${s.pre}_phase`)
      const animating = s.running
      for (let lane = 0; lane < 2; lane++) {
        const raw = input?.[lane]
        const clear = raw === undefined || !Number.isFinite(raw)
        let phase = clear ? 0 : raw === VOICE_KILL ? 1 : (raw - VOICE_ON) / PHASE_LENGTH
        phase = Math.min(phase, 1)
        const reset = s.lastPhase[lane] > phase
        if (reset) s.lastPhase[lane] = backup(phase)
        if (!s.animatedBefore) s.lastPhase[lane] = phase
        const b = s.boosts[lane]
        if (animating) {
          for (let i = 0; i < b.length; i++) b[i] *= TAIL_DECAY ** FRAMES_PER_PACKET
          const releasePoint = (VOICE_OFF - VOICE_ON) / PHASE_LENGTH
          if (phase > releasePoint && s.lastPhase[lane] < releasePoint && !reset) s.lastPhase[lane] = releasePoint
          s.lastPhase[lane] = Math.max(s.lastPhase[lane], 0)
          if (!clear) boostRange(lane, s.lastPhase[lane], phase, TAIL_DECAY)
          s.lastPhase[lane] = phase
        } else b.fill(0)
        // drawPosition's fade: full while the voice is between note-on and kill, then dying away.
        const live = !clear && raw >= VOICE_ON && raw < VOICE_KILL
        if (live) s.alpha[lane] = 1
        else s.alpha[lane] *= Math.min(0.9, Math.max(0, total('release'))) ** FRAMES_PER_PACKET
      }
      s.animatedBefore = animating
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const s = st.current
      const c = canvas.current
      if (!c || !s.dirty) return
      s.dirty = false
      const { W, H, k } = size()
      // Backing pixels at the displayed size (the stage's CSS scale times the device ratio).
      const dpr = (window.devicePixelRatio || 1) * (c.getBoundingClientRect().width / W || 1)
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr) }
      const g = c.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      const sk = s.skin

      // The ruler (setGridPositions / setTimePositions).
      const powers = Math.log(s.window) / Math.log(RULER_DIVISION)
      const division = Math.floor(powers), transition = powers - division
      const big = RULER_DIVISION ** division / 2, little = big / RULER_DIVISION
      const fade = (1 - transition) ** 2
      g.fillStyle = withAlpha(sk.lighten, fade)
      for (let i = 1; i * little < s.window; i++) if (i % RULER_DIVISION) g.fillRect(padX((W * i * little) / s.window, W), 0, 1, H)
      g.fillStyle = sk.lighten
      for (let i = 1; i * big < s.window; i++) g.fillRect(padX((W * i * big) / s.window, W), 0, 1, H)
      const fontH = TIME_DISPLAY_SIZE * H, fontBuffer = TIME_DISPLAY_BUFFER * H
      g.font = `${fontH}px 'Vital Lato', Lato, sans-serif`
      g.textBaseline = 'middle'
      // The times: Lighten Screen over the background, the sub divisions' faded with their lines.
      const bigText = over(sk.background, sk.lighten), littleText = over(sk.background, withAlpha(sk.lighten, fade))
      for (let i = 1; i * little < s.window && i < 24; i++) {
        g.fillStyle = i % RULER_DIVISION ? littleText : bigText
        g.fillText(formatTime(i * little), Math.round(padX((W * i * little) / s.window, W)) + fontBuffer, H - (fontH + fontBuffer) / 2)
      }

      // The lines (resetEnvelopeLine), filled to the bottom.
      const line = (index: number) => {
        const e = geometry(index, W, H)
        const xs = new Float32Array(TOTAL_POINTS), ys = new Float32Array(TOTAL_POINTS)
        for (let i = 0; i < POINTS_PER_SECTION; i++) {
          const t = i / POINTS_PER_SECTION
          xs[i] = e.delayX + (e.attackX - e.delayX) * t; ys[i] = e.attackValue(t)
          xs[i + POINTS_PER_SECTION] = e.attackX + (e.holdX - e.attackX) * t; ys[i + POINTS_PER_SECTION] = 0
          xs[i + 2 * POINTS_PER_SECTION] = e.holdX + (e.decayX - e.holdX) * t; ys[i + 2 * POINTS_PER_SECTION] = e.decayValue(t)
        }
        for (let i = 0; i <= POINTS_PER_SECTION; i++) {
          const t = i / POINTS_PER_SECTION
          xs[i + 3 * POINTS_PER_SECTION] = e.decayX + (e.releaseX - e.decayX) * t; ys[i + 3 * POINTS_PER_SECTION] = e.releaseValue(t)
        }
        for (let i = 0; i < TOTAL_POINTS; i++) { xs[i] = padX(xs[i], W); ys[i] = padY(ys[i], H) }
        return { xs, ys, e }
      }
      const lineW = sk.lineWidth * k
      const stroke = (xs: Float32Array, ys: Float32Array, color: string, boosts: Float32Array | null) => {
        g.strokeStyle = color; g.lineCap = 'round'; g.lineJoin = 'round'
        if (boosts) {
          for (let i = 0; i < TOTAL_POINTS - 1; i++) {
            g.lineWidth = lineW * (1 + sk.lineBoost * Math.max(boosts[i], boosts[i + 1]))
            g.beginPath(); g.moveTo(xs[i], ys[i]); g.lineTo(xs[i + 1], ys[i + 1]); g.stroke()
          }
        } else {
          g.lineWidth = lineW
          g.beginPath(); g.moveTo(xs[0], ys[0]); for (let i = 1; i < TOTAL_POINTS; i++) g.lineTo(xs[i], ys[i]); g.stroke()
        }
      }
      const fill = (xs: Float32Array, ys: Float32Array, color: string, boosts: Float32Array | null) => {
        const grad = g.createLinearGradient(0, 0, 0, H)
        grad.addColorStop(0, color); grad.addColorStop(1, withAlpha(color, 1 - sk.fillFade))
        g.fillStyle = grad
        for (let i = 0; i < TOTAL_POINTS - 1; i++) {
          g.globalAlpha = boosts ? Math.min(1, 1 + sk.fillBoost * (boosts[i] + boosts[i + 1]) / 2) : 1
          g.beginPath(); g.moveTo(xs[i], ys[i]); g.lineTo(xs[i + 1], ys[i + 1]); g.lineTo(xs[i + 1], H); g.lineTo(xs[i], H); g.closePath(); g.fill()
        }
        g.globalAlpha = 1
      }
      const animating = s.running
      const center = line(-1)
      if (animating) {
        const right = line(1), left = line(0)
        fill(right.xs, right.ys, sk.secondary2, s.boosts[1]); stroke(right.xs, right.ys, sk.primary2, s.boosts[1])
        fill(left.xs, left.ys, sk.secondary1, s.boosts[0]); stroke(left.xs, left.ys, sk.primary1, s.boosts[0])
      } else {
        fill(center.xs, center.ys, sk.secondary2, null); stroke(center.xs, center.ys, sk.primary2, null)
        fill(center.xs, center.ys, sk.secondary1, null); stroke(center.xs, center.ys, sk.primary1, null)
      }
      stroke(center.xs, center.ys, sk.center, null)

      const ring = (x: number, y: number, diameter: number, thickness: number, color: string, inner: string | null) => {
        const r = diameter / 2
        if (inner) { g.fillStyle = inner; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill() }
        g.strokeStyle = color; g.lineWidth = thickness
        g.beginPath(); g.arc(x, y, Math.max(0, r - thickness / 2), 0, Math.PI * 2); g.stroke()
      }

      // The playheads (getPosition / drawPosition), right lane first, fading after the voice ends.
      if (animating) {
        const input = statusLanes(`${s.pre}_phase`)
        for (const lane of [1, 0]) {
          const a = s.alpha[lane]
          if (!a) continue
          const raw = input?.[lane]
          if (raw === undefined || !Number.isFinite(raw) || raw < VOICE_ON || raw >= VOICE_KILL) continue
          const e = geometry(lane, W, H)
          const stage = Math.floor(raw), p = raw - stage
          let t = 0, value = 0
          if (stage === VOICE_ON) { t = e.delay + p * e.attack; value = e.attackValue(p) }
          else if (stage === VOICE_HOLD) { t = e.delay + e.attack + p * e.hold; value = 0 }
          else if (stage === VOICE_DECAY) { t = e.delay + e.attack + e.hold + p * e.decay; value = e.decayValue(p) }
          else if (stage === VOICE_OFF) { t = e.delay + e.attack + e.hold + e.decay + p * e.release; value = e.releaseValue(p) }
          const color = lane ? sk.primary2 : sk.primary1
          const m = a * a
          ring(padX((W * t) / s.window, W), padY(value, H), MARKER_WIDTH * k, MARKER_WIDTH * RING_THICKNESS * k, withAlpha(mix(color, sk.background, 0), m), withAlpha(mix(color, sk.background, 0.2), m))
        }
      }

      // Points and power handles (setPointPositions), then the hover ring and drag disc.
      const e = center.e
      const top = padY(0, H), bottom = padY(H, H)
      const markers: [number, number][] = [[e.attackX, 0], ...(e.holdX === e.attackX ? [] : [[e.holdX, 0] as [number, number]]), [e.decayX, e.sustainY], [e.releaseX, H]]
      for (const [x, y] of markers) ring(padX(x, W), padY(y, H), MARKER_WIDTH * k, MARKER_WIDTH * RING_THICKNESS * k, sk.center, sk.background)
      const minPower = MIN_POINT_DISTANCE_FOR_POWER * k
      const powerDots: [number, number][] = []
      if (e.attackX - e.delayX > minPower) powerDots.push([(e.delayX + e.attackX) / 2, e.attackValue(0.5)])
      if (e.decayX - e.holdX > minPower && padY(e.sustainY, H) > top) powerDots.push([(e.holdX + e.decayX) / 2, e.decayValue(0.5)])
      if (e.releaseX - e.decayX > minPower && padY(e.sustainY, H) < bottom) powerDots.push([(e.decayX + e.releaseX) / 2, e.releaseValue(0.5)])
      g.fillStyle = sk.center
      for (const [x, y] of powerDots) { g.beginPath(); g.arc(padX(x, W), padY(y, H), (POWER_MARKER_WIDTH * k) / 2, 0, Math.PI * 2); g.fill() }
      const grab: Record<Exclude<Hover, null>, [number, number]> = {
        delay: [e.delayX, H], release: [e.releaseX, H], sustain: [e.decayX, e.sustainY], attack: [e.attackX, 0], hold: [e.holdX, 0],
        attackPower: [(e.delayX + e.attackX) / 2, e.attackValue(0.5)], decayPower: [(e.holdX + e.decayX) / 2, e.decayValue(0.5)],
        releasePower: [(e.decayX + e.releaseX) / 2, e.releaseValue(0.5)],
      }
      if (s.hover) {
        const [gx, gy] = grab[s.hover]
        const x = padX(gx, W), y = padY(gy, H)
        if (s.mouseDown) { g.fillStyle = sk.accent2; g.beginPath(); g.arc(x, y, GRAB_RADIUS * k, 0, Math.PI * 2); g.fill() }
        ring(x, y, HOVER_RADIUS * 2 * k, Math.max(1, k), sk.accent1, null)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // The magnifier (DragMagnifyingGlass): drag to zoom (2^(0.02 per pt down)), double-click to fit.
  const magnify = useDrag((_dx, dy) => zoom(2 ** (0.02 * (-dy * 1440 / 1000))))
  const fit = () => {
    const s = st.current
    const { W, H } = size()
    s.window = Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, (1.25 * geometry(-1, W, H).releaseX * s.window) / W))
    s.dirty = true
  }
  return (
    <Box at={at} className="vt-screen vt-envscreen">
      <canvas ref={canvas} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none' }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave} onDoubleClick={onDoubleClick} />
      <span className="vt-mag" title="Drag to zoom, double-click to fit" {...magnify}
        onDoubleClick={(ev) => { ev.stopPropagation(); fit() }}>⌕</span>
    </Box>
  )
}
