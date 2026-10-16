import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { viewRoot } from './build-inputs.mjs';

const require = createRequire(import.meta.url);
const vite = resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
for (const [cwd, args] of [
  [resolve(viewRoot, 'packages/viewer'), [vite, 'build']],
  [viewRoot, [resolve(viewRoot, 'scripts/build-package.mjs')]],
]) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
