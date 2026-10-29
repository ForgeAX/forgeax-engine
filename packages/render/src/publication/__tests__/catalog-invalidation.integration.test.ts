import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { MeshFilter, MeshRenderer, Visibility, VisibilityStateValue } from '../../components';
import { Materials } from '../../materials';
import { PersistentRenderScene } from '../../scene/render-scene';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import {
  encodeRenderPublication,
  renderPublicationAssetTransfers,
  renderPublicationTransfers,
} from '../record';

function fixture() {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const identity = { source: 'catalog-invalidation', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const scene = new PersistentRenderScene({ assets });
  const spawn = (mesh: MeshAsset, hidden = false) => {
    const handle = assets.create(mesh).unwrap();
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
        ...renderPublicationTransfers(candidate.message),
        ...renderPublicationAssetTransfers(candidate.message),
      ],
    });
    candidate.accept();
    const accepted = receiver.accept(encodeRenderPublication(packet)).unwrap();
    const frame = scene.consumePublication(accepted);
    publisher
      .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
      .unwrap();
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
      publishRuntimeAssets(f.assets, [
        { guid: AssetGuid.format(AssetGuid.random()), asset: Materials.unlit([1, 0, 0, 1]) },
      ]);
      const next = f.publish();
      expect(next.packet.templates).toHaveLength(0);
      expect(next.packet.upserts).toHaveLength(0);
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
    const vertices = (box.attributes.position as Float32Array).slice();
    const mesh = { ...box, vertices, attributes: { position: vertices.subarray(0) } };
    const sourceBytes = mesh.vertices.slice();
    const { handle } = f.spawn(mesh);
    f.world.update(0).unwrap();
    const candidate = f.publisher.prepare(0).unwrap();
    const published = candidate.packet.assets.find((row) => row.handle === handle)?.value;
    if (published?.kind !== 'mesh') throw Error('Missing owned mesh publication');
    expect(published.vertices.buffer).not.toBe(mesh.vertices.buffer);
    const moved = renderPublicationAssetTransfers(candidate.message);
    expect(new Set(moved).size).toBe(moved.length);
    expect(moved).toContain(published.vertices.buffer);
    const packet = structuredClone(candidate.packet, {
      transfer: [...renderPublicationTransfers(candidate.message), ...moved],
    });
    expect(published.vertices.byteLength).toBe(0);
    expect(mesh.vertices).toEqual(sourceBytes);
    candidate.accept();
    const accepted = f.receiver.accept(encodeRenderPublication(packet)).unwrap();
    const resident = accepted.resources.resolveAsset<MeshAsset>(handle).unwrap();
    expect(resident.vertices).toEqual(sourceBytes);
    expect(resident.attributes.position).toBeInstanceOf(Float32Array);
    expect(resident.attributes.position).toEqual(resident.vertices);
    expect((resident.attributes.position as Float32Array).buffer).not.toBe(mesh.vertices.buffer);
    const returned = structuredClone(renderPublicationTransfers(encodeRenderPublication(packet)), {
      transfer: renderPublicationTransfers(encodeRenderPublication(packet)),
    });
    f.publisher.recycle(packet.revision, returned).unwrap();
    expect(resident.vertices).toEqual(sourceBytes);
    expect(mesh.vertices).toEqual(sourceBytes);
  } finally {
    f.dispose();
  }
});

it('rejects unresolved mesh defaults at admission and publishes the complete closure after loading', async () => {
  const f = fixture();
  try {
    const guid = AssetGuid.random();
    const mesh = {
      ...createBoxGeometry(1, 1, 1).unwrap(),
      materialSlots: [{ slotName: 'surface', defaultMaterial: guid }],
    };
    expect(f.assets.create(mesh).ok).toBe(false);
    publishRuntimeAssets(f.assets, [
      { guid: AssetGuid.format(guid), asset: Materials.unlit([0, 1, 0, 1]) },
    ]);
    (await f.assets.load(guid, 'material')).unwrap();
    const { entity, handle } = f.spawn(mesh);
    const material = f.publish();
    expect(material.packet.assets.some((row) => row.handle === handle)).toBe(true);
    expect(material.frame.renderables.at(0)?.material.snapshot.baseColor).toEqual(
      new Float32Array([0, 1, 0]),
    );
    publishRuntimeAssets(f.assets, [
      { guid: AssetGuid.format(guid), asset: Materials.unlit([0, 1, 0, 1]) },
      { guid: AssetGuid.format(AssetGuid.random()), asset: Materials.unlit([1, 0, 0, 1]) },
    ]);
    expect(f.publish().packet.assets.some((row) => row.handle === handle)).toBe(false);
    const replacement = f.assets
      .create({ ...createBoxGeometry(2, 1, 1).unwrap(), materialSlots: mesh.materialSlots })
      .unwrap();
    f.world.set(entity, MeshFilter, { assetHandle: replacement }).unwrap();
    const next = f.publish();
    expect(next.packet.assets.some((row) => row.handle === replacement)).toBe(true);
    expect(next.packet.retiredAssets).toContain(handle);
    expect(next.frame.renderables.at(0)?.assetHandle).toBe(replacement);
    expect(next.frame.renderables.at(0)?.material.snapshot.baseColor).toEqual(
      new Float32Array([0, 1, 0]),
    );
  } finally {
    f.dispose();
  }
});

it('retains same-handle material-slot updates', () => {
  const f = fixture();
  try {
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const { handle } = f.spawn(mesh);
    f.publish();
    f.assets.update(handle, { materialSlots: [{ slotName: 'reloaded' }] }).unwrap();
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
    f.assets
      .writeRange(handle, {
        attribute: 'position',
        first: 0,
        values: Float32Array.of(vertices[0] ?? 0, vertices[1] ?? 0, vertices[2] ?? 0),
      })
      .unwrap();
    publishRuntimeAssets(f.assets, [
      { guid: AssetGuid.format(AssetGuid.random()), asset: Materials.unlit([1, 0, 0, 1]) },
    ]);
    const discarded = f.publisher.prepare(0).unwrap();
    expect(discarded.packet.assetPatches.some((row) => row.handle === handle)).toBe(true);
    discarded.discard();
    const changed = f.publish();
    expect(changed.packet.assetPatches.some((row) => row.handle === handle)).toBe(true);
    expect(changed.resources.resolveAsset<MeshAsset>(handle).unwrap().vertices[0]).toBe(
      vertices[0],
    );
    f.assets.replace(handle, mesh).unwrap();
    const restored = f.publish();
    expect(restored.packet.assets.some((row) => row.handle === handle)).toBe(true);
    expect(restored.resources.resolveAsset<MeshAsset>(handle).unwrap().vertices[0]).toBe(
      mesh.vertices[0],
    );

    const identity = { ...f.identity, epoch: 2 };
    const publisher = createRenderPublisher(f.world, f.assets, identity);
    const receiver = new RenderPublicationReceiver(identity);
    try {
      expect(receiver.accept(encodeRenderPublication(restored.packet)).ok).toBe(false);
      const candidate = publisher.prepare(0).unwrap();
      expect(candidate.packet.baseline).toBe(true);
      expect(candidate.packet.assets.some((row) => row.handle === handle)).toBe(true);
      const packet = structuredClone(candidate.packet, {
        transfer: renderPublicationTransfers(candidate.message),
      });
      candidate.accept();
      expect(
        receiver
          .accept(encodeRenderPublication(packet))
          .unwrap()
          .resources.resolveAsset<MeshAsset>(handle)
          .unwrap().vertices,
      ).toEqual(mesh.vertices);
      publisher
        .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
        .unwrap();
    } finally {
      publisher.dispose();
      receiver.dispose();
    }
  } finally {
    f.dispose();
  }
});

it('keeps edited mesh content resident through unrelated component migration', () => {
  const f = fixture();
  try {
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const { handle, entity } = f.spawn(mesh);
    const firstPosition = Float32Array.of(
      (mesh.vertices[0] ?? 0) + 0.25,
      mesh.vertices[1] ?? 0,
      mesh.vertices[2] ?? 0,
    );
    f.assets
      .writeRange(handle, { attribute: 'position', first: 0, values: firstPosition })
      .unwrap();
    const first = f.publish();
    const admitted = first.resources.resolveAsset<MeshAsset>(handle).unwrap();
    f.world
      .addComponent(entity, { component: Visibility, data: { state: VisibilityStateValue.hidden } })
      .unwrap();
    const migrated = f.publish();
    expect(migrated.packet.assets.some((row) => row.handle === handle)).toBe(false);
    expect(migrated.packet.assetPatches.some((row) => row.handle === handle)).toBe(false);
    expect(migrated.resources.resolveAsset<MeshAsset>(handle).unwrap()).toBe(admitted);
    firstPosition[0] = (firstPosition[0] ?? 0) + 0.5;
    f.assets
      .writeRange(handle, { attribute: 'position', first: 0, values: firstPosition })
      .unwrap();
    const changed = f.publish();
    expect(changed.packet.assetPatches.some((row) => row.handle === handle)).toBe(true);
    expect(changed.resources.resolveAsset<MeshAsset>(handle).unwrap().vertices[0]).toBe(
      firstPosition[0],
    );
    f.assets.replace(handle, mesh).unwrap();
    const restored = f.publish();
    expect(restored.packet.assets.some((row) => row.handle === handle)).toBe(true);
    expect(restored.resources.resolveAsset<MeshAsset>(handle).unwrap().vertices[0]).toBe(
      mesh.vertices[0],
    );
  } finally {
    f.dispose();
  }
});
