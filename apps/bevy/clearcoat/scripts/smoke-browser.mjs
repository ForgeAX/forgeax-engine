#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/bevy-clearcoat',
  label: 'bevy clearcoat',
  mode: 'structural',
  drawIdx: 14,
  appDir: dirname(scriptsDir),
  assertTape({ tape }) {
    const draws = tape.events.filter((event) => event.kind === 'draw' || event.kind === 'drawIndexed');
    const clearcoatSphere = draws[14];
    if (clearcoatSphere?.kind !== 'drawIndexed' || clearcoatSphere.indexCount !== 8928) {
      throw new Error('clearcoat admission draw 14 must be the indexed sphere draw');
    }
  },
});
