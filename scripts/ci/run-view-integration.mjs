import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { collectViewBackendDiagnostics } from './view-backend-diagnostics.mjs';

const root = resolve(import.meta.dirname, '../..');
const candidate = process.argv.includes('--candidate');
const steps = [
  [
    'contracts',
    'pnpm',
    ['--dir', 'tools/view', 'install', '--frozen-lockfile', '--ignore-scripts'],
  ],
  ['prepare', 'pnpm', ['build:tools']],
  ['prepare', 'node', ['tools/forgeax-mcp/codex/build-app.mjs']],
  [
    'contracts',
    'node',
    ['node_modules/typescript/bin/tsc', '-p', 'tools/forgeax-mcp/tsconfig.json'],
  ],
  [
    'contracts',
    'node',
    [
      '--test',
      ...readdirSync(resolve(root, 'tools/forgeax-mcp/__tests__/app'))
        .filter((name) => name.endsWith('.test.mjs'))
        .map((name) => `tools/forgeax-mcp/__tests__/app/${name}`),
    ],
  ],
  ['contracts', 'node', ['tools/forgeax-mcp/test/local-plugin.mjs']],
  ['contracts', 'node', ['tools/view/scripts/verify-panel-observation.mjs']],
  ['contracts', 'node', ['tools/forgeax-mcp/test/frontend-startup.mjs']],
  ['contracts', 'node', ['tools/forgeax-mcp/test/runtime-import.mjs']],
  ['contracts', 'node', ['tools/forgeax-mcp/test/runtime-acceptance.mjs']],
  [
    'game3d',
    'node',
    [
      'tools/forgeax-mcp/test/app-browser.mjs',
      resolve(root, 'templates/game-3d'),
      resolve(root, 'artifacts/view-integration/mcp-app'),
    ],
  ],
  ['contracts', 'pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tools/view-plugins/tsconfig.json']],
  [
    'contracts',
    'node',
    [
      '--test',
      'scripts/forgeax/__tests__/sdk-view.test.mjs',
      'scripts/forgeax/__tests__/sdk-source.test.mjs',
      'scripts/forgeax/__tests__/sdk-stage.test.mjs',
    ],
  ],
  ['contracts', 'node', ['scripts/ci/verify-view-dependency-identity.mjs']],
  ['contracts', 'node', ['scripts/ci/verify-view-export-falsifier.mjs']],
  ['contracts', 'node', ['scripts/ci/verify-view-panels-falsifier.mjs']],
  ['diagnostics', 'node', ['tools/view-plugins/integration/verify-texture-preview.mjs']],
  [
    'diagnostics',
    'node',
    ['tools/view-plugins/integration/verify-diagnostic-pages.mjs'],
    ...(process.env.CI === 'true' ? [{ FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1' }] : []),
  ],
  ['engine-only', 'node', ['scripts/ci/verify-engine-without-view.mjs']],
];
if (!candidate)
  steps.unshift([
    'prepare',
    'python3',
    ['scripts/forgeax/check_submodule_pins.py', '--repo', root],
  ]);
const probes = [
  'verify-owner-surface-resize.mjs',
  'verify-page-plugin-lifecycle.mjs',
  'verify-engine-plugin-boundary.mjs',
  'verify-startup-boundaries.mjs',
  'verify-game3d-workspace.mjs',
  'verify-workspace-experience.mjs',
];
for (const probe of probes) {
  const owner =
    probe === 'verify-engine-plugin-boundary.mjs'
      ? 'plugin'
      : probe === 'verify-game3d-workspace.mjs'
        ? 'game3d'
        : probe === 'verify-workspace-experience.mjs'
          ? 'workspace'
          : 'lifecycle';
  steps.push([
    owner,
    'node',
    [`tools/view/scripts/${probe}`],
    ...(probe === 'verify-game3d-workspace.mjs'
      ? [{ FORGEAX_ENGINE_CHECKOUT: root, FORGEAX_LOCAL_ENGINE: '1' }]
      : []),
  ]);
}
// Retain both language producers and cold reopening of each saved publication.
for (const language of ['js', 'ts'])
  for (const cold of [false, true]) {
    const output = resolve(
      root,
      `artifacts/view-integration/runtime-${language}/${cold ? 'cold' : 'live'}`,
    );
    const snapshot = cold
      ? resolve(root, `artifacts/view-integration/runtime-${language}/live/saved-content.json`)
      : '';
    steps.push([
      `runtime-${language}`,
      'node',
      ['tools/view/scripts/verify-runtime-content-engine.mjs'],
      {
        FORGEAX_ENGINE_CHECKOUT: root,
        FORGEAX_RUNTIME_PACK_LANGUAGE: language,
        FORGEAX_EVIDENCE_DIR: output,
        FORGEAX_RUNTIME_PACK_SNAPSHOT: snapshot,
      },
    ]);
  }
const groups = [...new Set(steps.map(([owner]) => owner).filter((owner) => owner !== 'prepare'))];
// Keep complete groups on four processes. The plugin boundary took 664 s in
// run 38301245268; its independent 151 s TS live/cold journey fits on contracts
// instead. Each language retains its own saved publication and cold reopening.
const shards = [
  ['contracts', 'game3d', 'runtime-ts'],
  ['lifecycle', 'workspace', 'engine-only', 'runtime-js'],
  ['plugin'],
  ['diagnostics'],
];
if (process.argv.includes('--list-shards')) {
  console.log(JSON.stringify(shards.map((_, index) => index)));
  process.exit(0);
}
if (process.argv.includes('--list-groups')) {
  console.log(JSON.stringify(groups));
  process.exit(0);
}
const groupIndex = process.argv.indexOf('--group');
const group = groupIndex === -1 ? undefined : process.argv[groupIndex + 1];
if (groupIndex !== -1 && !groups.includes(group))
  throw new Error(`unknown-view-integration-group:${group}`);
const shardIndex = process.argv.indexOf('--shard');
const shard = shardIndex === -1 ? undefined : Number(process.argv[shardIndex + 1]);
if (
  shardIndex !== -1 &&
  (!Number.isInteger(shard) || shards[shard] === undefined || group !== undefined)
)
  throw new Error(`unknown-view-integration-shard:${process.argv[shardIndex + 1]}`);
const selected = steps.filter(
  ([owner]) =>
    owner === 'prepare' ||
    (shard !== undefined ? shards[shard].includes(owner) : group === undefined || owner === group),
);
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify(selected));
  process.exit(0);
}
for (const [owner, file, args, env = {}] of selected) {
  const start = performance.now();
  const startedAt = Date.now();
  const viewProbe = args[0]?.startsWith('tools/view/scripts/verify-');
  const result = spawnSync(
    file,
    viewProbe ? [args[0].replace('tools/view/', ''), ...args.slice(1)] : args,
    {
      cwd: viewProbe ? resolve(root, 'tools/view') : root,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...env,
        FORGEAX_VIEW_ADDITIONAL_PAGES: '["rhi-debug","profiler"]',
        FORGEAX_SKIP_HARNESS_SYNC: '1',
      },
    },
  );
  console.log(
    JSON.stringify({
      stage: [file, ...args].join(' '),
      seconds: (performance.now() - start) / 1000,
      exitCode: result.status,
      candidate,
      owner,
    }),
  );
  if (result.status !== 0) {
    if (viewProbe) {
      try {
        const files = collectViewBackendDiagnostics({
          probePid: result.pid,
          startedAt,
          outputDirectory: resolve(root, 'artifacts/view-integration', basename(args[0])),
        });
        console.error('View backend diagnostics:', files);
      } catch (error) {
        console.error('Unable to collect View backend diagnostics:', error.message);
      }
    }
    process.exit(result.status ?? 1);
  }
}
