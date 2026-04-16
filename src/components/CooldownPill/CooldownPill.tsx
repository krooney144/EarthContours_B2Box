/**
 * CooldownPill — "New location available in Xs" countdown pill
 *
 * Appears at the top of the map area after a successful location selection.
 * Shows a live-updating countdown so visitors know how long until they can
 * choose a new location. Prevents rapid-fire room changes.
 *
 * Mounting/unmounting is controlled by the parent. When `cooldownEndsAt`
 * changes to a future timestamp, this component counts down to zero and
 * calls `onExpire` exactly once when the countdown reaches 0.
 *
 * Props:
 *   cooldownEndsAt — Timestamp (Date.now() ms) when cooldown expires.
 *                    Pass null to hide the pill.
 *   onExpire       — Called once when the countdown reaches 0.
 *
 * USED BY: B2MapScreen
 */

import React, { useEffect, useRef, useState } from 'react'
import styles from './CooldownPill.module.css'

interface CooldownPillProps {
  /** Timestamp when cooldown ends. null = hidden. */
  cooldownEndsAt: number | null
  /** Called once when the countdown hits 0 */
  onExpire: () => void
}

const CooldownPill: React.FC<CooldownPillProps> = ({ cooldownEndsAt, onExpire }) => {
  const [remaining, setRemaining] = useState(0)
  const onExpireRef = useRef(onExpire)

  // Keep callback fresh without restarting the interval
  useEffect(() => { onExpireRef.current = onExpire }, [onExpire])

  useEffect(() => {
    if (cooldownEndsAt === null) {
      setRemaining(0)
      return
    }

    // Initial tick — compute remaining immediately on mount/prop change
    const tick = () => {
      const ms = cooldownEndsAt - Date.now()
      if (ms <= 0) {
        setRemaining(0)
        onExpireRef.current()
        return true  // signals "stop"
      }
      setRemaining(Math.ceil(ms / 1000))
      return false
    }

    if (tick()) return  // already expired, don't start interval

    const id = window.setInterval(() => {
      if (tick()) {
        window.clearInterval(id)
      }
    }, 250)  // 4Hz is plenty for second-level display, feels responsive

    return () => window.clearInterval(id)
  }, [cooldownEndsAt])

  if (cooldownEndsAt === null || remaining <= 0) return null

  return (
    <div className={styles.pill} role="status" aria-live="polite">
      <span className={styles.icon} aria-hidden="true">⏱</span>
      <span className={styles.text}>
        New location available in {remaining}s
      </span>
    </div>
  )
}

export default CooldownPill
