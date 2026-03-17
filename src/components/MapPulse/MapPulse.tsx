/**
 * MapPulse — Expanding concentric rings from the center of the map.
 *
 * ─── PLACEHOLDER ANIMATION ───
 * This is a placeholder transition effect. The visual style, timing, colors,
 * and number of rings are all meant to be tuned later. Current behavior:
 *
 *   - 3 concentric CSS rings expand from center of the map container
 *   - Rings use ec-glow / ec-mid / ec-reef palette colors
 *   - Total animation duration: ~2.7s (PULSE_DURATION_MS)
 *   - Rings expand to 2200px diameter (covers full 1920px map)
 *   - Staggered start: 0ms / 250ms / 500ms between rings
 *   - Only one pulse active at a time (new trigger replaces old)
 *
 * ─── HOW IT'S TRIGGERED ───
 * B2MapScreen increments `trigger` prop whenever a location is selected
 * (via SELECT button, fist-select, or mouse click in sim mode).
 * The locationStore subscription in B2MapScreen fires on lat/lng change,
 * which increments pulseTrigger → this component re-renders.
 *
 * ─── WHAT TO CHANGE LATER ───
 *   - Ring count, sizes, colors → edit MapPulse.module.css
 *   - Animation duration/easing → edit @keyframes pulse-expand in CSS
 *   - Stagger timing → edit .ring1/.ring2/.ring3 animation-delay in CSS
 *   - Duration before cleanup → change PULSE_DURATION_MS below
 *   - Position → currently hardcoded to center (50%/50%) in CSS
 */

import React, { useEffect, useState } from 'react'
import styles from './MapPulse.module.css'

interface MapPulseProps {
  /**
   * Increment this number to trigger a new pulse.
   * The component uses React key={trigger} to force CSS animation restart.
   * A value of 0 means "no pulse yet" — first pulse fires when trigger > 0.
   */
  trigger: number
}

/**
 * How long to keep the component mounted after triggering.
 * Should be >= the longest CSS animation duration (2.2s ring + 0.5s delay = 2.7s).
 * After this, the DOM is removed to avoid stale elements.
 */
const PULSE_DURATION_MS = 2700

const MapPulse: React.FC<MapPulseProps> = ({ trigger }) => {
  // activeKey changes on each trigger, forcing React to remount the pulseGroup
  // div with a new key — this restarts the CSS animations from the beginning.
  const [activeKey, setActiveKey] = useState(0)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (trigger === 0) return

    // Change key to force CSS animation restart
    setActiveKey(trigger)
    setVisible(true)

    // Auto-hide after animation completes
    const timer = setTimeout(() => {
      setVisible(false)
    }, PULSE_DURATION_MS)

    return () => clearTimeout(timer)
  }, [trigger])

  if (!visible) return null

  return (
    <div className={styles.container} aria-hidden="true">
      {/* key={activeKey} forces React to destroy+recreate this div on each
          trigger, which restarts all CSS animations from their 0% keyframe */}
      <div key={activeKey} className={styles.pulseGroup}>
        {/* Three concentric rings with staggered animation-delay.
            Ring styles (color, delay, width) are in MapPulse.module.css.
            To add more rings: add another div here + a .ring4 class in CSS. */}
        <div className={`${styles.ring} ${styles.ring1}`} />
        <div className={`${styles.ring} ${styles.ring2}`} />
        <div className={`${styles.ring} ${styles.ring3}`} />
      </div>
    </div>
  )
}

export default MapPulse
