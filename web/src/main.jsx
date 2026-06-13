import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './i18n'
import ErrorBoundary from './components/ErrorBoundary'
import Minimal from './minimal'
import App from './App'
import './index.css'

window.onerror = (msg, url, line, col, err) => {
  console.error('GLOBAL ERROR:', msg, err?.stack)
}
window.addEventListener('unhandledrejection', e => {
  console.error('UNHANDLED PROMISE:', e.reason?.stack || e.reason)
})

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  })
}

function mount() {
  const root = document.getElementById('root')
  if (!root) { console.error('ROOT NOT FOUND'); return }
  try {
    ReactDOM.createRoot(root).render(
      <ErrorBoundary>
        <Minimal />
      </ErrorBoundary>
    )
  } catch (e) {
    console.error('RENDER ERROR:', e.message)
    root.innerHTML = '<div style="color:red;padding:20px">Error: ' + e.message + '</div>'
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount)
} else {
  mount()
}
