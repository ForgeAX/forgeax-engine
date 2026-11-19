import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { equirectContribution } from '@forgeax/engine-image';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { MeshFilter, MeshRenderer, SkyboxBackground } from '../components';
import { Materials } from '../materials';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { renderPublicationTransfers } from '../publication/record';
import { extractSource } from '../render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from '../scene/render-scene';
import { SceneComposition } from '../scene/scene-composition';
import { registerMaterialSystems } from '../world/material-systems';
import { beginRenderFrame, createRenderWorld, endRenderFrame } from '../world/render-world';
import { RenderSceneDelta, registerSceneSystem } from '../world/scene-systems';

function fixture() {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const lease = createRenderReadLease(world);
  const shared = new SceneComposition({ assets });
  const active = new PersistentRenderScene({}, shared);
  const texture = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array([0, 0, 0, 255]),
    })
    .unwrap();
  const follow = (view: PersistentRenderScene) =>
    view.extractComposition(
      world,
      assets,
      (request) => extractSource(world, assets, undefined, { renderables: request }),
      lease,
    );
  const update = (red: number) => {
    assets.update(texture, { data: new Uint8Array([red, 0, 0, 255]) }).unwrap();
    follow(active);
  };
  return {
    assets,
    world,
    texture,
    shared,
    active,
    follow,
    update,
    dispose() {
      active.dispose();
      shared.dispose();
      lease.dispose();
    },
  };
}

it('delivers same-handle texture edits while a retained view misses multiple advances', () => {
  const f = fixture();
  const changed = vi.fn();
  const sleeping = new PersistentRenderScene({ onViewAssetChange: changed }, f.shared);
  try {
    f.follow(sleeping);
    changed.mockClear();
    f.update(80);
    f.update(160);
    f.follow(sleeping);
    expect(changed.mock.calls.map((call) => call[1].handle)).toEqual([f.texture, f.texture]);
    f.follow(sleeping);
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    sleeping.dispose();
    f.dispose();
  }
});

it('keeps live consumers subscribed through view reset and GPU recovery, and unregisters retired views', () => {
  const f = fixture();
  const changed = vi.fn();
  f.follow(f.active);
  f.update(40);
  // A new view has no old private asset state requiring historical replay.
  const late = new PersistentRenderScene({ onViewAssetChange: changed }, f.shared);
  try {
    f.follow(late);
    expect(changed).not.toHaveBeenCalled();
    late.resetView();
    late.resetGpuForRecover();
    f.update(80);
    expect(changed).toHaveBeenCalledTimes(1);
    f.shared.invalidate();
    f.update(120);
    expect(changed).toHaveBeenCalledTimes(2);
    late.dispose();
    f.update(160);
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    late.dispose();
    f.dispose();
  }
});

it('delivers invalidation to sibling consumers before surfacing a consumer failure', () => {
  const f = fixture();
  f.follow(f.active);
  const failed = new Error('view consumer failed');
  const first = new PersistentRenderScene(
    {
      onViewAssetChange: () => {
        throw failed;
      },
    },
    f.shared,
  );
  const changed = vi.fn();
  const sibling = new PersistentRenderScene({ onViewAssetChange: changed }, f.shared);
  try {
    // Subscribe before the first extraction: even a view not yet drawn owns private consumers.
    expect(() => f.update(40)).toThrow(failed);
    expect(changed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ handle: f.texture }),
    );
    first.dispose();
    changed.mockClear();
    f.follow(f.active);
    expect(changed).toHaveBeenCalledTimes(1);
  } finally {
    first.dispose();
    sibling.dispose();
    f.dispose();
  }
});

it('notifies a sleeping publication view for same-handle texture changes without replay on follow', () => {
  const f = fixture();
  const material = f.assets
    .create(Materials.standard({ baseColor: [1, 1, 1, 1], baseColorTexture: f.texture }))
    .unwrap();
  const mesh = f.assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  f.world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  propagateTransforms(f.world).unwrap();
  const identity = { source: 'sleeping-view-assets', epoch: 1 };
  const publisher = createRenderPublisher(f.world, f.assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const changed = vi.fn();
  const sleeping = new PersistentRenderScene({ onViewAssetChange: changed }, f.shared);
  const publish = (view: PersistentRenderScene) => {
    const candidate = publisher.prepare(0).unwrap();
    const message = structuredClone(candidate.message, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const input = receiver.accept(message).unwrap();
    view.consumePublication(input);
    publisher.recycle(candidate.packet.revision, renderPublicationTransfers(message)).unwrap();
  };
  try {
    publish(sleeping);
    changed.mockClear();
    for (const red of [80, 160]) {
      f.assets.update(f.texture, { data: new Uint8Array([red, 0, 0, 255]) }).unwrap();
      publish(f.active);
    }
    expect(changed.mock.calls.filter((call) => call[1].handle === f.texture)).toHaveLength(2);
    publish(sleeping);
    expect(changed.mock.calls.filter((call) => call[1].handle === f.texture)).toHaveLength(2);
  } finally {
    sleeping.dispose();
    publisher.dispose();
    receiver.dispose();
    f.dispose();
  }
});

it('fences a later same-frame view resource frame against its own asset edits', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const lease = createRenderReadLease(world);
  const shared = new SceneComposition({});
  assets.installDecoder(equirectContribution.kind, equirectContribution.decoder);
  const views = Array.from({ length: 2 }, () => new PersistentRenderScene({}, shared));
  const sky = assets
    .create({
      kind: 'equirect',
      width: 4,
      height: 2,
      format: 'rgba16float',
      colorSpace: 'linear',
      data: new Uint8Array(64),
    })
    .unwrap();
  world.spawn({ component: SkyboxBackground, data: { equirect: sky } }).unwrap();
  // One renderer frame: view 0 owns the `render-scene` observation; every
  // view then follows it with its own resource frame.
  const renderWorld = createRenderWorld();
  const source = registerSceneSystem(renderWorld, shared, assets);
  registerMaterialSystems(renderWorld);
  const build = (request: PersistentRenderCandidateRequest) =>
    extractSource(world, assets, undefined, { renderables: request });
  let frame = 0;
  const draw = () => {
    source.staged = true;
    source.world = world;
    source.lease = lease;
    source.buildCandidateFrame = build;
    beginRenderFrame(renderWorld, ++frame);
    try {
      const adoption = renderWorld.getResource(RenderSceneDelta);
      views.forEach((view) => {
        view.followAdoption(adoption, build);
      });
    } finally {
      endRenderFrame(renderWorld);
    }
  };
  try {
    draw();
    const retained = views[1]?.compositionRetainedScene();
    expect(retained?.isSourceCurrent()).toBe(true);
    // A resource edit invalidates the held view through its source asset closure.
    assets.update(sky, { data: new Uint8Array(64).fill(1) }).unwrap();
    expect(retained?.isSourceCurrent()).toBe(false);
    draw();
    expect(retained?.isCurrent()).toBe(false);
  } finally {
    for (const view of views) view.dispose();
    shared.dispose();
    lease.dispose();
    assets.dispose();
  }
});
