import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  NearestFilter,
  OrthographicCamera,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  Vector3,
  WebGPURenderer,
} from '@forgeax/engine/three';
import { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { pointColorModes, verifyPointColors } from './point-colors.fixture';
import { comparePixels, displayPixels, readyFrames } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

for (const mode of pointColorModes)
  it(`point colors ${mode} on browser`, { timeout: 120000 }, async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const renderer = new WebGPURenderer({ canvas });
    try {
      await verifyPointColors(renderer, mode, async (name, frame, scene, camera) => {
        const reference = await renderReference(scene, camera);
        await saveBrowserEvidence(`r187-point-colors-${name}`, frame, reference);
        comparePixels(displayPixels(frame), reference);
        expect(
          equalBytes(displayPixels(frame), reference),
          `${name} point pixels match r187 exactly`,
        ).toBe(true);
      });
    } finally {
      await renderer.dispose();
    }
  });

it('renders mapped, additive point sprites at the r187 WebGL raster size', {
  timeout: 120000,
}, async () => {
  const canvas = document.createElement('canvas');
  const native = new WebGPURenderer({ canvas });
  const reference = new WebGLRenderer({ preserveDrawingBuffer: true });
  const scene = new Scene();
  scene.background = new Color(0);
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 2;
  const ortho = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  ortho.position.copy(camera.position);
  const geometry = new BufferGeometry().setFromPoints([
    new Vector3(-0.35, 0, 0),
    new Vector3(0.7, 0, -2),
  ]);
  const image = document.createElement('canvas');
  image.width = image.height = 2;
  const paint = image.getContext('2d');
  if (paint === null) throw new Error('point sprite needs a canvas texture');
  paint.fillStyle = 'red';
  paint.fillRect(0, 0, 1, 1);
  paint.fillStyle = 'lime';
  paint.fillRect(1, 0, 1, 1);
  paint.fillStyle = 'blue';
  paint.fillRect(0, 1, 1, 1);
  const map = new CanvasTexture(image);
  map.minFilter = map.magFilter = NearestFilter;
  map.generateMipmaps = false;
  const material = new PointsMaterial({
    map,
    size: 0.5,
    sizeAttenuation: true,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  scene.add(new Points(geometry, material));
  const read = document.createElement('canvas');
  read.width = read.height = 128;
  const context = read.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('point sprite needs WebGL pixel readback');
  const channelAt = (pixels: ArrayLike<number>, x: number, y: number, channel: number) =>
    pixels[(y * 128 + x) * 4 + channel] ?? 0;
  const check = async (
    view: PerspectiveCamera | OrthographicCamera,
    diameters: readonly number[],
  ) => {
    reference.render(scene, view);
    context.drawImage(reference.domElement, 0, 0);
    const expected = context.getImageData(0, 0, 128, 128).data;
    const frame = await native.captureFrame(scene, view);
    const pixels = displayPixels(frame);
    for (const [index, diameter] of diameters.entries()) {
      const center = new Vector3()
        .fromBufferAttribute(geometry.getAttribute('position'), index)
        .project(view);
      const x = Math.floor(64 * (center.x + 1));
      const offset = Math.max(1, Math.floor(diameter / 4));
      for (const [dx, dy, channel] of [
        [-offset, -offset, 0],
        [offset, -offset, 1],
        [-offset, offset, 2],
        [offset, offset, 0],
      ] as const) {
        expect(channelAt(pixels, x + dx, 64 + dy, channel)).toBe(
          channelAt(expected, x + dx, 64 + dy, channel),
        );
      }
      expect(channelAt(pixels, x - offset, 64 - offset, 0)).toBeGreaterThan(240);
      expect(channelAt(pixels, x + offset, 64 + offset, 0)).toBe(0);
      for (const data of [pixels, expected]) {
        const covered = Array.from(
          { length: 32 },
          (_, i) =>
            channelAt(data, x + i - 16, 64 - offset, 0) +
            channelAt(data, x + i - 16, 64 - offset, 1),
        ).filter((value) => value > 200);
        expect(Math.abs(covered.length - diameter)).toBeLessThanOrEqual(1);
      }
    }
    await saveBrowserEvidence(
      `r187-point-sprite-${view.type}-${material.sizeAttenuation}`,
      frame,
      new Uint8Array(expected),
    );
  };
  try {
    for (const renderer of [native, reference]) {
      renderer.setPixelRatio(2);
      renderer.setSize(64, 64, false);
    }
    await native.init();
    await readyFrames(native, scene, camera, 60);
    await check(camera, [16, 8]);
    material.size = 5;
    material.sizeAttenuation = false;
    material.needsUpdate = true;
    await check(camera, [10, 10]);
    material.sizeAttenuation = true;
    material.needsUpdate = true;
    await check(ortho, [10, 10]);
  } finally {
    reference.dispose();
    await native.dispose();
    geometry.dispose();
    material.dispose();
    map.dispose();
  }
});
