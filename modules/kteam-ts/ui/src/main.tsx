// Entry. Mounts <App /> and forces a relative-URL redirect for any trailing
// route that the daemon's SPA fallback will eventually return. The browser's
// load order: index.html (with __KTEAM_TOKEN__ placeholder) → main.tsx → App.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import './highlight.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
