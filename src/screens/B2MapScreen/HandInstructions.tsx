/**
 * Hand Instructions — bottom strip of the B2 Map table.
 *
 * Replaces the old ControlStrip buttons. Shows 4 cells teaching visitors
 * the hand-tracked gestures available on the map:
 *   1. Hover Hand over Map
 *   2. Grab to Pan           (4-way directional arrows overlay)
 *   3. Zoom In and Out       (two mirrored grab hands + ↔ arrow)
 *   4. Point to Choose Location   (concentric radiating rings behind hand)
 *
 * SVG paths are in ./hands/*.tsx. All stroke color comes from currentColor,
 * set by .iconWrap { color: var(--ec-glow) } in the CSS module.
 *
 * The drop-shadow glow is applied at the .iconWrap level so it covers
 * both the hand and any decorator elements (arrows, rings).
 */

import React from 'react'
import HandOpen from './hands/HandOpen'
import HandGrab from './hands/HandGrab'
import HandPoint from './hands/HandPoint'
import styles from './HandInstructions.module.css'

// ─── Arrow primitive (used for pan 4-way + zoom ↔) ───────────────────────────
//
// A stroked chevron arrowhead + tail. Direction is controlled by SVG rotation
// in the cell wrappers below so the same primitive serves all 5 uses.

const Arrow: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 48 48"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    {/* Filled arrowhead pointing UP — wrappers rotate this to face any direction.
      * Fill: --ec-deep (navy interior), stroke: currentColor (set by .decor = --ec-mid). */}
    <path
      d="M 24 4 L 40 22 L 8 22 Z"
      fill="var(--ec-deep)"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
    {/* Tail */}
    <line
      x1={24} y1={22} x2={24} y2={44}
      stroke="currentColor"
      strokeWidth={4}
      strokeLinecap="round"
    />
  </svg>
)

// ─── Component ───────────────────────────────────────────────────────────────

const HandInstructions: React.FC = () => {
  return (
    <div className={styles.strip} aria-label="Hand gesture instructions">

      {/* ── Cell 1: Hover Hand over Map ─────────────────────────────────── */}
      <div className={styles.cell}>
        <div className={styles.iconWrap}>
          <div className={styles.handBox}>
            <HandOpen className={styles.hand} />
          </div>
        </div>
        <div className={styles.label}>Hover Hand over Map</div>
      </div>

      <div className={styles.divider} aria-hidden="true" />

      {/* ── Cell 2: Grab to Pan — grab hand with 4-way arrows around it ── */}
      <div className={styles.cell}>
        <div className={styles.iconWrap}>
          <div className={styles.panGroup}>
            {/* Top arrow */}
            <div className={`${styles.panArrow} ${styles.panUp} ${styles.decor}`}>
              <Arrow />
            </div>
            {/* Left arrow */}
            <div className={`${styles.panArrow} ${styles.panLeft} ${styles.decor}`}>
              <Arrow />
            </div>
            {/* Centre: grab hand */}
            <div className={styles.handBox}>
              <HandGrab className={styles.hand} />
            </div>
            {/* Right arrow */}
            <div className={`${styles.panArrow} ${styles.panRight} ${styles.decor}`}>
              <Arrow />
            </div>
            {/* Bottom arrow */}
            <div className={`${styles.panArrow} ${styles.panDown} ${styles.decor}`}>
              <Arrow />
            </div>
          </div>
        </div>
        <div className={styles.label}>Grab to Pan</div>
      </div>

      <div className={styles.divider} aria-hidden="true" />

      {/* ── Cell 3: Zoom In and Out — two mirrored grab hands + ↔ arrow ── */}
      <div className={styles.cell}>
        <div className={styles.iconWrap}>
          <div className={styles.zoomGroup}>
            {/* Left hand — mirrored */}
            <div className={`${styles.handBox} ${styles.mirrored}`}>
              <HandGrab className={styles.hand} />
            </div>
            {/* ← arrow overlapping → arrow (tails meet/overlap in the middle) */}
            <div className={`${styles.zoomArrowGroup} ${styles.decor}`} aria-hidden="true">
              <div className={styles.zoomSideArrow}>
                <Arrow />
              </div>
              <div className={`${styles.zoomSideArrow} ${styles.zoomRight}`}>
                <Arrow />
              </div>
            </div>
            {/* Right hand — original orientation */}
            <div className={styles.handBox}>
              <HandGrab className={styles.hand} />
            </div>
          </div>
        </div>
        <div className={styles.label}>Zoom In and Out</div>
      </div>

      <div className={styles.divider} aria-hidden="true" />

      {/* ── Cell 4: Point to Choose Location — rings radiating behind hand ── */}
      <div className={styles.cell}>
        <div className={styles.iconWrap}>
          <div className={styles.pointGroup}>
            {/* Concentric radiating rings behind pointing hand */}
            <svg
              viewBox="0 0 200 200"
              xmlns="http://www.w3.org/2000/svg"
              className={`${styles.rings} ${styles.decor}`}
              aria-hidden="true"
            >
              <circle cx="100" cy="100" r="40"
                fill="none" stroke="currentColor" strokeWidth="2.5"
                opacity="0.9" />
              <circle cx="100" cy="100" r="62"
                fill="none" stroke="currentColor" strokeWidth="2"
                opacity="0.55" />
              <circle cx="100" cy="100" r="84"
                fill="none" stroke="currentColor" strokeWidth="1.5"
                opacity="0.3" />
            </svg>
            <div className={styles.handBox}>
              <HandPoint className={styles.hand} />
            </div>
          </div>
        </div>
        <div className={styles.label}>Point to Choose Location</div>
      </div>

    </div>
  )
}

export default HandInstructions
