import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.each([
  'js',
  'ts',
])('creates and restores %s tool plugins through native independent Fibers without evaluating code during admission', async (language) => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-inline-tools-'));
  try {
    const fixture = fileURLToPath(new URL('./fixtures/runtime-pack-tools.mjs', import.meta.url));
    for (const mode of ['create', 'restore']) {
      const result = await promisify(execFile)(
        process.execPath,
        [fixture, language, join(root, 'saved.json'), mode],
        { timeout: 15000 },
      );
      expect(JSON.parse(result.stdout)).toEqual({
        language,
        restoring: mode === 'restore',
        conversions: mode === 'create' && language === 'ts' ? 2 : 0,
        calls: 3,
        independentFibers: true,
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 35_000);
