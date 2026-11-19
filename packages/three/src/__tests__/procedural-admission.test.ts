import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { samplerContribution } from '@forgeax/engine-render';
import { MorphWeights } from '@forgeax/engine-scene';
import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
} from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { cameraData } from '../camera';
import { SceneProjection } from '../scene';

it('admits the MorphAnimMesh source tag and updates existing native morph weights', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const projection = new SceneProjection(assets),
    scene = new Scene(),
    camera = new PerspectiveCamera();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 3));
  geometry.morphAttributes.position = [new Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 0, 2, 0], 3)];
  class MorphSourceMesh extends Mesh {
    override readonly type = 'MorphAnimMesh';
  }
  const material = new MeshBasicMaterial(),
    mesh = new MorphSourceMesh(geometry, material);
  // Source-owner test; the GPU fixture exercises the original public addon constructor.
  scene.add(mesh);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  try {
    sync();
    const entity = projection.entityFor(mesh);
    if (entity === undefined || mesh.morphTargetInfluences === undefined)
      throw Error('missing morph mesh');
    mesh.morphTargetInfluences[0] = 0.75;
    sync();
    expect(projection.entityFor(mesh)).toBe(entity);
    expect(Array.from(projection.world.get(entity, MorphWeights).unwrap().weights)).toEqual([0.75]);
    const observer = assets.observe().unwrap();
    for (let i = 0; i < 20; i++) sync();
    expect(observer.read().unwrap().changes).toEqual([]);
  } finally {
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    material.dispose();
  }
});
