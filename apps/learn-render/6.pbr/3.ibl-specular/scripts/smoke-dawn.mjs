#!/usr/bin/env node
// apps/learn-render/6.pbr/3.ibl-specular/scripts/smoke-dawn.mjs
//
// Thin shim over apps/learn-render/6.pbr/_shared/ibl-smoke-shared.mjs.
// Verdict (60 frame + reference PNG mean abs delta <= 0.05; AC-12 + AC-18):
// see sibling 2.ibl-irradiance/scripts/smoke-dawn.mjs header for context.

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emitSmokeReceipt } from '../../../../shared/scripts/smoke-receipt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sharedPath = resolve(here, '..', '..', '_shared', 'ibl-smoke-shared.mjs');
const { runIblSmoke, warmUpng } = await import(pathToFileURL(sharedPath).href);

await warmUpng();
const framesObserved = await runIblSmoke({
  demoKind: 'specular',
  demoId: 'learn-render-ibl-specular',
  referencePath: resolve(
    here,
    '..',
    '..',
    '..',
    '..',
    '..',
    'forgeax-engine-assets',
    'smoke-baselines',
    'learn-render-6-pbr-3-ibl-specular',
    'skylight-specular.ref.png',
  ),
  mode: 'verify',
  distDir: resolve(here, '..', 'dist'),
});
emitSmokeReceipt('app-learn-render-6-pbr-3-ibl-specular/smoke', framesObserved);
process.exit(0);
