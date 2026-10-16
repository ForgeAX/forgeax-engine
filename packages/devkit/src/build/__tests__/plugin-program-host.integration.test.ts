import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.each([
  'dev',
  'build',
] as const)('%s uses the Vite Host identity for sibling content projects', async (mode) => {
  // pnpm's injected NODE_PATH otherwise lets the content project resolve
  // the runner's umbrella package, hiding a real custom-host failure.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/plugin-program-host.mjs', import.meta.url)), mode],
    { env: { ...process.env, NODE_PATH: '' }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  );
  expect(JSON.parse(stdout.trim())).toMatchObject({ mode, namespaces: 2 });
}, 65_000);
