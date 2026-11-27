import { sceneAssetContribution } from '@forgeax/engine-scene';
import type { SceneAsset } from '@forgeax/engine-types';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { type CatalogListener, createCatalogSource } from '../catalog-source';
import type { AssetContentLease } from '../internal/asset-records';
import { runtimeAssets } from '../internal/runtime-assets';
import {
  createSceneContentPublicationTask,
  type SceneContentPublicationTask,
} from '../registry/scene-content-publication';
import * as publicationFences from '../registry/scene-publication-fence';
import { defined } from './assert-defined';
import { publishRuntimeAssets } from './fixtures/runtime-publication';

const rootGuid = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const childGuid = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const siblingGuid = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function finish(task: SceneContentPublicationTask) {
  for (let work = 0; work < 10_000; work++) {
    const result = task.step(1);
    if (!result.ok || result.value !== undefined) return result;
  }
  throw new Error('publication task did not terminate');
}

function sceneWithMount(source: string | number): SceneAsset {
  return { kind: 'scene', entities: { mount: { components: {}, instance: { source } } } };
}

async function fixture() {
  const assets = new AssetRegistry();
  assets.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
  cleanups.push(() => assets.dispose());
  const child: SceneAsset = { kind: 'scene', entities: { leaf: { components: {} } } };
  const root = sceneWithMount(childGuid);
  const entries = [
    { guid: childGuid, asset: child },
    { guid: rootGuid, asset: root, refs: [childGuid] },
    { guid: siblingGuid, asset: { kind: 'scene' as const, entities: {} } },
  ];
  publishRuntimeAssets(assets, entries);
  const handle = (await assets.load(rootGuid, 'scene')).unwrap();
  const records = runtimeAssets(assets);
  function capture(target = handle): AssetContentLease {
    const lease = records.beginContentCapture(target).unwrap().step(1000).unwrap();
    assert.isDefined(lease);
    cleanups.push(() => {
      const retirement = lease.retire().unwrap();
      while (!retirement.inspect().done) retirement.step(1).unwrap();
    });
    return lease;
  }
  function task(lease = capture(), target = handle) {
    const preparation = createSceneContentPublicationTask(assets, lease, target);
    cleanups.push(() => preparation.dispose());
    return preparation;
  }
  return { assets, records, handle, entries, capture, task };
}

describe('fixed Scene content publication preparation', () => {
  it.each([
    'step',
    'guard',
  ] as const)('refuses nested %s without consuming or poisoning the current proof', async (where) => {
    const f = await fixture();
    const task = f.task();
    const guard = defined(finish(task).unwrap());
    const read = f.assets.sourceOf.bind(f.assets);
    let nested: boolean | undefined;
    vi.spyOn(f.assets, 'sourceOf').mockImplementationOnce((handle) => {
      nested = where === 'step' ? task.step(1).ok : guard.validate().ok;
      return read(handle);
    });
    expect(guard.validate().ok).toBe(true);
    expect(nested).toBe(false);
    expect(task.step(1).unwrap()).toBe(guard);
  });

  it('refuses nested stepping while the source iterator is running', async () => {
    const f = await fixture();
    const task = f.task();
    const read = f.assets.sourceOf.bind(f.assets);
    let nested: boolean | undefined;
    vi.spyOn(f.assets, 'sourceOf').mockImplementationOnce((handle) => {
      nested = task.step(1).ok;
      return read(handle);
    });
    expect(task.step(1).ok).toBe(true);
    expect(nested).toBe(false);
    expect(defined(finish(task).unwrap()).validate().ok).toBe(true);
  });

  it('rejects a real content edit made after the initial observation before returning its proof', async () => {
    const f = await fixture();
    const task = f.task();
    const guard = defined(finish(task).unwrap());
    const read = f.assets.sourceOf.bind(f.assets);
    vi.spyOn(f.assets, 'sourceOf').mockImplementationOnce((handle) => {
      const result = read(handle);
      f.assets.update(f.handle, { entities: {} }).unwrap();
      return result;
    });
    expect(guard.validate()).toMatchObject({ ok: false, error: { code: 'asset-write-conflict' } });
    expect(guard.validate().ok).toBe(false);
  });

  it.each([
    'source',
    'catalog',
    'closure',
  ] as const)('keeps disposal terminal during %s observation', async (where) => {
    const f = await fixture();
    const content = f.capture();
    const task = f.task(content);
    const guard = defined(finish(task).unwrap());
    if (where === 'source') {
      const read = f.assets.sourceOf.bind(f.assets);
      vi.spyOn(f.assets, 'sourceOf').mockImplementationOnce((handle) => {
        task.dispose();
        return read(handle);
      });
    } else if (where === 'catalog') {
      const read = f.assets.catalogEntry.bind(f.assets);
      vi.spyOn(f.assets, 'catalogEntry').mockImplementationOnce((guid) => {
        task.dispose();
        return read(guid);
      });
    } else {
      const read = content.matchesCurrent.bind(content);
      vi.spyOn(content, 'matchesCurrent').mockImplementationOnce(() => {
        task.dispose();
        return read();
      });
    }
    expect(guard.validate()).toMatchObject({
      ok: false,
      error: { code: 'asset-generation-fence-mismatch' },
    });
    expect(guard.validate().ok).toBe(false);
    expect(task.step(1).ok).toBe(false);
    expect(content.matchesCurrent()).toBe(true);
  });

  it('settles disposal from inside the running publication traversal without returning its iterator recursively', async () => {
    const f = await fixture();
    const task = f.task();
    const read = f.assets.sourceOf.bind(f.assets);
    vi.spyOn(f.assets, 'sourceOf').mockImplementationOnce((handle) => {
      task.dispose();
      return read(handle);
    });
    expect(task.step(1)).toMatchObject({
      ok: false,
      error: { code: 'asset-generation-fence-mismatch' },
    });
    expect(task.step(1).ok).toBe(false);
  });

  it('reuses normalized proofs while immutable adopted and complete Catalog facts are unchanged', async () => {
    const f = await fixture();
    const normalize = vi.spyOn(publicationFences, 'createScenePublicationFence');
    const complete = vi.spyOn(publicationFences, 'scenePublicationFenceForRow');
    const task = f.task();
    const guard = defined(finish(task).unwrap());
    expect(normalize).toHaveBeenCalled();
    expect(complete).toHaveBeenCalled();
    normalize.mockClear();
    complete.mockClear();
    for (let repeat = 0; repeat < 100; repeat++) guard.validate().unwrap();
    expect(normalize).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('revalidates the current closure without repeatedly reading adopted Scene origins', async () => {
    const f = await fixture();
    const lease = f.capture();
    const task = f.task(lease);
    const guard = defined(finish(task).unwrap());
    const version = vi.spyOn(f.records, 'version');
    const current = vi.spyOn(lease, 'matchesCurrent');
    for (let repeat = 0; repeat < 100; repeat++) guard.validate().unwrap();
    expect(version).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(100);

    const unrelated = f.assets.create({ kind: 'scene', entities: {} }).unwrap();
    expect(guard.validate().ok).toBe(true);
    expect(version.mock.calls.flat().sort()).toEqual([...lease.handles].sort());
    version.mockClear();
    guard.validate().unwrap();
    expect(version).not.toHaveBeenCalled();
    f.assets.release(unrelated).unwrap();
  });

  it('reads only the Scene roots while the same accepted Catalog publication is current', async () => {
    const f = await fixture();
    const task = f.task();
    const guard = defined(finish(task).unwrap());
    const entry = vi.spyOn(f.assets, 'catalogEntry');
    for (let repeat = 0; repeat < 5; repeat++) guard.validate().unwrap();
    expect(entry.mock.calls).toEqual(
      Array.from({ length: 5 }, () => [[rootGuid], [childGuid]]).flat(),
    );
  });

  it.each([
    'shared',
    'wire',
  ] as const)('checks the complete Catalog once for two roots of one %s publication', async (route) => {
    const f = await fixture();
    if (route === 'wire') {
      const entries = JSON.parse(JSON.stringify(defined(f.assets.catalogSnapshot()).entries));
      f.assets.setCatalogSource(createCatalogSource({ entries }));
      (await f.assets.enumerateCatalog()).unwrap();
    }
    const root = defined(f.assets.catalogEntry(rootGuid)?.publication);
    const child = defined(f.assets.catalogEntry(childGuid)?.publication);
    expect(child).toEqual(root);
    expect(child === root).toBe(route === 'shared');
    const complete = vi.spyOn(publicationFences, 'scenePublicationFenceForRow');
    const task = f.task();
    const guard = defined(finish(task).unwrap());
    expect(complete).toHaveBeenCalledTimes(1);
    guard.validate().unwrap();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('captures immutable publication facts without freezing the source observation', async () => {
    const f = await fixture();
    const rows = defined(f.assets.catalogSnapshot()).entries;
    const input = structuredClone(rows);
    const sourcePublication = defined(input.find((row) => row.guid === rootGuid)?.publication);
    f.assets.setCatalogSource(createCatalogSource({ entries: input }));
    (await f.assets.enumerateCatalog()).unwrap();
    const accepted = defined(f.assets.catalogEntry(rootGuid)?.publication);
    expect(accepted).not.toBe(sourcePublication);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.outputs)).toBe(true);
    expect(accepted.outputs.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(accepted.receipt)).toBe(true);
    const adopted = defined(f.assets.sourceOf(f.handle)?.publication);
    expect(Object.isFrozen(adopted.outputs)).toBe(true);
    expect(adopted.outputs.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(adopted.receipt)).toBe(true);
    expect(Object.isFrozen(sourcePublication)).toBe(false);
    const first = defined(sourcePublication.outputs[0]);
    // The mutable source may build its next observation; accepted facts stay owned.
    Object.assign(first, { guid: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000099' });
    expect(accepted.outputs[0]?.guid).not.toBe(first.guid);
  });

  it('shares one owned copy per observation without reusing a later mutable producer input', async () => {
    const f = await fixture();
    const rows = structuredClone(defined(f.assets.catalogSnapshot()).entries);
    const publication = defined(rows[0]?.publication);
    f.assets.setCatalogSource(
      createCatalogSource({ entries: rows.map((row) => ({ ...row, publication })) }),
    );
    (await f.assets.enumerateCatalog()).unwrap();
    const first = defined(f.assets.catalogEntry(rootGuid)?.publication);
    expect(f.assets.catalogEntry(childGuid)?.publication).toBe(first);
    expect(first).not.toBe(publication);
    Object.assign(publication, { generation: publication.generation + 1 });
    (await f.assets.reconcileCatalog()).unwrap();
    const next = defined(f.assets.catalogEntry(rootGuid)?.publication);
    expect(next).not.toBe(first);
    expect(next.generation).toBe(publication.generation);
    expect(first.generation).toBe(publication.generation - 1);
  });

  it('does not lend a complete root proof to an equal scalar fence with a different missing output', async () => {
    const f = await fixture();
    const task = f.task();
    const guard = defined(finish(task).unwrap());
    guard.validate().unwrap();
    const rows = defined(f.assets.catalogSnapshot()).entries;
    const changed = rows.map((row) =>
      row.guid === childGuid
        ? {
            ...row,
            publication: {
              ...defined(row.publication),
              outputs: [
                ...defined(row.publication).outputs,
                {
                  ...defined(defined(row.publication).outputs[0]),
                  guid: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000099',
                },
              ],
            },
          }
        : row,
    );
    // The scalar fence intentionally remains equal; each root still requires
    // its own complete set rather than the earlier root's cached membership.
    f.assets.setCatalogSource(createCatalogSource({ entries: changed }));
    (await f.assets.enumerateCatalog()).unwrap();
    expect(guard.validate()).toMatchObject({
      ok: false,
      error: { code: 'asset-generation-fence-mismatch' },
    });
  });

  it.each([
    'remove',
    'replace',
  ] as const)('invalidates a cached complete proof on a same-source %s delta', async (mode) => {
    const f = await fixture();
    let emit: CatalogListener | undefined;
    const rows = defined(f.assets.catalogSnapshot()).entries;
    f.assets.setCatalogSource(
      createCatalogSource({
        entries: rows,
        subscribe: (listener) => {
          emit = listener;
          return () => {
            emit = undefined;
          };
        },
      }),
    );
    (await f.assets.enumerateCatalog()).unwrap();
    const task = f.task();
    const guard = defined(finish(task).unwrap());
    guard.validate().unwrap();
    defined(emit)({
      added: [],
      changed:
        mode === 'remove'
          ? []
          : rows.map((row) => ({
              ...row,
              publication: {
                ...defined(row.publication),
                generation: defined(row.publication).generation + 1,
              },
            })),
      removed: mode === 'remove' ? [siblingGuid] : [],
    });
    expect(guard.validate()).toMatchObject({
      ok: false,
      error: { code: 'asset-generation-fence-mismatch' },
    });
  });

  it('uses the adopted exact closure through real Pack decode without current payload borrows', async () => {
    const f = await fixture();
    const lease = f.capture();
    const read = vi.spyOn(f.assets, 'read').mockImplementation(() => {
      throw new Error('ordinary current read is forbidden');
    });
    const borrow = vi.spyOn(f.records, 'borrow').mockImplementation(() => {
      throw new Error('ordinary current borrow is forbidden');
    });
    const catalog = vi.spyOn(f.assets, 'catalogSnapshot').mockImplementation(() => {
      throw new Error('unrelated Catalog enumeration is forbidden');
    });
    const task = f.task(lease);
    expect(task.step(0)).toMatchObject({ ok: false, error: { code: 'asset-invalid-value' } });
    // Indexing a closure member does not also drain the whole nested hierarchy.
    expect(task.step(1).unwrap()).toBeUndefined();
    const guard = finish(task).unwrap();
    expect(guard?.validate().ok).toBe(true);
    expect(task.step(1).unwrap()).toBe(guard);
    expect(read).not.toHaveBeenCalled();
    expect(borrow).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();
  });

  it('rejects changed current content on resume without reading it into the fixed candidate', async () => {
    const f = await fixture();
    const lease = f.capture();
    const task = f.task(lease);
    task.step(1).unwrap();
    f.assets.update(f.handle, { entities: {} }).unwrap();
    expect(task.step(1)).toMatchObject({ ok: false, error: { code: 'asset-write-conflict' } });
    expect(lease.read<SceneAsset>(f.handle).unwrap().entities.mount).toBeDefined();
    expect(task.step(20)).toMatchObject({ ok: false, error: { code: 'asset-write-conflict' } });
  });

  it('does not label old adopted content with a newer Catalog publication at final acceptance', async () => {
    const f = await fixture();
    const lease = f.capture();
    const guard = finish(f.task(lease)).unwrap();
    expect(guard).toBeDefined();
    const oldDigest = f.assets.sourceOf(f.handle)?.publication?.digest;
    publishRuntimeAssets(f.assets, [
      { ...defined(f.entries[0]), asset: { kind: 'scene', entities: {} } },
      defined(f.entries[1]),
    ]);
    (await f.assets.enumerateCatalog()).unwrap();
    expect(lease.matchesCurrent()).toBe(true);
    expect(f.assets.sourceOf(f.handle)?.publication?.digest).toBe(oldDigest);
    expect(f.assets.catalogEntry(rootGuid)?.publication?.digest).not.toBe(oldDigest);
    expect(guard?.validate()).toMatchObject({
      ok: false,
      error: { code: 'asset-generation-fence-mismatch' },
    });
    // Observed invalidation is terminal even if the old Catalog tuple later returns.
    publishRuntimeAssets(f.assets, f.entries);
    (await f.assets.enumerateCatalog()).unwrap();
    expect(guard?.validate().ok).toBe(false);
  });

  it('requires the complete sibling publication, including outputs outside the scene closure', async () => {
    const f = await fixture();
    const lease = f.capture();
    const row = defined(f.assets.catalogEntry(rootGuid));
    expect(f.assets.catalogEntry(siblingGuid)).toBeDefined();
    expect(lease.handles).toHaveLength(2);
    f.assets.setCatalogSource(createCatalogSource({ entries: [row] }));
    (await f.assets.enumerateCatalog()).unwrap();
    expect(finish(f.task(lease))).toMatchObject({
      ok: false,
      error: { code: 'asset-generation-fence-mismatch', phase: 'catalog' },
    });
  });

  it('rejects source edits already made before capture instead of reusing the producer receipt', async () => {
    const f = await fixture();
    f.assets.update(f.handle, { entities: {} }).unwrap();
    expect(f.assets.sourceOf(f.handle)?.modified).toBe(true);
    expect(finish(f.task())).toMatchObject({
      ok: false,
      error: { code: 'asset-generation-fence-mismatch' },
    });
  });

  it('keeps runtime-created nested scenes independent of Catalog publication', async () => {
    const f = await fixture();
    const child = f.assets.create({ kind: 'scene', entities: {} }).unwrap();
    const root = f.assets.create(sceneWithMount(child)).unwrap();
    const lease = f.capture(root);
    expect(lease.handles).toContain(child);
    const guard = finish(f.task(lease, root)).unwrap();
    expect(guard?.validate().ok).toBe(true);
    f.assets.release(root).unwrap();
    f.assets.release(child).unwrap();
  });

  it('refuses a current GUID outside the captured closure rather than resolving it live', async () => {
    const f = await fixture();
    // Deliberately malformed owner input: the source exists, but no dependency hold was declared.
    const root = f.records.create('scene', sceneWithMount(childGuid)).unwrap();
    const lease = f.capture(root);
    expect(finish(f.task(lease, root))).toMatchObject({
      ok: false,
      error: { code: 'asset-generation-fence-mismatch', hint: expect.stringContaining('outside') },
    });
    f.records.release(root).unwrap();
  });

  it('invalidates an accepted guard after its fixed lease is retired', async () => {
    const f = await fixture();
    const lease = f.capture();
    const guard = finish(f.task(lease)).unwrap();
    lease.retire().unwrap();
    expect(guard?.validate()).toMatchObject({ ok: false, error: { code: 'asset-write-conflict' } });
  });

  it('closes suspended preparation and accepted proofs without consuming the caller lease', async () => {
    const f = await fixture();
    const lease = f.capture();
    const task = f.task(lease);
    task.step(3).unwrap();
    task.dispose();
    task.dispose();
    expect(task.step(1)).toMatchObject({
      ok: false,
      error: { code: 'asset-generation-fence-mismatch', hint: expect.stringContaining('disposed') },
    });
    expect(lease.read<SceneAsset>(f.handle).ok).toBe(true);
    const next = f.task(lease);
    const guard = finish(next).unwrap();
    expect(guard?.validate().ok).toBe(true);
    next.dispose();
    expect(guard?.validate().ok).toBe(false);
    expect(lease.matchesCurrent()).toBe(true);
  });
});
