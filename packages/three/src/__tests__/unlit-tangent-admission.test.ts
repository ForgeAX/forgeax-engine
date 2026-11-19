import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { copyMeshAttribute } from '@forgeax/engine-geometry';
import { MeshFilter, samplerContribution } from '@forgeax/engine-render';
import type { MeshAsset } from '@forgeax/engine-types';
import {
  BufferGeometry,
  DataTexture,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
} from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { cameraData } from '../camera';
import { SceneProjection } from '../scene';

it('admits constant UVs for unlit geometry and rechecks tangent requirements after a material change', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const projection = new SceneProjection(assets),
    scene = new Scene(),
    camera = new PerspectiveCamera();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(new Float32Array(6), 2));
  const basic = new MeshBasicMaterial(),
    standard = new MeshStandardMaterial(),
    normalMap = new DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1),
    mesh: Mesh = new Mesh(geometry, basic);
  scene.add(mesh);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  try {
    sync();
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw Error('missing source mesh');
    const handle = projection.world.get(entity, MeshFilter).unwrap().assetHandle;
    const payload = runtimeAssets(assets).borrow<MeshAsset>(handle).unwrap();
    const tangents = copyMeshAttribute(payload, 'tangent');
    expect(tangents).toHaveLength(12);
    expect(Array.from(tangents ?? []).every(Number.isFinite)).toBe(true);
    mesh.material = standard;
    sync();
    expect(projection.world.get(entity, MeshFilter).unwrap().assetHandle).toEqual(handle);
    standard.normalMap = normalMap;
    expect(sync).toThrow('no triangle has a valid UV-derived tangent');
    standard.normalMap = null;
    mesh.material = basic;
    sync();
    expect(projection.world.get(entity, MeshFilter).unwrap().assetHandle).toEqual(handle);
    const observer = assets.observe().unwrap();
    try {
      for (let i = 0; i < 20; i++) sync();
      expect(observer.read().unwrap().changes).toEqual([]);
    } finally {
      observer.dispose();
    }
  } finally {
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    basic.dispose();
    standard.dispose();
    normalMap.dispose();
  }
});
