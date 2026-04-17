/**
 * B2 Map Screen — Fullscreen top-down table projection surface
 *
 * Fixed 1800×1800 layout for ceiling-mounted projector on a table.
 * Visitors interact via MediaPipe hand tracking (camera-tracked).
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
 *   /h1:Pointing_Up  [confidence 0–1] — Hand 1 pointing (hold to select)
 *
 *   /h2:ILoveYou     [confidence 0–1] — Hand 2 grab gesture (pan / pinch-zoom)
 *   /h2:Pointing_Up  [confidence 0–1] — Hand 2 pointing (hold to select)
 *
 * NOTE: Camera is mounted upside-down (180° flip), so all hand X/Y
 * coordinates are inverted: xDesign = (1 - x_norm) * DESIGN_W.
 *
 * ─── COORDINATE SYSTEM ───
 *
 * All hand coordinates are kept in DESIGN space (0–1800 on each axis).
 * The .screen element scales design space to the current window via CSS
 * transform, so everything inside (map, cursors, pulses) stays aligned
 * regardless of window size.
 *
 * ─── GESTURE MEANINGS ───
 *
 *   ILoveYou ≥ GRAB_THRESHOLD  = grab — map interaction:
 *                  • One hand  → pan the map (drag)
 *                  • Two hands → pinch-to-zoom (distance between hands)
 *   ILoveYou < GRAB_THRESHOLD  = release — back to idle
 *
 *   Pointing ≥ POINT_THRESHOLD = hold progress animation at captured hand
 *                                 position; 2-second hold is required.
 *   Pointing < POINT_THRESHOLD = drop — 200ms grace period, then cancel
 *                                        unless gesture resumes.
 *
 *   After a successful selection, a 30-second cooldown prevents another
 *   selection. A pill countdown shows how much time remains.
 *
 * ─── MOUSE SIMULATION (default OFF) ───
 *   Press "M" or click "SIM" button to toggle.
 *   SIM ON: mouse moves = hand 1 (open palm). Hold left button = fist (pan).
 *   Right-click + hold = pointing gesture (hold 2s for select).
 *
 * Layout:
 *   ┌──────────────────────────────────┐
 *   │                                  │
 *   │         MapScreen (1fr)          │
 *   │         + hand cursors           │
 *   │         + hold/pulse animations  │
 *   │                                  │
 *   ├──────────────────────────────────┤
 *   │    Hand Instructions (240px)     │
 *   └──────────────────────────────────┘
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import { useMapViewStore, useLocationStore } from '../../store'
import { createLogger } from '../../core/logger'
import { pixelToLatLng } from '../../core/utils'
import MapScreen from '../MapScreen/MapScreen'
import HandInstructions from './HandInstructions'
import HandCursor from '../../components/HandCursor'
import MapPulse from '../../components/MapPulse'
import HoldPulse from '../../components/HoldPulse/HoldPulse'
import CooldownPill from '../../components/CooldownPill/CooldownPill'
import type { HandState, HandSide } from '../../components/HandCursor'
import styles from './B2MapScreen.module.css'

const log = createLogger('SCREEN:B2-MAP')

// ─── DESIGN DIMENSIONS ───────────────────────────────────────────────────────
// The .screen element is DESIGN_W × DESIGN_H and is scaled to fit the window
// via CSS transform. All hand coords stay in this design space.

const DESIGN_W = 1800
const DESIGN_H = 1800

// ─── MAP AREA BOUNDS (in design space) ───────────────────────────────────────
// The map canvas occupies the grid cell inside the 60px border and above the
// 240px instruction strip (see B2MapScreen.module.css).

const MAP_LEFT = 60
const MAP_TOP = 60
const MAP_RIGHT = DESIGN_W - 60         // 1740
const MAP_BOTTOM = DESIGN_H - 240       // 1560
const MAP_W = MAP_RIGHT - MAP_LEFT      // 1680
const MAP_H = MAP_BOTTOM - MAP_TOP      // 1500

// ─── GESTURE THRESHOLDS ──────────────────────────────────────────────────────
// FLAG: Adjust these thresholds during testing with real MediaPipe data.

/** ILoveYou confidence threshold for grab (pan/pinch). */
const GRAB_THRESHOLD = 0.8

/** Pointing_Up confidence threshold for aim preview. */
const POINT_THRESHOLD = 0.5

// ─── POINT-SELECT TIMING ─────────────────────────────────────────────────────

/** How long the user must hold the pointer gesture before a selection fires. */
const POINT_HOLD_MS = 2000

/** Grace period after a gesture drop — if gesture resumes within this
 *  window, the hold continues. Tolerates MediaPipe confidence flicker. */
const POINT_GRACE_MS = 200

/** Cooldown after a successful selection. Prevents the room changing too
 *  often. During cooldown, pointer gestures are ignored and a pill UI
 *  shows the countdown. */
const SELECT_COOLDOWN_MS = 30_000

// ─── Types ───────────────────────────────────────────────────────────────────

interface HandTracker {
  x: number          // Design-space pixel position from left edge (0–DESIGN_W)
  y: number          // Design-space pixel position from top edge (0–DESIGN_H)
  isGrabbing: boolean // /hN:ILoveYou >= GRAB_THRESHOLD — only the ILoveYou handler writes this
  isPointing: boolean // /hN:Pointing_Up >= POINT_THRESHOLD — only the Pointing_Up handler writes this
  hand: HandSide     // 'left' | 'right'
  visible: boolean   // Whether this hand is currently detected
}

// Derive the visible cursor state from the two independent gesture flags.
// Pointing wins over grabbing; neither → open palm.
const deriveHandState = (h: HandTracker): HandState =>
  h.isPointing ? 'pointing' : h.isGrabbing ? 'closed' : 'open'

type HoldPhase = 'idle' | 'holding' | 'cooldown'

interface HoldState {
  phase: HoldPhase
  holdingHand: 1 | 2 | null
  capturedX: number         // design-space coords at gesture start
  capturedY: number
  startedAt: number
  graceEndsAt: number | null
  cooldownEndsAt: number
}

// Helper: is a design-space coordinate inside the visible map area?
const isInMapBounds = (x: number, y: number): boolean =>
  x >= MAP_LEFT && x <= MAP_RIGHT && y >= MAP_TOP && y <= MAP_BOTTOM

// ─── Component ───────────────────────────────────────────────────────────────

const B2MapScreen: React.FC = () => {
  log.info('B2MapScreen mounted')

  const setExploreLocation = useLocationStore((s) => s.setExploreLocation)
  const socketRef = useRef<Socket | null>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const mapContainerRef = useRef<HTMLDivElement>(null)

  // ─── SCALE-TO-FIT ───────────────────────────────────────────────────────
  // Shrinks the 1800×1800 design to fit the current window during dev.
  // At exhibit resolution (1800×1800 window) the scale is 1:1.
  //
  // We keep scaleFactorRef in sync so SIM mouse handlers can convert
  // window-pixel mouse events back into design-space coordinates.

  const scaleFactorRef = useRef(1)

  useEffect(() => {
    const updateScale = () => {
      if (!screenRef.current) return
      const s = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H)
      screenRef.current.style.setProperty('--scale-factor', String(s))
      scaleFactorRef.current = s
    }
    updateScale()
    window.addEventListener('resize', updateScale)
    return () => window.removeEventListener('resize', updateScale)
  }, [])

  // ─── HAND STATE ─────────────────────────────────────────────────────────
  //
  // Two hands tracked independently, both in DESIGN-SPACE pixels (0–1800).
  // Each hand remembers its own x, y, gesture state, and visibility.
  //
  // IMPORTANT — why we use `prev` in every setter:
  //   TouchDesigner sends x and y as SEPARATE messages (/h1tx then /h1ty).
  //   If we just wrote `setHand1({ x: newX, y: 0 })` the y would be wiped.
  //   Using `prev => ({ ...prev, x: newX })` keeps all existing values and
  //   only changes the one field we care about.

  const [hand1, setHand1] = useState<HandTracker>({
    x: 0, y: 0, isGrabbing: false, isPointing: false, hand: 'right', visible: false,
  })

  const [hand2, setHand2] = useState<HandTracker>({
    x: 0, y: 0, isGrabbing: false, isPointing: false, hand: 'left', visible: false,
  })

  // ─── SIM MODE (default OFF) ─────────────────────────────────────────────
  const [simMode, setSimMode] = useState(false)
  const [pulseTrigger, setPulseTrigger] = useState(0)

  // ─── POINT-HOLD STATE MACHINE ───────────────────────────────────────────
  //
  // Single state machine for the entire hold-to-select flow. Either hand
  // can start a hold; once one hand owns the hold, the other hand's
  // pointer gesture is ignored until the hold completes or cancels.
  //
  // holdStateRef is the source of truth (read by OSC/mouse handlers);
  // the React state mirrors it for rendering.

  const holdStateRef = useRef<HoldState>({
    phase: 'idle',
    holdingHand: null,
    capturedX: 0,
    capturedY: 0,
    startedAt: 0,
    graceEndsAt: null,
    cooldownEndsAt: 0,
  })

  const [holdPhase, setHoldPhase] = useState<HoldPhase>('idle')
  const [holdPos, setHoldPos] = useState<{ x: number; y: number } | null>(null)
  const [pulsePos, setPulsePos] = useState<{ x: number; y: number } | null>(null)
  const [cooldownEndsAt, setCooldownEndsAt] = useState<number | null>(null)

  // ─── PINCH-ZOOM TRACKING ────────────────────────────────────────────────
  //
  // When BOTH hands are in ILoveYou (grab), we track the distance between
  // them. As that distance changes we zoom the map in or out.

  const lastPinchDistRef = useRef<number | null>(null)
  const hand1Ref = useRef(hand1)
  const hand2Ref = useRef(hand2)

  // Keep refs in sync with state so gesture handlers always see fresh values
  useEffect(() => { hand1Ref.current = hand1 }, [hand1])
  useEffect(() => { hand2Ref.current = hand2 }, [hand2])

  // ─── POINT-HOLD: START (leading edge of pointer gesture) ────────────────
  //
  // Called when a hand's pointing confidence crosses POINT_THRESHOLD.
  // Captures the hand's position and begins the 2s hold.
  //
  // Ignored if:
  //   - Cooldown is active (pill still counting down)
  //   - Another hand is already holding (one hold at a time)
  //   - Hand is outside the map area (no selection off-map)
  //
  // Special case: if the same hand re-raises within the grace period
  // after a brief drop, we resume the hold without resetting.

  const startHold = useCallback((handNum: 1 | 2, x: number, y: number) => {
    const state = holdStateRef.current
    const now = Date.now()

    // Cooldown active → ignore all pointer gestures
    if (state.phase === 'cooldown') {
      log.debug('Point: ignoring during cooldown', {
        remainingMs: state.cooldownEndsAt - now,
      })
      return
    }

    // Already holding
    if (state.phase === 'holding') {
      // Same hand recovering from a brief drop within grace → resume
      if (
        state.holdingHand === handNum
        && state.graceEndsAt !== null
        && now < state.graceEndsAt
      ) {
        state.graceEndsAt = null
        log.info('Point: resumed within grace period', { hand: handNum })
        return
      }
      // Otherwise (other hand, or same hand past grace) → ignore
      log.debug('Point: ignored — hold already in progress', {
        owningHand: state.holdingHand,
        attemptingHand: handNum,
      })
      return
    }

    // Bounds check — hand must be over the visible map area
    if (!isInMapBounds(x, y)) {
      log.info('Point: out of map bounds, ignoring', {
        x: x.toFixed(0),
        y: y.toFixed(0),
        bounds: { MAP_LEFT, MAP_TOP, MAP_RIGHT, MAP_BOTTOM },
      })
      return
    }

    // Start a new hold
    state.phase = 'holding'
    state.holdingHand = handNum
    state.capturedX = x
    state.capturedY = y
    state.startedAt = now
    state.graceEndsAt = null

    setHoldPhase('holding')
    setHoldPos({ x, y })

    log.info('Point: hold started', {
      hand: handNum,
      x: x.toFixed(0),
      y: y.toFixed(0),
    })
  }, [])

  // ─── POINT-HOLD: RELEASE (gesture drops below threshold) ────────────────
  //
  // Starts the grace period. If gesture resumes within POINT_GRACE_MS,
  // the hold continues (startHold re-entry path). If grace expires
  // without resume, the RAF loop cancels the hold.

  const releaseHold = useCallback((handNum: 1 | 2) => {
    const state = holdStateRef.current

    if (state.phase !== 'holding' || state.holdingHand !== handNum) return

    state.graceEndsAt = Date.now() + POINT_GRACE_MS
    log.debug('Point: gesture dropped, grace period started', { hand: handNum })
  }, [])

  // ─── HOLD LOOP — runs while phase === 'holding' ────────────────────────
  //
  // One RAF-driven loop handles both outcomes:
  //   1. Hold duration elapses (2s) → FIRE selection, enter cooldown
  //   2. Grace period expires      → CANCEL, back to idle

  useEffect(() => {
    if (holdPhase !== 'holding') return

    let rafId = 0
    let cancelled = false

    const tick = () => {
      if (cancelled) return
      const state = holdStateRef.current
      const now = Date.now()

      if (state.phase !== 'holding') return

      // Grace expired without resumption → cancel
      if (state.graceEndsAt !== null && now >= state.graceEndsAt) {
        state.phase = 'idle'
        state.holdingHand = null
        state.graceEndsAt = null
        setHoldPhase('idle')
        setHoldPos(null)
        log.info('Point: grace expired → hold cancelled')
        return
      }

      // Hold duration complete → fire selection
      if (now - state.startedAt >= POINT_HOLD_MS) {
        const capturedX = state.capturedX
        const capturedY = state.capturedY

        // Local design-space coords (used to position MapPulse/HoldPulse
        // inside the scaled .mapContainer via CSS — design px are correct there)
        const localDesignX = capturedX - MAP_LEFT
        const localDesignY = capturedY - MAP_TOP

        // For lat/lng we need WINDOW-pixel coords because pixelToLatLng
        // expects pixel offsets in the same units as the canvas's drawing
        // resolution. The map canvas renders at window-scale resolution, so
        // we convert captured design coords → window coords using the current
        // scale factor and the actual map rect's bounding box. This is the
        // same math MapScreen's own handlers use.
        const mapRect = mapContainerRef.current?.getBoundingClientRect()
        const s = scaleFactorRef.current || 1
        const capturedWindowX = capturedX * s
        const capturedWindowY = capturedY * s
        const localWindowX = mapRect ? capturedWindowX - mapRect.left : localDesignX
        const localWindowY = mapRect ? capturedWindowY - mapRect.top : localDesignY
        const canvasW = mapRect ? mapRect.width : MAP_W
        const canvasH = mapRect ? mapRect.height : MAP_H

        const { centerLat, centerLng, zoom } = useMapViewStore.getState()
        const coords = pixelToLatLng(
          localWindowX, localWindowY,
          centerLat, centerLng,
          zoom,
          canvasW, canvasH,
        )

        log.info('Point: hold complete → FIRE', {
          lat: coords.lat.toFixed(5),
          lng: coords.lng.toFixed(5),
          hand: state.holdingHand,
          capturedDesign: { x: capturedX, y: capturedY },
          capturedWindow: { x: capturedWindowX, y: capturedWindowY },
          canvas: { w: canvasW, h: canvasH },
        })

        setExploreLocation(coords.lat, coords.lng)
        setPulsePos({ x: localDesignX, y: localDesignY })

        // Enter cooldown
        const endsAt = now + SELECT_COOLDOWN_MS
        state.phase = 'cooldown'
        state.holdingHand = null
        state.graceEndsAt = null
        state.cooldownEndsAt = endsAt

        setHoldPhase('cooldown')
        setHoldPos(null)
        setCooldownEndsAt(endsAt)
        return
      }

      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
  }, [holdPhase, setExploreLocation])

  // ─── COOLDOWN EXPIRY — pill counts down and calls this at 0 ──────────────

  const handleCooldownExpire = useCallback(() => {
    const state = holdStateRef.current
    if (state.phase !== 'cooldown') return

    state.phase = 'idle'
    state.cooldownEndsAt = 0

    setHoldPhase('idle')
    setCooldownEndsAt(null)

    log.info('Cooldown expired — ready for new selection')
  }, [])

  // ─── PAN MAP (single closed fist drag) ───────────────────────────────────

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

    const bothFists = h1.isGrabbing && h2.isGrabbing
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
    // Hand x/y positions are converted to DESIGN SPACE (0–1800) so they
    // align with CSS layout regardless of the current window scale.

    socket.on('osc', (msg: { address: string; args: number[] }) => {
      console.log('[B2-MAP] OSC IN:', msg.address, msg.args)

      // ── Hand 1 position ──────────────────────────────────────────────────
      // Camera is 180° flipped, so we invert: (1 - value). Output is in
      // design space (0–DESIGN_W / 0–DESIGN_H).
      if (msg.address === '/h1tx') {
        const xDesign = (1 - msg.args[0]) * DESIGN_W
        setHand1(prev => {
          if (prev.isGrabbing) handleFistGesture(1, xDesign, prev.y)
          return { ...prev, x: xDesign, visible: true }
        })
      }

      if (msg.address === '/h1ty') {
        const yDesign = (1 - msg.args[0]) * DESIGN_H
        setHand1(prev => {
          if (prev.isGrabbing) handleFistGesture(1, prev.x, yDesign)
          return { ...prev, y: yDesign, visible: true }
        })
      }

      // ── Hand 2 position ──────────────────────────────────────────────────
      if (msg.address === '/h2tx') {
        const xDesign = (1 - msg.args[0]) * DESIGN_W
        setHand2(prev => {
          if (prev.isGrabbing) handleFistGesture(2, xDesign, prev.y)
          return { ...prev, x: xDesign, visible: true }
        })
      }

      if (msg.address === '/h2ty') {
        const yDesign = (1 - msg.args[0]) * DESIGN_H
        setHand2(prev => {
          if (prev.isGrabbing) handleFistGesture(2, prev.x, yDesign)
          return { ...prev, y: yDesign, visible: true }
        })
      }

      // ── Hand 1 gesture: ILoveYou = grab (pan / pinch-zoom) ─────────────
      // Writes ONLY isGrabbing — never touches isPointing so the two gestures
      // cannot clobber each other on frames where MediaPipe emits both.
      if (msg.address === '/h1:ILoveYou') {
        const confidence = msg.args[0] ?? 0
        const grabActive = confidence >= GRAB_THRESHOLD
        if (!grabActive) lastFistPosRef.current = null
        setHand1(prev => {
          if (prev.isGrabbing !== grabActive) {
            console.log('[HAND-1] grab', { from: prev.isGrabbing, to: grabActive, confidence: confidence.toFixed(2) })
          }
          return { ...prev, isGrabbing: grabActive }
        })
      }

      // ── Hand 1 gesture: Pointing_Up = hold-to-select ───────────────────
      // Writes ONLY isPointing. Leading edge (false→true) starts the hold,
      // trailing edge (true→false) releases it.
      if (msg.address === '/h1:Pointing_Up') {
        const confidence = msg.args[0] ?? 0
        const pointActive = confidence >= POINT_THRESHOLD
        setHand1(prev => {
          if (prev.isPointing !== pointActive) {
            console.log('[HAND-1] point', { from: prev.isPointing, to: pointActive, confidence: confidence.toFixed(2) })
            if (pointActive) startHold(1, prev.x, prev.y)
            else releaseHold(1)
          }
          return { ...prev, isPointing: pointActive }
        })
      }

      // ── Hand 2 gesture: ILoveYou = grab ────────────────────────────────
      if (msg.address === '/h2:ILoveYou') {
        const confidence = msg.args[0] ?? 0
        const grabActive = confidence >= GRAB_THRESHOLD
        if (!grabActive) lastPinchDistRef.current = null
        setHand2(prev => {
          if (prev.isGrabbing !== grabActive) {
            console.log('[HAND-2] grab', { from: prev.isGrabbing, to: grabActive, confidence: confidence.toFixed(2) })
          }
          return { ...prev, isGrabbing: grabActive }
        })
      }

      // ── Hand 2 gesture: Pointing_Up = hold-to-select ───────────────────
      if (msg.address === '/h2:Pointing_Up') {
        const confidence = msg.args[0] ?? 0
        const pointActive = confidence >= POINT_THRESHOLD
        setHand2(prev => {
          if (prev.isPointing !== pointActive) {
            console.log('[HAND-2] point', { from: prev.isPointing, to: pointActive, confidence: confidence.toFixed(2) })
            if (pointActive) startHold(2, prev.x, prev.y)
            else releaseHold(2)
          }
          return { ...prev, isPointing: pointActive }
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
  }, [handleFistGesture, startHold, releaseHold]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── BROADCAST LOCATION CHANGES TO WRAP SCREEN ───────────────────────────
  //
  // Whenever the active location changes (from a pointing-gesture selection,
  // a tap on the flat map, etc.) emit it over WebSocket so the Wrap screen
  // updates its terrain. Also bumps pulseTrigger so MapPulse re-animates.

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
  //   Left mouse move          = hand 1 position (open palm)
  //   Left mouse held          = closed fist (pan)
  //   Left mouse release       = open palm (stops pan)
  //   Right mouse down         = pointing gesture start (begins 2s hold)
  //   Right mouse up           = pointing release (may cancel within grace)
  //   "M" key                  = toggle sim on/off
  //
  // Mouse events arrive in WINDOW pixels; we convert to DESIGN space by
  // dividing by the current --scale-factor so everything downstream works
  // in a single coordinate system.

  useEffect(() => {
    const toDesign = (clientX: number, clientY: number) => {
      const s = scaleFactorRef.current || 1
      return { x: clientX / s, y: clientY / s }
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!simMode) return
      const { x, y } = toDesign(e.clientX, e.clientY)
      setHand1(prev => {
        if (prev.isGrabbing) handleFistGesture(1, x, y)
        return { ...prev, x, y, visible: true }
      })
    }

    const handleMouseDown = (e: MouseEvent) => {
      if (!simMode) return
      if (e.button === 0) {
        // Left button = fist (pan) — sets isGrabbing only
        setHand1(prev => {
          if (!prev.isGrabbing) console.log('[HAND-1] grab', { from: false, to: true, source: 'sim' })
          return { ...prev, isGrabbing: true }
        })
      }
    }

    const handleMouseUp = (e: MouseEvent) => {
      if (!simMode) return
      if (e.button === 0) {
        // Left release = stop pan — clears isGrabbing only
        lastFistPosRef.current = null
        setHand1(prev => {
          if (prev.isGrabbing) console.log('[HAND-1] grab', { from: true, to: false, source: 'sim' })
          return { ...prev, isGrabbing: false }
        })
      }
    }

    const handleContextMenu = (e: MouseEvent) => {
      if (!simMode) return
      e.preventDefault()
      // Right click down = start pointing hold — sets isPointing only
      const { x, y } = toDesign(e.clientX, e.clientY)
      setHand1(prev => {
        if (!prev.isPointing) {
          console.log('[HAND-1] point', { from: false, to: true, source: 'sim' })
          startHold(1, x, y)
        }
        return { ...prev, x, y, isPointing: true, visible: true }
      })
    }

    // Right-mouse-up releases the pointing gesture (grace, then cancel).
    // We use auxclick for the release so we can distinguish from the
    // contextmenu event above.
    const handleAuxUp = (e: MouseEvent) => {
      if (!simMode) return
      if (e.button !== 2) return
      setHand1(prev => {
        if (prev.isPointing) {
          console.log('[HAND-1] point', { from: true, to: false, source: 'sim' })
          releaseHold(1)
        }
        return { ...prev, isPointing: false }
      })
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
    window.addEventListener('mouseup', handleAuxUp)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('contextmenu', handleContextMenu)
      window.removeEventListener('mouseup', handleAuxUp)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [simMode, handleFistGesture, startHold, releaseHold])

  // ─── RENDER ──────────────────────────────────────────────────────────────
  //
  // HoldPulse and MapPulse live inside the map container so their overflow
  // is clipped to the map bounds (rings don't bleed into the instruction
  // strip). They use map-container-local pixel coordinates.
  //
  // CooldownPill sits at the top of the .screen (above the map area) so
  // it's visible in the 60px top border strip.

  const holdLocalPos = holdPos
    ? { x: holdPos.x - MAP_LEFT, y: holdPos.y - MAP_TOP }
    : null

  return (
    <div ref={screenRef} className={styles.screen}>

      {/* SIM MODE TOGGLE — top-right corner */}
      {/* Left click/drag = pan, right-click+hold = point-select */}
      <button
        className={styles.simToggle}
        onClick={() => setSimMode(prev => !prev)}
        title={simMode
          ? 'SIM ON — Left drag = pan, Right-click+hold 2s = select. Press M to toggle.'
          : 'SIM OFF — reading real TouchDesigner OSC data. Press M to toggle.'}
      >
        {simMode ? 'SIM ON' : 'SIM OFF'}
      </button>

      {/* Cooldown countdown pill — shows after a successful selection */}
      <CooldownPill
        cooldownEndsAt={cooldownEndsAt}
        onExpire={handleCooldownExpire}
      />

      {/* Map — grid row 2, col 2 */}
      <div ref={mapContainerRef} className={styles.mapContainer}>
        <MapScreen exhibitMode={true} />

        {/* Selection confirmation rings — expands from selected point */}
        <MapPulse
          trigger={pulseTrigger}
          x={pulsePos?.x}
          y={pulsePos?.y}
        />

        {/* Hold-to-select progress animation — at captured hand position */}
        {holdLocalPos && (
          <HoldPulse
            x={holdLocalPos.x}
            y={holdLocalPos.y}
            active={holdPhase === 'holding'}
          />
        )}
      </div>

      {/* Hand gesture instructions — 240px bottom strip */}
      <div className={styles.instructionStrip}>
        <HandInstructions />
      </div>

      {/* ── HAND CURSORS ──────────────────────────────────────────────────── */}
      {/* Hand 1 (right hand by default)                                      */}
      {/*   open    = idle cursor                                              */}
      {/*   closed  = fist icon (pan / pinch-zoom)                            */}
      {/*   pointing= finger icon (hold 2s to select)                         */}
      <HandCursor
        x={hand1.x} y={hand1.y}
        state={deriveHandState(hand1)} hand={hand1.hand}
        visible={hand1.visible}
      />

      {/* Hand 2 (left hand by default) */}
      <HandCursor
        x={hand2.x} y={hand2.y}
        state={deriveHandState(hand2)} hand={hand2.hand}
        visible={hand2.visible}
      />

    </div>
  )
}

export default B2MapScreen
