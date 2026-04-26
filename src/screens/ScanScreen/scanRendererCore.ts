/**
 * Shared pure rendering functions for SCAN-based views.
 *
 * Extracted from ScanScreen.tsx so B2WrapScreen (and future views) can reuse
 * the same projection, terrain rendering, contour rendering, and re-projection
 * logic without duplicating 1000+ lines of code.
 *
 * All functions are stateless — they take data in and produce output.
 * No React, no stores, no side effects.
 */

import type { SkylineData, SkylineBand, RefinedArc, SilhouetteLayer, TerrainProfile } from '../../core/types'
import { DEPTH_BANDS } from '../../core/types'

// ─── Visibility Envelope (terrain-profile-based occlusion) ──────────────────

/** Precomputed running-max-angle envelope from the raw terrain profile.
 *  At each azimuth and distance, stores the maximum elevation-angle ratio
 *  from all terrain between the viewer and that distance.  Used to determine
 *  which contour crossings, refined arc samples, and peaks are hidden behind
 *  closer terrain. */
export interface VisibilityEnvelope {
  /** Running max of (effElev − viewerElev) / dist, row-major: ai * numSteps + si. */
  envelope:     Float32Array
  /** Distance breakpoints in metres (shared across azimuths). */
  distances:    Float32Array
  numSteps:     number
  numAzimuths:  number
  resolution:   number
}

/** Binary search: find largest index where distances[i] <= dist.  Returns -1 if dist < distances[0]. */
export function profileDistIndex(distances: Float32Array, dist: number): number {
  let lo = 0, hi = distances.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (distances[mid] <= dist) lo = mid + 1
    else hi = mid - 1
  }
  return hi
}

/** Build the visibility envelope from the terrain profile at a given viewer elevation.
 *  Uses ratio comparison instead of atan2 for performance.
 *  ~2.9M multiply+compare ops for 2880 az × 1000 steps ≈ 5–10 ms on mobile. */
export function buildVisibilityEnvelope(
  profile: TerrainProfile,
  viewerElev: number,
): VisibilityEnvelope {
  const { profileData, distances, numSteps, numAzimuths, resolution } = profile
  const envelope = new Float32Array(numAzimuths * numSteps)
  for (let ai = 0; ai < numAzimuths; ai++) {
    let maxRatio = -Infinity
    const offset = ai * numSteps
    for (let si = 0; si < numSteps; si++) {
      const ratio = (profileData[offset + si] - viewerElev) / distances[si]
      if (ratio > maxRatio) maxRatio = ratio
      envelope[offset + si] = maxRatio
    }
  }
  return { envelope, distances, numSteps, numAzimuths, resolution }
}

// ─── Near-peak occlusion tolerance ──────────────────────────────────────────
// For peaks within NEAR_PEAK_TOL_MAX_M, allow the peak to be up to
// NEAR_PEAK_TOL_DEG below the envelope's max angle and still count as visible.
// Handles self-occlusion on convex mountain profiles (false-summit geometry)
// plus DEM/OSM elevation-source mismatch that dominates at close range.
const NEAR_PEAK_TOL_DEG    = 3
const NEAR_PEAK_TOL_MAX_M  = 5_000
const NEAR_PEAK_TOL_RATIO  = Math.tan(NEAR_PEAK_TOL_DEG * Math.PI / 180)

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_DIST          = 400_000     // Maximum render distance (m)
export const MAX_PEAK_DIST     = 400_000     // Max distance for peak label display (m)
export const EARTH_R           = 6_371_000   // Earth radius (m)
export const REFRACTION_K      = 0.13        // Atmospheric refraction coefficient
export const DEG_TO_RAD        = Math.PI / 180
export const OCEAN_ELEV_M      = 5           // Elevations below this are ocean (matches worker threshold)

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CameraParams {
  heading_deg: number
  pitch_deg:   number
  hfov:        number
  W:           number   // Physical pixels (canvas.width)
  H:           number   // Physical pixels (canvas.height)
  scale?:      number   // Visual size multiplier (defaults to 1)
}

export interface ProjectedBands {
  bandAngles: Float32Array[]
  overallAngles: Float32Array
  viewerElev: number
}

export interface ProjectedRefinedArc {
  angles: Float32Array
  arc: RefinedArc
}

export interface PeakScreenPos {
  id:          string
  name:        string
  elevation_m: number
  dist_km:     number
  bearing:     number
  lat:         number
  lng:         number
  screenX:     number
  screenY:     number
  /** Elevation angle from viewer, radians. Optional — used by B2 scope overlay
   *  for horizon-pool ranking. ScanScreen ignores this field. */
  peakAngle?:  number
}

export interface PrebuiltContourStrand {
  level:    number
  bandIdx:  number
  interval: number
  points:   Array<{ bearingDeg: number; elevAngleRad: number; dist: number }>
}

// ─── Re-Projection ───────────────────────────────────────────────────────────

export function reprojectBands(
  skyline: SkylineData,
  viewerElev: number,
): ProjectedBands {
  const { numAzimuths, bands } = skyline
  const bandAngles: Float32Array[] = []
  const overallAngles = new Float32Array(numAzimuths)
  overallAngles.fill(-Math.PI / 2)

  for (let bi = 0; bi < bands.length; bi++) {
    const band = bands[bi]
    const bandAz = band.numAzimuths
    const bandRes = band.resolution
    const angles = new Float32Array(bandAz)

    for (let ai = 0; ai < bandAz; ai++) {
      const elev = band.elevations[ai]
      const dist = band.distances[ai]

      if (elev === -Infinity || elev < OCEAN_ELEV_M || dist <= 0) {
        angles[ai] = -Math.PI / 2
        continue
      }

      const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const effElev  = elev - curvDrop
      angles[ai] = Math.atan2(effElev - viewerElev, dist)

      const overallIdx = Math.round((ai / bandRes) * skyline.resolution) % numAzimuths
      if (angles[ai] > overallAngles[overallIdx]) {
        overallAngles[overallIdx] = angles[ai]
      }
    }

    bandAngles.push(angles)
  }

  return { bandAngles, overallAngles, viewerElev }
}

export function reprojectRefinedArcs(
  arcs: RefinedArc[],
  viewerElev: number,
  envelope: VisibilityEnvelope | null = null,
): ProjectedRefinedArc[] {
  return arcs.map(arc => {
    const angles = new Float32Array(arc.numSamples)
    for (let i = 0; i < arc.numSamples; i++) {
      const elev = arc.elevations[i]
      const dist = arc.distances[i]
      if (elev === -Infinity || dist <= 0) {
        angles[i] = -Math.PI / 2
        continue
      }
      const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const effElev  = elev - curvDrop

      // Envelope LOS check: hide samples blocked by closer terrain.
      if (envelope) {
        const ratio   = (effElev - viewerElev) / dist
        const bearing = arc.centerBearing + (-arc.halfWidth + i * arc.stepDeg)
        const normB   = ((bearing % 360) + 360) % 360
        const envAi   = Math.round(normB * envelope.resolution) % envelope.numAzimuths
        const si      = profileDistIndex(envelope.distances, dist)
        if (si >= 0 && ratio < envelope.envelope[envAi * envelope.numSteps + si]) {
          angles[i] = -Math.PI / 2
          continue
        }
      }

      angles[i] = Math.atan2(effElev - viewerElev, dist)
    }
    return { angles, arc }
  })
}

// ─── Contour Strand Precomputation ──────────────────────────────────────────

const CONTOUR_INTERVALS_M: number[] = [15.24, 30.48, 60.96, 152.4, 304.8, 609.6]

export function buildContourStrands(
  skyline: SkylineData,
  viewerElev: number,
  envelope: VisibilityEnvelope | null = null,
): PrebuiltContourStrand[] {
  const completed: PrebuiltContourStrand[] = []

  for (let bi = skyline.bands.length - 1; bi >= 0; bi--) {
    const band = skyline.bands[bi]
    const bandAz = band.numAzimuths
    const bandRes = band.resolution
    const offsets = band.crossingOffsets
    const data = band.crossingData
    const interval = CONTOUR_INTERVALS_M[bi] || 152.4

    if (!data || data.length === 0) continue

    const maxAzGap = Math.ceil(bandRes * 2)

    type ActiveStrand = {
      lastAi:   number
      lastDist: number
      level:    number
      levelKey: string
      points:   Array<{ bearingDeg: number; elevAngleRad: number; dist: number }>
    }
    const activeStrands = new Map<string, ActiveStrand[]>()

    // Per-band completed list — populated during this band's sweep and
    // post-merged at the bottom (stitching strands that terminate near
    // bearing 360° with strands that begin near bearing 0°, so contour
    // lines connect across the 0°/360° wrap that sits at centre screen
    // on the 360° B2 wrap view).
    const bandCompleted: Array<ActiveStrand> = []

    for (let ai = 0; ai < bandAz; ai++) {
      const start = offsets[ai]
      const end = offsets[ai + 1]
      const bearingDeg = ai / bandRes

      if (start < end) {
        const azCrossings: Array<{ elev: number; dist: number; dir: number }> = []
        for (let j = start; j < end; j += 5) {
          azCrossings.push({ elev: data[j], dist: data[j + 1], dir: data[j + 4] })
        }
        azCrossings.sort((a, b) => a.dist - b.dist)

        // Occlusion policy:
        //  - envelope provided: profile-based global occlusion (V3 style) — applies
        //    to ALL bands uniformly, catches cross-band hiding.
        //  - envelope null: fall back to simple within-azimuth running-max (legacy),
        //    only active for far bands (bi >= 3) to match prior behavior.
        let runningMaxAngle = -Math.PI / 2
        const useLegacyOcclusion = !envelope && bi >= 3
        for (const c of azCrossings) {
          const curvDrop = (c.dist * c.dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
          const effElev  = c.elev - curvDrop
          const angle = Math.atan2(effElev - viewerElev, c.dist)

          // Profile-based occlusion (preferred when envelope is available)
          if (envelope) {
            const normB = ((bearingDeg % 360) + 360) % 360
            const envAi = Math.round(normB * envelope.resolution) % envelope.numAzimuths
            const si = profileDistIndex(envelope.distances, c.dist)
            if (si >= 0) {
              const maxRatio = envelope.envelope[envAi * envelope.numSteps + si]
              const crossingRatio = (effElev - viewerElev) / c.dist
              if (crossingRatio <= maxRatio) continue  // hidden behind closer terrain
            }
          } else if (useLegacyOcclusion) {
            if (angle <= runningMaxAngle) continue
            runningMaxAngle = angle
          }

          // Skip ocean / near-sea-level elevation — avoids coastline artifacts
          if (c.elev < OCEAN_ELEV_M) continue

          const snappedLevel = Math.round(c.elev / interval) * interval
          const levelKey = `${snappedLevel}_${c.dir > 0 ? 'u' : 'd'}`

          let strands = activeStrands.get(levelKey)
          if (!strands) {
            strands = []
            activeStrands.set(levelKey, strands)
          }

          const maxDistDiff = bi <= 1
            ? Math.max(10, c.dist * 0.02)
            : bi === 2
            ? Math.max(50, c.dist * 0.03)
            : Math.max(200, c.dist * 0.05)
          let bestIdx = -1
          let bestDiff = Infinity
          for (let si = 0; si < strands.length; si++) {
            const s = strands[si]
            if (s.lastAi === ai) continue
            if (ai - s.lastAi > maxAzGap) continue
            const diff = Math.abs(c.dist - s.lastDist)
            if (diff < bestDiff && diff < maxDistDiff) {
              bestIdx = si
              bestDiff = diff
            }
          }

          if (bestIdx >= 0) {
            strands[bestIdx].lastAi = ai
            strands[bestIdx].lastDist = c.dist
            strands[bestIdx].points.push({ bearingDeg, elevAngleRad: angle, dist: c.dist })
          } else {
            strands.push({
              lastAi: ai,
              lastDist: c.dist,
              level: snappedLevel,
              levelKey,
              points: [{ bearingDeg, elevAngleRad: angle, dist: c.dist }],
            })
          }
        }
      }

      if (ai % maxAzGap === 0) {
        for (const [key, strands] of activeStrands) {
          const remaining: typeof strands = []
          for (const s of strands) {
            if (ai - s.lastAi > maxAzGap) {
              if (s.points.length >= 2) bandCompleted.push(s)
            } else {
              remaining.push(s)
            }
          }
          if (remaining.length === 0) activeStrands.delete(key)
          else activeStrands.set(key, remaining)
        }
      }
    }

    for (const [, strands] of activeStrands) {
      for (const s of strands) {
        if (s.points.length >= 2) bandCompleted.push(s)
      }
    }

    // ── Post-merge: stitch strands across the 0°/360° azimuth wrap ──
    // For each level+direction bucket, join any strand whose last point sits
    // near 360° with any strand whose first point sits near 0°, provided their
    // distances at the join match within the same tolerance used during the
    // main-loop match. Greedy, single pass.
    const WRAP_TAIL_DEG = 2     // last point must be within 2° of 360
    const WRAP_HEAD_DEG = 2     // first point must be within 2° of 0
    const buckets = new Map<string, ActiveStrand[]>()
    for (const s of bandCompleted) {
      let arr = buckets.get(s.levelKey)
      if (!arr) { arr = []; buckets.set(s.levelKey, arr) }
      arr.push(s)
    }
    const merged = new Set<ActiveStrand>()
    for (const arr of buckets.values()) {
      const tails = arr.filter(s => s.points[s.points.length - 1].bearingDeg >= 360 - WRAP_TAIL_DEG)
      const heads = arr.filter(s => s.points[0].bearingDeg <= WRAP_HEAD_DEG)
      for (const a of tails) {
        if (merged.has(a)) continue
        const aLastDist = a.points[a.points.length - 1].dist
        const tol = bi <= 1
          ? Math.max(10, aLastDist * 0.02)
          : bi === 2
          ? Math.max(50, aLastDist * 0.03)
          : Math.max(200, aLastDist * 0.05)
        let bestB: ActiveStrand | null = null
        let bestDiff = Infinity
        for (const b of heads) {
          if (b === a || merged.has(b)) continue
          const diff = Math.abs(aLastDist - b.points[0].dist)
          if (diff < bestDiff && diff < tol) { bestB = b; bestDiff = diff }
        }
        if (bestB) {
          for (const pt of bestB.points) a.points.push(pt)
          merged.add(bestB)
        }
      }
    }
    for (const s of bandCompleted) {
      if (merged.has(s)) continue
      completed.push({ level: s.level, bandIdx: bi, interval, points: s.points })
    }
  }

  return completed
}

// ─── The Camera — Single Source of Truth ──────────────────────────────────────

export function project(
  bearingDeg: number,
  elevAngleRad: number,
  cam: CameraParams,
): { x: number; y: number } {
  const hfovRad  = cam.hfov * DEG_TO_RAD
  const pitchRad = cam.pitch_deg * DEG_TO_RAD

  const pxPerRad = cam.W / hfovRad

  let dBearing = bearingDeg - cam.heading_deg
  if (dBearing > 180) dBearing -= 360
  if (dBearing < -180) dBearing += 360
  const dBearingRad = dBearing * DEG_TO_RAD

  const horizonY = cam.H * 0.5 - pitchRad * pxPerRad

  return {
    x: cam.W * 0.5 + dBearingRad * pxPerRad,
    y: horizonY - elevAngleRad * pxPerRad,
  }
}

export function getHorizonY(cam: CameraParams): number {
  const pxPerRad = cam.W / (cam.hfov * DEG_TO_RAD)
  const pitchRad = cam.pitch_deg * DEG_TO_RAD
  return cam.H * 0.5 - pitchRad * pxPerRad
}

// ─── World → Screen Projection ───────────────────────────────────────────────

export function worldToBearingElev(
  lat: number, lng: number, elev: number,
  viewerLat: number, viewerLng: number, viewerElev: number,
): { bearingDeg: number; elevAngleRad: number; horizDist: number } | null {
  const cosLat = Math.cos(viewerLat * DEG_TO_RAD)
  const dx_east  = (lng - viewerLng) * 111_320 * cosLat
  const dy_north = (lat - viewerLat) * 111_132
  const horizDist = Math.sqrt(dx_east * dx_east + dy_north * dy_north)
  if (horizDist < 10) return null

  const bearingDeg = ((Math.atan2(dx_east, dy_north) * 180 / Math.PI) + 360) % 360
  const curvDrop     = (horizDist * horizDist) / (2 * EARTH_R) * (1 - REFRACTION_K)
  const corrElev     = elev - curvDrop
  const dz_up        = corrElev - viewerElev
  const elevAngleRad = Math.atan2(dz_up, horizDist)

  return { bearingDeg, elevAngleRad, horizDist }
}

export function projectFirstPerson(
  lat: number, lng: number, elev: number,
  viewerLat: number, viewerLng: number, viewerElev: number,
  cam: CameraParams,
): { screenX: number; screenY: number; horizDist: number } | null {
  const world = worldToBearingElev(lat, lng, elev, viewerLat, viewerLng, viewerElev)
  if (!world) return null
  const { x, y } = project(world.bearingDeg, world.elevAngleRad, cam)
  return { screenX: x, screenY: y, horizDist: world.horizDist }
}

// ─── Band Data Lookups ───────────────────────────────────────────────────────

export function skylineAngleAt(
  skyline: SkylineData,
  bearingDeg: number,
  projected: ProjectedBands | null = null,
): number {
  const normBearing = ((bearingDeg % 360) + 360) % 360
  const fracIdx = normBearing * skyline.resolution
  const idx0 = Math.floor(fracIdx) % skyline.numAzimuths
  const idx1 = (idx0 + 1) % skyline.numAzimuths
  const t = fracIdx - Math.floor(fracIdx)

  const arr = projected ? projected.overallAngles : skyline.angles
  return arr[idx0] * (1 - t) + arr[idx1] * t
}

export function bandAngleAt(
  skyline: SkylineData,
  bandIndex: number,
  bearingDeg: number,
  projected: ProjectedBands | null,
): number {
  const band = skyline.bands[bandIndex]
  const bandRes = band.resolution
  const bandAz  = band.numAzimuths

  const normBearing = ((bearingDeg % 360) + 360) % 360
  const fracIdx = normBearing * bandRes
  const idx0 = Math.floor(fracIdx) % bandAz
  const idx1 = (idx0 + 1) % bandAz
  const t = fracIdx - Math.floor(fracIdx)

  const SENTINEL = -Math.PI / 2 + 0.001

  if (projected) {
    const arr = projected.bandAngles[bandIndex]
    const a0 = arr[idx0], a1 = arr[idx1]
    if (a0 <= SENTINEL && a1 <= SENTINEL) return -Math.PI / 2
    if (a0 <= SENTINEL) return a1
    if (a1 <= SENTINEL) return a0
    return a0 * (1 - t) + a1 * t
  }

  if ((band.elevations[idx0] === -Infinity || band.elevations[idx0] < OCEAN_ELEV_M) &&
      (band.elevations[idx1] === -Infinity || band.elevations[idx1] < OCEAN_ELEV_M)) return -Math.PI / 2

  const computeAngle = (idx: number) => {
    if (band.elevations[idx] === -Infinity || band.elevations[idx] < OCEAN_ELEV_M) return -Math.PI / 2
    const dist = band.distances[idx]
    const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
    return Math.atan2(band.elevations[idx] - curvDrop - skyline.computedAt.elev, dist)
  }

  const a0 = computeAngle(idx0), a1 = computeAngle(idx1)
  if (a0 <= SENTINEL && a1 <= SENTINEL) return -Math.PI / 2
  if (a0 <= SENTINEL) return a1
  if (a1 <= SENTINEL) return a0
  return a0 * (1 - t) + a1 * t
}

export function bandElevAt(
  skyline: SkylineData,
  bandIndex: number,
  bearingDeg: number,
): number {
  const band = skyline.bands[bandIndex]
  const bandRes = band.resolution
  const bandAz  = band.numAzimuths

  const normBearing = ((bearingDeg % 360) + 360) % 360
  const fracIdx = normBearing * bandRes
  const idx0 = Math.floor(fracIdx) % bandAz
  const idx1 = (idx0 + 1) % bandAz
  const t = fracIdx - Math.floor(fracIdx)

  const e0 = band.elevations[idx0]
  const e1 = band.elevations[idx1]
  if (e0 === -Infinity && e1 === -Infinity) return -Infinity
  if (e0 === -Infinity) return e1
  if (e1 === -Infinity) return e0
  return e0 * (1 - t) + e1 * t
}

export function bandDistAt(
  skyline: SkylineData,
  bandIndex: number,
  bearingDeg: number,
): number {
  const band = skyline.bands[bandIndex]
  const bandRes = band.resolution
  const bandAz  = band.numAzimuths

  const normBearing = ((bearingDeg % 360) + 360) % 360
  const fracIdx = normBearing * bandRes
  const idx0 = Math.floor(fracIdx) % bandAz
  const idx1 = (idx0 + 1) % bandAz
  const t = fracIdx - Math.floor(fracIdx)

  const d0 = band.distances[idx0]
  const d1 = band.distances[idx1]
  if (band.elevations[idx0] === -Infinity && band.elevations[idx1] === -Infinity) return 0
  if (band.elevations[idx0] === -Infinity) return d1
  if (band.elevations[idx1] === -Infinity) return d0
  return d0 * (1 - t) + d1 * t
}

// ─── Elevation → Palette Color ──────────────────────────────────────────────

const RIDGE_PALETTE: [number, number, number][] = [
  [14,  57,  81],
  [18,  75, 107],
  [33,  92, 121],
  [47, 109, 135],
  [75, 142, 163],
  [104, 176, 191],
]

export function elevToRidgeColor(tElev: number): string {
  const t = Math.max(0, Math.min(1, tElev))
  const maxIdx = RIDGE_PALETTE.length - 1
  const scaled = t * maxIdx
  const i0 = Math.floor(scaled)
  const i1 = Math.min(i0 + 1, maxIdx)
  const frac = scaled - i0
  const [r0, g0, b0] = RIDGE_PALETTE[i0]
  const [r1, g1, b1] = RIDGE_PALETTE[i1]
  const r = Math.round(r0 + (r1 - r0) * frac)
  const g = Math.round(g0 + (g1 - g0) * frac)
  const b = Math.round(b0 + (b1 - b0) * frac)
  return `rgb(${r},${g},${b})`
}

// ─── Depth Band Visual Parameters ───────────────────────────────────────────

export interface BandStyle {
  fillColor:      string
  strokeColor:    string
  lineWidthNear:  number
  lineWidthFar:   number
}

const BAND_LINE_WIDTHS: [number, number][] = [
  [5, 4.5],
  [4.5, 3.5],
  [3.5, 3],
  [3, 2.5],
  [2.5, 2],
  [2, 1],
]

export function bandStyleForIndex(bandIndex: number, bandCount: number): BandStyle {
  const t = bandCount <= 1 ? 1 : 1 - bandIndex / (bandCount - 1)

  // Fill: void (#000810) → deep (#124B6B), on the ocean-depth palette
  const FILL_COLORS: [number, number, number][] = [
    [2,  12, 20],   // ultra-near — near void
    [5,  24, 38],   // near — 20% toward deep
    [8,  36, 56],   // mid-near — 40% toward deep
    [11, 48, 74],   // mid — 60% toward deep
    [14, 62, 90],   // mid-far — 80% toward deep
    [18, 75, 107],  // far — exactly ec-deep
  ]
  const bandIdx = bandCount <= 1 ? 0 : Math.round((1 - t) * (FILL_COLORS.length - 1))
  const [fillR, fillG, fillB] = FILL_COLORS[Math.min(bandIdx, FILL_COLORS.length - 1)]
  const fillColor = `rgb(${fillR},${fillG},${fillB})`

  const strokeColor = `rgba(132, 209, 219, ${(0.15 + t * 0.65).toFixed(2)})`

  const widths = BAND_LINE_WIDTHS[bandIndex] || [1 + t * 4, 1 + t * 4]

  return { fillColor, strokeColor, lineWidthNear: widths[0], lineWidthFar: widths[1] }
}

// ─── Terrain Renderer ───────────────────────────────────────────────────────

export function renderTerrain(
  ctx: CanvasRenderingContext2D,
  skyline: SkylineData,
  cam: CameraParams,
  projected: ProjectedBands | null,
  showBandLines: boolean = true,
  showFill: boolean = true,
): void {
  const { W, H } = cam
  const scale = cam.scale ?? 1
  const numBands = skyline.bands.length

  let globalElevMin = Infinity
  let globalElevMax = -Infinity
  for (let bi = 0; bi < numBands; bi++) {
    const elev = skyline.bands[bi].elevations
    for (let i = 0; i < elev.length; i++) {
      if (elev[i] === -Infinity || elev[i] < OCEAN_ELEV_M) continue
      if (elev[i] < globalElevMin) globalElevMin = elev[i]
      if (elev[i] > globalElevMax) globalElevMax = elev[i]
    }
  }
  const elevRange = globalElevMax - globalElevMin
  const hasElevRange = elevRange > 1

  const SEGMENT_SIZES = [3, 4, 6, 12, 24, 48].map(s => Math.round(s * scale))

  for (let bi = numBands - 1; bi >= 0; bi--) {
    const style = bandStyleForIndex(bi, numBands)
    const bandCfg = DEPTH_BANDS[bi]
    const segSize = SEGMENT_SIZES[bi] ?? 24

    const lwMin = bandCfg ? bandCfg.minDist : 0
    const lwMax = bandCfg ? bandCfg.maxDist : 1
    const lwRange = lwMax - lwMin

    // ── Fill below this band's ridgeline
    ctx.beginPath()
    ctx.moveTo(0, H)
    let hasVisiblePixels = false

    for (let col = 0; col < W; col++) {
      const bearingDeg = cam.heading_deg + (col / W - 0.5) * cam.hfov
      const angle = bandAngleAt(skyline, bi, bearingDeg, projected)

      if (angle <= -Math.PI / 2 + 0.001) {
        ctx.lineTo(col, H)
        continue
      }

      hasVisiblePixels = true
      const { y } = project(bearingDeg, angle, cam)
      const screenY = Math.round(y)
      ctx.lineTo(col, Math.min(H, Math.max(0, screenY)))
    }

    ctx.lineTo(W, H)
    ctx.closePath()
    if (hasVisiblePixels && showFill) {
      ctx.fillStyle = style.fillColor
      ctx.fill()
    }

    // ── Ridgeline stroke
    if (hasVisiblePixels && showBandLines) {
      ctx.lineCap = 'butt'
      ctx.lineJoin = 'round'

      let segStartCol = -1

      for (let col = 0; col < W; col++) {
        const bearingDeg = cam.heading_deg + (col / W - 0.5) * cam.hfov
        const angle = bandAngleAt(skyline, bi, bearingDeg, projected)

        if (angle <= -Math.PI / 2 + 0.001) {
          if (segStartCol >= 0) ctx.stroke()
          segStartCol = -1
          continue
        }

        const { y } = project(bearingDeg, angle, cam)
        const screenY = Math.round(y)

        if (screenY >= H) {
          if (segStartCol >= 0) ctx.stroke()
          segStartCol = -1
          continue
        }

        const clampedY = Math.max(0, screenY)

        if (segStartCol < 0) {
          const elev = bandElevAt(skyline, bi, bearingDeg)
          const tElev = hasElevRange && elev > -Infinity
            ? (elev - globalElevMin) / elevRange
            : 0.5
          const dist = bandDistAt(skyline, bi, bearingDeg)
          const tDist = lwRange > 0 ? Math.max(0, Math.min(1, (dist - lwMin) / lwRange)) : 0
          ctx.lineWidth = (style.lineWidthNear + tDist * (style.lineWidthFar - style.lineWidthNear)) * scale
          ctx.beginPath()
          ctx.strokeStyle = elevToRidgeColor(tElev)
          ctx.moveTo(col, clampedY)
          segStartCol = col
        } else if (col - segStartCol >= segSize) {
          ctx.lineTo(col, clampedY)
          ctx.stroke()

          const elev = bandElevAt(skyline, bi, bearingDeg)
          const tElev = hasElevRange && elev > -Infinity
            ? (elev - globalElevMin) / elevRange
            : 0.5
          const dist = bandDistAt(skyline, bi, bearingDeg)
          const tDist = lwRange > 0 ? Math.max(0, Math.min(1, (dist - lwMin) / lwRange)) : 0
          ctx.lineWidth = (style.lineWidthNear + tDist * (style.lineWidthFar - style.lineWidthNear)) * scale
          ctx.beginPath()
          ctx.strokeStyle = elevToRidgeColor(tElev)
          ctx.moveTo(col, clampedY)
          segStartCol = col
        } else {
          ctx.lineTo(col, clampedY)
        }
      }

      if (segStartCol >= 0) ctx.stroke()
    }
  }
}

// ─── Contour Line Renderer ──────────────────────────────────────────────────

export function renderContours(
  ctx: CanvasRenderingContext2D,
  strands: PrebuiltContourStrand[],
  cam: CameraParams,
  globalElevMin: number,
  globalElevMax: number,
  skyline?: SkylineData,
  projected?: ProjectedBands | null,
): void {
  const { W, H } = cam
  const scale = cam.scale ?? 1
  const elevRange = globalElevMax - globalElevMin
  const hasElevRange = elevRange > 1

  const MAX_D = 400_000
  const WIDTH_MIN = 0.5 * scale
  const WIDTH_MAX = 5 * scale
  const WIDTH_RANGE = WIDTH_MAX - WIDTH_MIN
  const WIDTH_POWER = 0.2

  const CONTOUR_OPACITIES = [0.65, 0.55, 0.45, 0.35, 0.25, 0.15]

  const WIDTH_FLUSH_RATIO = 0.2

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const strand of strands) {
    if (strand.points.length < 2) continue

    const bi = strand.bandIdx
    const opacity = CONTOUR_OPACITIES[bi] ?? 0.15

    const tElev = hasElevRange
      ? Math.max(0, Math.min(1, (strand.level - globalElevMin) / elevRange))
      : 0.5
    const baseColor = elevToRidgeColor(tElev)
    const rgbMatch = baseColor.match(/\d+/g)
    if (!rgbMatch) continue

    ctx.strokeStyle = `rgba(${rgbMatch[0]},${rgbMatch[1]},${rgbMatch[2]},${opacity})`

    let pathStarted = false
    let currentWidth = 0
    // Track last projected x to detect seam jumps — when consecutive
    // points span more than half the canvas, they've crossed the
    // ±hfov/2 wrap boundary (e.g. bearing 180° at both edges on the
    // 360° wrap view). Break the path instead of drawing across it.
    let prevX = 0
    const SEAM_JUMP = W * 0.5

    for (let i = 0; i < strand.points.length; i++) {
      const pt = strand.points[i]

      // ── Occlusion check: skip points hidden behind nearer bands ──
      // For each strand point, check if any band closer than this strand's band
      // has a ridgeline angle above this point's angle at this bearing.
      // This works at all AGL values because projected band angles are already
      // re-projected for the current viewer elevation.
      if (skyline && bi > 0) {
        let occluded = false
        for (let nearerBi = 0; nearerBi < bi; nearerBi++) {
          const nearerAngle = bandAngleAt(skyline, nearerBi, pt.bearingDeg, projected ?? null)
          if (nearerAngle > -Math.PI / 2 + 0.001 && nearerAngle >= pt.elevAngleRad) {
            occluded = true
            break
          }
        }
        if (occluded) {
          if (pathStarted) { ctx.stroke(); pathStarted = false }
          continue
        }
      }

      const { x, y } = project(pt.bearingDeg, pt.elevAngleRad, cam)
      const onScreen = x >= -10 && x <= W + 10 && y >= 0 && y < H

      if (!onScreen) {
        if (pathStarted) { ctx.stroke(); pathStarted = false }
        continue
      }

      // Seam break: huge x jump means we crossed the panorama wrap.
      if (pathStarted && Math.abs(x - prevX) > SEAM_JUMP) {
        ctx.stroke()
        pathStarted = false
      }

      const tDist = Math.min(1, pt.dist / MAX_D)
      const lw = WIDTH_MIN + WIDTH_RANGE * (1 - Math.pow(tDist, WIDTH_POWER))

      if (!pathStarted) {
        ctx.lineWidth = lw
        currentWidth = lw
        ctx.beginPath()
        ctx.moveTo(x, y)
        pathStarted = true
      } else if (Math.abs(lw - currentWidth) > currentWidth * WIDTH_FLUSH_RATIO) {
        ctx.lineTo(x, y)
        ctx.stroke()
        ctx.lineWidth = lw
        currentWidth = lw
        ctx.beginPath()
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
      prevX = x
    }

    if (pathStarted) ctx.stroke()
  }
}

// ─── Peak Visibility ────────────────────────────────────────────────────────

const NEAR_PEAK_DIST = 50_000

export function isPeakVisible(
  peak: { lat: number; lng: number; elevation_m: number },
  viewerLat: number, viewerLng: number, viewerElev: number,
  heading_deg: number, hfov: number,
  skyline: SkylineData,
  projected: ProjectedBands | null,
  envelope: VisibilityEnvelope | null = null,
): boolean {
  const cosLat = Math.cos(viewerLat * DEG_TO_RAD)
  const dx = (peak.lng - viewerLng) * 111_320 * cosLat
  const dy = (peak.lat - viewerLat) * 111_132
  const dist = Math.sqrt(dx * dx + dy * dy)

  if (dist > MAX_PEAK_DIST || dist < 100) return false

  const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360

  let angleDiff = bearing - heading_deg
  if (angleDiff > 180) angleDiff -= 360
  if (angleDiff < -180) angleDiff += 360
  if (Math.abs(angleDiff) > hfov * 0.5) return false

  const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
  const peakAngle = Math.atan2(peak.elevation_m - curvDrop - viewerElev, dist)

  // Envelope-based occlusion (preferred when available) — V3 style, uniform
  // across all distances. Uses ratio comparison instead of atan2.
  if (envelope) {
    const peakRatio = (peak.elevation_m - curvDrop - viewerElev) / dist
    const normB = ((bearing % 360) + 360) % 360
    const envAi = Math.round(normB * envelope.resolution) % envelope.numAzimuths
    const si    = profileDistIndex(envelope.distances, dist)
    if (si < 0) return true  // peak closer than first profile step — show it
    const maxRatio = envelope.envelope[envAi * envelope.numSteps + si]
    if (dist <= NEAR_PEAK_TOL_MAX_M) {
      return peakRatio + NEAR_PEAK_TOL_RATIO >= maxRatio
    }
    return peakRatio >= maxRatio
  }

  // Legacy ridge-based occlusion (used when envelope is unavailable)
  const ridgeAngle = skylineAngleAt(skyline, bearing, projected)
  const tolerance = 0.15 * DEG_TO_RAD

  if (peakAngle >= ridgeAngle - tolerance) return true

  if (dist <= NEAR_PEAK_DIST) {
    let occluded = false
    for (let bi = 0; bi < skyline.bands.length; bi++) {
      const bandCfg = DEPTH_BANDS[bi]
      if (!bandCfg || bandCfg.minDist >= dist) continue
      const bAngle = bandAngleAt(skyline, bi, bearing, projected)
      if (bAngle > -Math.PI / 2 + 0.001 && peakAngle < bAngle - tolerance) {
        occluded = true
        break
      }
    }
    if (!occluded) return true
  }

  return false
}

// ─── Sky Gradient ───────────────────────────────────────────────────────────
// Gradient is black top → black through the horizon zone → slow fade to a
// deep ocean blue at the bottom. No horizon line, no baked-in stars.

export function drawSkyAndStars(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
): void {
  const skyGrad = ctx.createLinearGradient(0, 0, 0, H)
  skyGrad.addColorStop(0,    '#000000') 
  skyGrad.addColorStop(0.50, '#000000')
  skyGrad.addColorStop(0.65, '#030a14')
  skyGrad.addColorStop(0.82, '#071a2a')
  skyGrad.addColorStop(1.0,  '#0f2c42')
  ctx.fillStyle = skyGrad
  ctx.fillRect(0, 0, W, H)
}

// ─── Background Stars ───────────────────────────────────────────────────────
// Stars live in (bearing, elevation angle) space so they stay fixed to the
// sky as AGL changes. `generateStars` produces a stable list (seeded RNG);
// `drawStars` is called each frame with the current time and current
// per-azimuth ridge maxes, and hides/fades any star whose local ridge is
// within the buffer. All stars live above the horizon (elev > 0).

export interface Star {
  bearingDeg:   number
  elevAngleRad: number
  size:         number   // radius in canvas pixels at scale=1
  r:            number
  g:            number
  b:            number
  twinkleRate:  number   // rad/sec
  twinklePhase: number
  brightness:   number   // 0..1 base-alpha multiplier (dim pass < bright pass)
}

export interface StarPassOpts {
  count:      number
  seed?:      number
  sizeMin?:   number
  sizeMax?:   number
  sizePower?: number   // higher = more small stars
  brightness?: number  // 0..1
}

const STAR_PALETTE: [number, number, number][] = [
  [255, 255, 255],  // white
  [240, 246, 255],  // near-white
  [210, 228, 245],  // pale blue
  [178, 214, 232],  // ec-foam-ish
  [167, 221, 229],  // ec-reef
  [132, 209, 219],  // ec-glow
]

export function generateStars(opts: StarPassOpts): Star[] {
  const {
    count,
    seed       = 1337,
    sizeMin    = 1.0,
    sizeMax    = 4.5,
    sizePower  = 2.2,
    brightness = 1,
  } = opts
  let s = seed >>> 0
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff }
  const stars: Star[] = []
  for (let i = 0; i < count; i++) {
    const bearingDeg = rand() * 360
    const raw = Math.pow(rand(), 0.9)
    const elevAngleRad = (3 + raw * 79) * DEG_TO_RAD
    const size = sizeMin + Math.pow(rand(), sizePower) * (sizeMax - sizeMin)
    const [r, g, b] = STAR_PALETTE[Math.floor(rand() * STAR_PALETTE.length)]
    const twinkleRate  = 0.25 + rand() * 0.9
    const twinklePhase = rand() * Math.PI * 2
    stars.push({ bearingDeg, elevAngleRad, size, r, g, b, twinkleRate, twinklePhase, brightness })
  }
  return stars
}

export interface StarAngleSource {
  angles:      Float32Array
  resolution:  number   // samples per degree
  numAzimuths: number
}

export function drawStars(
  ctx: CanvasRenderingContext2D,
  stars: Star[],
  cam: CameraParams,
  sources: StarAngleSource[],
  timeSec: number,
): void {
  const { W } = cam
  const horizonY = getHorizonY(cam)
  const scale = cam.scale ?? 1

  const FADE_MIN_RAD = 1.0 * DEG_TO_RAD
  const FADE_MAX_RAD = 4.0 * DEG_TO_RAD
  const SENTINEL = -Math.PI / 2 + 0.001

  // Sample one source by bearing (linear interp across neighbouring buckets,
  // mirroring how renderTerrain reads the same array).
  const sample = (src: StarAngleSource, bearingDeg: number): number => {
    const normB = ((bearingDeg % 360) + 360) % 360
    const fracIdx = normB * src.resolution
    const idx0 = Math.floor(fracIdx) % src.numAzimuths
    const idx1 = (idx0 + 1) % src.numAzimuths
    const t = fracIdx - Math.floor(fracIdx)
    const a0 = src.angles[idx0]
    const a1 = src.angles[idx1]
    if (a0 > SENTINEL && a1 > SENTINEL) return a0 * (1 - t) + a1 * t
    if (a0 > SENTINEL) return a0
    if (a1 > SENTINEL) return a1
    return -Math.PI / 2
  }

  for (let i = 0; i < stars.length; i++) {
    const st = stars[i]

    // ── Max terrain angle at this star's bearing ──
    // Take the max across all supplied sources (silhouette + overall bands)
    // so whichever one reports taller terrain at this azimuth wins.
    let maxRidge = -Math.PI / 2
    for (let s = 0; s < sources.length; s++) {
      const a = sample(sources[s], st.bearingDeg)
      if (a > maxRidge) maxRidge = a
    }

    const margin = st.elevAngleRad - maxRidge
    if (margin < FADE_MIN_RAD) continue

    const fadeT = margin >= FADE_MAX_RAD
      ? 1
      : (margin - FADE_MIN_RAD) / (FADE_MAX_RAD - FADE_MIN_RAD)

    const tw = 0.6 + 0.4 * Math.sin(timeSec * st.twinkleRate + st.twinklePhase)
    const alpha = fadeT * (0.25 + 0.75 * tw) * st.brightness
    if (alpha < 0.02) continue

    const { x, y } = project(st.bearingDeg, st.elevAngleRad, cam)
    if (y < 0 || y > horizonY - 1) continue
    if (x < 0 || x > W) continue

    ctx.fillStyle = `rgba(${st.r},${st.g},${st.b},${alpha.toFixed(3)})`
    ctx.beginPath()
    ctx.arc(x, y, st.size * scale, 0, Math.PI * 2)
    ctx.fill()
  }
}

// ─── Horizon Glow ───────────────────────────────────────────────────────────

export function drawHorizonGlow(
  ctx: CanvasRenderingContext2D,
  cam: CameraParams,
): void {
  const horizonY = getHorizonY(cam)
  const { W } = cam
  const g = Math.round(12 * (cam.scale ?? 1))

  const glowGrad = ctx.createLinearGradient(0, horizonY - g, 0, horizonY + g)
  glowGrad.addColorStop(0,   'rgba(132, 209, 219, 0)')
  glowGrad.addColorStop(0.5, 'rgba(132, 209, 219, 0.22)')
  glowGrad.addColorStop(1,   'rgba(132, 209, 219, 0)')
  ctx.fillStyle = glowGrad
  ctx.fillRect(0, Math.round(horizonY - g), W, 2 * g)

  ctx.fillStyle = 'rgba(132, 209, 219, 0.18)'
  ctx.fillRect(0, Math.round(horizonY), W, 1)
}

// ─── Silhouette Layer Builder ────────────────────────────────────────────────

/**
 * Compute visible silhouette layers from the worker's packed candidate data.
 *
 * For each azimuth, sweeps the candidate list near→far and converts rawElev+dist
 * into elevation angles at the current viewerElev.  A candidate is visible if its
 * angle exceeds the running maximum from all nearer terrain.
 *
 * Returns SilhouetteLayers[azimuthIdx][layerIdx] — layers sorted near→far within
 * each azimuth.  Typically 2–12 layers per azimuth in mountainous terrain.
 *
 * Cost: ~26 candidates × 2880 azimuths = ~75K atan2 calls.  Sub-millisecond.
 */
export function buildSilhouetteLayers(
  skyline: SkylineData,
  viewerElev: number,
): SilhouetteLayer[][] | null {
  const sil = skyline.silhouette
  if (!sil || !sil.candidateData || sil.candidateData.length === 0) return null

  const { candidateData, candidateOffsets, numAzimuths } = sil
  const FPC = 8  // floats per candidate (SILHOUETTE_FLOATS_PER_CANDIDATE)
  const result: SilhouetteLayer[][] = new Array(numAzimuths)

  for (let ai = 0; ai < numAzimuths; ai++) {
    const start = candidateOffsets[ai]
    const end   = candidateOffsets[ai + 1]

    if (start >= end) {
      result[ai] = []
      continue
    }

    const layers: SilhouetteLayer[] = []
    let maxAngle = -Math.PI / 2

    // Candidates are sorted near→far by distance
    for (let off = start; off < end; off += FPC) {
      const effElev     = candidateData[off]
      const rawElev     = candidateData[off + 1]
      const dist        = candidateData[off + 2]
      const lat         = candidateData[off + 3]
      const lng         = candidateData[off + 4]
      const baseEffElev = candidateData[off + 5]
      const baseDist    = candidateData[off + 6]
      const flags       = candidateData[off + 7]

      const peakAngle = Math.atan2(effElev - viewerElev, dist)
      const isOcean   = (flags & 1) !== 0

      // Skip ocean candidates — no terrain fill for ocean
      if (isOcean) continue

      // Visible only if this candidate peeks above all nearer terrain
      if (peakAngle > maxAngle) {
        // Base angle: either the valley floor angle or the current running max
        // (whichever is higher — we can't see below the running max)
        const rawBaseAngle = baseDist > 0
          ? Math.atan2(baseEffElev - viewerElev, baseDist)
          : -Math.PI / 2
        const baseAngle = Math.max(rawBaseAngle, maxAngle)

        layers.push({
          peakAngle,
          baseAngle,
          rawElev,
          dist,
          lat,
          lng,
          effElev,
          baseEffElev,
          isOcean,
        })

        maxAngle = peakAngle
      }
    }

    result[ai] = layers
  }

  return result
}

// ─── Silhouette Layer Matching (connect layers across azimuths into strands) ─

/** A matched silhouette strand: a continuous silhouette edge across azimuths.
 *  Built by matching layers at adjacent azimuths by distance proximity. */
export interface SilhouetteStrand {
  /** Per-azimuth data for this strand, indexed by screen column position.
   *  Each entry has the azimuth index and the layer from that azimuth. */
  segments: Array<{ ai: number; layer: SilhouetteLayer }>
  /** Average distance of this strand (for depth-based styling) */
  avgDist: number
}

/**
 * Match silhouette layers across adjacent azimuths into continuous strands.
 * Primary match key: distance proximity — a silhouette line represents terrain
 * at a specific distance from the viewer. Two adjacent azimuth samples belong
 * to the same strand only if they're at approximately the same distance.
 * Minimum peakAngle filter: skip layers whose angle is too low — near-flat
 * ridgelines aren't meaningful silhouettes and clutter the view.
 * Returns strands sorted far→near (for painter's order fill rendering).
 */
export function matchSilhouetteStrands(
  layers: SilhouetteLayer[][],
  numAzimuths: number,
  resolution: number,
  cam: CameraParams,
): SilhouetteStrand[] {
  const { heading_deg, hfov } = cam

  // Minimum peakAngle — fixed relative to horizon. AGL is already baked into
  // peakAngle by buildSilhouetteLayers (atan2(effElev - viewerElev, dist)).
  // Camera pitch only affects where on screen things are drawn, not whether
  // silhouette lines exist. Same mountain at same AGL = same silhouettes.
  const MIN_PEAK_ANGLE = -0.30  // ~-17° below horizon

  // Determine visible azimuth range.
  // Special case for full-panorama views (hfov >= 360): sweep all azimuths.
  // Without this, hfov=360 collapses to aiStart==aiEnd==0 and we'd visit 1 azimuth.
  const isFullPanorama = hfov >= 359.999
  const bearingStart = heading_deg - hfov * 0.5
  const bearingEnd   = heading_deg + hfov * 0.5

  const aiStart = isFullPanorama
    ? 0
    : Math.floor(((bearingStart % 360 + 360) % 360) * resolution)
  const aiEnd = isFullPanorama
    ? numAzimuths - 1
    : Math.ceil(((bearingEnd % 360 + 360) % 360) * resolution)

  // Active strands being built
  interface ActiveStrand {
    segments: Array<{ ai: number; layer: SilhouetteLayer }>
    lastAi:   number
    lastDist: number
    distSum:  number
  }
  const active: ActiveStrand[] = []
  const completed: SilhouetteStrand[] = []

  const MAX_AZ_GAP = Math.ceil(resolution * 4)  // Max 4° gap before expiring

  // Sweep through visible azimuths
  const totalVisible = isFullPanorama
    ? numAzimuths
    : (aiEnd >= aiStart
        ? aiEnd - aiStart + 1
        : (numAzimuths - aiStart) + aiEnd + 1)

  for (let step = 0; step < totalVisible; step++) {
    const ai = (aiStart + step) % numAzimuths
    const azLayers = layers[ai]
    if (!azLayers || azLayers.length === 0) continue

    const matched = new Set<number>()  // indices into active that got matched

    for (const layer of azLayers) {
      // Skip layers below minimum angle — not meaningful silhouettes
      if (layer.peakAngle < MIN_PEAK_ANGLE) continue

      // Find closest active strand by distance — primary match key.
      // A real ridgeline varies ±10-15% in distance across its bearing span
      // (cosine effect of a ridge curving away). Tighter tolerance prevents
      // connecting candidates from different ridges at different depths.
      let bestIdx = -1
      let bestDiff = Infinity
      const distTol = layer.dist < 10_000
        ? Math.max(200, layer.dist * 0.12)   // near: 12%, floor 200m
        : layer.dist < 50_000
        ? Math.max(500, layer.dist * 0.15)   // mid: 15%, floor 500m
        : Math.max(1000, layer.dist * 0.18)  // far: 18%, floor 1km

      for (let si = 0; si < active.length; si++) {
        if (matched.has(si)) continue
        const s = active[si]
        // Check azimuth gap
        const azGap = ai >= s.lastAi ? ai - s.lastAi : (numAzimuths - s.lastAi + ai)
        if (azGap > MAX_AZ_GAP) continue

        const diff = Math.abs(layer.dist - s.lastDist)
        if (diff < bestDiff && diff < distTol) {
          bestIdx = si
          bestDiff = diff
        }
      }

      if (bestIdx >= 0) {
        // Extend existing strand
        active[bestIdx].segments.push({ ai, layer })
        active[bestIdx].lastAi   = ai
        active[bestIdx].lastDist = layer.dist
        active[bestIdx].distSum += layer.dist
        matched.add(bestIdx)
      } else {
        // Start new strand
        active.push({
          segments: [{ ai, layer }],
          lastAi:   ai,
          lastDist: layer.dist,
          distSum:  layer.dist,
        })
      }
    }

    // Expire old strands (check periodically)
    if (step % MAX_AZ_GAP === 0) {
      for (let si = active.length - 1; si >= 0; si--) {
        const s = active[si]
        const azGap = ai >= s.lastAi ? ai - s.lastAi : (numAzimuths - s.lastAi + ai)
        if (azGap > MAX_AZ_GAP) {
          if (s.segments.length >= 3) {
            completed.push({
              segments: s.segments,
              avgDist:  s.distSum / s.segments.length,
            })
          }
          active.splice(si, 1)
        }
      }
    }
  }

  // Flush remaining active strands
  for (const s of active) {
    if (s.segments.length >= 3) {
      completed.push({
        segments: s.segments,
        avgDist:  s.distSum / s.segments.length,
      })
    }
  }

  // Sort far→near for painter's order (far drawn first, near on top)
  completed.sort((a, b) => b.avgDist - a.avgDist)

  return completed
}

// ─── Silhouette Renderers (glow + strokes) ───────────────────────────────────

const GLOW_MAX_ALPHA    = 0.55  // max glow opacity at peak prominence + near + high angle
const GLOW_DIST_FLOOR   = 0.06  // even the farthest ridge gets a small glow floor
const GLOW_ANGLE_ZERO   = -0.30 // rad — matches MIN_PEAK_ANGLE; all visible silhouette terrain gets glow
const GLOW_ANGLE_FULL   = 0.10  // rad — glow reaches full intensity above this angle
const GLOW_PROMINENCE_SCALE = 150 // metres — ridge this far above its valley = full tProminence

/**
 * Render soft atmospheric glow behind silhouette strands.
 *
 * Three gaussian-like passes at decreasing width/increasing alpha create a halo
 * that sits BEHIND the crisp strokes.  Brightness scales with:
 *   - Angle: high ridgelines glow strong, flat terrain near threshold = zero
 *   - Distance: near = intense tight glow, far = subtle soft whisper
 *   - Prominence (effElev - baseEffElev): 0.5–1.0 boost multiplier
 *
 * Called BEFORE renderSilhouetteStrokes so the crisp line draws on top.
 */
export function renderSilhouetteGlow(
  ctx: CanvasRenderingContext2D,
  strands: SilhouetteStrand[],
  cam: CameraParams,
  globalElevMin: number,
  globalElevMax: number,
  silResolution: number,
): void {
  const { H } = cam
  const elevRange = globalElevMax - globalElevMin
  const hasElevRange = elevRange > 1
  const maxDist = 400_000
  const MIN_PEAK_ANGLE = -0.30
  const MAX_ANGLE_JUMP = 0.005
  const MIN_STRAND_SEGS = 8
  const numAzimuths = silResolution * 360
  const MAX_AZ_GAP = 4

  ctx.save()
  ctx.lineCap  = 'round'
  ctx.lineJoin = 'round'

  for (let si = 0; si < strands.length; si++) {
    const strand = strands[si]
    const segs = strand.segments
    if (segs.length < MIN_STRAND_SEGS) continue

    const distT = Math.sqrt(Math.min(1, strand.avgDist / maxDist))
    const tDistGlow = GLOW_DIST_FLOOR + (1 - GLOW_DIST_FLOOR) * (1 - distT)

    // Strand-level base width (midpoint of near/far range — glow is atmospheric,
    // doesn't need curvature tapering)
    const maxWidth = 1.5 + (1 - distT) * 3.5
    const minWidth = 0.4 + (1 - distT) * 1.6
    const baseGlowWidth = (minWidth + maxWidth) * 0.5

    // Strand-level color from average elevation
    const avgElev = segs.reduce((s, seg) => s + seg.layer.rawElev, 0) / segs.length
    const tElev = hasElevRange
      ? Math.max(0, Math.min(1, (avgElev - globalElevMin) / elevRange)) : 0.5
    const baseColor = elevToRidgeColor(tElev)
    const rgbMatch = baseColor.match(/\d+/g)
    const gr = rgbMatch ? Math.min(255, Math.round(parseInt(rgbMatch[0]) * 0.9 + 40)) : 140
    const gg = rgbMatch ? Math.min(255, Math.round(parseInt(rgbMatch[1]) * 0.9 + 30)) : 190
    const gb = rgbMatch ? Math.min(255, Math.round(parseInt(rgbMatch[2]) * 0.95 + 50)) : 220

    // Strand-level tGlow from average peakAngle + average prominence
    const avgPeakAngle = segs.reduce((s, seg) => s + seg.layer.peakAngle, 0) / segs.length
    let promSum = 0
    for (const seg of segs) {
      const hasBase = Math.abs(seg.layer.baseAngle - (-Math.PI / 2)) > 0.01
      promSum += hasBase
        ? Math.max(0, seg.layer.effElev - seg.layer.baseEffElev)
        : GLOW_PROMINENCE_SCALE
    }
    const avgProm = promSum / segs.length
    const tProminence = Math.min(1, Math.max(0, avgProm / GLOW_PROMINENCE_SCALE))
    // Ease-out power curve: steep rise from threshold, gentle plateau toward full.
    // At -0.30 rad: 0.44 glow.  At -0.20 rad: 0.87.  At -0.10 rad: 0.98.
    const tLinear = Math.max(0, Math.min(1,
      (avgPeakAngle - GLOW_ANGLE_ZERO) / (GLOW_ANGLE_FULL - GLOW_ANGLE_ZERO)))
    const tAngle = 1 - Math.pow(1 - tLinear, 5)
    const tGlow = tAngle * tDistGlow * (0.5 + 0.5 * tProminence)

    if (tGlow < 0.01) continue

    const glowAlpha = tGlow * GLOW_MAX_ALPHA

    // Asymmetric Y offset: sky (up) gets tight bright passes, terrain (down) gets diffused bleed.
    // Scales with distance so offset is proportional at all depths.
    const baseOffset = 2 + (1 - distT) * 2  // near: 4px, far: 2px

    // Glow passes: drawn wide→narrow so narrower overlays wider.
    // Y offset: negative = sky (up), positive = terrain (down).
    const passes = [
      { widthMul: 6,   alphaMul: 0.10, yOff: +baseOffset },        // terrain bleed (wide, dim, down)
      { widthMul: 3,   alphaMul: 0.22, yOff: -baseOffset * 0.7 },  // sky halo (medium, brighter, up)
      { widthMul: 1.5, alphaMul: 0.45, yOff: -baseOffset * 0.3 },  // sky core (tight, brightest, slight up)
    ]

    // Build runs (same azimuth-gap logic as strokes)
    const runs: Array<{ start: number; end: number }> = []
    let runStart = 0
    for (let i = 1; i < segs.length; i++) {
      const prevAi = segs[i - 1].ai
      const currAi = segs[i].ai
      const gap = currAi >= prevAi ? currAi - prevAi : (numAzimuths - prevAi + currAi)
      if (gap > MAX_AZ_GAP) {
        if (i - runStart >= 3) runs.push({ start: runStart, end: i })
        runStart = i
      }
    }
    if (segs.length - runStart >= 3) runs.push({ start: runStart, end: segs.length })

    for (const run of runs) {
      // Project points — angle continuity check keeps the path smooth
      const projected: Array<{ x: number; y: number }> = []
      let prevPeakAngle = -999

      for (let i = run.start; i < run.end; i++) {
        const { ai, layer } = segs[i]
        if (layer.peakAngle < MIN_PEAK_ANGLE) {
          projected.push({ x: 0, y: -9999 })
          prevPeakAngle = -999
          continue
        }
        if (prevPeakAngle > -999 && Math.abs(layer.peakAngle - prevPeakAngle) > MAX_ANGLE_JUMP) {
          projected.push({ x: 0, y: -9999 })
          prevPeakAngle = layer.peakAngle
          continue
        }
        const bearing = ai / silResolution
        const pos = project(bearing, layer.peakAngle, cam)
        if (pos.y >= H) {
          projected.push({ x: pos.x, y: -9999 })
        } else {
          projected.push({ x: pos.x, y: Math.max(0, Math.min(H, pos.y)) })
        }
        prevPeakAngle = layer.peakAngle
      }

      // Draw 3 glow passes over the same projected path
      const SEAM_JUMP_GLOW = cam.W * 0.5
      for (const pass of passes) {
        const passWidth = baseGlowWidth * pass.widthMul
        const passAlpha = glowAlpha * pass.alphaMul

        ctx.lineWidth = passWidth
        ctx.strokeStyle = `rgba(${gr},${gg},${gb},${passAlpha.toFixed(3)})`
        ctx.beginPath()
        let started = false
        let prevXGlow = 0

        for (let j = 0; j < projected.length; j++) {
          const pt = projected[j]
          if (pt.y < -9000) {
            if (started) { ctx.stroke(); ctx.beginPath(); started = false }
            continue
          }

          if (started && Math.abs(pt.x - prevXGlow) > SEAM_JUMP_GLOW) {
            ctx.stroke()
            ctx.beginPath()
            started = false
          }

          const yShifted = pt.y + pass.yOff

          if (!started) {
            ctx.moveTo(pt.x, yShifted)
            started = true
          } else if (j + 1 < projected.length
                     && projected[j + 1].y > -9000
                     && Math.abs(projected[j + 1].x - pt.x) <= SEAM_JUMP_GLOW) {
            const next = projected[j + 1]
            ctx.quadraticCurveTo(pt.x, yShifted, (pt.x + next.x) / 2, (yShifted + next.y + pass.yOff) / 2)
          } else {
            ctx.lineTo(pt.x, yShifted)
          }
          prevXGlow = pt.x
        }
        if (started) ctx.stroke()
      }
    }
  }

  ctx.restore()
}

/**
 * Render silhouette edge strokes only.
 *
 * Silhouette FILLS are not ported — see V3 comment:
 * "Silhouette pre-bucketing removed — band fill polygons provide full coverage.
 *  Silhouette layer fills are no longer needed (were the largest per-frame cost)."
 * This function draws only the edge strokes on top of everything.
 * Strokes use strand matching for continuous lines across azimuths.
 */
export function renderSilhouetteStrokes(
  ctx: CanvasRenderingContext2D,
  strands: SilhouetteStrand[],
  cam: CameraParams,
  globalElevMin: number,
  globalElevMax: number,
  silResolution: number,
): void {
  const { H } = cam
  const elevRange = globalElevMax - globalElevMin
  const hasElevRange = elevRange > 1
  const maxDist = 400_000
  const numAzimuths = silResolution * 360

  // ── Silhouette edge strokes (strand-based for smooth lines) ────
  // Only draw strokes for strands with enough segments.
  // Use curvature-based line tapering for natural appearance.

  const MIN_STRAND_SEGS = 8   // Eliminate short dash artifacts — 8 segs = 1° bearing
  const MAX_AZ_GAP_FOR_STROKE = 4  // Match the matching gap tolerance
  // Fixed min angle — AGL already baked into peakAngle, pitch is viewport only
  const MIN_PEAK_ANGLE = -0.30  // ~-17° below horizon

  for (const strand of strands) {
    const segs = strand.segments
    if (segs.length < MIN_STRAND_SEGS) continue

    // Sqrt distance scaling — spreads the 0-100km range across more of 0-1,
    // giving much better near/far width separation. Linear was compressing
    // everything under 100km into distT < 0.25.
    const distT = Math.sqrt(Math.min(1, strand.avgDist / maxDist))
    // 1km→0.05, 5km→0.11, 30km→0.27, 100km→0.50, 400km→1.0

    const angles: number[] = segs.map(s => s.layer.peakAngle)
    const baseOpacity = 0.25 + (1 - distT) * 0.55    // near: 0.80, far: 0.25
    const maxWidth    = 1.5 + (1 - distT) * 3.5       // near: 5.0px, far: 1.5px
    const minWidth    = 0.4 + (1 - distT) * 1.6       // near: 2.0px, far: 0.4px
    const CURVATURE_THRESHOLD = 0.008

    ctx.lineCap  = 'round'
    ctx.lineJoin = 'round'

    // Break into contiguous runs
    const runs: Array<{ start: number; end: number }> = []
    let runStart = 0
    for (let i = 1; i < segs.length; i++) {
      const prevAi = segs[i - 1].ai
      const currAi = segs[i].ai
      const gap = currAi >= prevAi
        ? currAi - prevAi
        : (numAzimuths - prevAi + currAi)
      if (gap > MAX_AZ_GAP_FOR_STROKE) {
        if (i - runStart >= 3) runs.push({ start: runStart, end: i })
        runStart = i
      }
    }
    if (segs.length - runStart >= 3) runs.push({ start: runStart, end: segs.length })

    for (const run of runs) {
      // Pre-project all points in this run, filtering out low-angle segments
      // and marking angle discontinuities as path breaks
      const MAX_ANGLE_JUMP = 0.005  // rad — max natural peakAngle change per 0.125° azimuth step
      interface SilPt { x: number; y: number; rawElev: number; curvature: number }
      const projected: SilPt[] = []
      let prevPeakAngle = -999  // sentinel for first point

      for (let i = run.start; i < run.end; i++) {
        const { ai, layer } = segs[i]
        // Skip segments below minimum angle
        if (layer.peakAngle < MIN_PEAK_ANGLE) {
          projected.push({ x: 0, y: -9999, rawElev: 0, curvature: 0 })
          prevPeakAngle = -999
          continue
        }

        // Angle continuity check — break path if peakAngle jumps too much
        // between adjacent strand segments. This catches cross-ridge mismatches
        // that slipped through distance-based matching. AGL-stable because
        // peakAngle already encodes viewer elevation.
        if (prevPeakAngle > -999 && Math.abs(layer.peakAngle - prevPeakAngle) > MAX_ANGLE_JUMP) {
          projected.push({ x: 0, y: -9999, rawElev: 0, curvature: 0 })
          prevPeakAngle = layer.peakAngle  // reset for next segment
          continue
        }

        const bearing = ai / silResolution
        const pos = project(bearing, layer.peakAngle, cam)
        const clampedY = Math.max(0, Math.min(H, pos.y))
        let curvature = 0
        if (i > run.start && i < run.end - 1) {
          curvature = Math.abs(angles[i + 1] - 2 * angles[i] + angles[i - 1])
        }
        if (pos.y >= H) {
          projected.push({ x: pos.x, y: -9999, rawElev: 0, curvature: 0 })
        } else {
          projected.push({ x: pos.x, y: clampedY, rawElev: layer.rawElev, curvature })
        }
        prevPeakAngle = layer.peakAngle
      }

      // Draw smooth curves through valid points
      let pathStarted = false
      const SEG_SIZE = 8  // Update color/width every 8 points
      // Seam-jump threshold — a jump greater than half the canvas means
      // the strand crossed the panorama wrap (e.g. bearing 180° at both
      // edges on the 360° B2 wrap view). Break the path there.
      const SEAM_JUMP_SIL = cam.W * 0.5
      let prevX = 0

      for (let j = 0; j < projected.length; j++) {
        const pt = projected[j]
        if (pt.y < -9000) {
          if (pathStarted) { ctx.stroke(); pathStarted = false }
          continue
        }

        if (pathStarted && Math.abs(pt.x - prevX) > SEAM_JUMP_SIL) {
          ctx.stroke()
          pathStarted = false
        }

        if (!pathStarted) {
          const tElev = hasElevRange && pt.rawElev > 0
            ? Math.max(0, Math.min(1, (pt.rawElev - globalElevMin) / elevRange)) : 0.5
          const tCurvature = Math.min(1, pt.curvature / CURVATURE_THRESHOLD)
          const lineWidth = minWidth + (maxWidth - minWidth) * (0.2 + 0.8 * tCurvature)
          ctx.beginPath()
          ctx.lineWidth = lineWidth
          ctx.globalAlpha = baseOpacity
          ctx.strokeStyle = elevToRidgeColor(tElev)
          ctx.moveTo(pt.x, pt.y)
          pathStarted = true
        } else if (j % SEG_SIZE === 0) {
          // Flush and update style
          ctx.stroke()
          const tElev = hasElevRange && pt.rawElev > 0
            ? Math.max(0, Math.min(1, (pt.rawElev - globalElevMin) / elevRange)) : 0.5
          const tCurvature = Math.min(1, pt.curvature / CURVATURE_THRESHOLD)
          const lineWidth = minWidth + (maxWidth - minWidth) * (0.2 + 0.8 * tCurvature)
          ctx.beginPath()
          ctx.lineWidth = lineWidth
          ctx.strokeStyle = elevToRidgeColor(tElev)
          ctx.moveTo(projected[j - 1].x, projected[j - 1].y)
          // quadraticCurveTo to this point via midpoint — unless next is
          // across the panorama seam, in which case terminate at this pt.
          if (j + 1 < projected.length
              && projected[j + 1].y > -9000
              && Math.abs(projected[j + 1].x - pt.x) <= SEAM_JUMP_SIL) {
            const next = projected[j + 1]
            ctx.quadraticCurveTo(pt.x, pt.y, (pt.x + next.x) / 2, (pt.y + next.y) / 2)
          } else {
            ctx.lineTo(pt.x, pt.y)
          }
        } else if (j + 1 < projected.length
                   && projected[j + 1].y > -9000
                   && Math.abs(projected[j + 1].x - pt.x) <= SEAM_JUMP_SIL) {
          // Smooth curve: control=current, end=midpoint to next
          const next = projected[j + 1]
          ctx.quadraticCurveTo(pt.x, pt.y, (pt.x + next.x) / 2, (pt.y + next.y) / 2)
        } else {
          // Last valid point, next is invalid, or next is across the seam.
          ctx.lineTo(pt.x, pt.y)
        }
        prevX = pt.x
      }
      if (pathStarted) ctx.stroke()
    }
    ctx.globalAlpha = 1.0
  }
}
