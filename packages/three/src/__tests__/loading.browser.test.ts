import * as THREE from '@forgeax/engine/three';
import OriginalRenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';
import { RenderTarget } from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { comparePixels, displayPixels, readyFrames, SIZE, verifyReplay } from './render.fixture';

it('renders pending textures and preserves r184 upload timing across image replacements', {
  timeout: 120000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const renderer = new THREE.WebGPURenderer({ canvas });
  const original = new OriginalRenderer();
  const target = new RenderTarget(SIZE, SIZE);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  // r184 caches views by extent: a 1x1 image aliases its placeholder view.
  // Use a real 2x2 upload to exercise the intended asynchronous lifecycle.
  const texture = new THREE.DataTexture();
  let phase: 'forgeax' | 'three' = 'forgeax';
  const updates: Record<'forgeax' | 'three', number[]> = { forgeax: [], three: [] };
  texture.onUpdate = () => updates[phase].push(texture.version);
  const material = new THREE.MeshBasicMaterial({ map: texture, blending: THREE.NoBlending });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(3, 3), material));
  try {
    await renderer.init();
    await original.init();
    expect((original.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend).toBe(true);
    original.setSize(SIZE, SIZE);
    original.setOutputRenderTarget(target);
    const device = (original.backend as unknown as { device: GPUDevice }).device;
    device.pushErrorScope('validation');
    const frame = async (name: string, frames = 1) => {
      phase = 'forgeax';
      await readyFrames(renderer, scene, camera, frames);
      const capture = await renderer.captureFrame(scene, camera);
      phase = 'three';
      original.render(scene, camera);
      expect(updates.forgeax).toEqual(updates.three);
      const expected = new Uint8Array(
        await original.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE),
      );
      await saveBrowserEvidence(`loading-${name}`, capture, expected);
      comparePixels(displayPixels(capture), expected);
      return capture;
    };
    const pending = displayPixels(await frame('pending', 60));
    texture.image = {
      width: 2,
      height: 2,
      data: new Uint8Array(Array(4).fill([240, 40, 20, 255]).flat()),
    };
    texture.needsUpdate = true;
    const red = displayPixels(await frame('loaded'));
    expect(red).not.toEqual(pending);
    texture.image = {
      width: 2,
      height: 2,
      data: new Uint8Array(Array(4).fill([20, 220, 60, 255]).flat()),
    };
    expect(displayPixels(await frame('unpublished-image'))).toEqual(red);
    texture.source.dataReady = false;
    texture.needsUpdate = true;
    expect(displayPixels(await frame('data-not-ready'))).toEqual(red);
    texture.source.dataReady = true;
    expect(displayPixels(await frame('unpublished-ready'))).toEqual(red);
    texture.needsUpdate = true;
    const green = await frame('published-ready');
    expect(displayPixels(green)).not.toEqual(red);
    await verifyReplay(green);
    expect(updates.forgeax).toEqual([1, 2, 3]);
    expect((await device.popErrorScope())?.message ?? null).toBeNull();
  } finally {
    await renderer.dispose();
    target.dispose();
    original.dispose();
    material.dispose();
    texture.dispose();
  }
});

it('accepts TextureLoader.load immediately and shows its decoded image when ready', {
  timeout: 120000,
}, async () => {
  const image = document.createElement('canvas');
  image.width = image.height = 2;
  const context = image.getContext('2d');
  if (context === null) throw new Error('missing image encoder');
  context.fillStyle = '#20c060';
  context.fillRect(0, 0, 2, 2);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const renderer = new THREE.WebGPURenderer({ canvas });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const material = new THREE.MeshBasicMaterial();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(3, 3), material));
  let texture: THREE.Texture | undefined;
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    const completion = new Promise<void>((resolve, reject) => {
      texture = new THREE.TextureLoader().load(
        image.toDataURL(),
        () => resolve(),
        undefined,
        reject,
      );
    });
    if (texture === undefined) throw new Error('missing pending texture');
    material.map = texture;
    material.needsUpdate = true;
    expect(texture.image).toBeNull();
    expect(() => renderer.render(scene, camera)).not.toThrow();
    await completion;
    await readyFrames(renderer, scene, camera);
    const capture = await renderer.captureFrame(scene, camera);
    await saveBrowserEvidence('loading-texture-loader', capture);
    const pixels = displayPixels(capture),
      center = (SIZE * (SIZE / 2) + SIZE / 2) * 4;
    expect(pixels[center + 1]).toBeGreaterThan(150);
    expect(pixels[center + 1]).toBeGreaterThan(pixels[center] ?? 255);
  } finally {
    await renderer.dispose();
    material.dispose();
    texture?.dispose();
  }
});

it('reports a failed TextureLoader request while continuing to render its placeholder', {
  timeout: 120000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const renderer = new THREE.WebGPURenderer({ canvas });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  let failed = 0;
  const loader = new THREE.TextureLoader();
  let texture!: THREE.Texture;
  const completed = new Promise<void>((resolve) => {
    texture = loader.load('data:image/png;base64,invalid-image', undefined, undefined, () => {
      failed++;
      resolve();
    });
  });
  const material = new THREE.MeshBasicMaterial({ map: texture });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(3, 3), material));
  try {
    await renderer.init();
    await completed;
    expect(failed).toBe(1);
    expect(texture.version).toBe(0);
    await readyFrames(renderer, scene, camera, 60);
    const capture = await renderer.captureFrame(scene, camera);
    await saveBrowserEvidence('loading-error-placeholder', capture);
    await verifyReplay(capture);
    const pixels = displayPixels(capture),
      center = (SIZE * (SIZE / 2) + SIZE / 2) * 4;
    expect(Array.from(pixels.slice(center, center + 4))).toEqual([0, 0, 0, 255]);
  } finally {
    await renderer.dispose();
    material.dispose();
    texture.dispose();
  }
});
