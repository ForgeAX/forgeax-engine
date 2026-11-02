import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectCodeFileLineFindings } from '../check-code-file-lines.mjs';
import { ensureGateSubmodules, ensurePnpm } from './prepare-modeling-gate.mjs';

// `pnpm test:modeling [-- --candidate] [-- --dawn] [-- --mech-gt]`: the Engine x forgeax-modeling pair.
// Formal mode also requires the gitlink on modeling `main`; `--candidate` tests a
// proposed pair whose modeling commit is not merged yet. `--dawn` adds the real
// renderer journeys (model.render, the C-001 case and the C-015 LOD chain), which need a Dawn device.
// `--mech-gt` adds the whole-run S7 scan of case C-100, required for every change to
// `examples/mech-gt`: minutes and a 16 GB heap, so the default stage runs only its cheap check.
const root = resolve(import.meta.dirname, '../..');
const candidate = process.argv.includes('--candidate');
const dawn = process.argv.includes('--dawn');
const mechGt = process.argv.includes('--mech-gt');
const modeling = resolve(root, 'packages/modeling');

if (!existsSync(resolve(modeling, 'package.json'))) {
  console.error(
    'modeling submodule missing: run bun fx setup (or git submodule update --init packages/modeling)',
  );
  process.exit(1);
}

const run = (stage, command, args, cwd = root, env = {}, hint = undefined) => {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  console.log(
    JSON.stringify({
      stage,
      seconds: (performance.now() - started) / 1000,
      exitCode: result.status,
      candidate,
    }),
  );
  if (result.status !== 0) {
    if (hint !== undefined) console.error(hint);
    process.exit(result.status ?? 1);
  }
};

if (!candidate) {
  run('fetch-main', 'git', ['-C', modeling, 'fetch', '--quiet', 'origin', 'main']);
  const pin = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD:packages/modeling'], {
    encoding: 'utf8',
  });
  const onMain = spawnSync('git', [
    '-C',
    modeling,
    'merge-base',
    '--is-ancestor',
    pin.stdout.trim(),
    'origin/main',
  ]);
  if (pin.status !== 0 || onMain.status !== 0) {
    console.error(
      `modeling pin ${pin.stdout.trim()} is not on forgeax-modeling main: merge the modeling PR, bump the pin, or rerun with --candidate`,
    );
    process.exit(1);
  }
}

// Prepare the checkout before any stage: missing gate submodules (the lockfile's tools/view
// importer, the build's wgpu and blitz) and a resolvable pnpm.
const unprepared = [...ensureGateSubmodules({ root }), ensurePnpm()].filter(
  (failure) => failure !== undefined,
);
if (unprepared.length > 0) {
  for (const failure of unprepared) console.error(failure);
  process.exit(1);
}
// An integration update can add a workspace dependency without relinking node_modules. pnpm's
// offline frozen install repairs missing links (0.3 s when current, ~3 s when relinking).
run(
  'install',
  'pnpm',
  ['install', '--frozen-lockfile', '--offline'],
  root,
  {},
  'node_modules does not match pnpm-lock.yaml and the offline store lacks a package: run pnpm install',
);
// Lint before anything slow: the submodule's own CI cannot run the Engine's Biome config.
run('biome', process.execPath, [
  'node_modules/@biomejs/biome/bin/biome',
  'check',
  '--diagnostic-level=error',
  'packages/modeling',
]);
// Keep candidate admission aligned with primary-pnpm's internal API convention gate.
run('internal', process.execPath, ['scripts/lint-internal.mjs']);
// A stale kernel digest (forgotten FORGEAX_UPDATE_GOLDEN=1) fails in seconds, naming the files.
run(
  'kernel-digest',
  'pnpm',
  ['exec', 'vitest', 'run', 'src/__tests__/kernel-digest.unit.test.ts'],
  modeling,
);
// Modeling resolves its Engine closure through each package's dist, and Isolation and capture
// Workers import the built modeling dist. The input-keyed package builder rebuilds exactly the
// packages whose content changed (a no-op takes under a second).
const facts = join(mkdtempSync(join(tmpdir(), 'modeling-build-')), 'facts.json');
run('build', process.execPath, ['scripts/build-packages.mjs'], root, {
  FORGEAX_PACKAGE_FACTS_PATH: facts,
});
const rebuilt = JSON.parse(readFileSync(facts, 'utf8'))
  .packages.results.filter((r) => r.status !== 'skipped' && r.name !== '@forgeax/engine-modeling')
  .map((r) => r.name);
console.log(JSON.stringify({ stage: 'engine-rebuilt', rebuilt, candidate }));
// tsc -b can trust a stale .tsbuildinfo and keep old declarations of a rebuilt Engine package.
run('types', process.execPath, [
  'node_modules/typescript/bin/tsc',
  '-b',
  ...(rebuilt.length > 0 ? ['--force'] : []),
  'packages/modeling',
]);
// Tests and examples type-check only through the test tsconfig; vitest checks `*.test-d.ts` alone.
run('test-types', process.execPath, [
  'node_modules/typescript/bin/tsc',
  '-p',
  'packages/modeling/tsconfig.test.json',
]);
run('modeling', 'pnpm', ['--filter', '@forgeax/engine-modeling', 'test']);
// Engine-side consumers of the modeling seams, each in its owning package project.
for (const [pkg, file] of [
  ['pack', 'src/__tests__/pack-generation-projection.unit.test.ts'],
  ['preview', 'src/__tests__/mesh.test.ts'],
  ['app', 'src/__tests__/workspace-preview-display.unit.test.ts'],
  ['devkit', 'src/__tests__/unified-cli.test.ts'],
  ['import', 'src/__tests__/mesh-lod-pack.unit.test.ts'],
])
  run(`consumer:${pkg}`, 'pnpm', ['--dir', `packages/${pkg}`, 'exec', 'vitest', 'run', file]);
run('english', 'python3', [
  'scripts/forgeax/check_english_only.py',
  '--code',
  'packages/modeling/src',
  'packages/modeling/examples',
]);
const long = collectCodeFileLineFindings({ root }).findings.filter((finding) =>
  finding.path.startsWith('packages/modeling/'),
);
console.log(JSON.stringify({ stage: 'file-lines', findings: long, candidate }));
if (long.length > 0) process.exit(1);
run('test-layout', process.execPath, ['scripts/check-test-layout.mjs']);
if (dawn) {
  // Like `pnpm test:dawn`: renderer journeys read the shared engine shader inputs.
  // Without them every model.render call recompiles the whole engine manifest.
  run('shared-inputs', process.execPath, ['scripts/build-shared-inputs.mjs', '--root', '.']);
  run(
    'dawn',
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--project',
      'dawn',
      'packages/devkit/src/tools/__tests__/model-render.dawn.test.ts',
      'packages/devkit/src/tools/__tests__/model-surface-views.dawn.test.ts',
      'packages/import/__tests__/mesh-lod-pack.dawn.test.ts',
      'packages/modeling',
    ],
    root,
    { FORGEAX_SHARED_APP_INPUTS_MANIFEST: 'shared-build-inputs/manifest.json' },
  );
}
if (mechGt)
  run(
    'mech-gt-scan',
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--project',
      '@forgeax/engine-modeling',
      'packages/modeling/examples/mech-gt/__tests__/s7-scan.integration.test.ts',
    ],
    root,
    // The scan runs in a Vitest worker process: only NODE_OPTIONS reaches its heap limit.
    {
      FORGEAX_MECH_GT_SCAN: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=16384`.trim(),
    },
  );
