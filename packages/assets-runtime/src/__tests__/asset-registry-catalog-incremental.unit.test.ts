import { type CatalogDelta, type CatalogEntry, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
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
  const registry = new AssetRegistry({} as never);
  registry.setCatalogSource({
    enumerate: async () => ok(entries),
    subscribe: (listener) => {
      publish = listener;
      return () => {};
    },
  });
  await registry.enumerateCatalog();
  const register = vi.spyOn(registry, '_registerPackage');
  const old = defined(entries[0]);
  const next = { ...old, name: 'renamed', packageUrl: '/packages/replaced.pack.json' };
  publish({ added: [], changed: [next], removed: [] });
  expect(registry.packIndexCache?.get(old.guid)?.name).toBe('renamed');
  expect(register.mock.calls.flatMap((call) => call[1])).toEqual([old.guid]);
  expect(registry.packIndexCache?.get(defined(entries[99]).guid)?.name).toBe('mesh-99');
  registry.clearCatalogSource();
});

it('invalidates the loaded reference closure while retaining unrelated payloads and accepted rows', async () => {
  const entries: CatalogEntry[] = ['root', 'child', 'leaf', 'unrelated'].map((name, index) => ({
    guid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    kind: 'mesh',
    sourcePath: name,
    packageUrl: `/packages/${name}.pack.json`,
  }));
  let publish!: (delta: CatalogDelta) => void;
  const registry = new AssetRegistry({} as never);
  registry.setCatalogSource({
    enumerate: async () => ok(entries),
    subscribe: (listener) => {
      publish = listener;
      return () => {};
    },
  });
  await registry.enumerateCatalog();
  const [root, child, leaf, unrelated] = entries as [
    CatalogEntry,
    CatalogEntry,
    CatalogEntry,
    CatalogEntry,
  ];
  const stable = {};
  registry.loadState.prepare(root.guid, {}, []);
  registry.loadState.prepare(child.guid, {}, [root.guid]);
  registry.loadState.prepare(leaf.guid, {}, [child.guid]);
  registry.loadState.prepare(unrelated.guid, stable, []);
  publish({
    added: [],
    changed: [{ ...root, packageUrl: '/packages/root-new.pack.json' }],
    removed: [],
  });
  expect(registry.loadState.get(child.guid)).toBeUndefined();
  expect(registry.loadState.get(leaf.guid)).toBeUndefined();
  expect(registry.loadState.getPrepared(unrelated.guid)).toBe(stable);
  expect(registry.packIndexCache?.get(child.guid)).toMatchObject({ packageUrl: child.packageUrl });
  expect(registry.packIndexCache?.get(leaf.guid)).toMatchObject({ packageUrl: leaf.packageUrl });
  registry.clearCatalogSource();
});
