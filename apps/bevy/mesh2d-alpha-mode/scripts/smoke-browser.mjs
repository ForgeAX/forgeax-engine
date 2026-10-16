#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/bevy-mesh2d-alpha-mode',
  label: 'bevy mesh2d alpha mode',
  mode: 'structural',
  appDir: dirname(scriptsDir),
});
