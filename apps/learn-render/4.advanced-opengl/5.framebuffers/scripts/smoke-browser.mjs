// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 4.advanced-opengl/5.framebuffers (offscreen render-to-texture +
// fullscreen post-process effects; first-person controls input-gated so no
// motion without input).
// Delegates to the shared harness; this file only supplies the demo identity +
// its live-pixel hook (window.__captureFramebuffers, installed by src/index.ts).
//
// pixel mode: capture a frame -> replay on a fresh browser WebGPU device ->
// compare the same-backend replay against the live canvas readback. The shared
// verifier still runs the independent Node Dawn replay and records its metrics,
// but Chrome/WebGPU owns the strict pixel verdict because cross-backend
// software-rasterization can differ at sparse edge pixels.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-4-advanced-opengl-5-framebuffers',
  label: 'learn-render 4.5 framebuffers',
  mode: 'pixel',
  liveHook: '__captureFramebuffers',
  browserReplayHook: '__replayFramebuffersCapture',
  pixelVerdictOwner: 'browser-fresh',
  // The shared verifier checks the public capture seam; Vite's live connection is not frame readiness.
  navigationWaitUntil: 'domcontentloaded',
  rtIdx: 0,
  appDir: dirname(here),
});
