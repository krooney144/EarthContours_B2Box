/**
 * B2 Wrap Screen — 360° Cylindrical Projection Surface
 *
 * Renders a full 360° panorama on a 10880×1080 canvas for cylindrical
 * projection in the B2 venue. North is centered (pixel ~5440), South is
 * split at both edges. East is to the right of North, West to the left.
 *
 * Uses the same skyline worker and rendering pipeline as ScanScreen but
 * with a fixed 360° horizontal FOV and no drag/gyro/zoom interaction.
 *
 * ─── OSC / WEBSOCKET INTEGRATION ───
 *
 * This screen receives TWO types of real-time data:
 *
 * 1. TRACKER PORTALS (from motion capture via OSC)
 *    - OSC addresses: /trk_1_xy_loc  and  /trk_2_xy_loc
 *    - Args: [y_normalized, x_normalized, layer_fraction]
 *    - These show glowing portal circles where the trackers are pointing
 *
 * 2. LOCATION UPDATES (from map screen via WebSocket)
 *    - Event: "location:update"  with { lat, lng }
 *    - When someone selects a location on the Map screen, this screen
 *      updates its terrain to show the new location
 *
 * MOUSE SIMULATION:
 *    - Press "M" key or click "SIM" button to toggle mouse simulation mode
 *    - When SIM is ON, moving your mouse drives tracker portal 1
 *    - This lets you test the portal overlay without real OSC hardware
 *
 * Controls:
 *   - AGL height slider (vertical, left edge — HIGH at top, LOW at bottom)
 *   - /trk_4_z_loc OSC address can also drive AGL height (FLAG: range 1–8)
 *   - Coordinate/elevation overlay (bottom center, under North)
 *
 * SCOPE OVERLAYS:
 *   - Trackers now render as circular magnified terrain scopes (not simple portals)
 *   - Scope size driven by layer_fraction (3rd OSC arg, FLAG: range 0–8)
 *   - Each scope shows distance-to-terrain at its center bearing
 *   - Distance is looked up from skyline band data (nearest band with valid data)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { io, Socket } from 'socket.io-client'
import { useCameraStore, useLocationStore, useSettingsStore } from '../../store'
import { createLogger } from '../../core/logger'
import { MAX_HEIGHT_M, MIN_HEIGHT_M } from '../../core/constants'
import { formatElevation, metersToFeet } from '../../core/utils'
import { fetchPeaksNear } from '../../data/peakLoader'
import { fetchPlaceName } from '../../data/locationNameLoader'
import { getPeaksInBounds } from '../../data/peakDatabase'
import type { Peak, SkylineData, RefinedArc, PeakRefineItem, SilhouetteLayer } from '../../core/types'
import { DEPTH_BANDS } from '../../core/types'
import {
  type CameraParams, type ProjectedBands, type ProjectedRefinedArc,
  type PrebuiltContourStrand, type PeakScreenPos, type SilhouetteStrand,
  type VisibilityEnvelope,
  DEG_TO_RAD, EARTH_R, REFRACTION_K, MAX_PEAK_DIST,
  reprojectBands, reprojectRefinedArcs, buildContourStrands,
  project, getHorizonY,
  projectFirstPerson, isPeakVisible,
  skylineAngleAt, bandAngleAt,
  renderTerrain, renderContours,
  drawSkyAndStars,
  generateStars, drawStars, type Star, type StarAngleSource,
  buildSilhouetteLayers, matchSilhouetteStrands,
  renderSilhouetteStrokes, renderSilhouetteGlow,
  buildVisibilityEnvelope,
} from '../ScanScreen/scanRendererCore'
import ScopeOverlay, {
  SCOPE_LAYER_MIN, SCOPE_LAYER_MAX, SCOPE_SIZE_MIN_PX, SCOPE_SIZE_MAX_PX,
} from '../../components/ScopeOverlay'
import TransitionOverlay from '../../components/TransitionOverlay'
import styles from './B2WrapScreen.module.css'

const log = createLogger('SCREEN:B2-WRAP')

// ─── Constants ────────────────────────────────────────────────────────────────

/** Native canvas resolution for the cylindrical projection */
const WRAP_W = 10880
const WRAP_H = 1080

/**
 * Fixed camera for 360° panorama:
 * - heading = 0° (looking North) so that North is centered (x = W/2)
 * - pitch = 0 (horizon at vertical center)
 * - hfov = 360 (full panorama)
 *
 * With heading=0, hfov=360:
 *   North (  0°) → dBearing = 0, x = W/2. ✓ (center)
 *   East  ( 90°) → dBearing = +90°, x = 3W/4. ✓ (right of center)
 *   West  (270°) → dBearing = -90°, x = W/4. ✓ (left of center)
 *   South (180°) → dBearing = ±180°, x = 0 or W. ✓ (split at both edges)
 *
 * The skyline data's natural 0°/360° wrap now sits at centre screen, so
 * contour strands must connect across that boundary (handled by the wrap
 * pass in buildContourStrands). The display seam at ±180° (South) is
 * handled by the |dx| > W/2 seam-break check in the contour and silhouette
 * renderers.
 */
const WRAP_HEADING = 0
const WRAP_PITCH   = 0
const WRAP_HFOV    = 360

// ─── OSC AGL Control ──────────────────────────────────────────────────────────
// FLAG: Adjust these ranges during testing with real OSC hardware.
/** Minimum value from /trk_4_z_loc (maps to MIN_HEIGHT_M) */
const TRK4_Z_MIN = 1
/** Maximum value from /trk_4_z_loc (maps to MAX_HEIGHT_M) */
const TRK4_Z_MAX = 8

let prevZ = 0
const Z_Thresh = 0.2

let prevX1 = 0, prevY1 = 0
let prevX2 = 0, prevY2 = 0
const TRK_XY_Thresh = 0.01

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a layer_fraction value to scope diameter in pixels */
function layerFractionToDiameter(layerFraction: number): number {
  const t = Math.max(0, Math.min(1,
    (layerFraction - SCOPE_LAYER_MIN) / (SCOPE_LAYER_MAX - SCOPE_LAYER_MIN),
  ))
  return SCOPE_SIZE_MIN_PX + t * (SCOPE_SIZE_MAX_PX - SCOPE_SIZE_MIN_PX)
}

/**
 * Fixed wrap camera for bearing/angle reverse-projection.
 * Kept outside the component so reference equality doesn't churn memos.
 */
const WRAP_CAM: CameraParams = {
  heading_deg: WRAP_HEADING,
  pitch_deg:   WRAP_PITCH,
  hfov:        WRAP_HFOV,
  W:           WRAP_W,
  H:           WRAP_H,
}
const WRAP_HORIZON_Y = getHorizonY(WRAP_CAM)
const WRAP_PX_PER_RAD = WRAP_W / (WRAP_HFOV * DEG_TO_RAD)

/**
 * Look up distance to terrain at the point the crosshair is aimed at
 * (bearing AND elevation angle). Finds the nearest silhouette layer whose
 * peak elevation angle is at or above the crosshair — i.e. the first
 * ridgeline the crosshair ray hits. Returns km, or null if aimed at sky.
 */
function distanceAtCrosshair(
  layers: SilhouetteLayer[][],
  silResolution: number,
  numAzimuths: number,
  bearingDeg: number,
  elevAngleRad: number,
): number | null {
  const ai = ((Math.round(bearingDeg * silResolution) % numAzimuths) + numAzimuths) % numAzimuths
  const azLayers = layers[ai]
  if (!azLayers || azLayers.length === 0) return null
  // Layers are sorted near→far; first hit above the ray is the answer.
  for (const layer of azLayers) {
    if (layer.peakAngle >= elevAngleRad) return layer.dist / 1000
  }
  return null
}

// ─── Component ────────────────────────────────────────────────────────────────

const B2WrapScreen: React.FC = () => {
  const { height_m, setHeightFromSlider } = useCameraStore()
  const { activeLat, activeLng } = useLocationStore()
  const setExploreLocation = useLocationStore((s) => s.setExploreLocation)
  const { showBandLines, showFill, showSilhouetteLines, showPeakLabels } = useSettingsStore()
  // B2 wrap is an exhibit display — audience expects imperial.
  // Ignore the settings toggle and hard-code imperial for all audience-visible readouts.
  const units = 'imperial' as const

  const canvasRef       = useRef<HTMLCanvasElement>(null)
  // Stars are drawn on a transparent overlay canvas stacked above the terrain
  // canvas. The overlay has its own RAF loop so stars twinkle independently
  // of terrain redraws (which only fire when data changes).
  const starsCanvasRef  = useRef<HTMLCanvasElement>(null)
  const starsRafRef     = useRef<number>(0)
  const starSourcesRef  = useRef<StarAngleSource[]>([])
  // Offscreen "base" canvas — sky/stars/terrain/contours/silhouette strokes.
  // No silhouette glow, no horizon glow. The scope reads from this canvas so
  // it never sees the magnified glow aliasing. The main wrap canvas composites
  // this base and then draws the glow passes on top.
  const baseCanvasRef   = useRef<HTMLCanvasElement | null>(null)
  const containerRef    = useRef<HTMLDivElement>(null)
  const rafRef          = useRef<number>(0)
  const skylineWorker   = useRef<Worker | null>(null)
  const skylineDataRef  = useRef<SkylineData | null>(null)
  const sliderRef       = useRef<HTMLDivElement>(null)
  const sliderDragRef   = useRef<{ isDragging: boolean; startY: number; startHeight: number }>({
    isDragging: false, startY: 0, startHeight: height_m,
  })

  const [skylineData, setSkylineData]               = useState<SkylineData | null>(null)
  const [isSkylineComputing, setIsSkylineComputing] = useState(false)
  const [skylineProgress, setSkylineProgress]       = useState(0)
  const [refinedArcs, setRefinedArcs]               = useState<RefinedArc[]>([])
  const [osmPeaks, setOsmPeaks]                     = useState<Peak[]>([])
  const [peakPositions, setPeakPositions]           = useState<PeakScreenPos[]>([])
  const [placeName, setPlaceName]                   = useState<string | null>(null)

  // ─── TRACKER PORTAL STATE ────────────────────────────────────────────────
  // These track the positions of motion capture trackers from OSC.
  // Each tracker has x,y (pixel coords) and a visible flag.
  // trk_1_xy_loc → tracker1,  trk_2_xy_loc → tracker2

  const [tracker1, setTracker1] = useState({ x: 0, y: 0, visible: false, diameter: SCOPE_SIZE_MIN_PX })
  const [tracker2, setTracker2] = useState({ x: 0, y: 0, visible: false, diameter: SCOPE_SIZE_MIN_PX })

  // ─── TRANSITION ANIMATION STATE ────────────────────────────────────────
  const [transitionActive, setTransitionActive] = useState(false)
  const [transitionSettling, setTransitionSettling] = useState(false)

  // ─── MOUSE SIMULATION MODE ──────────────────────────────────────────────
  // When SIM is ON (default), mouse movement drives tracker portal 1.
  // Toggle with the "SIM" button or press "M" key.
  // This lets you test the portal overlay without real OSC hardware.

  const [simMode, setSimMode] = useState(true)

  // Keep a ref to the socket so we can access it in cleanup
  const socketRef = useRef<Socket | null>(null)

  // Static worldwide peak database — instant fallback when Overpass is down.
  // Recomputed only when the viewer location changes. ~200-entry scan, sub-ms.
  const databasePeaks = useMemo<Peak[]>(() => {
    const cosLat = Math.cos(activeLat * DEG_TO_RAD)
    // 130 km box matches the peakLoader fetch radius.
    const dLat = 130 / 111.132
    const dLng = 130 / (111.320 * cosLat)
    return getPeaksInBounds(
      activeLat + dLat, activeLat - dLat,
      activeLng + dLng, activeLng - dLng,
    )
  }, [activeLat, activeLng])

  // OSM peaks win when available (richer set); database peaks are the fallback.
  const activePeaks: Peak[] = osmPeaks.length > 0 ? osmPeaks : databasePeaks

  // ── Re-projection on AGL change ─────────────────────────────────────────

  const projectedBands = useMemo<ProjectedBands | null>(() => {
    if (!skylineData) return null
    const viewerElev = skylineData.computedAt.groundElev + height_m
    return reprojectBands(skylineData, viewerElev)
  }, [skylineData, height_m])

  // Visibility envelope built from the full terrain profile. Used to occlude
  // contours, refined arc samples, and peaks behind closer terrain.
  // Recomputes only when skyline data or viewer AGL changes. ~5–10 ms on mobile.
  const visibilityEnvelope = useMemo<VisibilityEnvelope | null>(() => {
    const tp = skylineData?.terrainProfile
    if (!tp) return null
    const viewerElev = skylineData!.computedAt.groundElev + height_m
    return buildVisibilityEnvelope(tp, viewerElev)
  }, [skylineData, height_m])

  const contourStrands = useMemo<PrebuiltContourStrand[]>(() => {
    if (!skylineData) return []
    const viewerElev = skylineData.computedAt.groundElev + height_m
    return buildContourStrands(skylineData, viewerElev, visibilityEnvelope)
  }, [skylineData, height_m, visibilityEnvelope])

  const projectedArcs = useMemo<ProjectedRefinedArc[] | null>(() => {
    if (!skylineData || refinedArcs.length === 0) return null
    const viewerElev = skylineData.computedAt.groundElev + height_m
    return reprojectRefinedArcs(refinedArcs, viewerElev, visibilityEnvelope)
  }, [skylineData, refinedArcs, height_m, visibilityEnvelope])

  // ── Silhouette layers + strand matching (AGL-dependent, runs on height change)
  // Front-to-back sweep over AGL-independent candidates. ~75K atan2 calls, sub-ms.
  const silhouetteLayers = useMemo<SilhouetteLayer[][] | null>(() => {
    if (!skylineData || !skylineData.silhouette) return null
    const viewerElev = skylineData.computedAt.groundElev + height_m
    return buildSilhouetteLayers(skylineData, viewerElev)
  }, [skylineData, height_m])

  // Strand matching (camera is fixed for B2Wrap, so only layer data matters).
  const silhouetteStrands = useMemo<SilhouetteStrand[]>(() => {
    if (!silhouetteLayers || !skylineData?.silhouette) return []
    const fixedCam: CameraParams = {
      heading_deg: WRAP_HEADING,
      pitch_deg:   WRAP_PITCH,
      hfov:        WRAP_HFOV,
      W:           WRAP_W,
      H:           WRAP_H,
    }
    return matchSilhouetteStrands(
      silhouetteLayers,
      skylineData.silhouette.numAzimuths,
      skylineData.silhouette.resolution,
      fixedCam,
    )
  }, [silhouetteLayers, skylineData])

  // Silhouette elevation range (for color normalization) — once per layers change.
  const silElevRange = useMemo<{ min: number; max: number }>(() => {
    if (!silhouetteLayers) return { min: 0, max: 0 }
    let min = Infinity, max = -Infinity
    for (const azLayers of silhouetteLayers) {
      for (const layer of azLayers) {
        if (layer.rawElev > 0 && layer.rawElev < min) min = layer.rawElev
        if (layer.rawElev > max) max = layer.rawElev
      }
    }
    if (min === Infinity) min = 0
    if (max === -Infinity) max = 0
    return { min, max }
  }, [silhouetteLayers])

  const groundElev = skylineData ? skylineData.computedAt.groundElev : 0

  // ── Distance readout for scopes ───────────────────────────────────────────
  // Reverse-project each tracker's (display x, y) through the fixed wrap
  // camera to (bearing, elevation angle), then find the first silhouette
  // layer the crosshair ray hits. This makes the number track what the
  // audience actually sees at the crosshair, not just the horizontal bearing.

  const scopeDistanceAt = useCallback((x: number, y: number): number | null => {
    if (!skylineData || !silhouetteLayers || !skylineData.silhouette) return null
    const containerEl = containerRef.current
    const containerW = containerEl?.clientWidth  ?? WRAP_W
    const containerH = containerEl?.clientHeight ?? WRAP_H
    // Display → native canvas pixels.
    const px = x * (WRAP_W / containerW)
    const py = y * (WRAP_H / containerH)
    // Native → bearing (deg) / elevation angle (rad).
    const dBearingRad = (px - WRAP_W / 2) / WRAP_PX_PER_RAD
    const bearing = ((WRAP_HEADING + dBearingRad / DEG_TO_RAD) % 360 + 360) % 360
    const elevAngle = (WRAP_HORIZON_Y - py) / WRAP_PX_PER_RAD
    const { resolution, numAzimuths } = skylineData.silhouette
    return distanceAtCrosshair(silhouetteLayers, resolution, numAzimuths, bearing, elevAngle)
  }, [skylineData, silhouetteLayers])

  const scope1Distance = useMemo<number | null>(() => {
    if (!tracker1.visible) return null
    return scopeDistanceAt(tracker1.x, tracker1.y)
  }, [scopeDistanceAt, tracker1.x, tracker1.y, tracker1.visible])

  const scope2Distance = useMemo<number | null>(() => {
    if (!tracker2.visible) return null
    return scopeDistanceAt(tracker2.x, tracker2.y)
  }, [scopeDistanceAt, tracker2.x, tracker2.y, tracker2.visible])

  // ── Canvas draw ─────────────────────────────────────────────────────────

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Ensure native resolution on both the visible canvas and the offscreen
    // "base" canvas that the scope lens reads from.
    if (canvas.width !== WRAP_W || canvas.height !== WRAP_H) {
      canvas.width = WRAP_W
      canvas.height = WRAP_H
    }
    if (!baseCanvasRef.current) {
      baseCanvasRef.current = document.createElement('canvas')
    }
    const baseCanvas = baseCanvasRef.current
    if (baseCanvas.width !== WRAP_W || baseCanvas.height !== WRAP_H) {
      baseCanvas.width = WRAP_W
      baseCanvas.height = WRAP_H
    }

    const mainCtx = canvas.getContext('2d')
    const baseCtx = baseCanvas.getContext('2d')
    if (!mainCtx || !baseCtx) return
    mainCtx.setTransform(1, 0, 0, 1, 0, 0)
    baseCtx.setTransform(1, 0, 0, 1, 0, 0)

    const renderScale = 1

    const cam: CameraParams = {
      heading_deg: WRAP_HEADING,
      pitch_deg:   WRAP_PITCH,
      hfov:        WRAP_HFOV,
      W:           WRAP_W,
      H:           WRAP_H,
      scale:       renderScale,
    }

    // ── Pass A: offscreen base canvas ──────────────────────────────────────
    // Everything common to both wrap and scope: sky, stars, terrain bands,
    // contours, silhouette strokes. NO silhouette glow, NO horizon glow —
    // those alias badly when magnified through the scope.

    // 1. Sky + stars
    drawSkyAndStars(baseCtx, WRAP_W, WRAP_H)

    // 2. Terrain bands (far→near painter's order)
    if (skylineData) {
      renderTerrain(baseCtx, skylineData, cam, projectedBands, showBandLines, showFill)
    }

    // 3. Contour lines
    if (contourStrands.length > 0 && skylineData) {
      let cElevMin = Infinity, cElevMax = -Infinity
      for (let bi = 0; bi < skylineData.bands.length; bi++) {
        const elev = skylineData.bands[bi].elevations
        for (let i = 0; i < elev.length; i++) {
          if (elev[i] === -Infinity) continue
          if (elev[i] < cElevMin) cElevMin = elev[i]
          if (elev[i] > cElevMax) cElevMax = elev[i]
        }
      }
      renderContours(baseCtx, contourStrands, cam, cElevMin, cElevMax, skylineData, projectedBands)
    }

    // 3b. Silhouette edge strokes (on base — visible to both wrap and scope).
    if (showSilhouetteLines && silhouetteLayers && silhouetteStrands.length > 0 && skylineData?.silhouette) {
      const silRes = skylineData.silhouette.resolution
      renderSilhouetteStrokes(baseCtx, silhouetteStrands, cam, silElevRange.min, silElevRange.max, silRes)
    }

    // ── Pass B: main wrap canvas ───────────────────────────────────────────
    // Blit the base layer, then add silhouette glow + horizon glow ONLY on
    // the visible wrap. The scope's source (baseCanvas) stays glow-free.
    mainCtx.drawImage(baseCanvas, 0, 0)

    // 3c. Silhouette glow (main wrap only — gives the ridges their atmosphere).
    if (showSilhouetteLines && silhouetteLayers && silhouetteStrands.length > 0 && skylineData?.silhouette) {
      const silRes = skylineData.silhouette.resolution
      renderSilhouetteGlow(mainCtx, silhouetteStrands, cam, silElevRange.min, silElevRange.max, silRes)
      // Re-stroke on top so crisp lines sit above the glow halo.
      renderSilhouetteStrokes(mainCtx, silhouetteStrands, cam, silElevRange.min, silElevRange.max, silRes)
    }

    // 4. Peak positions (computed for scope overlay).
    //    Two-pool selection: up to 25 nearest (<30 km) + up to 25 by elevation
    //    angle. Pass 1 is cheap (bearing/dist/angle per peak); pass 2 runs
    //    project + snap-to-ridgeline only for the union survivors (≤50).
    const eyeElev = groundElev + height_m
    const newPositions: PeakScreenPos[] = []

    if (skylineData && showPeakLabels) {
      const cosLat = Math.cos(activeLat * DEG_TO_RAD)

      // Pass 1 — visible peaks + lightweight metadata (no projection yet).
      type PeakMeta = {
        peak: Peak
        bearing: number
        horizDist: number
        peakAngle: number
      }
      const meta: PeakMeta[] = []
      for (const p of activePeaks) {
        if (!isPeakVisible(p, activeLat, activeLng, eyeElev, WRAP_HEADING, WRAP_HFOV, skylineData, projectedBands, visibilityEnvelope)) continue
        const dx = (p.lng - activeLng) * 111_320 * cosLat
        const dy = (p.lat - activeLat) * 111_132
        const horizDist = Math.sqrt(dx * dx + dy * dy)
        if (horizDist > MAX_PEAK_DIST) continue
        const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360
        const peakAngle = Math.atan2(
          p.elevation_m - (horizDist * horizDist) / (2 * EARTH_R) * (1 - REFRACTION_K) - eyeElev,
          horizDist,
        )
        meta.push({ peak: p, bearing, horizDist, peakAngle })
      }

      // Near pool: peaks within 30 km, sorted by distance ascending, top 50.
      const nearPool = meta
        .filter(m => m.horizDist < 30_000)
        .sort((a, b) => a.horizDist - b.horizDist)
        .slice(0, 50)
      // Horizon pool: sorted by elevation angle descending, top 50.
      const horizonPool = [...meta]
        .sort((a, b) => b.peakAngle - a.peakAngle)
        .slice(0, 50)

      // Union by id (first-seen order).
      const seen = new Set<string>()
      const union: PeakMeta[] = []
      for (const m of nearPool) {
        const id = `${m.peak.lat}-${m.peak.lng}`
        if (seen.has(id)) continue
        seen.add(id)
        union.push(m)
      }
      for (const m of horizonPool) {
        const id = `${m.peak.lat}-${m.peak.lng}`
        if (seen.has(id)) continue
        seen.add(id)
        union.push(m)
      }

      // Pass 2 — project + snap-to-ridgeline, only for survivors.
      for (const { peak, bearing, horizDist, peakAngle } of union) {
        const proj = projectFirstPerson(
          peak.lat, peak.lng, peak.elevation_m,
          activeLat, activeLng, eyeElev, cam,
        )
        if (!proj) continue
        let { screenX, screenY } = proj
        if (screenX < -50 || screenX > WRAP_W + 50) continue

        const ridgeAngle = skylineAngleAt(skylineData, bearing, projectedBands)
        if (peakAngle <= ridgeAngle + 0.002) {
          let maxBandAngle = -Math.PI / 2
          for (let bi = 0; bi < skylineData.bands.length; bi++) {
            const ba = bandAngleAt(skylineData, bi, bearing, projectedBands)
            if (ba > maxBandAngle) maxBandAngle = ba
          }
          if (maxBandAngle > -Math.PI / 2 + 0.001) {
            const snapped = project(bearing, maxBandAngle, cam)
            if (snapped.y < screenY) screenY = snapped.y
          }
        }

        newPositions.push({
          id: `${peak.lat}-${peak.lng}`,
          name: peak.name,
          elevation_m: peak.elevation_m,
          dist_km: horizDist / 1000,
          bearing,
          lat: peak.lat,
          lng: peak.lng,
          screenX,
          screenY,
          peakAngle,
        })
      }
    }

    setPeakPositions(newPositions)
  }, [
    skylineData, projectedBands, contourStrands, projectedArcs,
    silhouetteLayers, silhouetteStrands, silElevRange, visibilityEnvelope,
    showBandLines, showFill, showSilhouetteLines, showPeakLabels,
    activeLat, activeLng, height_m, groundElev, activePeaks,
  ])

  // RAF-gated redraw
  useEffect(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(redrawCanvas)
    return () => cancelAnimationFrame(rafRef.current)
  }, [redrawCanvas])

  // ── Background stars ────────────────────────────────────────────────────
  // Two passes: bright "foreground" stars + dim "dust" that fills the sky
  // with depth. Seeded so they're stable across the session.
  const stars = useMemo<Star[]>(() => [
    ...generateStars({ count: 350, seed: 1337, sizeMin: 1.0, sizeMax: 4.5, sizePower: 2.2, brightness: 1.0 }),
    ...generateStars({ count: 350, seed: 7331, sizeMin: 1.2, sizeMax: 4.0, sizePower: 1.6, brightness: 0.9 }),
  ], [])

  // Per-azimuth max silhouette peakAngle. Silhouette layers are sorted by
  // candidate distance, and `buildSilhouetteLayers` only pushes a layer
  // when its peakAngle exceeds the running max — so the last layer at each
  // azimuth IS the max. We precompute it into a Float32Array so the star
  // RAF can do a single O(1) lookup per star.
  const silhouetteMaxAngles = useMemo<Float32Array | null>(() => {
    if (!silhouetteLayers || !skylineData?.silhouette) return null
    const numAz = skylineData.silhouette.numAzimuths
    const arr = new Float32Array(numAz)
    arr.fill(-Math.PI / 2)
    for (let ai = 0; ai < numAz; ai++) {
      const layers = silhouetteLayers[ai]
      if (!layers || layers.length === 0) continue
      arr[ai] = layers[layers.length - 1].peakAngle
    }
    return arr
  }, [silhouetteLayers, skylineData])

  // Keep the latest terrain-angle sources in a ref so the star RAF can
  // read current data without restarting on every AGL / location change.
  // We pass BOTH silhouette-max and band-overall so whichever is stricter
  // at a given azimuth wins.
  useEffect(() => {
    const sources: StarAngleSource[] = []
    if (silhouetteMaxAngles && skylineData?.silhouette) {
      sources.push({
        angles:      silhouetteMaxAngles,
        resolution:  skylineData.silhouette.resolution,
        numAzimuths: skylineData.silhouette.numAzimuths,
      })
    }
    if (projectedBands && skylineData) {
      sources.push({
        angles:      projectedBands.overallAngles,
        resolution:  skylineData.resolution,
        numAzimuths: skylineData.numAzimuths,
      })
    }
    starSourcesRef.current = sources
  }, [silhouetteMaxAngles, projectedBands, skylineData])

  // Continuous RAF for star twinkle. Independent of the terrain redraw so
  // each frame only clears + draws ~180 tiny arcs.
  useEffect(() => {
    const canvas = starsCanvasRef.current
    if (!canvas) return
    if (canvas.width !== WRAP_W || canvas.height !== WRAP_H) {
      canvas.width  = WRAP_W
      canvas.height = WRAP_H
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const starCam: CameraParams = {
      heading_deg: WRAP_HEADING,
      pitch_deg:   WRAP_PITCH,
      hfov:        WRAP_HFOV,
      W:           WRAP_W,
      H:           WRAP_H,
    }

    let cancelled = false
    const tick = (tMs: number) => {
      if (cancelled) return
      ctx.clearRect(0, 0, WRAP_W, WRAP_H)
      drawStars(ctx, stars, starCam, starSourcesRef.current, tMs / 1000)
      starsRafRef.current = requestAnimationFrame(tick)
    }
    starsRafRef.current = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(starsRafRef.current)
    }
  }, [stars])

  // ── Web Worker ──────────────────────────────────────────────────────────

  useEffect(() => {
    const worker = new Worker(
      new URL('../../workers/skylineWorker.ts', import.meta.url),
      { type: 'module' },
    )

    worker.onmessage = (e: MessageEvent) => {
      const { type, phase, progress, skyline } = e.data
      if (type === 'progress') {
        if (phase === 'tiles') setSkylineProgress(progress * 0.4)
        else if (phase === 'skyline') setSkylineProgress(0.4 + progress * 0.6)
      } else if (type === 'complete') {
        log.info('Skyline precomputed for B2 Wrap')
        const newSkyline = skyline as SkylineData
        setSkylineData(newSkyline)
        skylineDataRef.current = newSkyline
        setIsSkylineComputing(false)
        setSkylineProgress(1)
        setRefinedArcs([])
        // Signal transition overlay to start settling/fading
        setTransitionSettling(true)
      } else if (type === 'refined-arcs') {
        const arcs = e.data.refinedArcs as RefinedArc[]
        log.info('Refined arcs received', { count: arcs.length })
        setRefinedArcs(arcs)
      }
    }

    worker.onerror = (err) => {
      log.warn('Skyline worker error', { err: err.message })
      setIsSkylineComputing(false)
    }

    skylineWorker.current = worker
    return () => { worker.terminate() }
  }, [])

  // ── Skyline computation on location change ──────────────────────────────

  useEffect(() => {
    const prev = skylineDataRef.current
    if (prev) {
      const cosLat = Math.cos(activeLat * DEG_TO_RAD)
      const dx = (activeLng - prev.computedAt.lng) * 111_320 * cosLat
      const dy = (activeLat - prev.computedAt.lat) * 111_132
      if (Math.sqrt(dx * dx + dy * dy) < 1500) return
    }

    const worker = skylineWorker.current
    if (!worker) return

    setIsSkylineComputing(true)
    setSkylineProgress(0)

    worker.postMessage({
      viewerLat:     activeLat,
      viewerLng:     activeLng,
      viewerHeightM: height_m,
      resolution:    4,
      maxRange:      400_000,
    })
  }, [activeLat, activeLng]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fetch OSM peaks ─────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    fetchPeaksNear(activeLat, activeLng, 130).then(fetchedPeaks => {
      if (!cancelled && fetchedPeaks.length > 0) {
        setOsmPeaks(fetchedPeaks)
        log.info('OSM peaks loaded for B2 Wrap', { count: fetchedPeaks.length })
      }
    })
    return () => { cancelled = true }
  }, [activeLat, activeLng])

  // ── Reverse-geocode current location to a human-readable name ──────────

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      fetchPlaceName(activeLat, activeLng).then((name) => {
        if (!cancelled) setPlaceName(name)
      })
    }, 500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeLat, activeLng])

  // ── Peak refinement (second pass) ───────────────────────────────────────

  useEffect(() => {
    if (!skylineData || isSkylineComputing || activePeaks.length === 0) return
    const worker = skylineWorker.current
    if (!worker) return

    const eyeElev = skylineData.computedAt.groundElev + height_m
    const refineItems: PeakRefineItem[] = []

    for (const peak of activePeaks) {
      if (!isPeakVisible(peak, activeLat, activeLng, eyeElev, WRAP_HEADING, WRAP_HFOV, skylineData, projectedBands)) continue

      const cosLat = Math.cos(activeLat * DEG_TO_RAD)
      const dx = (peak.lng - activeLng) * 111_320 * cosLat
      const dy = (peak.lat - activeLat) * 111_132
      const dist = Math.sqrt(dx * dx + dy * dy)
      const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360

      let bandIndex = -1
      for (let bi = 0; bi < DEPTH_BANDS.length; bi++) {
        const cfg = DEPTH_BANDS[bi]
        if (cfg && dist >= cfg.minDist && dist <= cfg.maxDist) {
          bandIndex = bi
          break
        }
      }
      if (bandIndex < 0) continue

      refineItems.push({ bearing, distance: dist, bandIndex, name: peak.name })
    }

    if (refineItems.length === 0) return
    log.info('Requesting peak refinement', { peaks: refineItems.length })
    worker.postMessage({ type: 'refine-peaks', peaks: refineItems })
  }, [skylineData, activePeaks, isSkylineComputing, projectedBands, height_m]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Height slider handlers ──────────────────────────────────────────────

  const handleSliderPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    sliderDragRef.current = { isDragging: true, startY: e.clientY, startHeight: height_m }
  }, [height_m])

  const handleSliderPointerMove = useCallback((e: React.PointerEvent) => {
    if (!sliderDragRef.current.isDragging) return
    const track = sliderRef.current
    if (!track) return
    const trackHeight = track.getBoundingClientRect().height
    const deltaY = sliderDragRef.current.startY - e.clientY
    const range = MAX_HEIGHT_M - MIN_HEIGHT_M
    const newHeight = Math.max(MIN_HEIGHT_M, Math.min(MAX_HEIGHT_M,
      sliderDragRef.current.startHeight + (deltaY / trackHeight) * range))
    setHeightFromSlider(metersToFeet(newHeight))
  }, [setHeightFromSlider])

  const handleSliderPointerUp = useCallback(() => {
    sliderDragRef.current.isDragging = false
  }, [])

  // ─── SOCKET.IO + OSC CONNECTION ──────────────────────────────────────────
  //
  // This connects to the Express server (index.js) via Socket.IO.
  // The server forwards all OSC messages as "osc" events.
  //
  // We listen for:
  //   "osc" → tracker portals (trk_1_xy_loc, trk_2_xy_loc)
  //   "location:update" → when the map screen selects a new location
  //
  // All OSC messages are logged to the browser console so you can
  // see exactly what's coming in during testing.

  useEffect(() => {
    // Connect to the WebSocket server
    // In dev: Vite proxies /socket.io to localhost:3000
    // In production: same origin serves both
    const socket = io()
    socketRef.current = socket

    socket.on('connect', () => {
      log.info('WebSocket connected to server', { id: socket.id })
    })

    // ── OSC MESSAGE HANDLER ──────────────────────────────────────────────
    // Every OSC message from the server arrives here.
    // We check the address and update the tracker portal positions.
    //
    // OSC format from motion capture:
    //   /trk_1_xy_loc  args: [y_normalized, x_normalized, layer_fraction]
    //   /trk_2_xy_loc  args: [y_normalized, x_normalized, layer_fraction]
    //
    // The x,y values are normalized 0–1 (0=top-left, 1=bottom-right).
    // We multiply by the screen size to get pixel coordinates.

    socket.on('osc', (msg: { address: string; args: number[] }) => {
      // Log every OSC message so you can see what's coming in
      console.log('[B2-WRAP] OSC:', msg.address, msg.args)

      if (msg.address === '/trk_1_xy_loc') {
        // Tracker 1: args = [y_norm, x_norm, layer_fraction]
        if (Math.abs(msg.args[1] - prevX1) > TRK_XY_Thresh || Math.abs(msg.args[0] - prevY1) > TRK_XY_Thresh) {
          const xPixel = msg.args[1] * window.innerWidth
          const yPixel = msg.args[0] * window.innerHeight
          const layerFrac = msg.args[2] ?? SCOPE_LAYER_MIN
          setTracker1({ x: xPixel, y: yPixel, visible: true, diameter: layerFractionToDiameter(layerFrac) })
          prevX1 = msg.args[1]
          prevY1 = msg.args[0]
        }
      }

      if (msg.address === '/trk_2_xy_loc') {
        // Tracker 2: same format as tracker 1
        if (Math.abs(msg.args[1] - prevX2) > TRK_XY_Thresh || Math.abs(msg.args[0] - prevY2) > TRK_XY_Thresh) {
          const xPixel = msg.args[1] * window.innerWidth
          const yPixel = msg.args[0] * window.innerHeight
          const layerFrac = msg.args[2] ?? SCOPE_LAYER_MIN
          setTracker2({ x: xPixel, y: yPixel, visible: true, diameter: layerFractionToDiameter(layerFrac) })
          prevX2 = msg.args[1]
          prevY2 = msg.args[0]
        }
      }

      if (msg.address === '/trk_4_z_loc') {
        // AGL height control: args = [z_value]
        // FLAG: Adjust TRK4_Z_MIN / TRK4_Z_MAX during testing with real OSC hardware.
        // if curent vaule - previous vaule > threshold then call set high from slider and set current to slider hight
        if ( Math.abs(msg.args[0] - prevZ) > Z_Thresh){

                  const zVal = msg.args[0] ?? TRK4_Z_MIN
        const t = Math.max(0, Math.min(1, (zVal - TRK4_Z_MIN) / (TRK4_Z_MAX - TRK4_Z_MIN)))
        const newHeight = MIN_HEIGHT_M + t * (MAX_HEIGHT_M - MIN_HEIGHT_M)
        setHeightFromSlider(metersToFeet(newHeight))
        prevZ = msg.args[0]

        }

      }
    })

    // ── LOCATION UPDATE FROM MAP SCREEN ──────────────────────────────────
    // When someone presses SELECT on the map screen, it emits this event.
    // We update our location store so the terrain re-renders for the new spot.

    socket.on('location:update', (data: { lat: number; lng: number }) => {
      log.info('Location update from map screen', {
        lat: data.lat.toFixed(4),
        lng: data.lng.toFixed(4),
      })
      // Start transition animation
      setTransitionSettling(false)
      setTransitionActive(true)
      setExploreLocation(data.lat, data.lng)
    })

    socket.on('disconnect', () => {
      log.warn('WebSocket disconnected from server')
    })

    // Cleanup: disconnect when component unmounts
    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [setExploreLocation])

  // ─── MOUSE SIMULATION FOR TESTING ───────────────────────────────────────
  //
  // When simMode is ON, mouse movement drives tracker portal 1.
  // This lets you test the portal overlay without real OSC hardware.
  // Press "M" key to toggle sim mode on/off.

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!simMode) return
      // Convert mouse position to same coords as OSC tracker
      // In SIM mode, use a mid-range scope diameter
      setTracker1(prev => ({
        x: e.clientX,
        y: e.clientY,
        visible: true,
        diameter: prev.diameter,
      }))
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // Press M to toggle mouse simulation mode
      if (e.key === 'm' || e.key === 'M') {
        setSimMode(prev => !prev)
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [simMode])

  // ── Loading state ───────────────────────────────────────────────────────

  const isLoading = isSkylineComputing

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className={styles.screen}>
      <Link to="/" className={styles.backLink}>← Back</Link>

      {/* SIM MODE TOGGLE — small button in top-right corner */}
      {/* Click this to switch between mouse simulation and real OSC input */}
      <button
        className={styles.simToggle}
        onClick={() => setSimMode(prev => !prev)}
        title={simMode ? 'Mouse simulation ON — click or press M to toggle' : 'Mouse simulation OFF — only real OSC data. Click or press M to toggle'}
      >
        {simMode ? 'SIM ON' : 'SIM OFF'}
      </button>

      <div
        ref={containerRef}
        className={styles.canvasContainer}
      >
        <canvas
          ref={canvasRef}
          className={styles.terrainCanvas}
          width={WRAP_W}
          height={WRAP_H}
        />

        {/* ── STAR OVERLAY ────────────────────────────────────────────── */}
        {/* Transparent canvas above the terrain; twinkling stars are     */}
        {/* drawn here on their own RAF so terrain doesn't redraw         */}
        {/* every frame. Pointer-events off so scopes still receive input. */}
        <canvas
          ref={starsCanvasRef}
          className={styles.starsCanvas}
          width={WRAP_W}
          height={WRAP_H}
        />

        {/* ── TRANSITION OVERLAY ──────────────────────────────────────── */}
        {/* Wave animation during location transitions                    */}
        <TransitionOverlay
          active={transitionActive}
          settling={transitionSettling}
          onComplete={() => {
            setTransitionActive(false)
            setTransitionSettling(false)
          }}
        />

        {/* ── SCOPE OVERLAYS ──────────────────────────────────────────── */}
        {/* Circular magnified terrain scopes at tracker positions.       */}
        {/* Size controlled by layer_fraction from OSC data.              */}
        {/* Peak dots/labels render INSIDE each scope only — the wrap     */}
        {/* view itself shows zero peak labels.                           */}
        <ScopeOverlay
          x={tracker1.x} y={tracker1.y}
          visible={tracker1.visible && tracker1.y >= 0 && tracker1.y <= window.innerHeight}
          diameter={tracker1.diameter}
          canvasRef={baseCanvasRef}
          distanceKm={scope1Distance}
          label="1"
          peaks={peakPositions}
          units={units}
        />
        <ScopeOverlay
          x={tracker2.x} y={tracker2.y}
          visible={tracker2.visible && tracker2.y >= 0 && tracker2.y <= window.innerHeight}
          diameter={tracker2.diameter}
          canvasRef={baseCanvasRef}
          distanceKm={scope2Distance}
          label="2"
          peaks={peakPositions}
          units={units}
        />

        {/* Cardinal direction markers.
            Single S on the far right (opposite the AGL slider on the left).
            Placed just inside the edge so the label isn't clipped by the
            container. Visually ~179° on the panorama. */}
        <div className={styles.cardinalMarker} style={{ left: '50%' }}>N</div>
        <div className={styles.cardinalMarker} style={{ left: '75%' }}>E</div>
        <div className={styles.cardinalMarker} style={{ left: '25%' }}>W</div>
        <div className={styles.cardinalMarker} style={{ left: '99%' }}>S</div>

        {/* Loading overlay */}
        {isLoading && (
          <div className={styles.loadingOverlay}>
            <div className={styles.loadingBar}>
              <div className={styles.loadingFill} style={{ width: `${Math.round(skylineProgress * 100)}%` }} />
            </div>
            <span className={styles.loadingLabel}>
              Computing 360° panorama… {Math.round(skylineProgress * 100)}%
            </span>
          </div>
        )}

        {/* Height slider — vertical on left edge, HIGH at top, LOW at bottom */}
        <div className={styles.heightSlider}>
          <span className={styles.heightSliderLabel}>HIGH</span>
          <div
            ref={sliderRef}
            className={styles.heightSliderTrack}
            onPointerDown={handleSliderPointerDown}
            onPointerMove={handleSliderPointerMove}
            onPointerUp={handleSliderPointerUp}
            onPointerCancel={handleSliderPointerUp}
            role="slider"
            aria-label="Eye height above ground"
            aria-valuemin={Math.round(metersToFeet(MIN_HEIGHT_M))}
            aria-valuemax={Math.round(metersToFeet(MAX_HEIGHT_M))}
            aria-valuenow={Math.round(metersToFeet(height_m))}
          >
            <div
              className={styles.heightSliderFill}
              style={{ height: `${((height_m - MIN_HEIGHT_M) / (MAX_HEIGHT_M - MIN_HEIGHT_M)) * 100}%` }}
            />
            <div
              className={styles.heightSliderThumb}
              style={{ bottom: `${((height_m - MIN_HEIGHT_M) / (MAX_HEIGHT_M - MIN_HEIGHT_M)) * 100}%` }}
            />
          </div>
          <span className={styles.heightSliderLabel}>LOW</span>
          <span className={styles.heightSliderValue}>
            {units === 'imperial'
              ? `${Math.round(metersToFeet(height_m))}ft`
              : `${Math.round(height_m)}m`}
          </span>
        </div>

        {/* Coordinate overlay — bottom center, under South */}
        <div className={styles.coordOverlay}>
          {placeName && (
            <div className={styles.placeNameRow}>
              <span className={styles.placeName}>{placeName}</span>
            </div>
          )}
          <div className={styles.coordRow}>
          <div className={styles.coordItem}>
            <span className={styles.coordLabel}>LAT</span>
            <span className={styles.coordValue}>{activeLat.toFixed(4)}°</span>
          </div>
          <div className={styles.coordDivider} />
          <div className={styles.coordItem}>
            <span className={styles.coordLabel}>LONG</span>
            <span className={styles.coordValue}>{Math.abs(activeLng).toFixed(4)}°{activeLng < 0 ? 'W' : 'E'}</span>
          </div>
          <div className={styles.coordDivider} />
          <div className={styles.coordItem}>
            <span className={styles.coordLabel}>ELEV</span>
            <span className={styles.coordValue}>{formatElevation(groundElev, units)}</span>
          </div>
          <div className={styles.coordDivider} />
          <div className={styles.coordItem}>
            <span className={styles.coordLabel}>AGL</span>
            <span className={styles.coordValue}>{formatElevation(height_m, units)}</span>
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default B2WrapScreen
