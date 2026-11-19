import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  Camera,
  Instances,
  MeshFilter,
  MeshRenderer,
  Visibility,
  VisibilityStateValue,
} from '../../components';
import { Materials } from '../../materials';
import type { ExtractedFrame } from '../../render-system-extract';
import { extractSource } from '../../render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from '../../scene/render-scene';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import { renderPublicationTransfers } from '../record';
import { worldRenderResources } from '../resource-scope';

function facts(frame: ExtractedFrame) {
  return {
    cameras: frame.cameras.map((row) => ({
      entity: row.entityKey,
      world: [...row.world],
      exposure: row.exposure,
    })),
    rows: frame.renderables
      .map((row) => ({
        entity: row.entityKey,
        world: [...row.transform.world],
        visible: row.authorVisible !== false,
        color: [...row.material.snapshot.baseColor],
        instances: row.instances === undefined ? undefined : [...row.instances.transforms],
      }))
      .sort((a, b) => a.entity - b.entity),
  };
}
it('applies the same accepted edit sequence locally and through transferred records', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const geometry = createPrimitiveMesh('cube').unwrap();
  const mesh = assets.create(geometry).unwrap();
  const material = assets.create(Materials.standard({ baseColor: [1, 0, 0, 1] })).unwrap();
  const identity = { source: 'local-worker-changes', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const local = new PersistentRenderScene({ assets });
  const remote = new PersistentRenderScene({ assets });
  const lease = createRenderReadLease(world);

  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: Math.PI / 3 } },
    )
    .unwrap();
  const parent = world
    .spawn(
      { component: Transform, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.visible } },
    )
    .unwrap();
  const spawn = () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  let entity: EntityHandle = spawn();
  const build = (renderables: PersistentRenderCandidateRequest) =>
    extractSource(world, assets, local.materialSnapshotCacheStore(), {
      cull: 'none',
      retainHidden: true,
      renderables,
    });
  const compare = () => {
    world.update(1 / 60).unwrap();
    const direct = local.extractComposition(world, assets, build, lease);
    const candidate = publisher.prepare(0).unwrap();
    const message = structuredClone(candidate.message, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const accepted = receiver.accept(message).unwrap();
    const transported = remote.consumePublication(accepted);
    expect(facts(transported)).toEqual(facts(direct));
    const receivedMesh = accepted.resources.resolveAsset<MeshAsset>(mesh);
    if (world.hasComponent(entity, MeshFilter)) {
      expect([...receivedMesh.unwrap().vertices]).toEqual([
        ...worldRenderResources(world).resolveAsset<MeshAsset>(mesh).unwrap().vertices,
      ]);
    } else expect(receivedMesh.ok).toBe(false);
    publisher.recycle(accepted.packet.revision, renderPublicationTransfers(message)).unwrap();
    return facts(direct);
  };
  try {
    const initial = compare();
    world.set(entity, Transform, { pos: [2, 1, 0] }).unwrap();
    compare();
    world
      .addComponent(entity, { component: Instances, data: { transforms: new Float32Array(32) } })
      .unwrap();
    compare();
    world.set(entity, Instances, { transforms: new Float32Array(16).fill(1) }).unwrap();
    compare();
    world.removeComponent(entity, Instances).unwrap();
    compare();
    world.set(parent, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
    compare();
    world.removeComponent(parent, Visibility).unwrap();
    compare();
    assets.update(material, { values: { baseColor: [0, 1, 0, 1] } }).unwrap();
    compare();
    const vertices = new Float32Array(geometry.vertices.slice(0));
    vertices[0] = (vertices[0] ?? 0) + 0.25;
    assets.update(mesh, { vertices }).unwrap();
    compare();
    world.set(camera, Camera, { exposure: 2 }).unwrap();
    compare();
    const previous = entity;
    world.despawn(entity).unwrap();
    entity = spawn();
    expect(entity).not.toBe(previous);
    compare();
    world.despawn(entity).unwrap();
    compare();
    expect(initial.rows).toHaveLength(1);
    expect(initial.rows[0]?.color).toEqual([1, 0, 0]);
  } finally {
    lease.dispose();
    publisher.dispose();
    receiver.dispose();
    local.dispose();
    remote.dispose();
  }
});
