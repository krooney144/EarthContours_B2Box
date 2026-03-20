/**
 * B2 Map Screen — Fullscreen top-down table projection surface
 *
 * Fixed 1920×1080 layout for ceiling-mounted projector on a table.
 * Visitors stand around all 4 sides and interact via control strips
 * (for testing) or via MediaPipe hand tracking (for the exhibit).
 *
 * ─── OSC / WEBSOCKET INTEGRATION ───
 *
 * TouchDesigner sends each hand value as a SEPARATE OSC message:
 *
 *   /h1tx            [x_norm 0–1]   — Hand 1 X position (normalised)
 *   /h1ty            [y_norm 0–1]   — Hand 1 Y position (normalised)
 *   /h2tx            [x_norm 0–1]   — Hand 2 X position (normalised)
 *   /h2ty            [y_norm 0–1]   — Hand 2 Y position (normalised)
 *
 *   /h1:ILoveYou     [confidence 0–1] — Hand 1 grab gesture (pan / pinch-zoom)
 *   /h1:Pointing_Up  [confidence 0–1] — Hand 1 pointing (preview → release = select)
 *
 *   /h2:ILoveYou     [confidence 0–1] — Hand 2 grab gesture (pan / pinch-zoom)
 *   /h2:Pointing_Up  [confidence 0–1] — Hand 2 pointing (preview → release = select)
 *
 * NOTE: Camera is mounted upside-down (180° flip), so all hand X/Y
 * coordinates are inverted: xPixel = (1 - x_norm) * screenWidth.
 *
 * ─── GESTURE MEANINGS ───
 *
 *   ILoveYou ≥ GRAB_THRESHOLD  = grab — map interaction:
 *                  • One hand  → pan the map (drag)
 *                  • Two hands → pinch-to-zoom (distance between hands)
 *   ILoveYou < GRAB_THRESHOLD  = release — back to idle
 *
 *   Pointing ≥ POINT_THRESHOLD = preview — cursor shows where you're aiming
 *   Pointing < POINT_THRESHOLD = release — selects the location (one-shot)
 *              5-second cooldown prevents rapid re-triggering.
 *
 * ─── MOUSE SIMULATION (default OFF) ───
 *   Press "M" or click "SIM" button to toggle.
 *   SIM ON: mouse = hand 1, held = fist (pan), released = open palm.
 *   Right-click = pointing (select location).
 *
 * Layout:
 *   ┌──────────────────────────────────┐
 *   │          TOP STRIP (160px)       │
 *   ├──────┬──────────────────┬────────┤
 *   │ LEFT │   MapScreen      │ RIGHT  │
 *   │ 200px│   + crosshair    │ 200px  │
 *   │      │   + hand cursors │        │
 *   ├──────┴──────────────────┴────────┤
 *   │        BOTTOM STRIP (160px)      │
 *   └──────────────────────────────────┘
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import { useMapViewStore, useLocationStore } from '../../store'
import { createLogger } from '../../core/logger'
import MapScreen from '../MapScreen/MapScreen'
import ControlStrip from './ControlStrip'
import HandCursor from '../../components/HandCursor'
import MapPulse from '../../components/MapPulse'
import type { HandState, HandSide } from '../../components/HandCursor'
import styles from './B2MapScreen.module.css'

const log = createLogger('SCREEN:B2-MAP')

// ─── GESTURE THRESHOLDS ──────────────────────────────────────────────────────
// FLAG: Adjust these thresholds during testing with real MediaPipe data.
// Confidence values from TouchDesigner are 0–1 continuous.
// Above threshold = gesture active, below = gesture released.

/** ILoveYou confidence threshold for grab (pan/pinch). Raise to require more certainty. */
const GRAB_THRESHOLD = 0.8

/** Pointing_Up confidence threshold for aim preview. Raise to require more certainty. */
const POINT_THRESHOLD = 0.5

/** Cooldown in ms after a point-select before another can fire (prevents rapid re-triggers) */
const POINT_COOLDOWN_MS = 5

// ─── Types ───────────────────────────────────────────────────────────────────

interface HandTracker {
  x: number        // Pixel position from left edge
  y: number        // Pixel position from top edge
  state: HandState // 'open' | 'closed' | 'pointing'
  hand: HandSide   // 'left' | 'right'
  visible: boolean // Whether this hand is currently detected
}

// ─── Component ───────────────────────────────────────────────────────────────

const B2MapScreen: React.FC = () => {
  log.info('B2MapScreen mounted')

  const setExploreLocation = useLocationStore((s) => s.setExploreLocation)
  const socketRef = useRef<Socket | null>(null)

  // ─── HAND STATE ─────────────────────────────────────────────────────────
  //
  // Two hands tracked independently.
  // Each hand remembers its own x, y, gesture state, and visibility.
  //
  // IMPORTANT — why we use `prev` in every setter:
  //   TouchDesigner sends x and y as SEPARATE messages (/h1tx then /h1ty).
  //   If we just wrote `setHand1({ x: newX, y: 0 })` the y would be wiped.
  //   Using `prev => ({ ...prev, x: newX })` keeps all existing values and
  //   only changes the one field we care about.

  const [hand1, setHand1] = useState<HandTracker>({
    x: 0, y: 0, state: 'open', hand: 'right', visible: false,
  })

  const [hand2, setHand2] = useState<HandTracker>({
    x: 0, y: 0, state: 'open', hand: 'left', visible: false,
  })

  // ─── SIM MODE (default OFF) ─────────────────────────────────────────────
  const [simMode, setSimMode] = useState(false)
  const [pulseTrigger, setPulseTrigger] = useState(0)

  // ─── POINT-SELECT COOLDOWN ──────────────────────────────────────────────
  // Prevents rapid re-triggering of location selection.
  // After a point-select fires, ignore further triggers for POINT_COOLDOWN_MS.
  const lastPointSelectTimeRef = useRef<number>(0)

  // ─── PINCH-ZOOM TRACKING ────────────────────────────────────────────────
  //
  // When BOTH hands are in ILoveYou (grab), we track the distance between them.
  // As that distance changes we zoom the map in or out.
  // `lastPinchDistRef` remembers the previous distance so we can calculate
  // how much it changed each frame.

  const lastPinchDistRef = useRef<number | null>(null)
  const hand1Ref = useRef(hand1)
  const hand2Ref = useRef(hand2)

  // Keep refs in sync with state so gesture handlers always see fresh values
  useEffect(() => { hand1Ref.current = hand1 }, [hand1])
  useEffect(() => { hand2Ref.current = hand2 }, [hand2])

  // ─── SELECT LOCATION (POINTING gesture) ──────────────────────────────────
  //
  // Called when a pointing gesture is detected.
  // Sets the explore location to wherever that hand is currently pointing.
  // The location store subscription below then broadcasts it to the Wrap screen.

  const handlePointSelect = useCallback((handX: number, handY: number) => {
    // ── Cooldown guard: ignore if fired too recently ──
    const now = Date.now()
    if (now - lastPointSelectTimeRef.current < POINT_COOLDOWN_MS) {
      log.info('Point-select: cooldown active, ignoring', {
        remainingMs: POINT_COOLDOWN_MS - (now - lastPointSelectTimeRef.current),
      })
      return
    }
    lastPointSelectTimeRef.current = now

    // Convert pixel position back to normalised 0–1 range
    const xNorm = handX / window.innerWidth
    const yNorm = handY / window.innerHeight

    // Ask the map store what lat/lng is at this normalised screen position
    const { getLatLngAtNorm } = useMapViewStore.getState()

    if (typeof getLatLngAtNorm === 'function') {
      const { lat, lng } = getLatLngAtNorm(xNorm, yNorm)
      log.info('Point-select: choosing location', {
        lat: lat.toFixed(4),
        lng: lng.toFixed(4),
      })
      setExploreLocation(lat, lng)
    } else {
      // Fallback: if getLatLngAtNorm isn't available, use map center
      const { centerLat, centerLng } = useMapViewStore.getState()
      log.warn('Point-select: getLatLngAtNorm unavailable, using center')
      setExploreLocation(centerLat, centerLng)
    }
  }, [setExploreLocation])

  // ─── PAN MAP (single closed fist drag) ───────────────────────────────────
  //
  // When one hand is a fist and moving, we pan the map.
  // `lastFistPosRef` remembers where the fist was last frame so we can
  // calculate how far it moved (the "delta") and pan by that amount.

  const lastFistPosRef = useRef<{ x: number; y: number } | null>(null)

  const handleFistPan = useCallback((x: number, y: number) => {
    const { panBy } = useMapViewStore.getState()

    if (lastFistPosRef.current && typeof panBy === 'function') {
      const dx = x - lastFistPosRef.current.x
      const dy = y - lastFistPosRef.current.y
      panBy(dx, dy)
    }

    lastFistPosRef.current = { x, y }
  }, [])

  // ─── PINCH ZOOM (two closed fists) ───────────────────────────────────────
  //
  // Calculates the distance between both hands.
  // If that distance grew → zoom in. If it shrunk → zoom out.
  // The zoom amount is proportional to how much the distance changed.

  const handlePinchZoom = useCallback(() => {
    const h1 = hand1Ref.current
    const h2 = hand2Ref.current

    if (!h1.visible || !h2.visible) return

    const dx = h2.x - h1.x
    const dy = h2.y - h1.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    const { zoomBy } = useMapViewStore.getState()

    if (lastPinchDistRef.current !== null && typeof zoomBy === 'function') {
      const delta = dist - lastPinchDistRef.current
      // Scale factor: 0.005 feels natural — adjust if zoom is too fast/slow
      zoomBy(delta * 0.005)
    }

    lastPinchDistRef.current = dist
  }, [])

  // ─── GESTURE LOGIC ───────────────────────────────────────────────────────
  //
  // Called every time a hand position updates while in a closed-fist state.
  // Decides whether to pan (one fist) or pinch-zoom (two fists).

  const handleFistGesture = useCallback((handNum: 1 | 2, x: number, y: number) => {
    const h1 = hand1Ref.current
    const h2 = hand2Ref.current

    const bothFists = h1.state === 'closed' && h2.state === 'closed'
      && h1.visible && h2.visible

    if (bothFists) {
      // Two fists → pinch-to-zoom
      lastFistPosRef.current = null // clear pan memory so pan doesn't glitch after
      handlePinchZoom()
    } else {
      // One fist → pan
      lastPinchDistRef.current = null // clear zoom memory
      handleFistPan(x, y)
    }
  }, [handleFistPan, handlePinchZoom])

  // ─── OSC SOCKET CONNECTION ───────────────────────────────────────────────

  useEffect(() => {
    const socket = io()
    socketRef.current = socket

    socket.on('connect', () => {
      log.info('WebSocket connected', { id: socket.id })
    })

    // ── OSC MESSAGE HANDLER ────────────────────────────────────────────────
    //
    // Every OSC message from TouchDesigner arrives here as:
    //   { address: '/h1tx', args: [0.42] }
    //
    // We switch on the address and update only the relevant field of
    // hand1 or hand2 state, using `prev` to preserve all other fields.
    //
    // For gesture messages, TD may send:
    //   - Continuous:  args[0] === 1 while gesture active, args[0] === 0 when not
    //   - One-shot:    just sends the message once when gesture is detected
    // We handle both: if args[0] === 0 we switch back to 'open' (idle).

    socket.on('osc', (msg: { address: string; args: number[] }) => {
      console.log('[B2-MAP] OSC IN:', msg.address, msg.args)

      // ── Hand 1 position ──────────────────────────────────────────────────
      // NOTE: Camera is 180° flipped, so we invert: (1 - value)
      if (msg.address === '/h1tx') {
        const xPixel = (1 - msg.args[0]) * window.innerWidth
        setHand1(prev => {
          if (prev.state === 'closed') handleFistGesture(1, xPixel, prev.y)
          return { ...prev, x: xPixel, visible: true }
        })
      }

      if (msg.address === '/h1ty') {
        const yPixel = (1 - msg.args[0]) * window.innerHeight
        setHand1(prev => {
          if (prev.state === 'closed') handleFistGesture(1, prev.x, yPixel)
          return { ...prev, y: yPixel, visible: true }
        })
      }

      // ── Hand 2 position ──────────────────────────────────────────────────
      // NOTE: Camera is 180° flipped, so we invert: (1 - value)
      if (msg.address === '/h2tx') {
        const xPixel = (1 - msg.args[0]) * window.innerWidth
        setHand2(prev => {
          if (prev.state === 'closed') handleFistGesture(2, xPixel, prev.y)
          return { ...prev, x: xPixel, visible: true }
        })
      }

      if (msg.address === '/h2ty') {
        const yPixel = (1 - msg.args[0]) * window.innerHeight
        setHand2(prev => {
          if (prev.state === 'closed') handleFistGesture(2, prev.x, yPixel)
          return { ...prev, y: yPixel, visible: true }
        })
      }

      // ── Hand 1 gesture: ILoveYou = grab (pan / pinch-zoom) ─────────────
      // args[0] is continuous confidence 0–1.
      // Above GRAB_THRESHOLD = grab active, below = release.
      // FLAG: Adjust GRAB_THRESHOLD at top of file to tune sensitivity.
      if (msg.address === '/h1:ILoveYou') {
        const confidence = msg.args[0] ?? 0
        const grabActive = confidence >= GRAB_THRESHOLD
        if (!grabActive) lastFistPosRef.current = null // stop pan on release
        setHand1(prev => ({ ...prev, state: grabActive ? 'closed' : 'open' }))
      }

      // ── Hand 1 gesture: Pointing_Up = preview → release = select ───────
      // args[0] is continuous confidence 0–1.
      // Above POINT_THRESHOLD = "aiming" (preview where you'll select).
      // Dropping BELOW threshold = "release" → fires the location select.
      // 5-second cooldown prevents rapid re-triggers.
      // FLAG: Adjust POINT_THRESHOLD at top of file to tune sensitivity.
      // Pointing = instantly select location under this hand
      if (msg.address === '/h1:Pointing_Up') {
        const active = msg.args[0] !== 0
        setHand1(prev => {
          // Only fire the select on the leading edge (when it becomes active)
          if (active && prev.state !== 'pointing') {
            handlePointSelect(prev.x, prev.y)
          }
          return { ...prev, state: active ? 'pointing' : 'open' }
        })
      }

      // ── Hand 2 gesture: ILoveYou = grab ────────────────────────────────
      if (msg.address === '/h2:ILoveYou') {
        const confidence = msg.args[0] ?? 0
        const grabActive = confidence >= GRAB_THRESHOLD
        if (!grabActive) lastPinchDistRef.current = null
        setHand2(prev => ({ ...prev, state: grabActive ? 'closed' : 'open' }))
      }

      // ── Hand 2 gesture: Pointing_Up = preview → release = select ──────
      if (msg.address === '/h2:Pointing_Up') {
        const confidence = msg.args[0] ?? 0
        const pointActive = confidence >= POINT_THRESHOLD
        setHand2(prev => {
          if (!pointActive && prev.state === 'pointing') {
            handlePointSelect(prev.x, prev.y)
          }
          return { ...prev, state: pointActive ? 'pointing' : 'open' }
        })
      }
    })

    socket.on('disconnect', () => {
      log.warn('WebSocket disconnected')
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [handleFistGesture, handlePointSelect]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── BROADCAST LOCATION CHANGES TO WRAP SCREEN ───────────────────────────
  //
  // Whenever the active location changes (from pointing gesture, control strip,
  // etc.) we emit it over WebSocket so the Wrap screen updates its terrain.

  useEffect(() => {
    const unsub = useLocationStore.subscribe((state, prevState) => {
      if (
        state.activeLat !== prevState.activeLat ||
        state.activeLng !== prevState.activeLng
      ) {
        setPulseTrigger(prev => prev + 1)

        if (socketRef.current) {
          socketRef.current.emit('location:update', {
            lat: state.activeLat,
            lng: state.activeLng,
          })
          log.info('Location broadcast to Wrap screen', {
            lat: state.activeLat.toFixed(4),
            lng: state.activeLng.toFixed(4),
          })
        }
      }
    })
    return unsub
  }, [])

  // ─── MOUSE SIMULATION (default OFF) ──────────────────────────────────────
  //
  // SIM ON lets you test without TouchDesigner:
  //   Left mouse move   = hand 1 position (open palm)
  //   Left mouse held   = closed fist (pan)
  //   Left mouse release= open palm (stops pan)
  //   Right click       = pointing (selects location instantly)
  //   "M" key           = toggle sim on/off

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!simMode) return
      setHand1(prev => {
        if (prev.state === 'closed') handleFistGesture(1, e.clientX, e.clientY)
        return { ...prev, x: e.clientX, y: e.clientY, visible: true }
      })
    }

    const handleMouseDown = (e: MouseEvent) => {
      if (!simMode) return
      if (e.button === 0) {
        // Left button = fist (pan)
        setHand1(prev => ({ ...prev, state: 'closed' }))
      }
    }

    const handleMouseUp = (e: MouseEvent) => {
      if (!simMode) return
      if (e.button === 0) {
        // Left release = back to open palm, stop pan
        lastFistPosRef.current = null
        setHand1(prev => ({ ...prev, state: 'open' }))
      }
    }

    const handleContextMenu = (e: MouseEvent) => {
      if (!simMode) return
      e.preventDefault()
      // Right click = pointing → select location
      setHand1(prev => {
        handlePointSelect(prev.x, prev.y)
        return { ...prev, state: 'pointing' }
      })
      // Briefly show pointing state then return to open
      setTimeout(() => {
        setHand1(prev => ({ ...prev, state: 'open' }))
      }, 400)
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'm' || e.key === 'M') {
        setSimMode(prev => !prev)
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('contextmenu', handleContextMenu)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('contextmenu', handleContextMenu)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [simMode, handleFistGesture, handlePointSelect])

  // ─── RENDER ──────────────────────────────────────────────────────────────

  return (
    <div className={styles.screen}>

      {/* SIM MODE TOGGLE — top-right corner */}
      {/* Left click = pan/drag, Right click = point-select location */}
      <button
        className={styles.simToggle}
        onClick={() => setSimMode(prev => !prev)}
        title={simMode
          ? 'SIM ON — Left drag = pan, Right click = select location. Press M to toggle.'
          : 'SIM OFF — reading real TouchDesigner OSC data. Press M to toggle.'}
      >
        {simMode ? 'SIM ON' : 'SIM OFF'}
      </button>

      {/* Top control strip */}
      <div className={styles.topStrip}>
        <ControlStrip side="top" />
      </div>

      {/* Middle row: left strip + map + right strip */}
      <div className={styles.middleRow}>
        <div className={styles.leftStrip}>
          <ControlStrip side="left" />
        </div>

        <div className={styles.mapContainer}>
          <MapScreen exhibitMode={true} />

          {/* Crosshair — centre reference point */}
          <div className={styles.crosshair} aria-hidden="true">
            <div className={styles.crosshairH} />
            <div className={styles.crosshairV} />
            <div className={styles.crosshairDot} />
          </div>

          {/* Pulse rings appear when a location is selected */}
          <MapPulse trigger={pulseTrigger} />
        </div>

        <div className={styles.rightStrip}>
          <ControlStrip side="right" />
        </div>
      </div>

      {/* Bottom control strip */}
      <div className={styles.bottomStrip}>
        <ControlStrip side="bottom" />
      </div>

      {/* ── HAND CURSORS ──────────────────────────────────────────────────── */}
      {/* Hand 1 (right hand by default)                                      */}
      {/*   open    = idle cursor                                              */}
      {/*   closed  = fist icon (pan / pinch-zoom)                            */}
      {/*   pointing= finger icon (selects location instantly)                */}
      <HandCursor
        x={hand1.x} y={hand1.y}
        state={hand1.state} hand={hand1.hand}
        visible={hand1.visible}
      />

      {/* Hand 2 (left hand by default) */}
      <HandCursor
        x={hand2.x} y={hand2.y}
        state={hand2.state} hand={hand2.hand}
        visible={hand2.visible}
      />

    </div>
  )
}

export default B2MapScreen