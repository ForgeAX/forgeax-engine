import * as THREE from '@forgeax/engine/three';
import { buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import OriginalRenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';
import { DirectionalLight, PointLight, RenderTarget, SpotLight } from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { saveBrowserEvidence } from './browser-evidence.fixture';
import {
  browserRendererFixture,
  comparePixels,
  displayPixels,
  readyFrames,
  SIZE,
  verifyReplay,
} from './render.fixture';

const rendererFor = browserRendererFixture();

it.each([
  { kind: 'directional', variance: false },
  { kind: 'point', variance: false },
  { kind: 'spot', variance: false },
  { kind: 'directional', variance: true },
  { kind: 'spot', variance: true },
] as const)('retains $kind shadow depth (variance=$variance) until an explicit update', {
  timeout: 240000,
}, async ({ kind, variance }) => {
  const make = (reference: boolean) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x405060);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(5, 5, 7);
    camera.lookAt(0, 0.5, 0);
    const material = new THREE.MeshStandardMaterial({ color: 0xc0b090, roughness: 1 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), material);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2, 1.5), material);
    cube.position.y = 1;
    cube.castShadow = cube.receiveShadow = true;
    const constructors = reference
      ? { directional: DirectionalLight, point: PointLight, spot: SpotLight }
      : { directional: THREE.DirectionalLight, point: THREE.PointLight, spot: THREE.SpotLight };
    const sun = new constructors[kind](0xffffff, kind === 'directional' ? 3 : 200);
    sun.position.set(-3, 6, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(testQuality.shadowMapSize, testQuality.shadowMapSize);
    sun.shadow.bias = -0.001;
    scene.add(ground, cube, sun);
    return { scene, camera, material, cube, sun };
  };
  const native = make(false),
    reference = make(true);
  const renderer = rendererFor();
  const original = new OriginalRenderer();
  renderer.shadowMap.enabled = original.shadowMap.enabled = true;
  renderer.shadowMap.type = original.shadowMap.type = variance
    ? THREE.VSMShadowMap
    : THREE.PCFShadowMap;
  original.setSize(SIZE, SIZE);
  const target = new RenderTarget(SIZE, SIZE);
  original.setOutputRenderTarget(target);
  try {
    await renderer.init();
    await original.init();
    expect((original.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend).toBe(true);
    const device = (original.backend as unknown as { device: GPUDevice }).device;
    const frame = async (name: string, frames = 1) => {
      await readyFrames(renderer, native.scene, native.camera, frames);
      const capture = await renderer.captureFrame(native.scene, native.camera);
      // Native ready frames plus capture each submit; advance the independent
      // renderer through the same ready-frame count, including resize admission.
      for (let index = 0; index < frames + 1; index++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        device.pushErrorScope('validation');
        original.render(reference.scene, reference.camera);
        expect((await device.popErrorScope())?.message ?? null).toBeNull();
      }
      const pixels = new Uint8Array(
        await original.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE),
      );
      await saveBrowserEvidence(
        `shadow-update-${kind}${variance ? '-variance' : ''}-${name}`,
        capture,
        pixels,
      );
      comparePixels(displayPixels(capture), pixels);
      if (name.startsWith('frozen')) {
        const works = buildFrameModel(decodeTape(capture.tape.bytes).unwrap()).works;
        expect(
          works.filter((work) =>
            JSON.stringify(work.pipeline?.descriptor).includes('default-shadow-caster'),
          ),
        ).toHaveLength(0);
      }
      return capture;
    };
    await frame('initial', 60);
    for (const f of [native, reference]) {
      f.sun.shadow.autoUpdate = false;
      f.cube.position.x = 1.8;
    }
    const frozen = await frame('frozen-caster');
    await verifyReplay(frozen);
    for (const f of [native, reference]) {
      f.sun.position.x = 1;
    }
    await frame('frozen-light');
    for (const f of [native, reference])
      f.sun.shadow.mapSize.set(testQuality.shadowMapSize, testQuality.shadowMapSize / 2);
    await frame('frozen-resize');
    // r184 retains stale GPU views after a live allocation resize. Restore
    // the admitted extent here; fresh rectangular maps are covered separately.
    for (const f of [native, reference])
      f.sun.shadow.mapSize.set(testQuality.shadowMapSize, testQuality.shadowMapSize);
    for (const f of [native, reference]) f.sun.shadow.needsUpdate = true;
    const updated = await frame('requested');
    expect(native.sun.shadow.needsUpdate).toBe(false);
    expect(reference.sun.shadow.needsUpdate).toBe(false);
    expect(displayPixels(updated)).not.toEqual(displayPixels(frozen));
    await verifyReplay(updated);
    for (const f of [native, reference]) f.cube.position.x = -1;
    await frame('frozen-again');
    for (const f of [native, reference]) f.sun.shadow.autoUpdate = true;
    await frame('automatic');
  } finally {
    original.dispose();
    target.dispose();
    native.material.dispose();
    reference.material.dispose();
  }
});
