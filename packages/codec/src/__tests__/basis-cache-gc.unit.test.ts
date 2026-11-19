import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { it } from 'vitest';

it.each([
  false,
  true,
])('collects the real idle Basis instance and transcodes identically after reinstantiation (Host=%s)', async (host) => {
  await promisify(execFile)(
    process.execPath,
    [
      '--expose-gc',
      fileURLToPath(new URL('./fixtures/basis-cache-gc.mjs', import.meta.url)),
      ...(host ? ['--host'] : []),
    ],
    { timeout: 30_000, env: { ...process.env, NODE_OPTIONS: '' } },
  );
}, 40_000);
