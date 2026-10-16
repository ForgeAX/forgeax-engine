import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectDdcGarbage } from '../gc.js';
import { createRuntimeScope } from '../runtime-scope.js';

describe('DDC multiprocess GC and scope protection', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('keeps current, LKG and active lease objects reachable and scopes collision-free', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-multiprocess-gc-'));
    roots.push(root);
    await mkdir(join(root, 'entries', 'orphan'), { recursive: true });
    await writeFile(join(root, 'entries', 'orphan', 'marker'), 'orphan');

    const first = await createRuntimeScope(root, 'a/b');
    const sibling = await createRuntimeScope(root, 'a_b');
    const result = await collectDdcGarbage(root, {
      currentKeys: ['current-key'],
      lastKnownGoodKeys: ['lkg-key'],
      activeLeaseKeys: ['lease-key'],
      scopeIds: [first.scopeId, sibling.scopeId],
    });

    expect(first.scopeHash).not.toBe(sibling.scopeHash);
    expect(result.deleted).not.toContain('current-key');
    expect(result.deleted).not.toContain('lkg-key');
    expect(result.deleted).not.toContain('lease-key');
    expect(result.deleted).toContain('orphan');
  });
});
