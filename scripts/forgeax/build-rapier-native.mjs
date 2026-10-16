import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dimension = process.argv[2];
if (!['2d', '3d'].includes(dimension)) throw new Error('Expected Rapier dimension: 2d or 3d');
// Both dimensions use the same pinned Rust producer, remapping and ABI checks.
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL('../../packages/physics-rapier3d/scripts/build-wasm.mjs', import.meta.url),
    ),
    ...(dimension === '2d' ? ['--2d'] : []),
    process.argv.includes('--verify') ? '--verify' : '--ensure',
  ],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
