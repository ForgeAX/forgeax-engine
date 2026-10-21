#!/usr/bin/env node
// Pack owns offline source/evidence. Games use AssetRegistry.load at runtime;
// that valid API must not pull runtime ownership into Pack's production code.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const patterns = [
  String.raw`engine[[:space:]]*\.[[:space:]]*assets[[:space:]]*\.[[:space:]]*load[[:space:]]*\(`,
  "['\"`]@forgeax/engine([/-](assets-runtime|runtime)(/[^'\"`]*)?)?['\"`]",
];
const result = spawnSync('grep', [
  '-rnE', patterns.join('|'), 'packages/pack/src',
  '--exclude-dir=__tests__', '--exclude=*.d.ts',
], { cwd: root, encoding: 'utf8' });
if (result.error) throw result.error;
if (result.status === 1) process.exit(0); // No forbidden runtime dependencies.
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
process.stderr.write(
  '[check-no-assets-load] FAIL: runtime loading or imports found in packages/pack/src.\n' +
  'Keep Pack source/evidence offline; inject the build-time AssetReader.\n\n' +
  result.stdout,
);
process.exit(1);
