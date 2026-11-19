import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { samplerContribution } from '@forgeax/engine-render';
import type { TextureAsset } from '@forgeax/engine-types';
import ProjectorLight from 'three/src/lights/webgpu/ProjectorLight.js';
import {
  DataTexture,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
} from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { cameraData } from '../camera';
import { SceneProjection } from '../scene';

it('retains explicit preparation across unrelated frames without evicting the active scene texture', () => {
  const assets = new AssetRegistry(),
    projection = new SceneProjection(assets);
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const bytes = new Uint8Array([80, 0, 0, 255]);
  const prepared = new DataTexture(bytes, 1, 1);
  const map = new DataTexture(new Uint8Array([0, 90, 0, 255]), 1, 1);
  prepared.needsUpdate = map.needsUpdate = true;
  const scene = new Scene(),
    camera = new PerspectiveCamera();
  const material = new MeshBasicMaterial({ map });
  const mesh = new Mesh(new PlaneGeometry(), material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  try {
    const projector = new ProjectorLight();
    scene.add(projector);
    expect(() => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1))).toThrow(
      /rectangular attenuation/,
    );
    scene.remove(projector);
    projector.dispose();
    const first = projection.prepareTexture(prepared);
    expect(first.uploaded).toBe(true);
    expect(projection.prepareTexture(prepared).handle).toBe(first.handle);
    expect(projection.prepareTexture(prepared).uploaded).toBe(false);
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
    const observer = assets.observe().unwrap();
    projection.prepareTexture(prepared);
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
    const quiet = observer.read().unwrap();
    expect(quiet.changes).toHaveLength(0);
    quiet.accept();
    expect(runtimeAssets(assets).borrow<TextureAsset>(first.handle).unwrap().data).toEqual(
      new Uint8Array([80, 0, 0, 255]),
    );
    bytes[0] = 150;
    prepared.needsUpdate = true;
    const changed = projection.prepareTexture(prepared);
    expect(changed.handle).toBe(first.handle);
    expect(changed.uploaded).toBe(true);
    expect(runtimeAssets(assets).borrow<TextureAsset>(first.handle).unwrap().data[0]).toBe(150);
    prepared.dispose();
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
    expect(runtimeAssets(assets).borrow<TextureAsset>(first.handle).ok).toBe(false);
    observer.dispose();
  } finally {
    projection.dispose();
    assets.dispose();
    mesh.geometry.dispose();
    material.dispose();
    map.dispose();
  }
});
