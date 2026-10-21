import { WebGPURenderer } from '@forgeax/engine/three';
import OriginalRenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';
import { AmbientLight, DirectionalLight, RenderTarget } from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { verifyFlatShading } from './flat-shading.fixture';
import { SIZE } from './render.fixture';
import { verifyTextures } from './texture.fixture';

it.each([
  ['textures', verifyTextures],
  ['flat shading', verifyFlatShading],
] as const)(
  'matches independently authored r184 WebGPU inputs: %s',
  {
    timeout: 120000,
  },
  async (_name, verify) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    document.body.append(canvas);
    const renderer = new WebGPURenderer({ canvas });
    try {
      await verify(
        renderer,
        async (scene, camera) => {
          // r184's RenderObject material key omits Texture.channel, so a reused
          // reference can keep its first UV node even after material.needsUpdate.
          // Each reference is an independently authored input. Native mutations
          // still reuse one renderer and retain their identity/replay assertions.
          const original = new OriginalRenderer({ alpha: true, antialias: false });
          const reference = scene.clone();
          // LightsNode dispatches on constructor identity. Keep the reference
          // light in upstream's family, separate from the bundled facade family.
          for (const child of [...reference.children]) {
            if (child.type === 'AmbientLight') {
              reference.remove(child);
              reference.add(new AmbientLight().copy(child as AmbientLight));
            } else if (child.type === 'DirectionalLight') {
              reference.remove(child);
              reference.add(new DirectionalLight().copy(child as DirectionalLight));
            }
          }
          // Canvas-like unorm storage: the output node already encodes sRGB.
          const target = new RenderTarget(SIZE, SIZE);
          original.setSize(SIZE, SIZE);
          try {
            await original.init();
            expect((original.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend).toBe(true);
            original.setOutputRenderTarget(target);
            original.render(reference, camera);
            return new Uint8Array(
              await original.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE),
            );
          } finally {
            target.dispose();
            original.dispose();
          }
        },
        saveBrowserEvidence,
      );
    } finally {
      await renderer.dispose();
      canvas.remove();
    }
  },
);
