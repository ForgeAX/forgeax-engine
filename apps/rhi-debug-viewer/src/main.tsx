// main.tsx — app entry point, creates React root and mounts App.
//
// Related: AGENTS.md §Conventions (React 19 + StrictMode); plan-strategy D-9.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'dockview-react/dist/styles/dockview.css';
import '@forgeax/view-components/styles.css';
import './styles/globals.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('root element not found');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
