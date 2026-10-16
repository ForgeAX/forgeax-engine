// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 4.advanced-opengl/4.face-culling (static scene: unlit marble
// cube with frontFace='cw' + cullMode='back', first-person controls input-gated
// so no motion without input). Delegates to the shared harness; this file only
// supplies the demo identity + its live-pixel hook (window.__captureFaceCulling,
// installed by src/index.ts).
//
// pixel mode: capture a frame -> replay on a fresh dawn-node device -> compare
// the replayed RT against the live canvas readback (mean/maxChannel/coveredMean).
// Local-only gate (no Chrome+WebGPU on CI runners).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-4-advanced-opengl-4-face-culling',
  label: 'learn-render 4.4 face-culling',
  mode: 'pixel',
  liveHook: '__captureFaceCulling',
  rtIdx: 0,
  appDir: dirname(here),
});
