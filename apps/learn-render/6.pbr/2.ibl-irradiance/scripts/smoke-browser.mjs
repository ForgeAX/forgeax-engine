// smoke-browser.mjs -- RHI-debug capture verification for learn-render
// 6.pbr/2.ibl-irradiance (static IBL diffuse sphere matrix, Skylight equirect HDR).
//
// Pixel mode proves live->replay fidelity for the final target, but it does not
// prove algorithm truth: the Skylight irradiance/prefilter maps are rgba16float
// cubemaps and remain outside the frame-header seed path (recorder.ts
// isSnapshottableColorTexture + roadmap specs §10 residual #1). Keep the longer
// warmup so the IBL precompute completes before capture; intermediate cubemap
// truth remains a separate F3/F5 gap.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-6-pbr-2-ibl-irradiance',
  label: 'learn-render 6.2 ibl-irradiance',
  mode: 'pixel',
  liveHook: '__captureIblIrradiance',
  rtIdx: 0,
  warmupMs: 5000,
  appDir: dirname(here),
});
