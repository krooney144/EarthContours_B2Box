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
 * USED BY: B2WrapScreen
 */

import React, { useRef, useEffect } from 'react'
import styles from './ScopeOverlay.module.css'

// ─── TUNABLE CONSTANTS ──────────────────────────────────────────────────────
// FLAG: Adjust these ranges during testing with real OSC hardware.

/** Minimum layer_fraction value from OSC (maps to smallest scope) */
export const SCOPE_LAYER_MIN = 0
/** Maximum layer_fraction value from OSC (maps to largest scope) */
export const SCOPE_LAYER_MAX = 8

/** Scope diameter in pixels at minimum layer_fraction */
export const SCOPE_SIZE_MIN_PX = 120
/** Scope diameter in pixels at maximum layer_fraction */
export const SCOPE_SIZE_MAX_PX = 400

/** Magnification factor for the terrain inside the scope */
export const SCOPE_ZOOM = 2.0

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
}

const ScopeOverlay: React.FC<ScopeOverlayProps> = ({
  x, y, visible, diameter, canvasRef, distanceKm, label,
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

      // Draw the magnified terrain
      ctx.drawImage(srcCanvas, sx, sy, srcW, srcH, 0, 0, size, size)
      ctx.restore()

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [visible, diameter, x, y, canvasRef])

  if (!visible || diameter <= 0) return null

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
