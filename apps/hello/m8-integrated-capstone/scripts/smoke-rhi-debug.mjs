// M8 integrated capstone RHI-debug smoke: shared structural capture verifier.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/hello-m8-integrated-capstone',
  label: 'hello-m8-integrated-capstone',
  mode: 'structural',
  appDir: dirname(scriptsDir),
});
