// Entry. Mounts <App /> under the one shared client store, which owns the
// session cache and the single fleet event socket for the whole app.
// The browser's load order: index.html (with __KTEAM_TOKEN__ placeholder) →
// main.tsx → StoreProvider → App.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StoreProvider } from './lib/store';
import { AgentMentionProvider } from './lib/agent-mention-context';
import './index.css';
import './highlight.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <StoreProvider>
      <AgentMentionProvider>
        <App />
      </AgentMentionProvider>
    </StoreProvider>
  </StrictMode>,
);
