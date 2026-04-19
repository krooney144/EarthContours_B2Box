/**
 * HandCursor — Visual cursor for MediaPipe hand tracking
 * =========================================================
 *
 * This component renders a hand icon on the MAP SCREEN wherever
 * MediaPipe detects a hand. It changes appearance based on the
 * hand state:
 *
 *   OPEN    — palm icon, just hovering/moving around
 *   CLOSED  — fist icon, this is a "click" / select action
 *   POINTING — pointing finger icon, directional input
 *
 * USED BY: B2MapScreen
 * DATA SOURCE: OSC messages from MediaPipe (via index.js server)
 *
 * Props:
 *   x, y    — Position in pixels (already converted from normalized 0–1)
 *   state   — 'open' | 'closed' | 'pointing'
 *   hand    — 'left' | 'right' (which hand)
 *   visible — Whether this hand is currently detected
 */

import React from 'react'
import styles from './HandCursor.module.css'

export type HandState = 'open' | 'closed' | 'pointing'
export type HandSide = 'left' | 'right'

interface HandCursorProps {
  /** X position in pixels from left edge of the screen */
  x: number
  /** Y position in pixels from top edge of the screen */
  y: number
  /** Current hand state: open palm (hover), closed fist (click), or pointing */
  state: HandState
  /** Which hand: left or right */
  hand: HandSide
  /** Whether this hand is currently detected/visible */
  visible: boolean
}

/**
 * Hand emoji icons for each state.
 * Using emoji for simplicity — easy to see, no assets needed.
 * These can be replaced with SVG icons later if needed.
 */
const HAND_ICONS: Record<HandState, string> = {
  open: '🖐️',     // Open palm = hovering, not selecting
  closed: '✊',    // Closed fist = click/select action
  pointing: '👆',  // Pointing = directional input
}

const HandCursor: React.FC<HandCursorProps> = ({ x, y, state, hand, visible }) => {
  if (!visible) return null

  // Right hand uses the glow palette accent; left uses foam for a subtle
  // visual distinction so visitors can tell which hand is which on screen.
  const handClass = hand === 'left' ? styles.handLeft : styles.handRight

  return (
    <div
      className={`${styles.cursor} ${handClass} ${state === 'closed' ? styles.cursorActive : ''}`}
      style={{
        left: `${x}px`,
        top: `${y}px`,
        // Mirror the icon for left hand
        transform: `translate(-50%, -50%) ${hand === 'right' ? 'scaleX(-1)' : ''}`,
      }}
    >
      {/* Hand icon — changes based on state */}
      <span className={styles.icon}>{HAND_ICONS[state]}</span>
      {/* Hand label (L or R) — color-coded to match hand accent */}
      <span className={styles.label}>{hand === 'left' ? 'L' : 'R'}</span>
    </div>
  )
}

export default HandCursor
