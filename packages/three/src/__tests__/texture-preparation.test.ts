import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { MeshRenderer, samplerContribution } from '@forgeax/engine-render';
import type { TextureAsset } from '@forgeax/engine-types';
import ProjectorLight from 'three/src/lights/webgpu/ProjectorLight.js';
import {
  DataTexture,
  ExternalTexture,
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

it('collects only reachable external texture inputs before binding draws', () => {
  const assets = new AssetRegistry();
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const geometry = new PlaneGeometry();
  const selected = new ExternalTexture();
  const hidden = new ExternalTexture();
  const material = new MeshBasicMaterial({ map: selected });
  const hiddenMaterial = new MeshBasicMaterial({ map: hidden });
  const first = new Mesh(geometry, material);
  first.frustumCulled = false;
  const second = first.clone();
  const invisible = new Mesh(geometry, hiddenMaterial);
  invisible.visible = false;
  scene.add(first, second, invisible);
  const demand = new Set<ExternalTexture>();
  try {
    let thrown: unknown;
    try {
      projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1), {
        depth: true,
        stencil: false,
        sortObjects: true,
        opaque: true,
        transparent: true,
        updateMatrices: true,
        externalDemand: demand,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(demand);
    expect([...demand]).toEqual([selected]);
    const pending = projection.entityFor(first);
    if (pending === undefined) throw new Error('expected a projected pose');
    expect(projection.world.hasComponent(pending, MeshRenderer)).toBe(false);
    material.map = null;
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
    expect(projection.entityFor(first)).toBeDefined();
  } finally {
    projection.dispose();
    assets.dispose();
    selected.dispose();
    hidden.dispose();
    geometry.dispose();
    material.dispose();
    hiddenMaterial.dispose();
  }
});

it('shares one large texture snapshot until a clone independently accepts a new revision', () => {
  const assets = new AssetRegistry();
  const projection = new SceneProjection(assets);
  const edge = 1024;
  const bytes = new Uint8Array(edge * edge * 4).fill(31);
  const a = new DataTexture(bytes, edge, edge);
  a.needsUpdate = true;
  const b = a.clone();
  const c = a.clone();
  const prepare = (texture: DataTexture) => projection.prepareTexture(texture).handle;
  const read = (handle: ReturnType<typeof prepare>) =>
    runtimeAssets(assets).borrow<TextureAsset>(handle).unwrap();
  try {
    expect(a.source).toBe(b.source);
    const original = prepare(a);
    expect(prepare(b)).toBe(original);
    expect(prepare(c)).toBe(original);
    expect(read(original).data.byteLength).toBe(4 * 1024 * 1024);

    bytes[0] = 197;
    a.needsUpdate = true;
    const changed = prepare(a);
    expect(changed).not.toBe(original);
    expect(read(changed).data[0]).toBe(197);
    expect(prepare(b)).toBe(original);
    expect(read(original).data[0]).toBe(31);

    b.needsUpdate = true;
    expect(prepare(b)).toBe(changed);
    c.flipY = true;
    c.needsUpdate = true;
    const flipped = prepare(c);
    expect(flipped).not.toBe(changed);
    expect(read(flipped).data[(edge - 1) * edge * 4]).toBe(197);
    expect(assets.validate(original, 'texture').ok).toBe(false);

    a.dispose();
    expect(prepare(a)).not.toBe(changed);
    projection.sync(
      new Scene(),
      new PerspectiveCamera(),
      cameraData(new PerspectiveCamera(), NoToneMapping, 1),
    );
    expect(read(changed).data[0]).toBe(197);
    expect(prepare(b)).toBe(changed);
  } finally {
    projection.dispose();
    assets.dispose();
  }
});
