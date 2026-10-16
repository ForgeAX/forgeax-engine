import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('replaces the frozen executable Host after an ordinary Pack publication changes', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/plugin-program-reimport.mjs', import.meta.url))],
    { env: { ...process.env, NODE_PATH: '' }, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
  );
  expect(JSON.parse(stdout.trim())).toMatchObject({
    failedCandidateRetained: true,
    retiredSession: true,
    namespaces: 1,
  });
}, 65000);
