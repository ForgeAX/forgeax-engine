import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  ClippingPlanes,
  clippingPlanesData,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { testAssets } from './helpers/runtime-assets';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const SIZE = 64;
const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());

/**
 * A closed box cut by a camera plane: without caps the cut shows the hollow
 * inside (back faces are culled, so the clear color shows through); with
 * ClippingPlanes.caps the back faces seen through the cut shade as the plane.
 * Both geometry lanes and both render paths share the cap.
 */
it('caps clipped closed Standard meshes in forward and deferred, direct and GPU-driven', {
  timeout: 180_000,
}, async () => {
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  const canvas = {
    width: SIZE,
    height: SIZE,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        device = options.device;
        target?.destroy();
        target = options.device.createTexture({
          size: [SIZE, SIZE],
          format: options.format,
          usage: 0x11,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
  };
  const host = renderValue(
    await constructRuntimeRendererHost(canvas, {}, { shaderManifestUrl: manifestUrl }),
  );
  const { renderer } = host;
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  try {
    const world = new World();
    const camera = world
      .spawn(
        { component: Transform, data: {} },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            aspect: 1,
            near: 0.1,
            far: 30,
            antialias: 0,
            bloom: 0,
            tonemap: 1,
            clearColor: [0, 0, 0, 1],
          } as never,
        },
        { component: ClippingPlanes, data: clippingPlanesData({ planes: [] }) },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -6] } },
        {
          component: MeshFilter,
          data: {
            assetHandle: testAssets(world)
              .create(createBoxGeometry(2, 2, 6).unwrap())
              .unwrap(),
          },
        },
        {
          component: MeshRenderer,
          data: {
            materials: [
              testAssets(world)
                .create(Materials.standard({ baseColor: [0.9, 0.15, 0.1, 1], roughness: 0.6 }))
                .unwrap(),
            ],
          },
        },
      )
      .unwrap();
    world
      .spawn({ component: DirectionalLight, data: { direction: [0, 0, -1], intensity: 3 } })
      .unwrap();
    const lease = renderValue(renderer.attach(world));
    const read = async (x: number): Promise<[number, number, number]> => {
      if (device === undefined || target === undefined) throw new Error('no target');
      const bytesPerRow = 256;
      const buffer = device.createBuffer({ size: bytesPerRow * SIZE, usage: 0x0001 | 0x0008 });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [SIZE, SIZE, 1]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(0x0001);
      const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      buffer.destroy();
      const o = (SIZE / 2) * bytesPerRow + x * 4;
      const bgra = target.format.startsWith('bgra');
      return [
        (bytes[o + (bgra ? 2 : 0)] as number) / 255,
        (bytes[o + 1] as number) / 255,
        (bytes[o + (bgra ? 0 : 2)] as number) / 255,
      ];
    };
    const frame = async (caps: boolean, direct: boolean) => {
      world.set(
        camera,
        ClippingPlanes,
        // Clips z > -6: the near half of the box, which faces the camera.
        clippingPlanesData({ planes: [[0, 0, -1, -6]], caps }) as never,
      );
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      for (let frame = 0; frame < 3; frame++)
        await drawReadyFrame(renderer, {
          leases: [lease],
          camera: { lease },
          environment: { lease },
          ...(direct ? { geometryLane: 'direct' as const } : {}),
        });
      // Center: the far wall; x = 40: the band where only the inner side walls
      // (normals across the light) show through the cut, unless it is capped.
      return { center: await read(SIZE / 2), band: await read(40) };
    };
    const profile = renderer.inspect().profile;
    for (const renderPath of ['forward', 'deferred'] as const) {
      renderValue(renderer.setProfile({ ...profile, renderPath, ssao: false }));
      for (const direct of [true, false]) {
        const open = await frame(false, direct);
        const capped = await frame(true, direct);
        const label = `${renderPath}/${direct ? 'direct' : 'gpu-driven'}`;
        expect(Math.max(...open.center), `${label} open cut shows the clear color`).toBeLessThan(
          0.05,
        );
        expect(Math.max(...open.band), `${label} open band shows the clear color`).toBeLessThan(
          0.05,
        );
        for (const [name, pixel] of Object.entries(capped)) {
          // Two-sided interior shading would leave the side-wall band unlit.
          expect(pixel[0], `${label} ${name} cap is lit red`).toBeGreaterThan(0.2);
          expect(pixel[0], `${label} ${name} cap keeps the material hue`).toBeGreaterThan(
            pixel[2] * 2,
          );
        }
        expect(Math.abs(capped.center[0] - capped.band[0]), `${label} one flat cap`).toBeLessThan(
          0.05,
        );
      }
    }
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    renderValue(await renderer.dispose());
    target?.destroy();
  }
});
