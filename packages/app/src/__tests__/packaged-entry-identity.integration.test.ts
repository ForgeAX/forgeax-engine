import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each([
  'errors',
  'submitted-frame',
])('shares %s through the built root and browser entries', (mode) => {
  // Native ESM must load the published entries: source imports share modules
  // before bundling and cannot detect duplicated private state in dist.
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/packaged-entry-identity.mjs', import.meta.url)), mode],
    { encoding: 'utf8', timeout: 15_000 },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});
