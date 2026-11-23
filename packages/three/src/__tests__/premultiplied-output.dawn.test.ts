import * as THREE from '@forgeax/engine/three';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { displayPixels, readyFrames, SIZE, verifyReplay } from './render.fixture';

it('encodes unassociated color before premultiplication, including tone mapping and clear alpha', {
  timeout: 120000,
}, async () => {
  const target = offscreenCanvas(SIZE);
  const renderer = new THREE.WebGPURenderer({
    canvas: target.canvas as unknown as OffscreenCanvas,
    forgeax: {
      bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderTemplateManifest()) },
    },
  });
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const geometry = new THREE.PlaneGeometry(2, 2);
  const red = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  const blue = new THREE.MeshBasicMaterial({
    color: 0x0000ff,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  const far = new THREE.Mesh(geometry, red),
    near = new THREE.Mesh(geometry, blue);
  far.position.z = -0.1;
  scene.add(far, near);
  renderer.setTransparentSort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const center = (capture: THREE.ThreeFrameCapture) => {
    const bytes = displayPixels(capture),
      offset = (64 * SIZE + 64) * 4;
    return Array.from(bytes.subarray(offset, offset + 4));
  };
  const presentedCenter = async () => {
    const context = target.canvas.getContext();
    const device = context.getConfiguration()?.device;
    const texture = context.getCurrentTexture();
    if (device === undefined || texture === undefined) throw new Error('Missing drawing surface');
    const pixel = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture, origin: [64, 64] }, { buffer: pixel }, [1, 1]);
      device.queue.submit([encoder.finish()]);
      await pixel.mapAsync(GPUMapMode.READ);
      const rgba = Array.from(new Uint8Array(pixel.getMappedRange()));
      return texture.format === 'bgra8unorm' ? [rgba[2], rgba[1], rgba[0], rgba[3]] : rgba;
    } finally {
      pixel.destroy();
    }
  };
  const matches = (actual: number[], expected: number[]) => {
    for (const [index, value] of expected.entries())
      expect(Math.abs((actual[index] ?? 0) - value)).toBeLessThanOrEqual(1);
  };
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 1);
    const forward = () => renderer.inspect().renderer.featureGraph;
    const initial = forward();
    expect(initial?.last.topologyKey).toContain('"forwardDisplay"');
    const light = new THREE.PointLight(0xffffff, 2);
    for (let frame = 1; frame < 60; frame++) {
      far.position.x = (frame % 5) * 0.01;
      near.visible = frame % 3 !== 0;
      if (frame % 2 === 0) scene.add(light);
      else light.removeFromParent();
      await readyFrames(renderer, scene, camera, 1);
      expect(forward()?.compileAttempts).toBe(initial?.compileAttempts);
    }
    far.position.x = 0;
    near.visible = true;
    light.removeFromParent();
    await readyFrames(renderer, scene, camera, 1);
    matches(center(await renderer.captureFrame(scene, camera)), [160, 0, 117, 191]);
    renderer.toneMapping = THREE.ReinhardToneMapping;
    await readyFrames(renderer, scene, camera, 1);
    const toned = await renderer.captureFrame(scene, camera);
    expect(forward()?.last.topologyKey).toContain('"observedTarget":"three-output"');
    expect(renderer.inspect().renderer.perFramePassNames).toContain('final-display-observation');
    // Analytic premultiplied linear composite: (0.5, 0, 0.25, 0.75).
    // Divide by coverage, apply per-channel Reinhard and sRGB, then multiply coverage.
    const encode = (linear: number) => 1.055 * linear ** (1 / 2.4) - 0.055;
    matches(center(toned), [
      Math.round(encode(0.4) * 0.75 * 255),
      0,
      Math.round(encode(0.25) * 0.75 * 255),
      191,
    ]);
    await verifyReplay(toned, 'r187-premultiplied-tone');
    renderer.toneMapping = THREE.NoToneMapping;
    for (const alpha of [0, 0.5, 1]) {
      renderer.setClearColor(0x336699, alpha);
      const empty = new THREE.Scene();
      await readyFrames(renderer, empty, camera, 1);
      const direct = renderer.inspect().renderer.perFramePassNames;
      expect(direct).toContain('output-transform');
      expect(direct).not.toContain('present');
      const physical = await presentedCenter();
      const captured = center(await renderer.captureFrame(empty, camera));
      expect(physical).toEqual(captured);
      matches(
        captured,
        [51, 102, 153, 255].map((value) => Math.round(value * alpha)),
      );
    }
  } finally {
    await renderer.dispose();
    geometry.dispose();
    red.dispose();
    blue.dispose();
    target.destroy();
  }
});
