import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { required } from './features.fixture';
import { comparePixels, displayPixels, readyFrames, SIZE, verifyReplay } from './render.fixture';
import { videoSource } from './video.fixture';
import { renderReference } from './webgpu-reference.fixture';

it('imports borrowed WebGPU textures, observes edits, releases and readmits source disposal', {
  timeout: 120000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  const renderer = new THREE.WebGPURenderer({ canvas });
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera);
    const device = required(renderer.getContext().getConfiguration()).device;
    const gpu = device.createTexture({
      size: [2, 2],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    const texture = new THREE.ExternalTexture(gpu);
    const material = new THREE.MeshBasicMaterial({ map: texture });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
    for (const [index, color] of [
      [30, 110, 180, 255],
      [180, 100, 30, 255],
    ].entries()) {
      const pixels = Uint8Array.from([...color, ...color, ...color, ...color]);
      device.queue.writeTexture({ texture: gpu }, pixels, { bytesPerRow: 8 }, [2, 2]);
      if (index === 1) texture.dispose();
      await renderer.initTextureAsync(texture);
      await readyFrames(renderer, scene, camera, index === 0 ? 60 : 1);
      const capture = await renderer.captureFrame(scene, camera);
      const referenceScene = new THREE.Scene(),
        map = new THREE.DataTexture(pixels, 2, 2);
      map.needsUpdate = true;
      referenceScene.add(
        new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map })),
      );
      const reference = await renderReference(referenceScene, camera);
      await saveBrowserEvidence(`external-${index}`, capture, reference);
      comparePixels(displayPixels(capture), reference);
      await verifyReplay(capture);
    }
    texture.dispose();
    gpu.destroy();
  } finally {
    await renderer.dispose();
    canvas.remove();
  }
});

it('keeps BC blocks compressed across upload, edit and disposal', { timeout: 120000 }, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  const renderer = new THREE.WebGPURenderer({ canvas });
  try {
    await renderer.init();
    expect(renderer.hasFeature('texture-compression-bc')).toBe(true);
    const data = new Uint8Array([0, 248, 224, 7, 0, 0, 0, 0]);
    const texture = new THREE.CompressedTexture(
      [{ data, width: 4, height: 4 }],
      4,
      4,
      THREE.RGBA_S3TC_DXT1_Format,
    );
    texture.needsUpdate = true;
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.z = 5;
    scene.add(
      new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: texture })),
    );
    for (const phase of ['initial', 'edited'] as const) {
      if (phase === 'edited') {
        data[0] = 31;
        data[1] = 0;
        texture.dispose();
        texture.needsUpdate = true;
      }
      await readyFrames(renderer, scene, camera, phase === 'initial' ? 60 : 1);
      const capture = await renderer.captureFrame(scene, camera),
        reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`compressed-${phase}`, capture, reference);
      comparePixels(displayPixels(capture), reference);
      await verifyReplay(capture);
    }
    texture.dispose();
  } finally {
    await renderer.dispose();
    canvas.remove();
  }
});

it.each([THREE.SRGBColorSpace])('updates paused video frames in %s through source disposal', {
  timeout: 120000,
}, async (colorSpace) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  const renderer = new THREE.WebGPURenderer({ canvas });
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('video decode failed'));
    });
    video.src = videoSource;
    await loaded;
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = colorSpace;
    texture.needsUpdate = true;
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.z = 5;
    scene.add(
      new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: texture })),
    );
    for (const phase of ['initial', 'edited'] as const) {
      if (phase === 'edited') {
        const seek = new Promise<void>((resolve) => {
          video.onseeked = () => resolve();
        });
        video.currentTime = 0.7;
        await seek;
        texture.dispose();
        texture.needsUpdate = true;
      }
      await renderer.renderAsync(scene, camera);
      await readyFrames(renderer, scene, camera, phase === 'initial' ? 60 : 1);
      const capture = await renderer.captureFrame(scene, camera),
        reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`video-${colorSpace || 'raw'}-${phase}`, capture, reference);
      comparePixels(displayPixels(capture), reference);
      await expect(verifyReplay(capture)).rejects.toMatchObject({
        code: 'replay-event-failed',
        detail: {
          kind: 'copyExternalImageToTexture',
          cause: 'external image sources are not self-contained',
        },
      });
    }
    texture.dispose();
  } finally {
    video.removeAttribute('src');
    video.load();
    await renderer.dispose();
    canvas.remove();
  }
});
