import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { shaderManifestUrl } from '../../../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { createRenderer } from '../../../assembly/factory';
import { Camera, MeshFilter, MeshRenderer } from '../../../components';
import { Outline } from '../../../components/outline';
import { Materials } from '../../../materials';
import { editorAssistance } from '../state';

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

it.each([0, 2])('renders detached helpers, same-frame depth and independent outlines with AA=%s', {
  timeout: 120_000,
}, async (antialias) => {
  const manifest = await buildEngineShaderManifest();
  const url = shaderManifestUrl(manifest);
  let target: GPUTexture | undefined;
  const canvas = {
    width: 128,
    height: 128,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        target = options.device.createTexture({
          size: [128, 128],
          format: options.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
  };
  const renderer = await createRenderer(canvas, { rhi: webgpu.rhi }, { shaderManifestUrl: url });
  const errors: unknown[] = [];
  renderer.onError((error) => errors.push(error));
  try {
    value(await renderer.initialization);
    const world = new World({ assets: renderer.assetRegistry });
    const mesh = renderer.assetRegistry.create(createBoxGeometry(1.5, 1.5, 1.5).unwrap()).unwrap();
    const material = renderer.assetRegistry.create(Materials.unlit([0.2, 0.2, 0.2, 1])).unwrap();
    const cube = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            aspect: 1,
            near: 0.1,
            far: 50,
            antialias,
            tonemap: 0,
            clearColor: [0, 0, 0, 1],
          },
        },
        { component: Outline, data: { entities: [cube], visibleColor: [0, 0, 1], width: 2 } },
      )
      .unwrap();
    propagateTransforms(world);
    const lease = value(renderer.attach(world));
    const owner = {},
      assistance = editorAssistance(world);
    const draw = async (observe = false) => {
      const deadline = Date.now() + 15_000;
      do {
        if (observe) {
          const armed = renderer.requestObservation?.(['final-display']);
          if (armed === undefined) throw new Error('No observation capability');
          value(armed);
        }
        const draw = renderer.draw({ source: lease });
        if (!draw.ok) throw new Error(JSON.stringify(errors), { cause: draw.error });
        const receipt = draw.value;
        if (receipt === undefined) throw new Error('Scene draw returned no receipt');
        value(await receipt.completed);
        if (receipt.presentation === 'ready') return receipt;
        if (observe)
          value(await renderer.observe(receipt, { include: receipt.observationDomains ?? [] }));
        await new Promise((resolve) => setTimeout(resolve, 16));
      } while (Date.now() < deadline);
      throw new Error(`No ready editor frame: ${JSON.stringify(errors)}`);
    };
    const redPixels = async () => {
      const receipt = await draw(true);
      const observation = value(
        await renderer.observe(receipt, { include: ['final-display'] }),
      ).observations?.find((row) => row.domain === 'final-display');
      if (!observation) throw new Error('Missing final-display observation');
      let count = 0;
      const { bytesPerRow, width, height, format } = observation.metadata;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const offset = y * bytesPerRow + x * 4,
            red = observation.bytes[offset + (format.startsWith('bgra') ? 2 : 0)] ?? 0;
          if (
            red > 200 &&
            (observation.bytes[offset + 1] ?? 0) < 50 &&
            (observation.bytes[offset + (format.startsWith('bgra') ? 0 : 2)] ?? 0) < 50
          )
            count++;
        }
      return count;
    };
    await draw();
    expect(renderer.perFramePassNames.some((name) => name.includes('editor-'))).toBe(false);
    assistance.configure({ enabled: true, camera }).unwrap();
    const line = {
      kind: 'line' as const,
      start: [-0.4, 0, -1] as const,
      end: [0.4, 0, -1] as const,
      color: [1, 0, 0, 1] as const,
    };
    assistance.contribute(owner, [{ ...line, depth: 'always' }]).unwrap();
    expect(await redPixels()).toBeGreaterThan(12);
    assistance.contribute(owner, [{ ...line, depth: 'occluded' }]).unwrap();
    expect(await redPixels()).toBe(0);
    const transform = mat4.identity(mat4.create());
    transform[14] = 2;
    assistance
      .contribute(owner, [
        {
          kind: 'mesh',
          mesh,
          transform: Array.from(transform),
          color: [1, 0, 0, 1],
          depth: 'always',
          action: { kind: 'entity', entity: cube },
        },
      ])
      .unwrap();
    expect(await redPixels()).toBeGreaterThan(100);
    assistance.select([cube]).unwrap();
    const receipt = await draw();
    expect(receipt.editorAssistance?.sourceIdentity).toBe(world.identity);
    expect(renderer.perFramePassNames).toContain('editor-outline-selection');
    expect(renderer.perFramePassNames).not.toContain('outline-selection');
    expect(Array.from(world.get(camera, Outline).unwrap().visibleColor)).toEqual([0, 0, 1]);
    for (let frame = 0; frame < 60; frame++) await draw();
    assistance.clear();
    await draw();
    expect(renderer.perFramePassNames.some((name) => name.includes('editor-'))).toBe(false);
    expect(renderer.perFramePassNames).toContain('outline-selection');
    expect([...world.query({ with: [Transform] }).unwrap()]).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally {
    await renderer.dispose();
    target?.destroy();
  }
});
