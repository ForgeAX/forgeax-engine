// hello-cube RHI-debug browser smoke: shared structural capture verifier.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/hello-cube',
  label: 'hello-cube',
  mode: 'structural',
  waitForAppScene: true,
  warmupMs: 0,
  // The verifier selects an actual color-attachment work from FrameModel.
  appDir: dirname(scriptsDir),
});
