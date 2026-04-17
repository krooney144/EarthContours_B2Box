/**
 * ScopeOverlay — Circular magnified terrain scope for motion capture trackers
 * ===========================================================================
 *
 * Renders a circular "scope" at a tracker's position that shows a clipped,
 * scaled copy of the terrain canvas. The scope size is driven by the
 * layer_fraction parameter from OSC data.
 *
 * Uses a secondary canvas with drawImage() for efficient real-time clipping
 * from the main terrain canvas — no toDataURL, no frame-rate impact.
 *
 * Also displays a distance readout showing how far the terrain is at the
 * scope's center bearing, looked up from the skyline band data.
 *
 * Peak dots and labels render on an HTML overlay layered above the scope
 * canvas. Dots always show for peaks within the magnified source region;
 * full labels (name + elevation + miles) show only when the scope is
 * large enough and are capped at the top 6 by crosshair proximity +
 * elevation angle priority.
 *
 * USED BY: B2WrapScreen
 */

import React, { useRef, useEffect } from 'react'
import type { PeakScreenPos } from '../../screens/ScanScreen/scanRendererCore'
import { formatElevation } from '../../core/utils'
import styles from './ScopeOverlay.module.css'

// ─── TUNABLE CONSTANTS ──────────────────────────────────────────────────────
// FLAG: Adjust these ranges during testing with real OSC hardware.

/** Minimum layer_fraction value from OSC (maps to smallest scope) */
export const SCOPE_LAYER_MIN = 0
/** Maximum layer_fraction value from OSC (maps to largest scope) */
export const SCOPE_LAYER_MAX = 8

/** Scope diameter in pixels at minimum layer_fraction */
// FLAG: Adjust these to resize portals. Was 120/400, reduced for exhibit.
export const SCOPE_SIZE_MIN_PX = 110
/** Scope diameter in pixels at maximum layer_fraction */
export const SCOPE_SIZE_MAX_PX = 500

/** Magnification factor for the terrain inside the scope */
export const SCOPE_ZOOM = 2.0

/** Fraction of the scope radius a peak must be within (to the crosshair) to
 *  be eligible for a label. Dots still draw for every peak inside the source
 *  region — this is only about when labels turn on. */
/** Crosshair-distance (as fraction of scope radius) at which labels reach
 *  full opacity. Closer than this = fully visible. */
const LABEL_FULL_OPACITY_FRACTION = 0.7
/** Crosshair-distance (fraction of radius) at which labels fully fade out.
 *  Labels fade in linearly between this and LABEL_FULL_OPACITY_FRACTION. */
const LABEL_MAX_VISIBLE_FRACTION = 0.9
/** Maximum number of full labels rendered per scope (picked by priority). */
const MAX_LABELS_PER_SCOPE = 10
/** Minimum on-screen separation between accepted labels, in px. Below this,
 *  the lower-priority label is dropped to prevent overlap stacks. */
const LABEL_MIN_SEPARATION_PX = 90

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Format peak distance for scope labels. Always imperial.
 *   >= 10 mi → whole miles
 *   >= 0.1 mi → one-decimal miles
 *   else     → whole feet
 */
function formatPeakDistance(dist_km: number): string {
  const miles = dist_km * 0.621371
  if (miles >= 10)  return `${Math.round(miles)} mi`
  if (miles >= 0.1) return `${miles.toFixed(1)} mi`
  return `${Math.round(dist_km * 3280.84)} ft`
}

interface ScopeOverlayProps {
  /** X position in pixels from left edge */
  x: number
  /** Y position in pixels from top edge */
  y: number
  /** Whether this scope is visible */
  visible: boolean
  /** Scope diameter in pixels (computed from layer_fraction) */
  diameter: number
  /** Reference to the terrain canvas to clip from */
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  /** Distance to terrain at scope center in km, or null if unavailable */
  distanceKm: number | null
  /** Tracker label */
  label: string
  /** Projected peak positions (native-canvas coordinates) to render inside */
  peaks: PeakScreenPos[]
  /** Unit system for elevation formatting */
  units: 'imperial' | 'metric'
}

const ScopeOverlay: React.FC<ScopeOverlayProps> = ({
  x, y, visible, diameter, canvasRef, distanceKm, label, peaks, units,
}) => {
  const scopeCanvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)

  // Draw the magnified terrain clip into the scope canvas
  useEffect(() => {
    if (!visible || diameter <= 0) return

    const draw = () => {
      const scopeCanvas = scopeCanvasRef.current
      const srcCanvas = canvasRef.current
      if (!scopeCanvas || !srcCanvas) return

      const size = diameter * (window.devicePixelRatio || 1)
      if (scopeCanvas.width !== size || scopeCanvas.height !== size) {
        scopeCanvas.width = size
        scopeCanvas.height = size
      }

      const ctx = scopeCanvas.getContext('2d')
      if (!ctx) return

      // High-quality resampling makes the magnified terrain lines read cleaner
      // at the 2× zoom rather than pixel-doubled.
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'

      ctx.clearRect(0, 0, size, size)

      // Clip to circle
      ctx.save()
      ctx.beginPath()
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
      ctx.clip()

      // Calculate source rectangle from the main terrain canvas.
      // The scope position (x, y) is in display pixels of the container.
      // The terrain canvas is WRAP_W × WRAP_H native pixels, displayed
      // at container size. Convert display coords → native canvas coords.
      const containerEl = srcCanvas.parentElement
      const containerW = containerEl?.clientWidth ?? srcCanvas.width
      const containerH = containerEl?.clientHeight ?? srcCanvas.height
      const scaleX = srcCanvas.width / containerW
      const scaleY = srcCanvas.height / containerH

      // Center of scope in native canvas coords
      const cx = x * scaleX
      const cy = y * scaleY

      // Source region size (native pixels) — scope diameter / zoom in native space
      const srcW = (diameter * scaleX) / SCOPE_ZOOM
      const srcH = (diameter * scaleY) / SCOPE_ZOOM

      // Source top-left
      const sx = cx - srcW / 2
      const sy = cy - srcH / 2

      // Draw the magnified terrain. Source canvas is the glow-free "base"
      // layer from B2WrapScreen — no silhouette glow, no horizon glow, so
      // the scope never magnifies aliasing halos. Brightness/contrast lift
      // happens in CSS (.scopeCanvas filter) for free GPU compositing.
      ctx.drawImage(srcCanvas, sx, sy, srcW, srcH, 0, 0, size, size)

      ctx.restore()

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [visible, diameter, x, y, canvasRef])

  if (!visible || diameter <= 0) return null

  // ─── Peak dot / label layout ───────────────────────────────────────────
  // peak.screenX/screenY are in wrap-canvas native pixels. Convert to the
  // container's display px, find peaks inside the source region, magnify.
  // The source canvas may be an offscreen buffer (no parentElement); fall
  // back to its own native dimensions so scale resolves to 1:1 in that case.
  const srcCanvas = canvasRef.current
  const containerEl = srcCanvas?.parentElement ?? null
  const containerW = containerEl?.clientWidth  ?? srcCanvas?.width  ?? 1
  const containerH = containerEl?.clientHeight ?? srcCanvas?.height ?? 1
  const wrapW = srcCanvas?.width  ?? containerW
  const wrapH = srcCanvas?.height ?? containerH
  const dispScaleX = containerW / wrapW
  const dispScaleY = containerH / wrapH
  const radius = diameter / 2
  const sourceRadius = diameter / (2 * SCOPE_ZOOM)
  // Accept peaks slightly beyond the scope edge so dots don't pop out at the rim.
  const acceptRadius = sourceRadius
  const labelEligibilityRadius = radius * LABEL_MAX_VISIBLE_FRACTION

  type InScope = {
    id: string
    name: string
    elevation_m: number
    dist_km: number
    peakAngle: number
    localX: number  // px within the scope div
    localY: number
    crosshairDist: number
    fade: number
    labelOpacity: number
    priority: number
  }
  const inScope: InScope[] = []
  for (const p of peaks) {
    const peakDisplayX = p.screenX * dispScaleX
    const peakDisplayY = p.screenY * dispScaleY
    const dx = peakDisplayX - x
    const dy = peakDisplayY - y
    const distFromTracker = Math.sqrt(dx * dx + dy * dy)
    if (distFromTracker > acceptRadius) continue
    // Position relative to the scope div (top-left = x-radius, y-radius).
    const localX = radius + dx * SCOPE_ZOOM
    const localY = radius + dy * SCOPE_ZOOM
    const crosshairDist = Math.sqrt(
      (dx * SCOPE_ZOOM) * (dx * SCOPE_ZOOM) +
      (dy * SCOPE_ZOOM) * (dy * SCOPE_ZOOM),
    )
    const fade = Math.max(0, 1 - crosshairDist / radius)
    // Label opacity ramps from 0 at LABEL_MAX_VISIBLE_FRACTION to 1 at
    // LABEL_FULL_OPACITY_FRACTION; stays at 1 closer to the crosshair.
    const frac = crosshairDist / radius
    const labelOpacity = Math.max(0, Math.min(1,
      (LABEL_MAX_VISIBLE_FRACTION - frac) /
      (LABEL_MAX_VISIBLE_FRACTION - LABEL_FULL_OPACITY_FRACTION),
    ))
    const peakAngle = p.peakAngle ?? 0
    const priority =
      0.7 * (1 - crosshairDist / radius) +
      0.3 * (peakAngle / (Math.PI / 2))
    inScope.push({
      id: p.id,
      name: p.name,
      elevation_m: p.elevation_m,
      dist_km: p.dist_km,
      peakAngle,
      localX,
      localY,
      crosshairDist,
      fade,
      labelOpacity,
      priority,
    })
  }

  // Label eligibility: the user is "aiming at" the peak — within 70% of the
  // scope radius from the crosshair. Dots stay for all in-scope peaks; only
  // labels are gated. Accept up to 5, dropping any candidate that would
  // overlap (<60 px) an already-accepted higher-priority label.
  const labelIds = new Set<string>()
  const accepted: InScope[] = []
  const candidates = inScope
    .filter(p => p.crosshairDist <= labelEligibilityRadius)
    .sort((a, b) => b.priority - a.priority)
  for (const c of candidates) {
    if (accepted.length >= MAX_LABELS_PER_SCOPE) break
    let overlaps = false
    for (const a of accepted) {
      const sep = Math.sqrt(
        (c.localX - a.localX) * (c.localX - a.localX) +
        (c.localY - a.localY) * (c.localY - a.localY),
      )
      if (sep < LABEL_MIN_SEPARATION_PX) { overlaps = true; break }
    }
    if (overlaps) continue
    accepted.push(c)
    labelIds.add(c.id)
  }

  return (
    <div
      className={styles.scope}
      style={{
        left: `${x}px`,
        top: `${y}px`,
        width: `${diameter}px`,
        height: `${diameter}px`,
      }}
    >
      {/* Magnified terrain view */}
      <canvas
        ref={scopeCanvasRef}
        className={styles.scopeCanvas}
      />

      {/* Peak dots + labels — clipped to scope circle */}
      <div className={styles.peakLayer}>
        {inScope.map(p => {
          const showLabel = labelIds.has(p.id)
          return (
            <React.Fragment key={p.id}>
              <div
                className={styles.peakDot}
                style={{
                  left: `${p.localX}px`,
                  top:  `${p.localY}px`,
                }}
              />
              <div
                className={styles.peakLabel}
                style={{
                  left: `${p.localX}px`,
                  top:  `${p.localY}px`,
                  opacity: showLabel ? p.labelOpacity : 0,
                }}
              >
                <span className={styles.peakName}>{p.name}</span>
                <span className={styles.peakElev}>{formatElevation(p.elevation_m, units)}</span>
                <span className={styles.peakDist}>{formatPeakDistance(p.dist_km)}</span>
              </div>
            </React.Fragment>
          )
        })}
      </div>

      {/* Scope ring */}
      <div className={styles.scopeRing} />

      {/* Crosshair */}
      <div className={styles.crosshairH} />
      <div className={styles.crosshairV} />

      {/* Distance readout */}
      {distanceKm !== null && (
        <div className={styles.distanceLabel}>
          {distanceKm < 1
            ? `${Math.round(distanceKm * 1000)}m`
            : `${distanceKm.toFixed(1)}km`
          }
        </div>
      )}

      {/* Tracker label */}
      <span className={styles.label}>{label}</span>
    </div>
  )
}

export default ScopeOverlay
