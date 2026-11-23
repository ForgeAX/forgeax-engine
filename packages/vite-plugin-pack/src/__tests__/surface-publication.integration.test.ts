import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { temporaryDirectories } from '../../../../scripts/test/temporary-directories.mjs';
import { assertBuildRoots, projectPackIndexUrl, resolvePackBuildInputs } from '../build-inputs.js';

const scratch = temporaryDirectories();

afterEach(scratch.clear);

describe('trusted Surface publication roots', () => {
  it('normalizes configured roots and keeps the Pack index URL deterministic', async () => {
    const root = await scratch.make('forgeax-pack-roots-');
    const resolved = resolvePackBuildInputs({ roots: [root], base: '/game/' });
    expect(resolved).toEqual({ roots: [root], basePrefix: '/game' });
    expect(projectPackIndexUrl(resolved.basePrefix, '/pack-index.json')).toBe(
      '/game/pack-index.json',
    );
    await expect(assertBuildRoots(resolved.roots)).resolves.toBeUndefined();
  });

  it('admits absolute roots with trailing separators through the production root gate', async () => {
    const root = await scratch.make('forgeax-pack-roots-');
    const resolved = resolvePackBuildInputs({ roots: [`${root}/`] });
    expect(resolved.roots).toEqual([root]);
    await expect(assertBuildRoots(resolved.roots)).resolves.toBeUndefined();
  });

  it('fails closed before production emission when a trusted root is absent', async () => {
    const root = await scratch.make('forgeax-pack-roots-');
    const missing = join(root, 'missing-surface-root');
    await expect(assertBuildRoots([missing])).rejects.toMatchObject({
      code: 'config-failed',
      detail: { subject: missing },
    });
  });
});
