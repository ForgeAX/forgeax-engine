// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 5.x directional production shadow (3.1.shadow-mapping/3.full).
// Delegates to the shared harness; supplies demo identity + live-pixel hook
// (window.__captureShadowFull, installed by src/main.ts).
// Local-only gate (no Chrome+WebGPU on CI runners).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-5-advanced-lighting-3-1-shadow-mapping-3-full',
  label: 'learn-render 5.3.1 directional shadow',
  mode: 'pixel',
  liveHook: '__captureShadowFull',
  rtIdx: 0,
  appDir: dirname(here),
});
