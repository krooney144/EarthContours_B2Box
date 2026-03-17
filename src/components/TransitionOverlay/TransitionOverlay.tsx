/**
 * TransitionOverlay — Canvas-based wave animation for location transitions.
 *
 * Phases (all times relative to activation, which is 1s after map pulse):
 *   Phase 1 (0–2.2s): Opaque black sweeps bottom→top with ripple lines riding up.
 *   Phase 2 (1.0–∞):  Noisy contour-like lines undulate over the black.
 *                      Lines have continuous drift + amplitude breathing for movement.
 *   Phase 3 (triggered externally): Lines calm + staggered slice fade-out.
 *
 * Performance: 12 lines × ~1088 points × 3 noise octaves ≈ 39k ops/frame.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import styles from './TransitionOverlay.module.css'

// ─── Configuration ──────────────────────────────────────────────────────────
// TUNE: All timing, sizing, and count values below are placeholders.
//       Adjust these to change animation feel without touching the draw logic.

/** TUNE: Number of noisy contour lines drawn in Phase 2.
 *  More lines = denser look, but costs more CPU per frame.
 *  Performance budget: NUM_LINES × (CANVAS_W / LINE_STEP) × 3 noise octaves per frame.
 *  At 12 lines: ~12 × 544 × 3 = ~19.6k noise calls/frame — fine for 60fps. */
const NUM_LINES = 12

/** TUNE: Half-res canvas dimensions, stretched to full screen via CSS.
 *  Full wrap screen is 10880×1080. This is exactly half (5440×540).
 *  At projection distance (~3m), half-res is indistinguishable from full.
 *  Saves ~75% GPU compositing work compared to full-res.
 *  To increase quality: use 10880×1080 (but watch for frame drops). */
const CANVAS_W = 5440
const CANVAS_H = 540

/** TUNE: Delay (seconds) before the overlay animation starts.
 *  This lets the map pulse rings play on the table first before the
 *  wrap screen reacts. Set to 0 for instant start. */
const START_DELAY = 1.0

/** TUNE: Phase timing (seconds, all relative to overlay start AFTER the delay).
 *  - BLACK_SWEEP_DURATION: How long the opaque black takes to sweep bottom→top.
 *    Currently 2.2s to roughly match the map pulse ring expansion speed.
 *  - WAVE_BUILD_START: When contour lines begin appearing (during the sweep).
 *    1.0s = lines start when sweep is ~halfway up.
 *  - WAVE_MAX_AMP_TIME: How long lines take to reach full wobble amplitude.
 *    Shorter = lines appear more suddenly. Longer = gentler build.
 *  - SETTLE_DURATION: How long the fade-out takes when new terrain arrives.
 *    Each vertical slice fades independently over this period. */
const BLACK_SWEEP_DURATION = 2.2
const WAVE_BUILD_START = 1.0
const WAVE_MAX_AMP_TIME = 1.5
const SETTLE_DURATION = 1.5

/** TUNE: Number of faint horizontal ripple lines that ride up behind the
 *  black sweep edge. These give the sweep a "wave" feeling instead of
 *  just a hard edge. Set to 0 to disable sweep ripples entirely. */
const NUM_SWEEP_RIPPLES = 5

/** TUNE: Number of vertical slices for the staggered fade-out in Phase 3.
 *  Each slice gets a random delay before fading, creating a "dissolve" effect.
 *  More slices = finer granularity. Fewer = chunkier fade. */
const NUM_SLICES = 10

/** TUNE: Pixel step between line segment points.
 *  Lower = smoother curves, more CPU. Higher = jaggier, faster.
 *  10px at half-res (5440w) = ~544 points per line. */
const LINE_STEP = 10

/** TUNE: Line colors — each contour line randomly picks one of these.
 *  Uses the ocean-depth palette from palette.css.
 *  To change colors: edit rgba values or add/remove entries.
 *  Opacity in these colors is the BASE opacity — it's further modified by
 *  ampScale (build-in), globalAlpha (slice fade-out), and lineAlpha (sweep reveal). */
const COLORS = [
  'rgba(132, 209, 219, 0.75)',  // ec-glow — brightest, most visible
  'rgba(104, 176, 191, 0.65)',  // ec-reef — medium-bright
  'rgba(75, 142, 163, 0.55)',   // ec-mid — medium
  'rgba(47, 109, 135, 0.45)',   // ec-ocean — darker, recedes
  'rgba(132, 209, 219, 0.55)',  // ec-glow dim — variety
  'rgba(167, 221, 229, 0.45)',  // ec-foam dim — lightest tone
]

// ─── 3-octave noise ─────────────────────────────────────────────────────────
//
// These functions generate terrain-like randomness for the contour lines.
// The approach: hash-based pseudo-random noise → smoothed interpolation → layered octaves.
//
// TUNE: To change line character:
//   - More octaves = more detail (but more CPU). Currently 3 octaves.
//   - Larger frequency multipliers = more fine detail (jaggier lines).
//   - Larger time multipliers = faster line drift/evolution.
//   - Octave weights (0.45/0.33/0.22) control how much each scale contributes.

/** Hash-based pseudo-random: deterministic noise from position + seed.
 *  Uses the classic sin-hash trick — fast, no lookup tables.
 *  Returns 0–1. Not cryptographic, just visually random. */
function hashNoise(x: number, seed: number): number {
  const n = Math.sin(x * 127.1 + seed * 311.7) * 43758.5453
  return n - Math.floor(n)
}

/** Smooth interpolation between hash noise values.
 *  Uses Hermite smoothstep (3t² - 2t³) for C1 continuity — no visible grid artifacts.
 *  This is what makes lines look smooth instead of jagged. */
function smoothNoise(x: number, seed: number): number {
  const ix = Math.floor(x)
  const fx = x - ix
  const t = fx * fx * (3 - 2 * fx) // Hermite smoothstep
  return hashNoise(ix, seed) * (1 - t) + hashNoise(ix + 1, seed) * t
}

/** 3-octave terrain-like noise — the main displacement function for contour lines.
 *  TUNE: Each octave controls a different visual scale:
 *    Octave 1 (×0.001 freq, 0.45 weight): Large rolling hills — broad line shape
 *    Octave 2 (×0.005 freq, 0.33 weight): Medium bumps — ridgeline character
 *    Octave 3 (×0.018 freq, 0.22 weight): Fine detail — small terrain variation
 *  The t parameter adds time-based drift so lines evolve continuously.
 *  Returns -0.5 to +0.5 (centered at zero for even up/down displacement). */
function terrainNoise(x: number, seed: number, t: number): number {
  const o1 = smoothNoise(x * 0.001 + t * 0.03, seed) * 0.45       // Broad shape
  const o2 = smoothNoise(x * 0.005 + t * 0.07, seed + 50) * 0.33  // Medium detail
  const o3 = smoothNoise(x * 0.018 + t * 0.12, seed + 100) * 0.22 // Fine detail
  return (o1 + o2 + o3) - 0.5
}

// ─── Line Configuration ─────────────────────────────────────────────────────
// Each contour line has its own randomized parameters so they all look different.
// Lines are regenerated fresh on every new transition (not reused between pulses).

/** TUNE: Per-line configuration. Each field controls a different visual property.
 *  All values are randomized within ranges defined in generateLines(). */
interface WaveLine {
  baseY: number       // Vertical home position (0=top, 1=bottom) — lines spread evenly
  sineFreq: number    // Gentle large-scale sine wave frequency (very subtle, ~15% of displacement)
  sinePhase: number   // Starting phase of the sine wave (randomized per line)
  driftSpeed: number  // How fast this line's noise evolves over time (higher = faster drift)
  amplitude: number   // Max vertical displacement in pixels (30–90px at half-res)
  noiseSeed: number   // Unique seed for this line's noise function (avoids identical lines)
  lineWidth: number   // Stroke width in pixels (0.8–2.6px at half-res)
  colorIdx: number    // Index into COLORS array — which palette color this line uses
  breathPhase: number // Phase offset for amplitude "breathing" — each line pulses at its own rhythm
}

/** Generate randomized line configurations. Called once per transition.
 *  TUNE: Adjust the ranges here to change overall line character:
 *    - baseY range (0.06–0.94): How much vertical padding at top/bottom
 *    - sineFreq range: Larger = more visible sine wave undulation
 *    - driftSpeed range: Higher = lines evolve/move faster
 *    - amplitude range: Larger = more dramatic vertical displacement
 *    - lineWidth range: Thicker lines = bolder look */
function generateLines(): WaveLine[] {
  const lines: WaveLine[] = []
  for (let i = 0; i < NUM_LINES; i++) {
    const t = (i + 0.5) / NUM_LINES // Evenly distribute lines from top to bottom
    lines.push({
      baseY: 0.06 + t * 0.88,                          // 6%–94% of canvas height
      sineFreq: 0.0003 + Math.random() * 0.0008,       // Very low frequency — gentle curves
      sinePhase: Math.random() * Math.PI * 2,           // Random starting phase
      driftSpeed: 0.3 + Math.random() * 0.5,            // 0.3–0.8× time multiplier
      amplitude: 30 + Math.random() * 60,               // 30–90px displacement (at half-res)
      noiseSeed: Math.random() * 1000,                   // Unique noise seed
      lineWidth: 0.8 + Math.random() * 1.8,             // 0.8–2.6px stroke
      colorIdx: Math.floor(Math.random() * COLORS.length), // Random palette color
      breathPhase: Math.random() * Math.PI * 2,          // Random breathing rhythm offset
    })
  }
  return lines
}

/** Sweep ripple configuration — the faint horizontal lines that ride up
 *  behind the black sweep edge during Phase 1. These give the sweep a
 *  "water wave" feeling instead of just a hard black edge.
 *  TUNE: offset range, opacity range, and noise frequency in the draw loop. */
interface SweepRipple {
  offset: number    // How far behind the sweep edge (0=at edge, 0.25=25% of canvas behind)
  seed: number      // Unique noise seed for this ripple's horizontal wobble
  opacity: number   // Base opacity (0.3–0.7) — further faded by distance from edge
}

/** Generate sweep ripple configs. Called once per transition.
 *  TUNE: offset range (0.03–0.28): How spread out ripples are behind the edge.
 *  TUNE: opacity range (0.3–0.7): How visible the ripples are. */
function generateSweepRipples(): SweepRipple[] {
  const ripples: SweepRipple[] = []
  for (let i = 0; i < NUM_SWEEP_RIPPLES; i++) {
    ripples.push({
      offset: 0.03 + (i / NUM_SWEEP_RIPPLES) * 0.25, // Spread from 3% to 28% behind edge
      seed: Math.random() * 1000,
      opacity: 0.3 + Math.random() * 0.4,
    })
  }
  return ripples
}

/** Generate random delays for the staggered slice fade-out (Phase 3).
 *  Each vertical slice waits a random amount (0–0.5s) before starting to fade.
 *  TUNE: Max delay (0.5): Higher = more staggered/dramatic fade. Lower = more uniform. */
function generateSliceDelays(): number[] {
  const delays: number[] = []
  for (let i = 0; i < NUM_SLICES; i++) {
    delays.push(Math.random() * 0.5) // 0–500ms random delay per slice
  }
  return delays
}

// ─── Props ──────────────────────────────────────────────────────────────────
//
// The parent (B2WrapScreen) controls the overlay lifecycle:
//   1. Sets active=true when a new location is selected (via socket 'location:update')
//   2. Sets settling=true when the new skyline data arrives from the worker
//   3. Receives onComplete callback when the fade-out animation finishes
//
// Timeline:
//   [location selected] → active=true → 1s delay → sweep+waves start
//   [skyline arrives]   → settling=true → waves calm, slices fade out
//   [fade complete]     → onComplete() → parent resets state

interface TransitionOverlayProps {
  /** Set to true to start the transition animation (with START_DELAY wait first). */
  active: boolean
  /** Set to true when new terrain is ready — triggers the Phase 3 fade-out. */
  settling: boolean
  /** Called when the entire animation is done and the overlay can be removed. */
  onComplete: () => void
}

// ─── Component ──────────────────────────────────────────────────────────────

const TransitionOverlay: React.FC<TransitionOverlayProps> = ({
  active,
  settling,
  onComplete,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const activateTimeRef = useRef<number>(0)
  const startTimeRef = useRef<number>(0)
  const settleStartRef = useRef<number>(0)
  const linesRef = useRef<WaveLine[]>([])
  const sweepRipplesRef = useRef<SweepRipple[]>([])
  const sliceDelaysRef = useRef<number[]>([])
  const [visible, setVisible] = useState(false)

  // ── Start animation (with delay) ─────────────────────────────────────

  useEffect(() => {
    if (active) {
      linesRef.current = generateLines()
      sweepRipplesRef.current = generateSweepRipples()
      sliceDelaysRef.current = generateSliceDelays()
      activateTimeRef.current = performance.now() / 1000
      startTimeRef.current = 0
      settleStartRef.current = 0
      setVisible(true)
    }
  }, [active])

  // ── Begin settling when skyline arrives ───────────────────────────────

  useEffect(() => {
    if (settling && visible && settleStartRef.current === 0) {
      settleStartRef.current = performance.now() / 1000
    }
  }, [settling, visible])

  // ── Animation loop ────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !visible) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const now = performance.now() / 1000

    // Wait for the delay period
    if (now - activateTimeRef.current < START_DELAY) {
      rafRef.current = requestAnimationFrame(draw)
      return
    }

    if (startTimeRef.current === 0) {
      startTimeRef.current = now
    }

    const elapsed = now - startTimeRef.current
    const lines = linesRef.current
    const sweepRipples = sweepRipplesRef.current
    const sliceDelays = sliceDelaysRef.current

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)

    // ── Phase 1: Black background sweep (bottom → top) ─────────────────
    // An opaque black rectangle sweeps from bottom to top of the canvas,
    // covering the old terrain. Uses ease-out curve for smooth deceleration.
    // TUNE: BLACK_SWEEP_DURATION controls speed. Easing is quadratic ease-out.
    const sweepProgress = Math.min(elapsed / BLACK_SWEEP_DURATION, 1)
    const sweepEased = 1 - (1 - sweepProgress) * (1 - sweepProgress) // Quadratic ease-out
    const blackTopY = CANVAS_H * (1 - sweepEased) // Y position of the top edge of the black

    let blackOverallOpacity = 1
    if (settleStartRef.current > 0) {
      const settleElapsed = now - settleStartRef.current
      blackOverallOpacity = Math.max(0, 1 - settleElapsed / SETTLE_DURATION)
    }

    if (blackOverallOpacity > 0 && sweepProgress > 0) {
      if (settleStartRef.current > 0) {
        const sliceWidth = CANVAS_W / NUM_SLICES
        const settleElapsed = now - settleStartRef.current
        for (let s = 0; s < NUM_SLICES; s++) {
          const delay = sliceDelays[s]
          const sliceT = Math.max(0, (settleElapsed - delay) / SETTLE_DURATION)
          const sliceOpacity = Math.max(0, 1 - sliceT)
          if (sliceOpacity <= 0.01) continue
          ctx.fillStyle = `rgba(0, 8, 16, ${sliceOpacity})`
          ctx.fillRect(s * sliceWidth, blackTopY, sliceWidth, CANVAS_H - blackTopY)
        }
      } else {
        ctx.fillStyle = '#000810'
        ctx.fillRect(0, blackTopY, CANVAS_W, CANVAS_H - blackTopY)
      }

      // ── Sweep ripple lines — ride up with the black edge ────────────
      // These are horizontal noise lines that travel just behind the sweep edge,
      // like ripples extending up from the table/map below.
      if (sweepProgress < 1 && settleStartRef.current === 0) {
        for (const ripple of sweepRipples) {
          const rippleY = blackTopY + ripple.offset * CANVAS_H
          // Only draw if within the black area
          if (rippleY > CANVAS_H) continue

          // Fade based on distance from sweep edge
          const distFromEdge = (rippleY - blackTopY) / CANVAS_H
          const fadeAlpha = ripple.opacity * Math.max(0, 1 - distFromEdge * 3)
          if (fadeAlpha < 0.02) continue

          ctx.save()
          ctx.strokeStyle = `rgba(132, 209, 219, ${fadeAlpha})`
          ctx.lineWidth = 1.2
          ctx.beginPath()
          let first = true
          for (let x = 0; x <= CANVAS_W; x += 20) {
            const n = smoothNoise(x * 0.002 + elapsed * 0.5, ripple.seed)
            const y = rippleY + (n - 0.5) * 30
            if (first) { ctx.moveTo(x, y); first = false }
            else ctx.lineTo(x, y)
          }
          ctx.stroke()
          ctx.restore()
        }

        // Main sweep line at the leading edge
        const lineOpacity = 0.9 * (1 - sweepProgress * 0.3)
        ctx.save()
        ctx.strokeStyle = `rgba(132, 209, 219, ${lineOpacity})`
        ctx.lineWidth = 2
        ctx.shadowColor = 'rgba(132, 209, 219, 0.9)'
        ctx.shadowBlur = 20
        ctx.beginPath()
        ctx.moveTo(0, blackTopY)
        ctx.lineTo(CANVAS_W, blackTopY)
        ctx.stroke()
        ctx.restore()
      }
    }

    // ── Phase 2: Noisy contour lines with breathing ───────────────────
    // Lines appear behind the black sweep and undulate with noise + breathing.
    // They start small (ampScale ramps from 0→1 over WAVE_MAX_AMP_TIME)
    // and keep moving via driftSpeed + breathPhase until Phase 3 calms them.
    // TUNE: WAVE_BUILD_START = when lines start. WAVE_MAX_AMP_TIME = ramp-up speed.
    const waveElapsed = elapsed - WAVE_BUILD_START
    if (waveElapsed > 0) {
      // Smoothstep amplitude ramp-in (0→1 over WAVE_MAX_AMP_TIME)
      const buildT = Math.min(waveElapsed / WAVE_MAX_AMP_TIME, 1)
      let ampScale = buildT * buildT * (3 - 2 * buildT) // Hermite smoothstep

      const sliceWidth = CANVAS_W / NUM_SLICES
      let sliceOpacities: number[] | null = null

      if (settleStartRef.current > 0) {
        const settleElapsed = now - settleStartRef.current
        sliceOpacities = []
        let allDone = true

        for (let s = 0; s < NUM_SLICES; s++) {
          const delay = sliceDelays[s]
          const sliceT = Math.max(0, (settleElapsed - delay) / SETTLE_DURATION)
          const opacity = Math.max(0, 1 - sliceT)
          sliceOpacities.push(opacity)
          if (opacity > 0) allDone = false
        }

        const settleAmpT = Math.min(settleElapsed / (SETTLE_DURATION * 0.7), 1)
        ampScale *= 1 - settleAmpT * settleAmpT

        if (allDone && blackOverallOpacity <= 0) {
          cancelAnimationFrame(rafRef.current)
          setVisible(false)
          onComplete()
          return
        }
      }

      const lineClipTop = settleStartRef.current > 0 ? 0 : blackTopY

      for (const line of lines) {
        const y0 = line.baseY * CANVAS_H
        if (y0 < lineClipTop - 50) continue

        const color = COLORS[line.colorIdx]
        const t = waveElapsed * line.driftSpeed

        // TUNE: Amplitude breathing — each line's displacement pulses gently.
        // This keeps the animation alive during the wait for skyline data.
        // 0.8 + 0.4*sin = range 0.4→1.2 (±20% around nominal amplitude)
        // * 0.8 = breathing speed (lower = slower pulse). breathPhase staggers per line.
        const breathe = 0.8 + 0.4 * Math.sin(waveElapsed * 0.8 + line.breathPhase)
        const amp = line.amplitude * ampScale * breathe

        // TUNE: Vertical drift — lines slowly wander up/down during the wait.
        // * 0.3 = drift speed (lower = slower wander). * 12 = max drift in pixels.
        const yDrift = Math.sin(waveElapsed * 0.3 + line.breathPhase * 2) * 12

        ctx.save()
        ctx.strokeStyle = color
        ctx.lineWidth = line.lineWidth
        ctx.lineCap = 'round'

        if (sliceOpacities) {
          for (let s = 0; s < NUM_SLICES; s++) {
            if (sliceOpacities[s] <= 0.01) continue

            const x0 = s * sliceWidth
            const x1 = (s + 1) * sliceWidth
            ctx.globalAlpha = sliceOpacities[s]

            ctx.beginPath()
            let first = true
            for (let x = x0; x <= x1; x += LINE_STEP) {
              const noise = terrainNoise(x, line.noiseSeed, t)
              const gentleSine = Math.sin(x * line.sineFreq + line.sinePhase + t * 0.1) * 0.15
              const y = y0 + yDrift + (noise + gentleSine) * amp

              if (first) { ctx.moveTo(x, y); first = false }
              else ctx.lineTo(x, y)
            }
            ctx.stroke()
          }
        } else {
          const revealT = (CANVAS_H - y0) / CANVAS_H
          const lineRevealProgress = (sweepEased - revealT) / 0.15
          const lineAlpha = Math.max(0, Math.min(1, lineRevealProgress))
          if (lineAlpha <= 0) { ctx.restore(); continue }

          ctx.globalAlpha = lineAlpha
          ctx.beginPath()
          let first = true
          for (let x = 0; x <= CANVAS_W; x += LINE_STEP) {
            const noise = terrainNoise(x, line.noiseSeed, t)
            const gentleSine = Math.sin(x * line.sineFreq + line.sinePhase + t * 0.1) * 0.15
            const y = y0 + yDrift + (noise + gentleSine) * amp

            if (first) { ctx.moveTo(x, y); first = false }
            else ctx.lineTo(x, y)
          }
          ctx.stroke()
        }

        ctx.restore()
      }
    }

    rafRef.current = requestAnimationFrame(draw)
  }, [visible, onComplete])

  // ── Start/stop animation loop ─────────────────────────────────────────

  useEffect(() => {
    if (visible) {
      rafRef.current = requestAnimationFrame(draw)
    }
    return () => cancelAnimationFrame(rafRef.current)
  }, [visible, draw])

  if (!visible) return null

  return (
    <canvas
      ref={canvasRef}
      className={styles.overlay}
      width={CANVAS_W}
      height={CANVAS_H}
      aria-hidden="true"
    />
  )
}

export default TransitionOverlay
