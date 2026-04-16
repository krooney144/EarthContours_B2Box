/**
 * HoldPulse — 2-second "holding to select" animation
 *
 * Appears at the hand's captured position while the user is holding the
 * pointing gesture. Three concentric rings pulse outward in overlapping
 * waves, each wave bigger than the last — building anticipation toward
 * the moment the location fires.
 *
 * When the hold completes (or is cancelled), the parent unmounts this
 * component. Unmounting is animation-safe: CSS keyframes stop when the
 * element is removed.
 *
 * Props:
 *   x, y    — Position in pixels within the parent map container
 *             (map-container-local coordinates, 0–mapContainer.width/height)
 *   active  — When true, the component is visible and animating.
 *             When false, nothing renders.
 *
 * USED BY: B2MapScreen (inside .mapContainer so overflow is clipped to map bounds)
 */

import React from 'react'
import styles from './HoldPulse.module.css'

interface HoldPulseProps {
  /** X position in pixels within the map container */
  x: number
  /** Y position in pixels within the map container */
  y: number
  /** Whether the hold is currently active */
  active: boolean
}

const HoldPulse: React.FC<HoldPulseProps> = ({ x, y, active }) => {
  if (!active) return null

  return (
    <div
      className={styles.holdPulse}
      style={{ left: `${x}px`, top: `${y}px` }}
      aria-hidden="true"
    >
      {/* Solid center dot — anchor point for the captured location */}
      <div className={styles.center} />

      {/* Three overlapping pulse waves, each bigger than the last */}
      <div className={`${styles.wave} ${styles.wave1}`} />
      <div className={`${styles.wave} ${styles.wave2}`} />
      <div className={`${styles.wave} ${styles.wave3}`} />
    </div>
  )
}

export default HoldPulse
