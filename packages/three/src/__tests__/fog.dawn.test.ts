import * as THREE from '@forgeax/engine/three';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { displayPixels, readyFrames, SIZE, verifyReplay } from './render.fixture';

for (const law of ['linear', 'exp2'] as const)
  it(`projects ${law} fog through 60 native frames, edits, opt-out and removal`, {
    timeout: 120000,
  }, async () => {
    const target = offscreenCanvas(SIZE);
    const renderer = new THREE.WebGPURenderer({
      canvas: target.canvas as unknown as OffscreenCanvas,
      forgeax: {
        bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
      },
    });
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.z = 5;
    const material = new THREE.MeshBasicMaterial({ color: 0xe0a040 });
    const geometry = new THREE.PlaneGeometry(2, 2);
    scene.add(new THREE.Mesh(geometry, material));
    const fog =
      law === 'linear' ? new THREE.Fog(0x204060, 2, 9) : new THREE.FogExp2(0x204060, 0.13);
    scene.fog = fog;
    const verify = async (fogged: boolean) => {
      await readyFrames(renderer, scene, camera, 1);
      const capture = await renderer.captureFrame(scene, camera);
      let opacity = 0;
      if (fogged) {
        if (fog instanceof THREE.Fog) {
          const t = Math.max(0, Math.min(1, (5 - fog.near) / (fog.far - fog.near)));
          opacity = t * t * (3 - 2 * t);
        } else opacity = 1 - Math.exp(-fog.density * fog.density * 25);
      }
      // Independent authored plane depth and Three's documented laws, followed
      // by one linear-to-sRGB output transform. No reference render/readback.
      const expected = material.color.clone().lerp(fog.color, opacity).convertLinearToSRGB();
      const pixels = displayPixels(capture),
        center = (SIZE * (SIZE / 2) + SIZE / 2) * 4;
      for (const [lane, value] of expected.toArray().entries())
        expect(
          Math.abs((pixels[center + lane] ?? 0) - Math.round(value * 255)),
        ).toBeLessThanOrEqual(2);
      await verifyReplay(capture, `fog-${law}`);
    };
    try {
      await renderer.init();
      await readyFrames(renderer, scene, camera, 60);
      await verify(true);
      fog.color.setHex(0x405080);
      if (fog instanceof THREE.Fog) {
        fog.near = 1;
        fog.far = 7;
      } else fog.density = 0.25;
      await verify(true);
      material.fog = false;
      await verify(false);
      scene.fog = null;
      material.fog = true;
      await verify(false);
    } finally {
      await renderer.dispose();
      geometry.dispose();
      material.dispose();
      target.destroy();
    }
  });
