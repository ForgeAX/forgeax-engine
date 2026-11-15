import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { type Asset, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  createRenderFeatureHost,
  type RenderFeatureFrameInput,
  type RenderFeatureHost,
} from '../features/host';
import { captureFeatureSourceAssetVersion } from '../features/source';
import type { RenderFeature } from '../features/types';

function texture(fill: number): Asset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(16).fill(fill),
  };
}

function input(worlds: readonly World[], frameNumber: number): RenderFeatureFrameInput {
  return {
    identity: 'asset-owner-view',
    render: true,
    world: worlds[0],
    frameNumber,
    caps: {} as never,
  };
}

function prepare(host: RenderFeatureHost, worlds: readonly World[], frameNumber: number) {
  const opened = host.beginFrame([input(worlds, frameNumber)]);
  for (const feature of host.features) host.prepareFeature(opened, feature.identity);
  return host.finishFrame(opened);
}

function singleAssetFeature(
  handle: number,
  onValue: (value: Asset) => void,
  shouldRead: () => boolean = () => true,
  captured?: () => boolean,
): RenderFeature<{ handle: number; revision?: number } | undefined> {
  return {
    identity: 'asset-owner-test-feature',
    extract: (context) => {
      if (!shouldRead()) return ok(undefined);
      if (!captured?.()) return ok({ handle });
      const reference = captureFeatureSourceAssetVersion(context, handle, {
        revision: 700,
        value: texture(7),
      }).unwrap();
      return ok({ handle, revision: reference.revision });
    },
    assetDependencies: (data) => (data === undefined ? [] : [data.handle]),
    plan: (data, context) => {
      if (data !== undefined) {
        const reference = context.resolveAsset?.(data.handle, data.revision);
        if (reference === undefined || !reference.ok)
          throw new Error('test feature asset version was unavailable');
        onValue(reference.value);
      }
      return ok({ work: [] });
    },
  };
}

it('reuses a current feature pin, then releases it before a one-snapshot replacement', () => {
  const assets = new AssetRegistry({ limits: { maxSnapshots: 1 } });
  const world = new World({ assets });
  const registry = runtimeAssetRegistry(assets);
  const records = runtimeAssets(assets);
  const handle = registry.create(texture(1)).unwrap();
  const unrelated = registry.create(texture(2)).unwrap();
  const values: Asset[] = [];
  let read = true;
  const feature = singleAssetFeature(
    handle,
    (value) => values.push(value),
    () => read,
  );
  const host = createRenderFeatureHost([feature]).unwrap();

  try {
    const first = prepare(host, [world], 1);
    expect(first.frame.errors).toEqual([]);
    expect(records.inspect().snapshots).toBe(1);
    host.abortFrame(first);
    expect(records.inspect().snapshots).toBe(1);

    registry.update(unrelated, { data: new Uint8Array(16).fill(3) }).unwrap();
    const stable = prepare(host, [world], 2);
    expect(stable.frame.errors).toEqual([]);
    host.abortFrame(stable);
    expect(values[1]).toBe(values[0]);
    expect(records.inspect().snapshots).toBe(1);

    registry.update(handle, { data: new Uint8Array(16).fill(9) }).unwrap();
    const replacement = prepare(host, [world], 3);
    expect(replacement.frame.errors).toEqual([]);
    host.abortFrame(replacement);
    expect(values[2]).not.toBe(values[1]);
    expect((values[2] as Extract<Asset, { kind: 'texture' }>).data[0]).toBe(9);
    expect(records.inspect().snapshots).toBe(1);

    read = false;
    const unused = prepare(host, [world], 4);
    expect(unused.frame.errors).toEqual([]);
    host.abortFrame(unused);
    expect(records.inspect()).toMatchObject({ snapshots: 0, snapshotBytes: 0 });
  } finally {
    host.dispose();
    assets.dispose();
  }
});

it('keeps an unsettled old frame lease alive while a one-snapshot replacement waits', () => {
  const assets = new AssetRegistry({ limits: { maxSnapshots: 1 } });
  const world = new World({ assets });
  const registry = runtimeAssetRegistry(assets);
  const records = runtimeAssets(assets);
  const handle = registry.create(texture(1)).unwrap();
  const feature = singleAssetFeature(handle, () => {});
  const host = createRenderFeatureHost([feature]).unwrap();

  try {
    const inFlight = prepare(host, [world], 1);
    expect(inFlight.frame.errors).toEqual([]);
    registry.update(handle, { data: new Uint8Array(16).fill(2) }).unwrap();

    const waiting = prepare(host, [world], 2);
    expect(waiting.frame.errors.length).toBeGreaterThan(0);
    host.abortFrame(waiting);
    expect(records.inspect().snapshots).toBe(1);

    host.abortFrame(inFlight);
    expect(records.inspect()).toMatchObject({ snapshots: 0, snapshotBytes: 0 });
    const retried = prepare(host, [world], 3);
    expect(retried.frame.errors).toEqual([]);
    host.abortFrame(retried);
    expect(records.inspect().snapshots).toBe(1);
  } finally {
    host.dispose();
    assets.dispose();
  }
});

it('keeps single-World owners across reorder and retires the replaced World host', () => {
  const worlds = [
    new World({ assets: new AssetRegistry() }),
    new World({ assets: new AssetRegistry() }),
    new World({ assets: new AssetRegistry() }),
  ];
  const handles = new Map<World, number>();
  for (const [index, world] of worlds.entries())
    handles.set(
      world,
      runtimeAssetRegistry(world.assets)
        .create(texture(index + 1))
        .unwrap(),
    );
  let activeWorlds: readonly World[] = [worlds[0] as World, worlds[1] as World];
  const values = new Map<World, Asset>();
  const hosts = new Map(
    worlds.map((world) => [
      world,
      createRenderFeatureHost([
        singleAssetFeature(handles.get(world) as number, (value) => values.set(world, value)),
      ]).unwrap(),
    ]),
  );
  const seen: Map<World, Asset>[] = [];
  const prepareWorlds = (frameNumber: number) => {
    for (const world of activeWorlds) {
      const host = hosts.get(world) as RenderFeatureHost;
      const batch = prepare(host, [world], frameNumber);
      expect(batch.frame.errors).toEqual([]);
      host.abortFrame(batch);
    }
    seen.push(new Map(values));
  };
  const records = worlds.map((world) => runtimeAssets(world.assets));

  try {
    prepareWorlds(1);
    activeWorlds = [worlds[1] as World, worlds[0] as World];
    prepareWorlds(2);
    expect(seen[1]?.get(worlds[0] as World)).toBe(seen[0]?.get(worlds[0] as World));
    expect(seen[1]?.get(worlds[1] as World)).toBe(seen[0]?.get(worlds[1] as World));
    expect(records.map((owner) => owner.inspect().snapshots)).toEqual([1, 1, 0]);

    activeWorlds = [worlds[2] as World, worlds[1] as World];
    hosts
      .get(worlds[0] as World)
      ?.dispose()
      .unwrap();
    prepareWorlds(3);
    expect(records.map((owner) => owner.inspect().snapshots)).toEqual([0, 1, 1]);
  } finally {
    for (const host of hosts.values()) host.dispose();
    for (const world of worlds) {
      runtimeAssetRegistry(world.assets).dispose();
    }
  }
});

it.each([
  'uninstall',
  'recover',
  'dispose',
] as const)('releases the feature-owned asset version on %s', (action) => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const handle = runtimeAssetRegistry(assets).create(texture(1)).unwrap();
  const feature = singleAssetFeature(handle, () => {});
  const host = createRenderFeatureHost([feature]).unwrap();
  const records = runtimeAssets(assets);
  try {
    host.abortFrame(prepare(host, [world], 1));
    expect(records.inspect().snapshots).toBe(1);
    if (action === 'uninstall') host.uninstall(feature).unwrap();
    else if (action === 'recover') host.recover({ frameNumber: 2, caps: {} as never }).unwrap();
    else host.dispose().unwrap();
    expect(records.inspect()).toMatchObject({ snapshots: 0, snapshotBytes: 0 });
  } finally {
    host.dispose();
    assets.dispose();
  }
});

it('does not persist a captured borrowed input as a feature pin', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const handle = runtimeAssetRegistry(assets).create(texture(1)).unwrap();
  const feature = singleAssetFeature(
    handle,
    () => {},
    () => true,
    () => true,
  );
  const host = createRenderFeatureHost([feature]).unwrap();
  const records = runtimeAssets(assets);
  try {
    const batch = prepare(host, [world], 1);
    expect(batch.frame.errors).toEqual([]);
    expect(records.inspect()).toMatchObject({ snapshots: 0, snapshotBytes: 0 });
    host.abortFrame(batch);
    expect(records.inspect()).toMatchObject({ snapshots: 0, snapshotBytes: 0 });
  } finally {
    host.dispose();
    assets.dispose();
  }
});

it('keeps a supplied accepted resolver authoritative without acquiring local pins', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const handle = runtimeAssetRegistry(assets).create(texture(1)).unwrap();
  const accepted = texture(4);
  const values: Asset[] = [];
  const host = createRenderFeatureHost([
    singleAssetFeature(handle, (value) => values.push(value)),
  ]).unwrap();
  try {
    const opened = host.beginFrame([{ ...input([world], 1), resolveAsset: () => ok(accepted) }]);
    for (const feature of host.features) host.prepareFeature(opened, feature.identity);
    const batch = host.finishFrame(opened);
    expect(batch.frame.errors).toEqual([]);
    expect(values).toEqual([accepted]);
    expect(runtimeAssets(assets).inspect()).toMatchObject({ snapshots: 0, snapshotBytes: 0 });
    host.abortFrame(batch);
  } finally {
    host.dispose();
    assets.dispose();
  }
});

it('retires a pin when a later source extraction fails before planning', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const handle = runtimeAssetRegistry(assets).create(texture(1)).unwrap();
  const feature = singleAssetFeature(handle, () => {});
  const host = createRenderFeatureHost([feature]).unwrap();
  try {
    host.abortFrame(prepare(host, [world], 1));
    expect(runtimeAssets(assets).inspect().snapshots).toBe(1);
    feature.extract = () => {
      throw new Error('source extraction rejected');
    };
    const failed = prepare(host, [world], 2);
    expect(failed.frame.errors.map((error) => error.code)).toEqual(['render-feature-stage-failed']);
    expect(runtimeAssets(assets).inspect()).toMatchObject({ snapshots: 0, snapshotBytes: 0 });
    host.abortFrame(failed);
  } finally {
    host.dispose();
    assets.dispose();
  }
});
