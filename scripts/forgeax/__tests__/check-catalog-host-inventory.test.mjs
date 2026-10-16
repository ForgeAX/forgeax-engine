import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CATALOG_HOSTS, checkCatalogHostInventory } from '../check-catalog-host-inventory.mjs';

describe('catalog host inventory', () => {
  const roots = [];
  afterEach(async () =>
    Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
  );

  async function fixture(mutator) {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-catalog-hosts-'));
    roots.push(root);
    for (const host of CATALOG_HOSTS) {
      const file = join(root, host);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, 'pluginPack({ refresh: reloadAssetHost() });\n');
    }
    await mutator(root);
    return checkCatalogHostInventory(root);
  }

  it('reports the complete 41/41 host inventory and no extra channels', async () => {
    await expect(fixture(async () => {})).resolves.toMatchObject({
      ok: true,
      configured: 41,
      expected: 41,
      channels: { tsConfig: 0, typeErasureScript: 0, jsonFixture: 0 },
    });
  });

  it('fails for a missing policy, a default policy, or a new pluginPack host', async () => {
    const missing = await fixture(async (root) =>
      writeFile(join(root, CATALOG_HOSTS[0]), 'pluginPack({ roots: [] });\n'),
    );
    expect(missing.ok).toBe(false);
    expect(missing.errors).toContain(
      `${CATALOG_HOSTS[0]}: missing explicit reloadAssetHost policy`,
    );

    const added = await fixture(async (root) => {
      const file = join(root, 'apps/new-host/vite.config.ts');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, 'pluginPack({ refresh: reloadAssetHost() });\n');
    });
    expect(added.ok).toBe(false);
    expect(added.errors).toContain(
      'apps/new-host/vite.config.ts: new pluginPack host is not in the 41-host inventory',
    );
  });
});
