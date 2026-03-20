# EarthContours B2 — Black Box Exhibit

Terrain visualization for Kate's thesis exhibit in the **B2 Black Box** at CU ATLAS. Three screens run in separate browser windows on one machine, with 360° immersive projection.

---

## Quick Start

You need **two terminals** running:

```bash
# Terminal 1 — WebSocket + OSC server
npm install
node index.cjs

# Terminal 2 — Vite dev server
npm run dev
```

Then open three browser windows:

| URL | Screen | What It Does |
|-----|--------|-------------|
| `http://localhost:5173/b2-wrap` | **Wrap** | 360° panorama (10880×1080) — the main immersive projection |
| `http://localhost:5173/b2-map` | **Map** | Top-down table map (1920×1080) — where visitors select locations |
| `http://localhost:5173/settings` | **Settings** | Tech team tuning panel |
| `http://localhost:5173/` | **Launcher** | Links to all three screens |

---

## How the Screens Talk to Each Other

```
 ┌────────────────┐     UDP:57121      ┌──────────────────┐
 │ Motion Capture │ ──── OSC ────────→ │    index.cjs      │
 │ MediaPipe      │                    │  Express+Socket  │
 │ TouchOSC       │                    │  Port 3000       │
 └────────────────┘                    └────────┬─────────┘
                                                │ Socket.IO
                          ┌─────────────────────┼─────────────────────┐
                          ▼                     ▼                     ▼
                    /b2-map               /b2-wrap               /settings
                    (hand cursors)        (tracker portals)       (debug)
```

**Location sync**: When someone releases a pointing gesture on the Map screen (or presses SELECT on a control strip), it broadcasts `location:update` via WebSocket → the Wrap screen receives it and re-renders the terrain at the new location.

**OSC bridge**: The server (`index.cjs`) listens for OSC on UDP port 57121 and forwards every message to all browser windows. Each screen filters for the addresses it cares about.

---

## OSC → Wrap Screen (Tracker Portals)

The **Wrap screen** receives motion capture tracker data and shows glowing portal circles at each tracker's position.

| OSC Address | Args | What It Does |
|-------------|------|-------------|
| `/trk_1_xy_loc` | `[y_norm, x_norm, layer_frac]` | Tracker 1 position — portal circle appears here |
| `/trk_2_xy_loc` | `[y_norm, x_norm, layer_frac]` | Tracker 2 position — second portal circle |

- **x_norm, y_norm** are normalized 0–1 (0=top-left, 1=bottom-right)
- The portal is a glowing target reticle in the ocean color scheme
- **Component**: `src/components/TrackerPortal/TrackerPortal.tsx`
- **Handler**: In `src/screens/B2WrapScreen/B2WrapScreen.tsx` — search for `socket.on('osc'`

---

## OSC → Map Screen (Hand Cursors)

The **Map screen** receives MediaPipe hand tracking data and shows hand cursor icons.

**Position** (separate X/Y messages per hand, normalised 0–1):

| OSC Address | Args | What It Does |
|-------------|------|-------------|
| `/h1tx` | `[x_norm 0–1]` | Hand 1 X position |
| `/h1ty` | `[y_norm 0–1]` | Hand 1 Y position |
| `/h2tx` | `[x_norm 0–1]` | Hand 2 X position |
| `/h2ty` | `[y_norm 0–1]` | Hand 2 Y position |

> **NOTE**: Camera is mounted 180° flipped. The code inverts all coordinates: `(1 - value)`.

**Gestures** (confidence 0–1, threshold at ~0.5):

| OSC Address | Args | What It Does |
|-------------|------|-------------|
| `/h1:ILoveYou` | `[confidence 0–1]` | Hand 1 grab — ≥0.5 = pan/pinch, <0.5 = release |
| `/h1:Pointing_Up` | `[confidence 0–1]` | Hand 1 point — ≥0.5 = preview, release = select location |
| `/h2:ILoveYou` | `[confidence 0–1]` | Hand 2 grab — same as hand 1 |
| `/h2:Pointing_Up` | `[confidence 0–1]` | Hand 2 point — same as hand 1 |

How the gestures work:
- **ILoveYou ≥ 0.5** = grab — one hand pans, two hands pinch-to-zoom
- **ILoveYou < 0.5** = release — back to idle
- **Pointing ≥ 0.5** = preview — cursor shows where you're aiming
- **Pointing < 0.5** = release — selects the location under the cursor (5s cooldown)

Thresholds are tunable constants at the top of `B2MapScreen.tsx` (`GRAB_THRESHOLD`, `POINT_THRESHOLD`, `POINT_COOLDOWN_MS`).

- **Component**: `src/components/HandCursor/HandCursor.tsx`
- **Handler**: In `src/screens/B2MapScreen/B2MapScreen.tsx` — search for `socket.on('osc'`

---

## Mouse Simulation (Testing Without OSC)

Both screens have a **SIM toggle button** in the top-right corner:

- **SIM ON** (default): Mouse drives the tracker/hand cursor. No OSC hardware needed.
- **SIM OFF**: Only real OSC data drives the cursors.
- **Toggle**: Click the "SIM" button or press the **M** key.

### Wrap screen (SIM mode)
- Move your mouse → tracker portal 1 follows the cursor

### Map screen (SIM mode)
- Move your mouse → hand cursor (open palm) follows
- Hold left mouse button → cursor switches to grab (pan the map)
- Right-click → selects location at cursor position, syncs to Wrap screen

---

## Where Things Live

```
EarthContours_B2Box/
├── index.cjs                              ← EXPRESS + SOCKET.IO + OSC SERVER
├── src/
│   ├── components/
│   │   ├── TrackerPortal/                ← Glowing portal circles (wrap screen)
│   │   │   ├── TrackerPortal.tsx
│   │   │   └── TrackerPortal.module.css
│   │   ├── HandCursor/                   ← Hand tracking cursors (map screen)
│   │   │   ├── HandCursor.tsx
│   │   │   └── HandCursor.module.css
│   │   ├── LoadingScreen/
│   │   └── ErrorBoundary/
│   ├── screens/
│   │   ├── B2WrapScreen/                 ← 360° panorama + tracker portals
│   │   ├── B2MapScreen/                  ← Map table + hand cursors + control strips
│   │   ├── MapScreen/                    ← Core map rendering (globe + DEM)
│   │   ├── ScanScreen/                   ← Scan rendering engine (used by wrap)
│   │   └── SettingsScreen/               ← Tech team settings
│   ├── store/                            ← Zustand state stores
│   ├── workers/                          ← Web Worker for skyline computation
│   ├── data/                             ← Elevation, peak, water loaders
│   ├── core/                             ← Types, constants, utils, logger
│   └── styles/                           ← Global CSS + palette
├── vite.config.ts                        ← Vite config with Socket.IO proxy
└── package.json
```

---

## Pre-Loading Elevation Tiles

Internet in the Black Box can be unreliable. Pre-load tiles by:

1. Connect to good WiFi
2. Open the Map screen and navigate to your exhibit regions
3. The app automatically caches tiles in IndexedDB
4. In the exhibit, tiles load from cache without internet

---

## Build Commands

```bash
npm install          # Install dependencies
node index.cjs        # Start WebSocket + OSC server (port 3000)
npm run dev          # Vite dev server (port 5173)
npm run build        # Production build → /dist
npm run type-check   # TypeScript type checking
npm run lint         # ESLint
```

---

## Stack

React 18 · TypeScript 5.4 · Vite 5.2 · Zustand 4.5 · Three.js 0.160 · Socket.IO 4.8 · Express 5 · osc.js
