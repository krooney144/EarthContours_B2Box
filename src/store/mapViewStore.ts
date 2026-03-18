
/**
 * EarthContours — Map View Store
 *
 * Shared state for map center position and zoom level.
 * Used by MapScreen (reads + writes via gestures) and B2MapScreen
 * control strips (writes via buttons). Single source of truth so
 * the B2 exhibit table can drive the same map.
 */
 
import { create } from 'zustand'
import { createLogger } from '../core/logger'
import {
  DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM,
  MAP_MIN_ZOOM, MAP_MAX_ZOOM,
} from '../core/constants'
 
const log = createLogger('STORE:MAP-VIEW')
 
// ─── Helpers ─────────────────────────────────────────────────────────────────
 
function clampLat(lat: number): number {
  return Math.max(-85, Math.min(85, lat))
}
 
function wrapLng(lng: number): number {
  return ((lng + 180) % 360 + 360) % 360 - 180
}
 
function clampZoom(z: number): number {
  return Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, z))
}
 
// ─── How many degrees does one pixel represent at this zoom level? ────────────
//
// Zoom level controls how "zoomed in" we are. At zoom 1 the whole world
// fits on screen. Each extra zoom level halves the degrees-per-pixel.
//
// Formula: at zoom 0, one pixel = 360° / 256px (standard tile size).
// Each zoom level doubles the resolution, so we divide by 2^zoom.
//
// We also need the screen width/height to convert pixels → degrees.
 
function degreesPerPixelLng(zoom: number, screenWidth: number): number {
  // 256 = standard map tile size in pixels
  return 360 / (256 * Math.pow(2, zoom)) * (256 / screenWidth) * screenWidth
  // Simplified:
  // return 360 / Math.pow(2, zoom) / 256
}
 
function degreesPerPixelLat(zoom: number, screenHeight: number): number {
  // Latitude uses a Mercator projection so it's slightly different,
  // but at normal zoom levels this linear approximation is close enough.
  return 180 / (256 * Math.pow(2, zoom)) * (256 / screenHeight) * screenHeight
  // Simplified:
  // return 180 / Math.pow(2, zoom) / 256
}
 
// Cleaner versions used in the store below:
function pxToLng(px: number, zoom: number): number {
  return px * (360 / (256 * Math.pow(2, zoom)))
}
 
function pxToLat(px: number, zoom: number): number {
  return px * (180 / (256 * Math.pow(2, zoom)))
}
 
// ─── Store Interface ─────────────────────────────────────────────────────────
 
interface MapViewStore {
  centerLat: number
  centerLng: number
  zoom: number
 
  setCenterLat: (lat: number) => void
  setCenterLng: (lng: number) => void
  setCenter: (lat: number, lng: number) => void
  setZoom: (zoom: number) => void
 
  /** Pan by a lat/lng delta — clamps lat, wraps lng */
  pan: (dLat: number, dLng: number) => void
 
  /**
   * Pan by pixel deltas (dx, dy) from hand/mouse drag.
   *
   * This is what B2MapScreen calls when a closed fist moves.
   * It converts the pixel movement into lat/lng degrees and
   * calls pan() internally.
   *
   * dx = pixels moved horizontally (positive = right = east = +lng)
   * dy = pixels moved vertically   (positive = down  = south = -lat)
   */
  panBy: (dx: number, dy: number) => void
 
  /**
   * Convert a normalised screen position (0–1) to lat/lng.
   *
   * Used by the pointing gesture to work out which real-world location
   * the hand is pointing at on screen.
   *
   * xNorm = 0 is left edge, 1 is right edge
   * yNorm = 0 is top edge,  1 is bottom edge
   *
   * Returns { lat, lng } of that screen position.
   */
  getLatLngAtNorm: (xNorm: number, yNorm: number) => { lat: number; lng: number }
 
  /** Zoom in by 1 integer step */
  zoomIn: () => void
 
  /** Zoom out by 1 integer step */
  zoomOut: () => void
 
  /** Zoom by a fractional amount (e.g. ±0.3 for scroll or pinch) */
  zoomBy: (delta: number) => void
 
  /** Compute a small pan step appropriate for the current zoom level */
  panStep: () => number
}
 
// ─── Store Implementation ────────────────────────────────────────────────────
 
export const useMapViewStore = create<MapViewStore>()((set, get) => ({
  centerLat: DEFAULT_MAP_CENTER.lat,
  centerLng: DEFAULT_MAP_CENTER.lng,
  zoom: DEFAULT_MAP_ZOOM,
 
  setCenterLat: (lat) => set({ centerLat: clampLat(lat) }),
  setCenterLng: (lng) => set({ centerLng: wrapLng(lng) }),
 
  setCenter: (lat, lng) => {
    set({ centerLat: clampLat(lat), centerLng: wrapLng(lng) })
  },
 
  setZoom: (z) => set({ zoom: clampZoom(z) }),
 
  pan: (dLat, dLng) => {
    const { centerLat, centerLng } = get()
    const newLat = clampLat(centerLat + dLat)
    const newLng = wrapLng(centerLng + dLng)
    log.debug('Pan', { dLat: dLat.toFixed(4), dLng: dLng.toFixed(4) })
    set({ centerLat: newLat, centerLng: newLng })
  },
 
  // ── NEW: panBy ────────────────────────────────────────────────────────────
  //
  // Called by B2MapScreen when a closed fist drags across the screen.
  //
  // How it works:
  //   1. We know how many pixels the hand moved (dx, dy)
  //   2. We convert that to degrees using the current zoom level
  //   3. Moving RIGHT (+dx) moves the map view EAST (+lng)
  //      Moving DOWN  (+dy) moves the map view SOUTH (-lat)
  //      (inverted because dragging down reveals more southern land,
  //       which means the center latitude decreases)
 
  panBy: (dx, dy) => {
    const { zoom, pan } = get()
 
    const dLng = pxToLng(dx, zoom)
    const dLat = pxToLat(-dy, zoom) // negative because screen-y is flipped vs lat
 
    log.debug('PanBy pixels', {
      dx: dx.toFixed(1), dy: dy.toFixed(1),
      dLat: dLat.toFixed(5), dLng: dLng.toFixed(5),
    })
 
    pan(dLat, dLng)
  },
 
  // ── NEW: getLatLngAtNorm ──────────────────────────────────────────────────
  //
  // Called by B2MapScreen when a pointing gesture fires, to find out
  // which lat/lng the hand is pointing at.
  //
  // How it works:
  //   The screen center = centerLat / centerLng (from the store).
  //   xNorm=0.5, yNorm=0.5 is the exact center → returns centerLat/centerLng.
  //   xNorm=0 is the left edge → subtract half the screen's lng span.
  //   yNorm=0 is the top edge  → add    half the screen's lat span.
  //
  //   "span" = how many degrees of lat/lng fit on the whole screen at
  //            this zoom level.
 
  getLatLngAtNorm: (xNorm, yNorm) => {
    const { centerLat, centerLng, zoom } = get()
 
    const screenW = window.innerWidth
    const screenH = window.innerHeight
 
    // Total degrees visible across the full screen width/height
    const lngSpan = pxToLng(screenW, zoom)
    const latSpan = pxToLat(screenH, zoom)
 
    // Offset from center: xNorm=0.5 → 0 offset, xNorm=0 → -0.5 span
    const dLng = (xNorm - 0.5) * lngSpan
    const dLat = (0.5 - yNorm) * latSpan // flipped: top of screen = higher lat
 
    const lat = clampLat(centerLat + dLat)
    const lng = wrapLng(centerLng + dLng)
 
    log.debug('getLatLngAtNorm', {
      xNorm: xNorm.toFixed(3), yNorm: yNorm.toFixed(3),
      lat: lat.toFixed(4), lng: lng.toFixed(4),
    })
 
    return { lat, lng }
  },
 
  zoomIn: () => {
    const z = get().zoom
    set({ zoom: clampZoom(Math.floor(z) + 1) })
  },
 
  zoomOut: () => {
    const z = get().zoom
    set({ zoom: clampZoom(Math.ceil(z) - 1) })
  },
 
  zoomBy: (delta) => {
    const z = get().zoom
    set({ zoom: clampZoom(z + delta) })
  },
 
  panStep: () => {
    // Step that scales with zoom — visible nudge at every zoom level
    // At zoom 9: ~0.03° (~3.3 km). At zoom 3: ~2°. At zoom 16: ~0.0003°.
    const z = get().zoom
    return 1.5 / Math.pow(2, z - 1)
  },
}))
 