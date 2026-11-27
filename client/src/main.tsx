import './polyfills';
import './fonts.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { invoke, isTauri } from '@tauri-apps/api/core';

// Diagnostics: record that the frontend bundle actually started executing, and
// surface any early crash instead of dying silently in the webview.
function diag(msg: string) {
  if (!isTauri()) return;
  invoke('debug_log', { message: `webview: ${msg}` }).catch((e: unknown) => {
    console.error('[diag] invoke failed', e);
  });
}

diag('main.tsx executing');

window.addEventListener('error', (e) => {
  diag(`window.onerror: ${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  diag(`unhandledrejection: ${String(e.reason)}`);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
