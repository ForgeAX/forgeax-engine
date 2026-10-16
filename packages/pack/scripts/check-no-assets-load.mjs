#!/usr/bin/env node
// check-no-assets-load.mjs
// Gate: assert that runtime loading does not appear in the offline pack boundary.
// Exit 0 = clean; exit 1 = pattern found (use the build-time AssetReader instead).

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const searchPaths = ['packages/', 'apps/', 'templates/'];
const excludes = [
  '--exclude-dir=dist',
  '--exclude-dir=node_modules',
  '--exclude-dir=.forgeax-harness',
  '--exclude=*.d.ts',
  '--exclude=check-no-assets-load.mjs',
];

let output = '';

try {
  output = execSync(
    `grep -rn 'engine\\.assets\\.load(' ${searchPaths.join(' ')} ${excludes.join(' ')} 2>/dev/null`,
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
} catch (e) {
  // grep exits 1 when no matches found (which is success for this gate)
  const status = (e && typeof e.status === 'number') ? e.status : 1;
  if (status !== 1) process.exit(status);
  output = '';
}

if (output.trim().length > 0) {
  process.stderr.write(
    '[check-no-assets-load] FAIL: engine.assets.load( found in source files.\n' +
    'Use the build-time AssetReader instead (feat-20260513-guid-asset-package-system AC-09a).\n\n' +
    output,
  );
  process.exit(1);
}

try {
  output = execSync(
    "grep -rnE \"from ['\\\"]@forgeax/engine-(assets-runtime|runtime)\" packages/pack/src 2>/dev/null",
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
} catch (e) {
  const status = e && typeof e.status === 'number' ? e.status : 1;
  if (status !== 1) process.exit(status);
  output = '';
}

if (output.trim().length > 0) {
  process.stderr.write(
    '[check-no-assets-load] FAIL: runtime package imports found in packages/pack/src.\n' +
      'Keep offline evidence in @forgeax/engine-pack and inject runtime evidence through the SDK adapter.\n\n' +
      output,
  );
  process.exit(1);
}

process.exit(0);
