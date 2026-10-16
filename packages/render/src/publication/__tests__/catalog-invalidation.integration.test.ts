import { AssetRegistry, RuntimeMeshVertices } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { MeshFilter, MeshRenderer, Visibility, VisibilityStateValue } from '../../components';
import { Materials } from '../../materials';
import { PersistentRenderScene } from '../../scene/render-scene';
import { renderPublicationAssetTransfers, renderPublicationTransfers } from '../contract';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';

function fixture() {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const identity = { source: 'catalog-invalidation', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const scene = new PersistentRenderScene();
  const spawn = (mesh: MeshAsset, hidden = false) => {
    const handle = world.allocSharedRef('MeshAsset', mesh);
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: handle } },
        { component: MeshRenderer, data: {} },
        ...(hidden
          ? [{ component: Visibility, data: { state: VisibilityStateValue.hidden } }]
          : []),
      )
      .unwrap();
    return { entity, handle };
  };
  const publish = () => {
    world.update(0).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: [
        ...renderPublicationTransfers(candidate.packet),
        ...renderPublicationAssetTransfers(candidate.packet),
      ],
    });
    candidate.accept();
    const accepted = receiver.accept(packet).unwrap();
    const frame = scene.consumePublication(accepted);
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    return { packet, frame, resources: accepted.resources };
  };
  return {
    world,
    assets,
    identity,
    publisher,
    receiver,
    scene,
    spawn,
    publish,
    dispose() {
      publisher.dispose();
      receiver.dispose();
      scene.dispose();
    },
  };
}

it('retains hidden World meshes while unrelated Catalog admissions refresh their snapshots', () => {
  const f = fixture();
  try {
    const meshes = Array.from({ length: 32 }, (_, index) =>
      f.spawn(createBoxGeometry(1 + index / 100, 1, 1).unwrap(), true),
    );
    const discarded = f.publisher.prepare(0).unwrap();
    expect(discarded.packet.baseline).toBe(true);
    discarded.discard();
    const first = f.publish();
    expect(first.packet.assets.filter((row) => row.value.kind === 'mesh')).toHaveLength(
      meshes.length,
    );
    expect(first.frame.renderables).toHaveLength(0);
    const retained = meshes.map(({ handle }) =>
      first.resources.resolveAsset<MeshAsset>(handle).unwrap(),
    );
    for (let index = 0; index < 6; index++) {
      f.assets.catalog(`unrelated-material-${index}`, Materials.unlit([1, 0, 0, 1])).unwrap();
      const next = f.publish();
      expect(next.packet.templates).toHaveLength(meshes.length);
      expect(next.packet.assets.filter((row) => row.value.kind === 'mesh')).toHaveLength(0);
      expect(next.frame.renderables).toHaveLength(0);
      for (const [offset, mesh] of meshes.entries())
        expect(next.resources.resolveAsset<MeshAsset>(mesh.handle).unwrap()).toBe(retained[offset]);
    }
    const shownMesh = meshes[0];
    if (shownMesh === undefined) throw new Error('expected a hidden mesh');
    f.world.removeComponent(shownMesh.entity, Visibility).unwrap();
    const shown = f.publish();
    expect(shown.frame.renderables).toHaveLength(1);
    expect(shown.packet.assets.filter((row) => row.value.kind === 'mesh')).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

it('moves owned mesh buffers without detaching source or recycled receiver residency', () => {
  const f = fixture();
  try {
    const box = createBoxGeometry(2, 3, 4).unwrap();
    const mesh = {
      ...box,
      // Preserve aliased views as one transfer rather than duplicate buffers.
      attributes: { ...box.attributes, position: box.vertices.subarray(0) },
    };
    const sourceBytes = mesh.vertices.slice();
    const { handle } = f.spawn(mesh);
    f.world.update(0).unwrap();
    const candidate = f.publisher.prepare(0).unwrap();
    const published = candidate.packet.assets.find((row) => row.handle === handle)?.value;
    if (published?.kind !== 'mesh') throw Error('Missing owned mesh publication');
    expect(published.vertices.buffer).not.toBe(mesh.vertices.buffer);
    const moved = renderPublicationAssetTransfers(candidate.packet);
    expect(new Set(moved).size).toBe(moved.length);
    expect(moved).toContain(published.vertices.buffer);
    const packet = structuredClone(candidate.packet, {
      transfer: [...renderPublicationTransfers(candidate.packet), ...moved],
    });
    expect(published.vertices.byteLength).toBe(0);
    expect(mesh.vertices).toEqual(sourceBytes);
    candidate.accept();
    const accepted = f.receiver.accept(packet).unwrap();
    const resident = accepted.resources.resolveAsset<MeshAsset>(handle).unwrap();
    expect(resident.vertices).toEqual(sourceBytes);
    expect(resident.attributes.position).toBeInstanceOf(Float32Array);
    expect((resident.attributes.position as Float32Array).buffer).toBe(resident.vertices.buffer);
    const returned = structuredClone(renderPublicationTransfers(packet), {
      transfer: renderPublicationTransfers(packet),
    });
    f.publisher.recycle(packet.revision, returned).unwrap();
    expect(resident.vertices).toEqual(sourceBytes);
    expect(mesh.vertices).toEqual(sourceBytes);
  } finally {
    f.dispose();
  }
});

it('publishes late Catalog materials and newly referenced meshes', () => {
  const f = fixture();
  try {
    const guid = AssetGuid.random();
    const mesh = {
      ...createBoxGeometry(1, 1, 1).unwrap(),
      materialSlots: [{ slotName: 'surface', defaultMaterial: guid }],
    };
    const { entity, handle } = f.spawn(mesh);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(f.publish().frame.renderables).toHaveLength(0);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('mesh-default-not-ready'),
        expect.objectContaining({ code: 'load-failed' }),
      );
    } finally {
      error.mockRestore();
    }
    f.assets.catalog(guid, Materials.unlit([0, 1, 0, 1])).unwrap();
    const material = f.publish();
    expect(material.packet.assets.some((row) => row.handle === handle)).toBe(true);
    expect(material.packet.assets.some((row) => row.guid === AssetGuid.format(guid))).toBe(true);
    expect(material.frame.renderables[0]?.material.baseColor).toEqual(new Float32Array([0, 1, 0]));
    f.assets.catalog('unrelated-material', Materials.unlit([1, 0, 0, 1])).unwrap();
    expect(f.publish().packet.assets.some((row) => row.handle === handle)).toBe(false);

    const replacement = f.world.allocSharedRef('MeshAsset', {
      ...createBoxGeometry(2, 1, 1).unwrap(),
      materialSlots: mesh.materialSlots,
    });
    f.world.set(entity, MeshFilter, { assetHandle: replacement }).unwrap();
    const next = f.publish();
    expect(next.packet.assets.some((row) => row.handle === replacement)).toBe(true);
    expect(next.packet.retiredAssets).toContain(handle);
    expect(next.frame.renderables[0]?.assetHandle).toBe(replacement);
    expect(next.frame.renderables[0]?.material.baseColor).toEqual(new Float32Array([0, 1, 0]));
  } finally {
    f.dispose();
  }
});

it('retains Catalog-owned same-handle material-slot reloads', () => {
  const f = fixture();
  try {
    const guid = AssetGuid.random();
    const mesh = f.assets.catalog(guid, createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const { handle } = f.spawn(mesh);
    f.publish();
    f.assets.catalog(guid, { ...mesh, materialSlots: [{ slotName: 'reloaded' }] }).unwrap();
    f.assets.adoptReloadedMeshMaterialSlots(AssetGuid.format(guid), mesh).unwrap();
    const next = f.publish();
    expect(next.packet.assets.some((row) => row.handle === handle)).toBe(true);
    expect(next.resources.resolveAsset<MeshAsset>(handle).unwrap().materialSlots).toEqual([
      { slotName: 'reloaded' },
    ]);
    expect(next.resources.resolveAsset<MeshAsset>(handle).unwrap().vertices).toEqual(mesh.vertices);
  } finally {
    f.dispose();
  }
});

it('retries explicit same-handle geometry edits and starts replacement epochs with a full baseline', () => {
  const f = fixture();
  try {
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const { handle } = f.spawn(mesh);
    f.publish();
    const vertices = new Float32Array(mesh.vertices);
    vertices[0] = Number(vertices[0]) + 0.25;
    const content = f.world
      .spawn({ component: RuntimeMeshVertices, data: { asset: handle, vertices } })
      .unwrap();
    f.assets.catalog('unrelated-material', Materials.unlit([1, 0, 0, 1])).unwrap();
    const discarded = f.publisher.prepare(0).unwrap();
    expect(discarded.packet.invalidatedAssets).toContain(handle);
    discarded.discard();
    const changed = f.publish();
    expect(changed.packet.assets.some((row) => row.handle === handle)).toBe(true);
    expect(changed.resources.resolveAsset<MeshAsset>(handle).unwrap().vertices[0]).toBe(
      vertices[0],
    );
    f.world.despawn(content).unwrap();
    const restored = f.publish();
    expect(restored.packet.assets.some((row) => row.handle === handle)).toBe(true);
    expect(restored.resources.resolveAsset<MeshAsset>(handle).unwrap().vertices[0]).toBe(
      mesh.vertices[0],
    );

    const identity = { ...f.identity, epoch: 2 };
    const publisher = createRenderPublisher(f.world, f.assets, identity);
    const receiver = new RenderPublicationReceiver(identity);
    try {
      expect(receiver.accept(restored.packet).ok).toBe(false);
      const candidate = publisher.prepare(0).unwrap();
      expect(candidate.packet.baseline).toBe(true);
      expect(candidate.packet.assets.some((row) => row.handle === handle)).toBe(true);
      const packet = structuredClone(candidate.packet, {
        transfer: renderPublicationTransfers(candidate.packet),
      });
      candidate.accept();
      expect(
        receiver.accept(packet).unwrap().resources.resolveAsset<MeshAsset>(handle).unwrap()
          .vertices,
      ).toEqual(mesh.vertices);
      publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    } finally {
      publisher.dispose();
      receiver.dispose();
    }
  } finally {
    f.dispose();
  }
});

it('keeps runtime mesh content resident through unrelated component migration', () => {
  const f = fixture();
  try {
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const { handle } = f.spawn(mesh);
    const vertices = mesh.vertices.slice();
    vertices[0] = Number(vertices[0]) + 0.25;
    const content = f.world
      .spawn({ component: RuntimeMeshVertices, data: { asset: handle, vertices } })
      .unwrap();
    const first = f.publish();
    const admitted = first.resources.resolveAsset<MeshAsset>(handle).unwrap();
    // Membership changes, but the content component retains its values.
    f.world
      .addComponent(content, {
        component: Visibility,
        data: { state: VisibilityStateValue.hidden },
      })
      .unwrap();
    const migrated = f.publish();
    expect(migrated.packet.invalidatedAssets).not.toContain(handle);
    expect(migrated.packet.assets.some((row) => row.handle === handle)).toBe(false);
    expect(migrated.resources.resolveAsset<MeshAsset>(handle).unwrap()).toBe(admitted);
    // Actual same-handle content writes and removal must still publish.
    const changedVertices = vertices.slice();
    changedVertices[0] = Number(changedVertices[0]) + 0.5;
    f.world
      .set(content, RuntimeMeshVertices, { asset: handle, vertices: changedVertices })
      .unwrap();
    const changed = f.publish();
    expect(changed.packet.invalidatedAssets).toContain(handle);
    expect(changed.resources.resolveAsset<MeshAsset>(handle).unwrap().vertices[0]).toBe(
      changedVertices[0],
    );
    f.world.removeComponent(content, RuntimeMeshVertices).unwrap();
    const restored = f.publish();
    expect(restored.packet.invalidatedAssets).toContain(handle);
    expect(restored.resources.resolveAsset<MeshAsset>(handle).unwrap().vertices[0]).toBe(
      mesh.vertices[0],
    );
  } finally {
    f.dispose();
  }
});
