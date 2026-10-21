import { type CatalogDelta, type CatalogEntry, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
import { CatalogReplica } from '../registry/catalog-state';
import { defined } from './assert-defined.js';

it('applies one Catalog delta without revisiting unrelated package rows', async () => {
  const entries: CatalogEntry[] = Array.from({ length: 100 }, (_, index) => ({
    guid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    kind: 'mesh',
    sourcePath: `source/${index}`,
    packageUrl: `/packages/${index}.pack.json`,
    name: `mesh-${index}`,
  }));
  let publish!: (delta: CatalogDelta) => void;
  const registry = new AssetRegistry({ shaderRegistry: {} as never });
  registry.setCatalogSource({
    enumerate: async () => ok(entries),
    subscribe: (listener) => {
      publish = listener;
      return () => {};
    },
  });
  await registry.enumerateCatalog();
  const enumerate = vi.spyOn(registry, 'enumerateCatalog');
  const snapshot = vi.spyOn(CatalogReplica.prototype, 'snapshot');
  const unrelated = registry.catalogEntry(defined(entries[99]).guid);
  const old = defined(entries[0]);
  const next = { ...old, name: 'renamed', packageUrl: '/packages/replaced.pack.json' };
  publish({ added: [], changed: [next], removed: [] });
  expect(registry.catalogEntry(old.guid)?.name).toBe('renamed');
  expect(enumerate).not.toHaveBeenCalled();
  expect(snapshot).not.toHaveBeenCalled();
  expect(registry.catalogEntry(defined(entries[99]).guid)).toBe(unrelated);
  expect(registry.catalogEntry(defined(entries[99]).guid)?.name).toBe('mesh-99');
  snapshot.mockRestore();
  registry.dispose();
});
