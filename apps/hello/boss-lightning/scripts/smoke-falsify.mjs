import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smoke = resolve(appRoot, 'scripts/smoke-browser.mjs');

function run(mode, index) {
  return spawnSync('node', [smoke], {
    env: {
      ...process.env,
      BOSS_LIGHTNING_FALSIFY: mode,
      BOSS_LIGHTNING_PORT: String(5180 + index),
    },
    encoding: 'utf8',
  });
}

const cases = [
  'billboard-fallback',
  'freeze-generation',
  'disable-vfx',
  'emitter-zero',
  'material-empty',
  'missing-depth',
  'event-queue-cleared',
  'recursion-depth',
  'stage-cycle',
  'stage-hazard',
  'stage-budget',
];
const failures = [];
for (const [index, mode] of cases.entries()) {
  const result = run(mode, index);
  if (result.status !== 0) failures.push(`${mode} failed: ${result.stderr || result.stdout}`);
  else console.log(`[smoke-falsify] ${mode} preserved its explicit zero-output contract`);
}
if (failures.length > 0) {
  console.error(`[smoke-falsify] FAIL ${failures.join('; ')}`);
  process.exit(1);
}
console.log('[smoke-falsify] PASS GPU VFX falsifiers retained explicit zero-output semantics');
