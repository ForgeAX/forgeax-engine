#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const forbidden = 'compressed-projectile|generate-assets\\.mjs|generateTemplateAssets';
const result = spawnSync(
  'git',
  [
    'grep',
    '-n',
    '-E',
    forbidden,
    '--',
    'apps/game-capability-lab',
    'apps/preview',
    'vitest.config.ts',
  ],
  { cwd: root, encoding: 'utf8' },
);

if (result.status === 1) {
  console.log(
    '[check-game-capability-lab-self-contained] OK - no generated projectile asset dependency',
  );
  process.exit(0);
}

if (result.status === 0) {
  console.error(
    '[check-game-capability-lab-self-contained] generated projectile asset dependency returned:',
  );
  console.error(result.stdout.trim());
  process.exit(1);
}

console.error(
  `[check-game-capability-lab-self-contained] git grep failed: ${result.stderr.trim()}`,
);
process.exit(2);
