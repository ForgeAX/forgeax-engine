import * as THREE from '@forgeax/engine/three';
import { readRhiCommandCounts } from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { comparePixels, displayPixels, readyFrames, verifyReplay } from './render.fixture';

type Evidence = (
  name: string,
  capture: THREE.ThreeFrameCapture,
  expected?: Uint8Array,
) => Promise<void>;

export async function verifyEagerTexture(
  renderer: THREE.WebGPURenderer,
  oracle?: (scene: THREE.Object3D, camera: THREE.Camera) => Promise<Uint8Array>,
  evidence?: Evidence,
) {
  const data = new Uint8Array(3 * 5 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([32, 128, 224, 255], i);
  const texture = new THREE.DataTexture(data, 3, 5);
  let mipmap: THREE.Texture | undefined;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  let updates = 0;
  texture.onUpdate = () => {
    updates++;
  };
  const scene = new THREE.Scene(),
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const material = new THREE.MeshBasicMaterial({ map: texture });
  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  const errors: THREE.RendererErrorInfo[] = [];
  const previousError = renderer.onError;
  renderer.onError = (info) => errors.push(info);
  try {
    await renderer.init();
    const frame = renderer.inspect().receipt;
    const before = readRhiCommandCounts();
    renderer.initTexture(texture);
    const uploaded = readRhiCommandCounts();
    expect(uploaded.textureWrites - before.textureWrites).toBe(1);
    expect(uploaded.submits).toBe(before.submits);
    expect(renderer.inspect().receipt).toBe(frame);
    expect(updates).toBe(1);
    await renderer.initTextureAsync(texture);
    expect(readRhiCommandCounts().textureWrites).toBe(uploaded.textureWrites);
    expect(updates).toBe(1);
    mipmap = texture.clone();
    mipmap.onUpdate = null;
    mipmap.generateMipmaps = true;
    mipmap.minFilter = THREE.LinearMipmapLinearFilter;
    mipmap.needsUpdate = true;
    const mipFrame = renderer.inspect().receipt;
    const beforeMips = readRhiCommandCounts();
    renderer.initTexture(mipmap);
    await renderer.waitForGPU();
    const afterMips = readRhiCommandCounts();
    expect(afterMips.textureWrites - beforeMips.textureWrites).toBe(1);
    expect(afterMips.submits).toBeGreaterThan(beforeMips.submits);
    expect(renderer.inspect().receipt).toBe(mipFrame);
    renderer.initTexture(mipmap);
    expect(readRhiCommandCounts().textureWrites).toBe(afterMips.textureWrites);
    await readyFrames(renderer, scene, camera, 60);
    const initial = await renderer.captureFrame(scene, camera);
    const expected = await oracle?.(scene, camera);
    await evidence?.('eager-texture-initial', initial, expected);
    if (expected !== undefined) comparePixels(displayPixels(initial), expected);
    expect(
      Array.from(displayPixels(initial).subarray((128 * 64 + 64) * 4, (128 * 64 + 64) * 4 + 4)),
    ).toEqual([32, 128, 224, 255]);
    expect(updates).toBe(1);
    material.map = mipmap;
    mesh.scale.setScalar(0.02);
    await readyFrames(renderer, scene, camera);
    const minified = await renderer.captureFrame(scene, camera);
    const mipReference = await oracle?.(scene, camera);
    await evidence?.('eager-texture-minified', minified, mipReference);
    if (mipReference !== undefined) comparePixels(displayPixels(minified), mipReference);
    expect(
      Array.from(displayPixels(minified).subarray((128 * 64 + 64) * 4, (128 * 64 + 64) * 4 + 4)),
    ).toEqual([32, 128, 224, 255]);
    await verifyReplay(minified, 'eager-mips');
    material.map = texture;
    mesh.scale.setScalar(1);
    // No needsUpdate: retain the accepted bytes even though the caller edited its array.
    for (let i = 0; i < data.length; i += 4) data.set([224, 64, 32, 255], i);
    const unchanged = readRhiCommandCounts();
    renderer.initTexture(texture);
    expect(readRhiCommandCounts().textureWrites).toBe(unchanged.textureWrites);
    texture.needsUpdate = true;
    renderer.initTexture(texture);
    expect(readRhiCommandCounts().textureWrites - unchanged.textureWrites).toBe(1);
    expect(updates).toBe(2);
    await readyFrames(renderer, scene, camera);
    const edited = await renderer.captureFrame(scene, camera);
    const reference = await oracle?.(scene, camera);
    await evidence?.('eager-texture-edited', edited, reference);
    if (reference !== undefined) comparePixels(displayPixels(edited), reference);
    expect(
      Array.from(displayPixels(edited).subarray((128 * 64 + 64) * 4, (128 * 64 + 64) * 4 + 4)),
    ).toEqual([224, 64, 32, 255]);
    expect(updates).toBe(2);
    await verifyReplay(edited, 'eager-texture');
    texture.dispose();
    const disposed = readRhiCommandCounts();
    renderer.initTexture(texture);
    expect(readRhiCommandCounts().textureWrites - disposed.textureWrites).toBe(1);
    expect(updates).toBe(3);
    await renderer.waitForGPU();
    expect(errors).toHaveLength(0);
  } finally {
    renderer.onError = previousError;
    mipmap?.dispose();
    geometry.dispose();
    material.dispose();
    texture.dispose();
  }
}
