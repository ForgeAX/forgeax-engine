import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import type { AssetHandle } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { projectCaptureScene } from '../capture/scene-projection';
import { Camera, MeshFilter, MeshRenderer, Visibility, VisibilityStateValue } from '../components';
import { Materials } from '../materials';
import { renderPublicationTransfers } from '../publication/contract';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';
import { subsurfaceDemand } from '../subsurface/demand';
import { SubsurfaceSelection } from '../subsurface/selection';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

function fixture(worker: boolean) {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const mesh = assets.create(BUILTIN_CUBE).unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: Math.PI / 3, aspect: 1 } },
    )
    .unwrap();
  const scene = new PersistentRenderScene({ assets });
  const lease = createRenderReadLease(world);
  const caches = scene.materialSnapshotCacheStore();
  const identity = { source: 'managed-subsurface', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  let extractions = 0;
  let upserts = 0;
  return {
    assets,
    world,
    camera,
    scene,
    create(radius: number): AssetHandle<'material'> {
      return assets
        .create(
          Materials.standard({
            baseColor: [1, 1, 1, 1],
            subsurfaceRadius: [radius, 2, 1],
            subsurfaceWeight: 1,
          }),
        )
        .unwrap();
    },
    bind(material: AssetHandle<'material'>, x = 0, hidden = false) {
      return world
        .spawn(
          { component: Transform, data: { pos: [x, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
          {
            component: Visibility,
            data: { state: hidden ? VisibilityStateValue.hidden : VisibilityStateValue.visible },
          },
        )
        .unwrap();
    },
    draw() {
      world.update(0).unwrap();
      if (worker) {
        const candidate = publisher.prepare(0).unwrap();
        const packet = structuredClone(candidate.packet);
        candidate.accept();
        upserts += packet.upserts.length;
        const frame = scene.consumePublication(receiver.accept(packet).unwrap());
        publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
        return frame;
      }
      return scene.extractComposition(
        [world],
        { cameraOwner: 0, resourceOwner: 0 },
        assets,
        (request) => {
          if (request === 'full') extractions++;
          else if (typeof request === 'object')
            for (const entities of request.entitiesByWorld) extractions += entities?.size ?? 0;
          return extractFrames([world], 0, assets, undefined, caches, {
            cull: 'none',
            retainHidden: true,
            renderables: request,
          });
        },
        [lease],
      );
    },
    work() {
      return { extractions, upserts };
    },
    dispose() {
      publisher.dispose();
      receiver.dispose();
      scene.dispose();
      lease.dispose();
      assets.dispose();
    },
  };
}

it.each([
  false,
  true,
])('updates view demand without enumerating unchanged bindings (worker=%s)', (worker) => {
  const f = fixture(worker);
  try {
    const materials = Array.from({ length: 17 }, (_, index) =>
      f.create(index === 16 ? 1 : 1 + index / 2),
    );
    for (const material of materials) f.bind(material);
    f.draw();
    const before = f.draw();
    const content = f.scene.shadowCasterProjection()?.content;
    assert(content);
    expect(content.subsurface.admitted).toBe(16);
    const work = f.work();
    const membership = vi.spyOn(SubsurfaceSelection.prototype, 'add');
    try {
      const edited = materials[16];
      assert(edited);
      f.assets.update(edited, { values: { subsurfaceRadius: [12, 2, 1] } }).unwrap();
      const after = f.draw();
      expect(after.renderables).toBe(before.renderables);
      expect(after.dispatch).toBe(before.dispatch);
      expect(membership).not.toHaveBeenCalled();
      expect(f.work()).toEqual(work);
      const demand = f.scene.shadowCasterProjection()?.content.subsurface.admitted;
      assert(demand !== undefined);
      expect(() => subsurfaceDemand(demand)).toThrow('at most 16');
      expect(content.subsurface.admitted).toBe(16);
      f.assets.update(edited, { values: { subsurfaceRadius: [1, 2, 1] } }).unwrap();
      f.draw();
      expect(f.scene.shadowCasterProjection()?.content.subsurface.admitted).toBe(16);
      expect(membership).not.toHaveBeenCalled();
    } finally {
      membership.mockRestore();
    }
  } finally {
    f.dispose();
  }
});

it('keeps independent camera selections and the full capture source range', () => {
  const f = fixture(false);
  try {
    for (let index = 0; index < 32; index++)
      f.bind(f.create(0.1 + index / 3), index < 16 ? -100 : 100);
    f.world.set(f.camera, Transform, { pos: [-100, 0, 5] }).unwrap();
    const left = f.draw();
    const leftContent = f.scene.shadowCasterProjection()?.content;
    assert(leftContent);
    expect(left.renderables).toHaveLength(16);
    expect(leftContent.subsurface).toEqual({ admitted: 16, authorVisible: 32, source: 32 });
    expect(subsurfaceDemand(leftContent.subsurface.admitted)).toBe(true);
    f.world.set(f.camera, Transform, { pos: [100, 0, 5] }).unwrap();
    const right = f.draw();
    const projection = f.scene.shadowCasterProjection();
    assert(projection);
    expect(right.renderables).toHaveLength(16);
    expect(projection.content.subsurface.admitted).toBe(16);
    const capture = projectCaptureScene(projection, right.renderables, right.dispatch);
    expect(capture.renderables).toHaveLength(32);
    expect(() => subsurfaceDemand(projection.content.subsurface.authorVisible)).toThrow(
      'at most 16',
    );
    expect(leftContent.subsurface.admitted).toBe(16);
  } finally {
    f.dispose();
  }
});

it('keeps hidden unsupported materials out of display and author-visible capture selections', () => {
  const f = fixture(false);
  try {
    f.bind(f.create(2));
    const invalid = f.assets
      .create({
        kind: 'material',
        passes: [{ name: 'Forward', program: { module: 'game::unsupported-subsurface' } }],
        values: { subsurfaceRadius: [3, 2, 1], subsurfaceWeight: 1 },
      })
      .unwrap();
    f.bind(invalid, 0, true);
    const frame = f.draw();
    const projection = f.scene.shadowCasterProjection();
    assert(projection);
    expect(frame.renderables).toHaveLength(1);
    expect(projection.content.subsurface).toEqual({
      admitted: 1,
      authorVisible: 1,
      source: 'invalid-surface',
    });
    expect(subsurfaceDemand(projection.content.subsurface.admitted)).toBe(true);
    expect(() => subsurfaceDemand(projection.content.subsurface.source)).toThrow('opaque Deferred');
  } finally {
    f.dispose();
  }
});

it.each([
  false,
  true,
])('refreshes hidden source membership and author visibility independently (worker=%s)', (worker) => {
  const f = fixture(worker);
  try {
    f.bind(f.create(2));
    const hidden = f.bind(f.create(2), 0, true);
    f.draw();
    expect(f.scene.shadowCasterProjection()?.content.subsurface).toEqual({
      source: 1,
      authorVisible: 1,
      admitted: 1,
    });
    f.world.set(hidden, MeshRenderer, { materials: [f.create(3)] }).unwrap();
    f.draw();
    expect(f.scene.shadowCasterProjection()?.content.subsurface).toEqual({
      source: 2,
      authorVisible: 1,
      admitted: 1,
    });
    f.world.set(hidden, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    f.draw();
    expect(f.scene.shadowCasterProjection()?.content.subsurface).toEqual({
      source: 2,
      authorVisible: 2,
      admitted: 2,
    });
    f.world.set(hidden, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
    f.draw();
    expect(f.scene.shadowCasterProjection()?.content.subsurface).toEqual({
      source: 2,
      authorVisible: 1,
      admitted: 1,
    });
  } finally {
    f.dispose();
  }
});
