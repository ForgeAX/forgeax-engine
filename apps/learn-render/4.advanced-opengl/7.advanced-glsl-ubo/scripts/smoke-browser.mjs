// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 4.advanced-opengl/7.advanced-glsl-ubo (static scene: three cubes
// lit by a DirectionalLight, first-person controls input-gated so no motion
// without input). Delegates to the shared harness; this file only supplies the
// demo identity + its live-pixel hook (window.__captureAdvancedGlslUbo,
// installed by src/index.ts).
//
// pixel mode: capture a frame -> replay on a fresh dawn-node device -> compare
// the replayed RT against the live canvas readback (mean/maxChannel/coveredMean).
// Local-only gate (no Chrome+WebGPU on CI runners).
//
// maxChannelEpsilon relaxed to 0.40: the three cubes sit on a black background,
// so the only non-zero deltas are a thin anti-aliased silhouette ring (~4.4% of
// the frame) where Chrome-WebGPU (live) and dawn-node (replay) rasterize the cube
// edge one sub-pixel differently -- a cross-implementation edge-AA gap, NOT a
// replay fidelity bug (the image is eye-identical and mean is 0.00001). mean and
// coveredMean (0.0003) stay tight as the real regression gates; only the
// worst-single-pixel ceiling is loosened for the AA seam.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-4-advanced-opengl-7-advanced-glsl-ubo',
  label: 'learn-render 4.7 advanced-glsl-ubo',
  mode: 'pixel',
  liveHook: '__captureAdvancedGlslUbo',
  rtIdx: 0,
  maxChannelEpsilon: 0.4,
  appDir: dirname(here),
});
