import * as THREE from '@forgeax/engine/three';
import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine-render';
import { decodeTape } from '@forgeax/engine-rhi-debug';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { compactTape } from '../../../runtime/src/__tests__/compact-tape.fixture';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { exerciseOpaqueOrder, exerciseTransparentInstances } from './opaque-order.fixture';
import { displayPixels, readyFrames, SIZE } from './render.fixture';

it('preserves ordered opaque queues across native Dawn recording and replay', {
  timeout: 120000,
}, async () => {
  const target = offscreenCanvas(SIZE);
  const renderer = new THREE.WebGPURenderer({
    canvas: target.canvas as unknown as OffscreenCanvas,
    forgeax: {
      bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderTemplateManifest()) },
    },
  });
  try {
    await renderer.init();
    await exerciseOpaqueOrder(renderer, async () => {});
  } finally {
    await renderer.dispose();
    target.destroy();
  }
});

it('replays stable transparent instances and presents current instance matrices and order', {
  timeout: 120000,
}, async () => {
  const target = offscreenCanvas(SIZE);
  const renderer = new THREE.WebGPURenderer({
    canvas: target.canvas as unknown as OffscreenCanvas,
    forgeax: {
      bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderTemplateManifest()) },
    },
  });
  try {
    await renderer.init();
    await exerciseTransparentInstances(renderer);
  } finally {
    await renderer.dispose();
    target.destroy();
  }
});

it('writes equal-depth opaque surfaces once and restores the prepass on a material edit', {
  timeout: 120000,
}, async () => {
  const target = offscreenCanvas(SIZE);
  const renderer = new THREE.WebGPURenderer({
    canvas: target.canvas as unknown as OffscreenCanvas,
    forgeax: {
      renderer: {
        standardProfile: {
          ...DEFAULT_STANDARD_PROFILE,
          ambientOcclusion: { enabled: false },
        },
      },
      bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderTemplateManifest()) },
    },
  });
  const geometry = new THREE.PlaneGeometry(2, 2);
  const red = new THREE.MeshStandardMaterial({ emissive: 0xff0000 });
  const blue = new THREE.MeshStandardMaterial({ emissive: 0x0000ff });
  const scene = new THREE.Scene();
  const first = new THREE.Mesh(geometry, red);
  const second = new THREE.Mesh(geometry, blue);
  second.renderOrder = 2;
  scene.add(first, second);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  try {
    await renderer.init();
    for (const [index, strict] of [false, true, false].entries()) {
      red.depthFunc = strict ? THREE.LessDepth : THREE.LessEqualDepth;
      red.needsUpdate = true;
      first.position.x = index * 0.01;
      await readyFrames(renderer, scene, camera, 20);
      const capture = await renderer.captureFrame(scene, camera);
      const tape = decodeTape(compactTape(capture.tape).bytes).unwrap();
      const rasters = tape.events.filter((event) => event.kind === 'beginRenderPass');
      const labels = rasters.map((event) => event.desc.label);
      const main = rasters.find((event) => event.desc.label === 'main');
      expect(labels.includes('standard-scene-surface-data')).toBe(strict);
      expect(labels).not.toContain('skybox');
      expect(main?.desc.depthStencilAttachment?.depthLoadOp).toBe(strict ? 'load' : 'clear');
      expect(main?.desc.depthStencilAttachment?.stencilLoadOp).toBe(strict ? 'load' : 'clear');
      expect(Array.from(main?.desc.colorAttachments ?? [])[0]?.loadOp).toBe('clear');
      const geometryDraws = tape.events.filter((event) => event.kind === 'drawIndexed');
      expect(geometryDraws.length, strict ? 'separate depth' : 'color owns depth').toBe(
        strict ? 4 : 2,
      );
      const offset = (SIZE * (SIZE / 2) + SIZE / 2) * 4;
      const rgba = displayPixels(capture).subarray(offset, offset + 4);
      expect(rgba[2]).toBeGreaterThan(240);
      expect(rgba[0]).toBeLessThan(10);
    }
  } finally {
    await renderer.dispose();
    red.dispose();
    blue.dispose();
    geometry.dispose();
    target.destroy();
  }
});
