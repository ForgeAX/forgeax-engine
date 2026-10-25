import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { DEFAULT_SPRITE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { assert, expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer, SpriteRegionOverride } from '../components';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { encodeRenderPublication, renderPublicationTransfers } from '../publication/record';
import { worldRenderResources } from '../publication/resource-scope';
import { buildDispatchPlan } from '../record/fold-buckets';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';

const BUILTIN_QUAD = createPrimitiveMesh('quad').unwrap();

it.each([
  'local',
  'worker',
] as const)('keeps sprite UVs independent of shared material adoption (%s)', (mode) => {
  const assets = new AssetRegistry();
  assets.shaderRegistry.installMaterialArtifact('forgeax::sprite', {
    source: 'fn main() {}',
    paramSchema: DEFAULT_SPRITE_PARAM_SCHEMA,
  });
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const mesh = assets.create(BUILTIN_QUAD).unwrap();
  const material = assets
    .create({
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::sprite' },
          renderState: { tags: { LightMode: 'Forward' } },
        },
      ],
      values: {
        colorTint: [1, 0, 0, 1],
        region: [0, 0, 1, 1],
        flipX: 0,
        flipY: 0,
        slicesAndMode: [0, 0, 0, 0],
      },
    })
    .unwrap();
  world
    .spawn({ component: Transform, data: { pos: [0, 0, 5] } }, { component: Camera, data: {} })
    .unwrap();
  for (let index = 0; index < 128; index++)
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
        {
          component: SpriteRegionOverride,
          data: { region: [index % 2 === 0 ? 0 : 0.5, 0, 0.5, 1] },
        },
      )
      .unwrap();
  const lease = createRenderReadLease(world);
  const device = new RhiNullDevice(
    new RhiNullQueue(),
    (bookkeeper, owner) => new RhiNullCommandEncoder(bookkeeper, owner),
  );
  const scene = new PersistentRenderScene({ assets, getDevice: () => device });
  const caches = scene.materialSnapshotCacheStore();
  const owner = { cameraOwner: 0, resourceOwner: 0 };
  const identity = { source: 'sprite-edit', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  let extractions = 0;
  let upserts = 0;
  const draw = () => {
    world.update(0).unwrap();
    if (mode === 'worker') {
      const candidate = publisher.prepare(0).unwrap();
      const packet = structuredClone(candidate.packet);
      candidate.accept();
      upserts += packet.upserts.length;
      const accepted = receiver.accept(encodeRenderPublication(packet)).unwrap();
      const frame = scene.consumePublication(accepted);
      publisher
        .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
        .unwrap();
      return frame;
    }
    return scene.extractComposition(
      [world],
      owner,
      assets,
      (request) => {
        if (typeof request === 'object')
          for (const entities of request.entitiesByWorld) extractions += entities?.size ?? 0;
        else if (request === 'full') extractions += 128;
        return extractFrames([world], owner, assets, caches, {
          cull: 'none',
          retainHidden: true,
          renderables: request,
        });
      },
      [lease],
    );
  };
  try {
    draw();
    const before = draw();
    const first = before.renderables.at(0);
    assert(first);
    expect(new Set(before.renderables.map((row) => row.material)).size).toBe(1);
    const fixed = scene.shadowCasterProjection()?.content.materials;
    assert(fixed);
    const oldMaterial = fixed.get(first.material)?.snapshot;
    assert(oldMaterial);
    const oldDraw = oldMaterial;
    extractions = 0;
    upserts = 0;
    assets
      .update(material, {
        values: {
          colorTint: [0, 1, 0, 1],
          flipX: 1,
          flipY: 1,
          slicesAndMode: [0.1, 0.1, 0.1, 0.1],
        },
      })
      .unwrap();
    const after = draw();
    expect(extractions).toBe(0);
    expect(upserts).toBe(0);
    expect(after.renderables).toBe(before.renderables);
    const accepted = scene.shadowCasterProjection()?.content.materials;
    assert(accepted);
    const value = accepted.get(first.material)?.snapshot;
    assert(value);
    const current = value;
    expect(current.paramSnapshot?.colorTint).toEqual([0, 1, 0, 1]);
    expect(current.paramSnapshot?.flipX).toBe(1);
    expect(current.paramSnapshot?.flipY).toBe(1);
    expect(first.spriteRegion).toEqual([0, 0, 0.5, 1]);
    expect(current.paramSnapshot?.slicesAndMode).toEqual([0.1, 0.1, 0.1, 0.1]);
    expect(oldDraw.paramSnapshot?.colorTint).toEqual([1, 0, 0, 1]);
    expect(oldDraw.paramSnapshot?.flipX).toBe(0);
    expect(fixed.get(first.material)?.snapshot ?? oldMaterial).toBe(oldDraw);
    // Every instance region consumes the same shared root UBO.
    const rows = after.renderables.map((source, renderableIndex) => ({
      source,
      renderableIndex,
      meshSlot: renderableIndex,
      world,
      mesh: { submeshes: [{ materialSlot: 0 }] },
    })) as unknown as Parameters<typeof buildDispatchPlan>[1];
    const plan = buildDispatchPlan(
      {
        device,
        metrics: { increment: () => {} },
        meshSsboState: { meshSlotCount: 256, materialSlotCount: 256 },
      } as never,
      rows,
      [],
      [],
      [],
      undefined,
      false,
      { bindings: [], worlds: [world].map(worldRenderResources), frame: accepted },
    );
    expect(plan.materialSlots).toHaveLength(1);
    expect(plan.materialSlots[0]).toBe(value);
  } finally {
    scene.dispose();
    publisher.dispose();
    receiver.dispose();
    lease.dispose();
    assets.dispose();
  }
});
