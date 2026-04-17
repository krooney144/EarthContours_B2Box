/**
 * locationNameLoader — reverse-geocodes (lat, lng) to a short human-readable
 * place name using OpenStreetMap Nominatim.
 *
 * - No API key, no bundled deps.
 * - In-memory cache keyed by ~1 km cell (lat/lng rounded to 2 decimals).
 * - Returns null on any failure so the caller can simply not render a label.
 */

import { createLogger } from '../core/logger'

const log = createLogger('LocationName')

const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

function cellKey(lat: number, lng: number): string {
  return `${lat.toFixed(2)},${lng.toFixed(2)}`
}

interface NominatimAddress {
  city?: string
  town?: string
  village?: string
  hamlet?: string
  suburb?: string
  municipality?: string
  county?: string
  state?: string
  region?: string
  country?: string
  peak?: string
  natural?: string
  island?: string
  archipelago?: string
  water?: string
  mountain_range?: string
}

interface NominatimResponse {
  display_name?: string
  name?: string
  address?: NominatimAddress
}

function formatLabel(data: NominatimResponse): string | null {
  const addr = data.address ?? {}

  // Prefer specific natural feature names when present (e.g. "Longs Peak").
  const primary =
    addr.peak ||
    addr.mountain_range ||
    addr.island ||
    addr.natural ||
    addr.water ||
    addr.city ||
    addr.town ||
    addr.village ||
    addr.hamlet ||
    addr.suburb ||
    addr.municipality ||
    data.name ||
    null

  const secondary =
    addr.state ||
    addr.region ||
    addr.archipelago ||
    addr.county ||
    addr.country ||
    null

  if (primary && secondary && primary !== secondary) {
    return `${primary}, ${secondary}`
  }
  if (primary) return primary
  if (secondary) return secondary

  // Fallback: first two comma-parts of display_name.
  if (data.display_name) {
    const parts = data.display_name.split(',').map((s) => s.trim()).filter(Boolean)
    if (parts.length >= 2) return `${parts[0]}, ${parts[1]}`
    if (parts.length === 1) return parts[0]
  }
  return null
}

export async function fetchPlaceName(lat: number, lng: number): Promise<string | null> {
  const key = cellKey(lat, lng)
  if (cache.has(key)) return cache.get(key) ?? null
  const existing = inflight.get(key)
  if (existing) return existing

  const url =
    `https://nominatim.openstreetmap.org/reverse` +
    `?format=jsonv2&zoom=12&addressdetails=1` +
    `&lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`

  const promise = (async () => {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!res.ok) {
        log.warn(`Nominatim HTTP ${res.status} for ${key}`)
        cache.set(key, null)
        return null
      }
      const data = (await res.json()) as NominatimResponse
      const label = formatLabel(data)
      cache.set(key, label)
      return label
    } catch (err) {
      log.warn('Nominatim fetch failed', err)
      cache.set(key, null)
      return null
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, promise)
  return promise
}
