// smoke-browser.mjs -- RHI-debug capture STRUCTURAL verification for
// learn-render 5.3.2 point-shadows (DYNAMIC: point light orbits via Math.sin(t),
// so pixel-parity is not meaningful frame-to-frame). Structural mode asserts
// capture -> replay -> stepTo -> inspect all succeed on a fresh dawn-node device.
// Local-only gate (no Chrome+WebGPU on CI runners).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-5-advanced-lighting-3-2-point-shadows',
  label: 'learn-render 5.3.2 point-shadows',
  mode: 'structural',
  appDir: dirname(here),
});
