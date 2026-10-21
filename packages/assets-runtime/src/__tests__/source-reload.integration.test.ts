import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import {
  type CatalogDelta,
  type CatalogEntry,
  type MaterialAsset,
  ok,
  type TextureAsset,
} from '@forgeax/engine-types';
import { afterEach, expect, it } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import type { CatalogSource } from '../catalog-source';
import { runtimeAssets } from '../internal/runtime-assets';

const ROOT = '11111111-1111-4111-8111-111111111111';
const TEXTURE = '22222222-2222-4222-8222-222222222222';
const NEW_TEXTURE = '33333333-3333-4333-8333-333333333333';
const PARENT = '44444444-4444-4444-8444-444444444444';
const owners: AssetRegistry[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

function fixture(inherited = false, pushed = true) {
  let rows: CatalogEntry[] = [];
  const packages = new Map<string, string>();
  const listeners = new Set<(delta: CatalogDelta) => void>();
  let wait: (() => Promise<void>) | undefined;
  let reads = 0;
  let enumerations = 0;
  const requests: string[] = [];
  const source: CatalogSource = {
    enumerate: async () => {
      enumerations++;
      await Promise.resolve();
      return ok(rows);
    },
    ...(!pushed
      ? {
          get: async (guid: string) => {
            requests.push(guid);
            return ok(rows.filter((row) => row.guid === guid));
          },
        }
      : {}),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openPackage: () => async (input) => {
      reads++;
      const bytes = packages.get(String(input));
      await wait?.();
      return new Response(bytes ?? '', { status: bytes === undefined ? 404 : 200 });
    },
  };
  const registry = new AssetRegistry({ scopeId: 'reload', catalog: source });
  registry.installDecoder(defineAssetKind<MaterialAsset, 'material'>('material'), {
    decode: async ({ envelope }) => ok(envelope.payload),
  });
  registry.installDecoder(defineAssetKind<TextureAsset, 'texture'>('texture'), {
    decode: async ({ envelope }) =>
      ok({ ...envelope.payload, data: new Uint8Array(envelope.payload.data) }),
  });
  owners.push(registry);
  const publish = (
    revision: number,
    options: {
      invalidRoot?: boolean;
      newDependency?: boolean;
      roughness?: number;
      sourceClock?: number;
      publicationGeneration?: number;
    } = {},
  ) => {
    const texture = options.newDependency ? NEW_TEXTURE : TEXTURE;
    const packageUrl = `https://reload.invalid/${revision}/pack.json`;
    const material = {
      kind: 'material',
      passes: [{ name: 'main', program: { module: 'forgeax::default-unlit' } }],
      parameters: [
        { name: 'roughness', type: 'f32' },
        { name: 'albedo', type: 'texture' },
      ],
      values: {
        roughness: options.invalidRoot ? 'bad-value' : (options.roughness ?? revision / 10),
        albedo: { texture },
      },
    };
    const publication = createRuntimePackPublication({
      scopeId: 'reload',
      generation: options.publicationGeneration ?? revision,
      sourcePath: 'reload.pack',
      sourceRevision: String(revision),
      packageUrl,
      pack: {
        assets: [
          ...(inherited
            ? [
                {
                  guid: PARENT,
                  kind: 'material',
                  refs: [texture],
                  artifacts: {},
                  payload: material,
                },
              ]
            : []),
          {
            guid: ROOT,
            kind: 'material',
            refs: inherited ? [PARENT] : [texture],
            artifacts: {},
            payload: inherited ? { kind: 'material', parent: PARENT, values: {} } : material,
          },
          {
            guid: texture,
            kind: 'texture',
            refs: [],
            artifacts: {},
            payload: {
              kind: 'texture',
              shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
              mips: { kind: 'none' },
              format: 'rgba8unorm',
              colorSpace: 'linear',
              data: [revision, 0, 0, 255],
            },
          },
        ],
      },
    });
    packages.set(packageUrl, JSON.stringify(publication.pack));
    const previous = new Set(rows.map((row) => row.guid));
    rows = publication.pack.assets.map(({ guid, kind }) => ({
      guid,
      kind,
      packageUrl,
      sourcePath: 'reload.pack',
      publication: publication.publication,
      lifecycle: 'current',
      ...(options.sourceClock === undefined
        ? {}
        : {
            revision: {
              rootId: 'reload-source',
              observedAt: options.sourceClock,
              digest: `source-${revision}`,
            },
          }),
    }));
    for (const listener of pushed ? listeners : [])
      listener({
        added: rows.filter((row) => !previous.has(row.guid)),
        changed: rows.filter((row) => previous.has(row.guid)),
        removed: [...previous].filter((guid) => !rows.some((row) => row.guid === guid)),
      });
    return publication.publication;
  };
  return {
    registry,
    source,
    publish,
    reads: () => reads,
    requests,
    enumerations: () => enumerations,
    pause() {
      let release = () => {};
      let entered = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      wait = () => {
        entered();
        return pending;
      };
      return {
        started,
        release: () => {
          wait = undefined;
          release();
        },
      };
    },
    remove() {
      const removed = rows.map((row) => row.guid);
      rows = [];
      for (const listener of listeners) listener({ added: [], changed: [], removed });
    },
  };
}

it('preserves gameplay edits on ordinary loads and requires an explicit source conflict policy', async () => {
  const f = fixture();
  const first = f.publish(1);
  const root = (await f.registry.load(ROOT, 'material')).unwrap();
  const texture = (await f.registry.load(TEXTURE, 'texture')).unwrap();
  f.registry.update(root, { values: { roughness: 0.8 } }).unwrap();
  const source = f.registry.sourceOf(root);
  expect(source).toMatchObject({ modified: true, publication: { digest: first.digest } });
  const second = f.publish(2);
  const calls = f.reads();
  const loaded = (await f.registry.load(ROOT, 'material')).unwrap();
  expect(loaded).toBe(root);
  f.registry.release(loaded).unwrap();
  expect(f.reads()).toBe(calls);
  expect(f.registry.read(root).unwrap().values?.roughness).toBe(0.8);
  expect(await f.registry.reload(root, { conflict: 'reject' })).toMatchObject({
    ok: false,
    error: { code: 'asset-write-conflict' },
  });
  expect(f.registry.read(texture).unwrap().data[0]).toBe(1);
  expect(f.registry.sourceOf(root)).toEqual(source);
  (await f.registry.reload(root, { conflict: 'overwrite' })).unwrap();
  expect(f.registry.read(root).unwrap().values).toMatchObject({
    roughness: 0.2,
    albedo: { texture },
  });
  expect(f.registry.read(texture).unwrap().data[0]).toBe(2);
  expect(f.registry.sourceOf(root)).toMatchObject({
    modified: false,
    publication: { digest: second.digest },
  });
  const provenance = f.registry.sourceOf(root);
  if (provenance?.publication !== undefined)
    (provenance.publication as { digest: string }).digest = 'forged';
  expect(f.registry.sourceOf(root)?.publication?.digest).toBe(second.digest);
  const observer = f.registry.observe().unwrap();
  (await f.registry.reload(root, { conflict: 'reject' })).unwrap();
  expect(observer.read().unwrap().changes).toHaveLength(0);
  observer.dispose();
});

it('keeps pending content private and atomically adopts a complete closure under the same references', async () => {
  const f = fixture();
  f.publish(1);
  const root = (await f.registry.load(ROOT, 'material')).unwrap();
  const texture = (await f.registry.load(TEXTURE, 'texture')).unwrap();
  const fixed = f.registry.snapshot(root).unwrap();
  const observer = f.registry.observe().unwrap();
  f.publish(2);
  const gate = f.pause();
  const pending = f.registry.reload(root, { conflict: 'reject' });
  await gate.started;
  expect(f.registry.read(root).unwrap().values?.roughness).toBe(0.1);
  expect(f.registry.read(texture).unwrap().data[0]).toBe(1);
  expect(observer.read().unwrap().changes).toHaveLength(0);
  gate.release();
  (await pending).unwrap();
  expect(
    observer
      .read()
      .unwrap()
      .changes.map((change) => change.handle),
  ).toEqual([texture, root]);
  expect(f.registry.read(texture).unwrap().data[0]).toBe(2);
  expect(fixed.read<TextureAsset>(texture).unwrap().data[0]).toBe(1);
  expect(fixed.matchesCurrent()).toBe(false);
  fixed.dispose();
  observer.dispose();
});

it('adopts a changed dependency without revising its unchanged parent from the same source package', async () => {
  const f = fixture();
  f.publish(1);
  const root = (await f.registry.load(ROOT, 'material')).unwrap();
  const texture = (await f.registry.load(TEXTURE, 'texture')).unwrap();
  const records = runtimeAssets(f.registry);
  const revision = records.version(root).unwrap();
  const fixed = f.registry.snapshot(root).unwrap();
  const observer = f.registry.observe().unwrap();
  const next = f.publish(2, { roughness: 0.1 });
  (await f.registry.reload(root, { conflict: 'reject' })).unwrap();
  expect(records.version(root).unwrap()).toBe(revision);
  expect(
    observer
      .read()
      .unwrap()
      .changes.map((change) => change.handle),
  ).toEqual([texture]);
  expect(f.registry.read(texture).unwrap().data[0]).toBe(2);
  expect(f.registry.sourceOf(root)).toMatchObject({
    modified: false,
    publication: { digest: next.digest },
  });
  expect(fixed.matchesCurrent()).toBe(false);
  fixed.dispose();
  observer.dispose();
});

it('rebuilds flattened child content when only an inherited source changes', async () => {
  const f = fixture(true);
  f.publish(1);
  const root = (await f.registry.load(ROOT, 'material')).unwrap();
  expect(f.registry.read(root).unwrap().parent).toBeUndefined();
  expect(f.registry.read(root).unwrap().values?.roughness).toBe(0.1);
  const fixed = f.registry.snapshot(root).unwrap();
  f.publish(2);
  (await f.registry.reload(root, { conflict: 'reject' })).unwrap();
  expect(f.registry.read(root).unwrap().values?.roughness).toBe(0.2);
  expect(fixed.read<MaterialAsset>(root).unwrap().values?.roughness).toBe(0.1);
  fixed.dispose();
});

it.each([
  'root',
  'dependency',
] as const)('never overwrites %s edits made while a reload is pending', async (target) => {
  const f = fixture();
  f.publish(1);
  const root = (await f.registry.load(ROOT, 'material')).unwrap();
  const texture = (await f.registry.load(TEXTURE, 'texture')).unwrap();
  f.publish(2);
  const gate = f.pause();
  const pending = f.registry.reload(root, { conflict: 'overwrite' });
  await gate.started;
  if (target === 'root') f.registry.update(root, { values: { roughness: 0.7 } }).unwrap();
  else f.registry.update(texture, { data: new Uint8Array([9, 0, 0, 255]) }).unwrap();
  const before = runtimeAssets(f.registry).inspect();
  const observer = f.registry.observe().unwrap();
  gate.release();
  expect(await pending).toMatchObject({ ok: false, error: { code: 'asset-write-conflict' } });
  expect(f.registry.read(root).unwrap().values?.roughness).toBe(target === 'root' ? 0.7 : 0.1);
  expect(f.registry.read(texture).unwrap().data[0]).toBe(target === 'dependency' ? 9 : 1);
  observer.dispose();
  expect(runtimeAssets(f.registry).inspect()).toEqual(before);
});

it('rejects an invalid root after preparing new dependencies without publishing or leaking them', async () => {
  const f = fixture();
  f.publish(1);
  const root = (await f.registry.load(ROOT, 'material')).unwrap();
  const before = runtimeAssets(f.registry).inspect();
  const origin = f.registry.sourceOf(root);
  f.publish(2, { invalidRoot: true, newDependency: true });
  const observer = f.registry.observe().unwrap();
  expect((await f.registry.reload(root, { conflict: 'reject' })).ok).toBe(false);
  expect(observer.read().unwrap().changes).toHaveLength(0);
  observer.dispose();
  expect(runtimeAssets(f.registry).inspect()).toEqual(before);
  expect(f.registry.sourceOf(root)).toEqual(origin);
  expect(f.registry.read(root).unwrap().values?.roughness).toBe(0.1);
});

it.each([
  'abort',
  'source',
  'dispose',
  'publication',
] as const)('fences pending adoption after %s replacement', async (action) => {
  const f = fixture();
  f.publish(1);
  const root = (await f.registry.load(ROOT, 'material')).unwrap();
  f.publish(2);
  const gate = f.pause();
  const controller = new AbortController();
  const pending = f.registry.reload(root, { conflict: 'overwrite', signal: controller.signal });
  await gate.started;
  if (action === 'abort') controller.abort();
  else if (action === 'source') f.registry.setCatalogSource(f.source);
  else if (action === 'dispose') f.registry.dispose();
  else f.publish(3);
  gate.release();
  expect((await pending).ok).toBe(false);
  if (action !== 'dispose') expect(f.registry.read(root).unwrap().values?.roughness).toBe(0.1);
});

it('keeps adopted runtime content when its source disappears and reports the failed reload', async () => {
  const f = fixture();
  f.publish(1);
  const root = (await f.registry.load(ROOT, 'material')).unwrap();
  const before = f.registry.sourceOf(root);
  f.remove();
  expect((await f.registry.reload(root, { conflict: 'reject' })).ok).toBe(false);
  expect(f.registry.read(root).unwrap().values?.roughness).toBe(0.1);
  expect(f.registry.sourceOf(root)).toEqual(before);
});

it('explicit reload refreshes only the requested producer closure without a hot subscription', async () => {
  const f = fixture(false, false);
  f.publish(1);
  const root = (await f.registry.load(ROOT, 'material')).unwrap();
  const texture = (await f.registry.load(TEXTURE, 'texture')).unwrap();
  expect(f.enumerations()).toBe(1);
  f.publish(2);
  const held = (await f.registry.load(ROOT, 'material')).unwrap();
  expect(held).toBe(root);
  f.registry.release(held).unwrap();
  expect(f.requests).toEqual([]);
  expect(f.registry.read(root).unwrap().values?.roughness).toBe(0.1);
  (await f.registry.reload(root, { conflict: 'reject' })).unwrap();
  expect(f.registry.read(root).unwrap().values?.roughness).toBe(0.2);
  expect(f.registry.read(texture).unwrap().data[0]).toBe(2);
  expect(f.requests).toEqual([ROOT, TEXTURE]);
  expect(f.enumerations()).toBe(1);
  const observer = f.registry.observe().unwrap();
  (await f.registry.reload(root, { conflict: 'reject' })).unwrap();
  expect(observer.read().unwrap().changes).toEqual([]);
  observer.dispose();
});

it('reloads a new publication while the source observation clock remains unchanged', async () => {
  const f = fixture(false, false);
  f.publish(1, { sourceClock: 1 });
  const root = (await f.registry.load(ROOT, 'material')).unwrap();
  f.publish(2, { sourceClock: 1 });
  (await f.registry.reload(root, { conflict: 'reject' })).unwrap();
  expect(f.registry.read(root).unwrap().values?.roughness).toBe(0.2);
});

it('rejects changed payloads that reuse a publication generation', async () => {
  const f = fixture(false, false);
  f.publish(1, { sourceClock: 1 });
  const root = (await f.registry.load(ROOT, 'material')).unwrap();
  f.publish(2, { sourceClock: 2, publicationGeneration: 1 });
  expect((await f.registry.reload(root, { conflict: 'reject' })).ok).toBe(false);
  expect(f.registry.read(root).unwrap().values?.roughness).toBe(0.1);
});
