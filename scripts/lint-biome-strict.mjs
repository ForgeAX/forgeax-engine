#!/usr/bin/env node
// Wrapper around `biome ci .` that escalates info-level diagnostics to a
// non-zero exit. biome ci alone exits 0 on info-only output, so rules that
// ship at the info severity (e.g. lint/complexity/useLiteralKeys,
// lint/style/useTemplate) silently slip past local lint while CI still
// renders them as ::notice annotations on the PR. This wrapper closes that
// gap: any "Found N infos." line in summary output fails the build.
//
// Policy SSOT remains biome.json — escalate rules there when you want them
// reported by name. This wrapper only catches drift from rules we have not
// yet escalated, so a new info diagnostic still blocks the merge.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo-local biome bin so this script does not depend on bunx /
// npx / a global biome install. portability-bun runs `bunx biome ci .`
// directly in its own job; this wrapper is invoked from the shared core-build
// (and `pnpm run lint` locally), where biome is in devDependencies.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// The package owns its Node entry; Windows cannot execute the POSIX .bin shim.
const biomeBin = join(repoRoot, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');

const result = spawnSync(process.execPath, [biomeBin, 'ci', '.', '--reporter=summary'], {
  stdio: ['inherit', 'pipe', 'inherit'],
  encoding: 'utf8',
});

process.stdout.write(result.stdout ?? '');

if (result.status !== 0) {
  if (result.error) console.error(`lint-biome-strict: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

const infoMatch = (result.stdout ?? '').match(/Found (\d+) infos?\./);
if (infoMatch && Number(infoMatch[1]) > 0) {
  process.stderr.write(
    `\nlint-biome-strict: ${infoMatch[1]} info-level diagnostic(s) found.\n` +
      'Either fix them, or escalate the rule severity in biome.json so the\n' +
      'diagnostic is reported by name on every run.\n',
  );
  process.exit(1);
}
