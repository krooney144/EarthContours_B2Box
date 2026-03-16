/**
 * EarthContours B2 — Root Application Component
 *
 * Simple React Router shell for the B2 Black Box exhibit.
 * Each screen runs in its own browser window — no nav bar, no transitions,
 * no splash screen. Just URL-based routing to the three exhibit screens.
 *
 * Screens:
 *   /b2-wrap   → 360° panorama projection (10880×1080)
 *   /b2-map    → Top-down map table projection (1920×1080)
 *   /settings  → Tech team settings panel
 *   /          → Launcher page with links to all screens
 */

import React from 'react'
import { Routes, Route, Link } from 'react-router-dom'
import ErrorBoundary from './components/ErrorBoundary'
import B2WrapScreen from './screens/B2WrapScreen'
import B2MapScreen from './screens/B2MapScreen'
import SettingsScreen from './screens/SettingsScreen'
import { createLogger } from './core/logger'
import styles from './App.module.css'

const log = createLogger('APP')

// ─── Launcher Page ──────────────────────────────────────────────────────────
// Simple landing page with links to the three screens.
// Each link opens in a new browser window for the exhibit.

const Launcher: React.FC = () => {
  log.info('Launcher mounted')

  return (
    <div className={styles.launcher}>
      <h1 className={styles.launcherTitle}>EarthContours B2</h1>
      <p className={styles.launcherSubtitle}>Black Box Exhibit</p>
      <div className={styles.launcherLinks}>
        <Link to="/b2-wrap" className={styles.launcherLink}>
          Wrap Screen (360°)
        </Link>
        <Link to="/b2-map" className={styles.launcherLink}>
          Map Screen (Table)
        </Link>
        <Link to="/settings" className={styles.launcherLink}>
          Settings
        </Link>
      </div>
    </div>
  )
}

// ─── App Component ──────────────────────────────────────────────────────────

const App: React.FC = () => {
  return (
    <Routes>
      <Route path="/b2-wrap" element={
        <ErrorBoundary screenName="B2Wrap">
          <B2WrapScreen />
        </ErrorBoundary>
      } />
      <Route path="/b2-map" element={
        <ErrorBoundary screenName="B2Map">
          <B2MapScreen />
        </ErrorBoundary>
      } />
      <Route path="/settings" element={
        <ErrorBoundary screenName="Settings">
          <SettingsScreen />
        </ErrorBoundary>
      } />
      <Route path="/*" element={<Launcher />} />
    </Routes>
  )
}

export default App
