import * as THREE from '@forgeax/engine/three';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { displayPixels, readyFrames, SIZE, verifyReplay } from './render.fixture';

it('renders Matcap coverage through ordinary UVs, image edits, disposal and removal', {
  timeout: 120000,
}, async () => {
  const target = offscreenCanvas(SIZE);
  const renderer = new THREE.WebGPURenderer({
    canvas: target.canvas as unknown as OffscreenCanvas,
    forgeax: {
      bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
    },
  });
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  // Matcap image alpha is ignored. Opposite red/green mask lanes falsify the
  // wrong coverage channel independently of a reference renderer.
  const sphere = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1);
  const pixels = new Uint8Array([0, 255, 0, 255, 255, 0, 0, 255]);
  const mask = new THREE.DataTexture(pixels, 2, 1);
  sphere.needsUpdate = mask.needsUpdate = true;
  mask.channel = 1;
  mask.wrapS = THREE.RepeatWrapping;
  let uploads = 0;
  mask.onUpdate = () => {
    uploads++;
  };
  const material = new THREE.MeshMatcapMaterial({ matcap: sphere, alphaMap: mask, alphaTest: 0.5 });
  const geometry = new THREE.PlaneGeometry(2, 2),
    uv = geometry.getAttribute('uv').clone();
  for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
  geometry.setAttribute('uv1', uv);
  scene.add(new THREE.Mesh(geometry, material));
  const check = async (left: boolean, right: boolean) => {
    await readyFrames(renderer, scene, camera, 1);
    const capture = await renderer.captureFrame(scene, camera),
      bytes = displayPixels(capture);
    for (const [x, visible] of [
      [48, left],
      [80, right],
    ] as const) {
      const offset = (64 * SIZE + x) * 4;
      expect(bytes[offset + 3]).toBe(visible ? 255 : 0);
      expect(bytes[offset]).toBe(visible ? 255 : 0);
    }
    return capture;
  };
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    await check(true, false);
    expect(uploads).toBe(1);
    mask.offset.x = 0.5;
    await check(false, true);
    expect(uploads).toBe(1);
    pixels.set([255, 0, 0, 255, 0, 255, 0, 255]);
    mask.needsUpdate = true;
    await check(true, false);
    expect(uploads).toBe(2);
    mask.dispose();
    mask.needsUpdate = true;
    await check(true, false);
    expect(uploads).toBe(3);
    material.alphaMap = null;
    material.needsUpdate = true;
    const final = await check(true, true);
    await verifyReplay(final, 'matcap-alpha-removal');
  } finally {
    await renderer.dispose();
    geometry.dispose();
    material.dispose();
    sphere.dispose();
    mask.dispose();
    target.destroy();
  }
});
