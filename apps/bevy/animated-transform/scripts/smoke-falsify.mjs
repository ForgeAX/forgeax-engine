#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const smoke = resolve(here, 'smoke-dawn.mjs');
const result = spawnSync(process.execPath, [smoke], {
  encoding: 'utf8',
  env: { ...process.env, ANIMATED_TRANSFORM_FALSIFY: 'missing-binding' },
});

if (result.status === 0) {
  console.error('[smoke-falsify] FAIL - removed binding incorrectly passed');
  process.exit(1);
}

console.log('[smoke-falsify] PASS - removed binding produced a non-zero smoke exit');
