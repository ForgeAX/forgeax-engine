import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { copyMeshAttribute } from '@forgeax/engine-geometry';
import { Instances, MeshFilter } from '@forgeax/engine-render';
import type { MeshAsset } from '@forgeax/engine-types';
import {
  BoxGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
} from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { installDefaultAssetDecoders } from '../../../runtime/src/asset-contributions';
import { cameraData } from '../camera';
import { SceneProjection } from '../scene';

it.each([false, true])('keeps visible pool slots with instance colors = %s', (colored) => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const mesh = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial(), 3);
  const hidden = new Matrix4().makeScale(0, 0, 0).setPosition(10, 20, 30);
  const visible = new Matrix4().makeTranslation(2, 0, 0);
  scene.add(mesh);
  if (colored) {
    mesh.setColorAt(0, new Color(0xff0000));
    mesh.setColorAt(1, new Color(0x00ff00));
    mesh.setColorAt(2, new Color(0x0000ff));
  }
  const sync = () => {
    mesh.instanceMatrix.needsUpdate = true;
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw new Error('InstancedMesh must keep its entity');
    return entity;
  };
  const expectSlot = (slot: number) => {
    const entity = sync();
    if (colored) {
      const handle = projection.world.get(entity, MeshFilter).unwrap().assetHandle;
      const asset = runtimeAssets(assets).borrow<MeshAsset>(handle).unwrap();
      expect(asset.indices).toHaveLength(36);
      const color = copyMeshAttribute(asset, 'color') as Float32Array;
      expect(Array.from(color.subarray(0, 4))).toEqual(slot === 1 ? [0, 1, 0, 1] : [0, 0, 1, 1]);
    } else {
      expect(projection.world.get(entity, Instances).unwrap().transforms).toEqual(
        Float32Array.from(visible.elements),
      );
    }
  };
  try {
    for (let slot = 0; slot < mesh.count; slot++) mesh.setMatrixAt(slot, hidden);
    mesh.setMatrixAt(1, visible);
    expectSlot(1);
    mesh.setMatrixAt(1, hidden);
    const hiddenEntity = sync();
    expect(projection.world.get(hiddenEntity, MeshFilter).unwrap().assetHandle).toBe(0);
    mesh.setMatrixAt(2, visible);
    expectSlot(2);
    expect(projection.entityFor(mesh)).toBe(hiddenEntity);
    mesh.setMatrixAt(0, new Matrix4().makeScale(1, 0, 1));
    expect(sync).toThrow(/three-invalid-value/);
    mesh.setMatrixAt(0, hidden.clone().setPosition(Infinity, 0, 0));
    expect(sync).toThrow(/three-invalid-value/);
  } finally {
    projection.dispose();
    assets.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
});

it('keeps one tinted mesh across matrix revisions and switches on a color revision', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const mesh = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial(), 2);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const sync = () => {
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw new Error('InstancedMesh must keep its entity');
    const handle = projection.world.get(entity, MeshFilter).unwrap().assetHandle;
    return { entity, payload: runtimeAssets(assets).borrow<MeshAsset>(handle).unwrap() };
  };
  try {
    mesh.setColorAt(0, new Color(1, 0, 0));
    mesh.setColorAt(1, new Color(1, 0, 0));
    const instanceColor = mesh.instanceColor;
    if (instanceColor === null) throw new Error('Expected instance colors');
    const initial = sync();
    expect(projection.world.hasComponent(initial.entity, Instances)).toBe(true);
    expect(initial.payload.indices).toHaveLength(36);
    const color = copyMeshAttribute(initial.payload, 'color');
    if (color === undefined) throw new Error('Expected a color stream');
    expect(Array.from(color.slice(0, 4))).toEqual([1, 0, 0, 1]);
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(2, 0, 0));
    mesh.instanceMatrix.needsUpdate = true;
    expect(sync().payload).toBe(initial.payload);
    mesh.setColorAt(1, new Color(0, 1, 0));
    instanceColor.needsUpdate = true;
    expect(sync().payload.indices).toHaveLength(72);
    expect(projection.world.hasComponent(initial.entity, Instances)).toBe(false);
    mesh.setColorAt(1, new Color(1, 0, 0));
    instanceColor.needsUpdate = true;
    expect(sync().payload.indices).toHaveLength(36);
    expect(projection.world.hasComponent(initial.entity, Instances)).toBe(true);
    mesh.setMatrixAt(1, new Matrix4().makeShear(0.4, 0, 0, 0, 0, 0));
    mesh.instanceMatrix.needsUpdate = true;
    expect(sync().payload.indices).toHaveLength(72);
    expect(projection.world.hasComponent(initial.entity, Instances)).toBe(false);
  } finally {
    projection.dispose();
    assets.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
});
