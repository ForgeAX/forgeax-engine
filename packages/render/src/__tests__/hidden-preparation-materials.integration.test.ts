import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { MeshFilter, MeshRenderer, Visibility, VisibilityStateValue } from '../components';
import { Materials } from '../materials';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { encodeRenderPublication, renderPublicationTransfers } from '../publication/record';
import type { RenderResourceScope } from '../publication/resource-scope';
import { validateRenderables } from '../record/fold-buckets';
import type { RenderSystemInternals } from '../record/render-context';
import { extractFrames } from '../render-system-extract-tail';
import { meshDrawSnapshot } from '../scene/mesh-draw';
import { PersistentRenderScene } from '../scene/render-scene';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

// A hidden preparePipelines row whose slot resolves to the Mesh default must
// keep that material accepted on its own: a visible draw sharing it may leave
// (or never exist), and the frame then failed with "Geometry preparation has
// no accepted material".
it.each([
  [false, 'despawned'],
  [true, 'despawned'],
  [false, 'absent'],
  [true, 'absent'],
] as const)('hidden preparation keeps its Mesh-default material accepted (worker=%s, visible holder %s)', (worker, holderCase) => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const red = assets.create(Materials.unlit([1, 0, 0, 1])).unwrap();
  const mesh = assets
    .create({ ...BUILTIN_CUBE, materialSlots: [{ slotName: 'first', defaultMaterial: red }] })
    .unwrap();
  const holder =
    holderCase === 'despawned'
      ? world
          .spawn(
            { component: Transform, data: {} },
            { component: MeshFilter, data: { assetHandle: mesh } },
            { component: MeshRenderer, data: { materials: [] } },
          )
          .unwrap()
      : undefined;
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [], preparePipelines: true } },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
  const scene = new PersistentRenderScene({ assets });
  const caches = scene.materialSnapshotCacheStore();
  const lease = createRenderReadLease(world);
  const identity = { source: 'hidden-preparation', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const draw = () => {
    world.update(0).unwrap();
    if (worker) {
      const candidate = publisher.prepare(0).unwrap();
      const packet = structuredClone(candidate.packet);
      candidate.accept();
      scene.consumePublication(receiver.accept(encodeRenderPublication(packet)).unwrap());
      publisher
        .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
        .unwrap();
      return;
    }
    scene.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      assets,
      (request) =>
        extractFrames([world], 0, assets, caches, { cull: 'none', renderables: request }),
      [lease],
    );
  };
  // record/frame.ts validates every pipelinePreparation row against the fixed
  // frame materials; only GPU mesh residency is outside this CPU test.
  const validatePreparation = (stage: string) => {
    const projection = scene.shadowCasterProjection();
    if (projection === undefined) throw new Error('missing scene projection');
    const rows = [...projection.renderables].filter((row) => row.pipelinePreparation !== undefined);
    expect(rows).toHaveLength(1);
    const accepted = rows.map((row) =>
      projection.content.materials.get(meshDrawSnapshot(row, projection.content.meshes).material),
    );
    expect(
      accepted.map((material) => material?.snapshot.materialHandle),
      stage,
    ).toEqual([red]);
    const scope = {
      resolveAsset: () => ({ ok: true, value: BUILTIN_CUBE }),
    } as unknown as RenderResourceScope;
    const internals = {
      gpuStore: { getMeshGpuHandles: () => ({ layoutProjection: { attributes: [] } }) },
      errorRegistry: { fire: () => {} },
    } as unknown as RenderSystemInternals;
    const validated = validateRenderables(
      internals,
      scope,
      [scope],
      undefined as never,
      {} as never,
      rows,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      projection.content.materials,
      projection.content.meshes,
    );
    expect(validated).toHaveLength(1);
  };
  try {
    draw();
    validatePreparation('initial');
    if (holder !== undefined) {
      world.despawn(holder).unwrap();
      draw();
      validatePreparation('after holder despawn');
    }
  } finally {
    publisher.dispose();
    receiver.dispose();
    scene.dispose();
    lease.dispose();
    assets.dispose();
  }
});
