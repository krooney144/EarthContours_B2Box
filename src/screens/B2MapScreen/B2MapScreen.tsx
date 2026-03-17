/**
 * B2 Map Screen — Fullscreen top-down table projection surface
 *
 * Fixed 1920×1080 layout for ceiling-mounted projector on a table.
 * Visitors stand around all 4 sides and interact via control strips
 * (for testing) or via MediaPipe hand tracking (for the exhibit).
 *
 * ─── OSC / WEBSOCKET INTEGRATION ───
 *
 * This screen receives MediaPipe hand tracking data via OSC:
 *
 *   /hand_1_pos    [x_norm, y_norm]   — Hand 1 position (normalized 0–1)
 *   /hand_2_pos    [x_norm, y_norm]   — Hand 2 position (normalized 0–1)
 *   /hand_1_state  [state]            — Hand 1: 0=open, 1=fist, 2=pointing
 *   /hand_2_state  [state]            — Hand 2: 0=open, 1=fist, 2=pointing
 *
 * How it works:
 *   - OPEN HAND (state=0) = cursor moves around, just hovering
 *   - CLOSED FIST (state=1) = "click" — if near crosshair, selects location
 *   - POINTING (state=2) = directional input
 *
 * When a location is selected (fist at crosshair or SELECT button),
 * it's broadcast via WebSocket to the Wrap screen.
 *
 * MOUSE SIMULATION:
 *   - Press "M" key or click "SIM" button to toggle simulation mode
 *   - SIM ON: mouse = hand 1, mouse button held = fist, released = open palm
 *   - This lets you test without MediaPipe hardware
 *
 * ─── NOTE FOR TESTING TOMORROW ───
 * The OSC addresses above (/hand_1_pos, /hand_2_pos, etc.) are PLACEHOLDERS.
 * When you connect the real MediaPipe system, update the addresses in the
 * socket.on('osc', ...) handler below to match whatever your MediaPipe
 * bridge actually sends. Search for "MEDIAPIPE OSC ADDRESSES" in this file.
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
import type { HandState, HandSide } from '../../components/HandCursor'
import styles from './B2MapScreen.module.css'

const log = createLogger('SCREEN:B2-MAP')

// ─── Hand Tracker State Interface ──────────────────────────────────────────
// Each detected hand has a position, state, and visibility flag.

interface HandTracker {
  x: number         // Pixel position from left edge
  y: number         // Pixel position from top edge
  state: HandState  // 'open' | 'closed' | 'pointing'
  hand: HandSide    // 'left' | 'right'
  visible: boolean  // Whether this hand is currently detected
}

const B2MapScreen: React.FC = () => {
  log.info('B2MapScreen mounted')

  const setExploreLocation = useLocationStore((s) => s.setExploreLocation)
  const socketRef = useRef<Socket | null>(null)

  // ─── HAND CURSOR STATE ───────────────────────────────────────────────
  // Two hands can be tracked simultaneously.
  // Each hand has position (x,y), state (open/closed/pointing), and visibility.

  const [hand1, setHand1] = useState<HandTracker>({
    x: 0, y: 0, state: 'open', hand: 'right', visible: false,
  })
  const [hand2, setHand2] = useState<HandTracker>({
    x: 0, y: 0, state: 'open', hand: 'left', visible: false,
  })

  // ─── MOUSE SIMULATION MODE ──────────────────────────────────────────
  // When SIM is ON (default), mouse drives hand 1:
  //   - Mouse move = hand position (open palm)
  //   - Mouse button held = closed fist (click action)
  //   - Release = back to open palm
  // Toggle with "SIM" button or "M" key.

  const [simMode, setSimMode] = useState(true)

  // ─── SOCKET.IO + OSC CONNECTION ────────────────────────────────────────
  //
  // Connects to the Express server (index.js) via Socket.IO.
  // The server forwards all OSC messages as "osc" events.
  //
  // We listen for MediaPipe hand tracking OSC messages and
  // also EMIT "location:update" when a location is selected
  // so the Wrap screen can update.

  useEffect(() => {
    const socket = io()
    socketRef.current = socket

    socket.on('connect', () => {
      log.info('WebSocket connected to server', { id: socket.id })
    })

    // ── OSC MESSAGE HANDLER ──────────────────────────────────────────
    //
    // ╔══════════════════════════════════════════════════════════════╗
    // ║  MEDIAPIPE OSC ADDRESSES — UPDATE THESE WHEN TESTING!      ║
    // ║                                                            ║
    // ║  The addresses below are PLACEHOLDERS. When you connect    ║
    // ║  the real MediaPipe system, change them to match whatever  ║
    // ║  your MediaPipe-to-OSC bridge actually sends.              ║
    // ║                                                            ║
    // ║  Current placeholder addresses:                            ║
    // ║    /hand_1_pos    [x_norm, y_norm]    — hand 1 position    ║
    // ║    /hand_2_pos    [x_norm, y_norm]    — hand 2 position    ║
    // ║    /hand_1_state  [0|1|2]             — hand 1 gesture     ║
    // ║    /hand_2_state  [0|1|2]             — hand 2 gesture     ║
    // ║                                                            ║
    // ║  State values: 0=open palm, 1=closed fist, 2=pointing      ║
    // ╚══════════════════════════════════════════════════════════════╝

    socket.on('osc', (msg: { address: string; args: number[] }) => {
      // Log every OSC message so you can see what's coming in
      console.log('[B2-MAP] OSC:', msg.address, msg.args)

      // ── Hand 1 position ──
      if (msg.address === '/hand_1_pos') {
        const xPixel = msg.args[0] * window.innerWidth
        const yPixel = msg.args[1] * window.innerHeight
        setHand1(prev => ({ ...prev, x: xPixel, y: yPixel, visible: true }))
      }

      // ── Hand 2 position ──
      if (msg.address === '/hand_2_pos') {
        const xPixel = msg.args[0] * window.innerWidth
        const yPixel = msg.args[1] * window.innerHeight
        setHand2(prev => ({ ...prev, x: xPixel, y: yPixel, visible: true }))
      }

      // ── Hand 1 state (open/closed/pointing) ──
      if (msg.address === '/hand_1_state') {
        const stateValue = msg.args[0]
        const state: HandState =
          stateValue === 1 ? 'closed' :
          stateValue === 2 ? 'pointing' : 'open'
        setHand1(prev => ({ ...prev, state }))

        // If fist closes (state=1), treat it like a "click" — select location
        if (stateValue === 1) {
          handleFistSelect()
        }
      }

      // ── Hand 2 state ──
      if (msg.address === '/hand_2_state') {
        const stateValue = msg.args[0]
        const state: HandState =
          stateValue === 1 ? 'closed' :
          stateValue === 2 ? 'pointing' : 'open'
        setHand2(prev => ({ ...prev, state }))
      }
    })

    socket.on('disconnect', () => {
      log.warn('WebSocket disconnected from server')
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── FIST SELECT — SELECT LOCATION WHEN FIST CLOSES ──────────────────
  // When a closed fist is detected (from OSC or mouse sim), this selects
  // the current map center location and broadcasts it to the Wrap screen.

  const handleFistSelect = useCallback(() => {
    const { centerLat, centerLng } = useMapViewStore.getState()
    log.info('Fist-select: choosing location', {
      lat: centerLat.toFixed(4),
      lng: centerLng.toFixed(4),
    })

    // Update location locally — the store subscription above
    // automatically broadcasts to the Wrap screen via WebSocket
    setExploreLocation(centerLat, centerLng)
  }, [setExploreLocation])

  // ─── BROADCAST LOCATION CHANGES TO WRAP SCREEN ─────────────────────────
  // Subscribe to locationStore — whenever activeLat/activeLng change
  // (from map click, SELECT button, fist-select, etc.), broadcast via
  // WebSocket so the Wrap screen updates its terrain.

  useEffect(() => {
    const unsub = useLocationStore.subscribe((state, prevState) => {
      if (state.activeLat !== prevState.activeLat || state.activeLng !== prevState.activeLng) {
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

  // ─── MOUSE SIMULATION FOR TESTING ───────────────────────────────────────
  //
  // When simMode is ON:
  //   - Mouse move = hand 1 position (open palm cursor)
  //   - Mouse button held = hand switches to closed fist
  //   - Mouse click (button release after press) = fist select at crosshair
  //   - Press "M" to toggle sim mode on/off

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!simMode) return
      setHand1(prev => ({
        ...prev,
        x: e.clientX,
        y: e.clientY,
        visible: true,
      }))
    }

    const handleMouseDown = () => {
      if (!simMode) return
      // Mouse button down = closed fist
      setHand1(prev => ({ ...prev, state: 'closed' }))
    }

    const handleMouseUp = () => {
      if (!simMode) return
      // Mouse button up = back to open palm
      setHand1(prev => ({ ...prev, state: 'open' }))
      // Treat mouse click as fist-select (select location at crosshair)
      handleFistSelect()
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'm' || e.key === 'M') {
        setSimMode(prev => !prev)
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [simMode, handleFistSelect])

  // ─── RENDER ──────────────────────────────────────────────────────────────

  return (
    <div className={styles.screen}>
      {/* SIM MODE TOGGLE — small button in top-right corner */}
      {/* Click this to switch between mouse simulation and real OSC input */}
      <button
        className={styles.simToggle}
        onClick={() => setSimMode(prev => !prev)}
        title={simMode
          ? 'Mouse simulation ON — mouse = hand cursor, click = fist select. Press M to toggle.'
          : 'Mouse simulation OFF — only real MediaPipe OSC data. Press M to toggle.'}
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
          {/* Crosshair overlay — target indicator at center */}
          <div className={styles.crosshair} aria-hidden="true">
            <div className={styles.crosshairH} />
            <div className={styles.crosshairV} />
            <div className={styles.crosshairDot} />
          </div>
        </div>

        <div className={styles.rightStrip}>
          <ControlStrip side="right" />
        </div>
      </div>

      {/* Bottom control strip */}
      <div className={styles.bottomStrip}>
        <ControlStrip side="bottom" />
      </div>

      {/* ── HAND CURSORS ─────────────────────────────────────────────── */}
      {/* These hand icons show where MediaPipe detects hands.           */}
      {/* In SIM mode, hand 1 follows your mouse cursor.                 */}
      {/* Open palm = hovering, closed fist = selecting.                 */}
      <HandCursor
        x={hand1.x} y={hand1.y}
        state={hand1.state} hand={hand1.hand}
        visible={hand1.visible}
      />
      <HandCursor
        x={hand2.x} y={hand2.y}
        state={hand2.state} hand={hand2.hand}
        visible={hand2.visible}
      />
    </div>
  )
}

export default B2MapScreen
