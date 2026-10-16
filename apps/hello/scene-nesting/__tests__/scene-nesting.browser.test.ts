// hello-scene-nesting browser smoke — w35 (red phase, TDD).
//
// Browser (chromium + WebGPU) exercise: imports the demo's index.ts
// (bootstrap function) and verifies it does not fire renderer.onError
// within the 5s poll window (onerror-gate pattern).
//
// AC-33: browser smoke green — demo loads without render errors.
//
// Plan-strategy §5.1 TDD: this test file is written first (red), then w36
// writes main.ts + fixture to turn it green.

import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('hello-scene-nesting', () => import('../src/index.ts'));