/**
 * TrackerPortal — Glowing target reticle for motion capture trackers
 * ===================================================================
 *
 * This component renders a glowing circle on the WRAP SCREEN wherever
 * a motion capture tracker is pointing. It looks like a target portal
 * in the ocean color scheme.
 *
 * USED BY: B2WrapScreen
 * DATA SOURCE: OSC messages /trk_1_xy_loc and /trk_2_xy_loc
 *
 * Props:
 *   x, y     — Position in pixels (already converted from normalized 0–1)
 *   label    — Tracker number to display ("1" or "2")
 *   visible  — Whether the tracker is active
 */

import React from 'react'
import styles from './TrackerPortal.module.css'

interface TrackerPortalProps {
  /** X position in pixels from left edge of the screen */
  x: number
  /** Y position in pixels from top edge of the screen */
  y: number
  /** Tracker number label (e.g. "1", "2") */
  label: string
  /** Whether this tracker is currently active/visible */
  visible: boolean
}

const TrackerPortal: React.FC<TrackerPortalProps> = ({ x, y, label, visible }) => {
  if (!visible) return null

  return (
    <div
      className={styles.portal}
      style={{
        left: `${x}px`,
        top: `${y}px`,
      }}
    >
      {/* Outer pulsing ring */}
      <div className={styles.outerRing} />
      {/* Inner glowing circle */}
      <div className={styles.innerRing} />
      {/* Tracker number label */}
      <span className={styles.label}>{label}</span>
    </div>
  )
}

export default TrackerPortal
