// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 5.x parallax-mapping. Delegates to the shared harness; this file only
// supplies the demo identity + its live-pixel hook (window.__captureParallaxMapping, installed by
// src/index.ts).
//
// Pixel mode compares live pixels with a fresh browser-device replay using
// unchanged mean/maxChannel/coveredMean thresholds. Node Dawn also replays the
// tape and records its metrics; cross-backend parallax discard edges differ.
// Local-only gate (no Chrome+WebGPU on CI runners).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-5-advanced-lighting-5-parallax-mapping',
  label: 'learn-render 5.5 parallax-mapping',
  mode: 'pixel',
  waitForPackIndex: true,
  liveHook: '__captureParallaxMapping',
  browserReplayHook: '__replayParallaxMappingCapture',
  pixelVerdictOwner: 'browser-fresh',
  rtIdx: 0,
  appDir: dirname(here),
});
