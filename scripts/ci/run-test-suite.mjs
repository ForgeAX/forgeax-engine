import { spawnSync } from 'node:child_process';
import { pnpmCommand } from '../lib/pnpm-command.mjs';

// pnpm owns the package-manager executable. Reuse its exact entry rather than
// asking a platform shell to interpret assignments or find a pnpm.cmd shim.
const suite = process.argv[2];
if (!['browser', 'dawn'].includes(suite) || process.argv.length !== 3)
  throw new Error('usage: pnpm test:browser | pnpm test:dawn');
const manager = process.env.npm_execpath;
if (!manager) throw new Error('test suites must be launched through pnpm');
const pnpm = pnpmCommand();
const node = [process.execPath];
const lease = (timeout, command) => [
  ...node,
  'scripts/ci/local-gpu-lease.mjs',
  '--timeout-ms',
  String(timeout),
  '--',
  ...command,
];
const env = { ...process.env };
function run(command, extra = {}) {
  const result = spawnSync(command[0], command.slice(1), {
    env: { ...env, ...extra },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (suite === 'browser') {
  run(
    lease(300000, [
      ...node,
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'config/vitest.browser.config.ts',
      '--project=browser',
      'apps/hello/entity-visibility/src/__tests__/visibility.browser.test.ts',
    ]),
    { FORGEAX_BROWSER_ENTITY_VISIBILITY: '1' },
  );
  run([...node, 'scripts/ci/run-split-vitest-browser.mjs', '--group-size=8', '--max-workers=1'], {
    FORGEAX_BROWSER_ENTITY_VISIBILITY: '0',
  });
  run(lease(2700000, [...pnpm, '--filter', '@forgeax/engine-devkit', 'test:runtime-browser']));
  run(lease(2700000, [...pnpm, '--filter', '@forgeax/mesh-io-parity', 'verify']));
} else {
  run([...pnpm, 'build:engine'], {
    FORGEAX_PACKAGE_BUILD_CONCURRENCY: env.FORGEAX_PACKAGE_BUILD_CONCURRENCY || '2',
  });
  run([...node, 'scripts/build-shared-inputs.mjs', '--root', '.']);
  run([...node, 'scripts/ci/run-dawn-gate.mjs'], {
    FORGEAX_SHARED_APP_INPUTS_MANIFEST: 'shared-build-inputs/manifest.json',
    NODE_OPTIONS: '--max-old-space-size=4096',
  });
}
