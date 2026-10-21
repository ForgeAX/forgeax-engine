import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
  Fog,
  Materials,
  MeshFilter,
  MeshRenderer,
  TONEMAP_REINHARD,
} from '@forgeax/engine-render';
import { TransparentSort } from '@forgeax/engine-render/authoring';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { testAssets } from './helpers/runtime-assets';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { unwrap } from './specular-aa.fixture';

it.each(
  [false, true].flatMap((premultiplied) =>
    [false, true].flatMap((opaqueBack) =>
      [false, true].map((reverse) => ({ premultiplied, opaqueBack, reverse })),
    ),
  ),
)('offscreen Camera preserves HDR composition, sorting and Fog ($premultiplied, opaqueBack=$opaqueBack, reverse=$reverse)', async ({
  premultiplied,
  opaqueBack,
  reverse,
}) => {
  const surface = offscreenCanvas(32);
  const host = unwrap(
    await constructRuntimeRendererHost(
      surface.canvas as unknown as HTMLCanvasElement,
      { rhi: webgpu.rhi },
      { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
    ),
  );
  const renderer = host.renderer;
  const target = unwrap(
    renderer.createRenderTarget({
      shape: '2d',
      width: 32,
      height: 32,
      format: 'rgba16float',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: true,
    }),
  );
  const world = new World();
  TransparentSort.configure(world, { mode: TransparentSort.distance, yzAlpha: 1 }).unwrap();
  const cameraZ = reverse ? -6 : 0;
  const values = {
    fov: Math.PI / 3,
    aspect: 1,
    near: 0.1,
    far: 30,
    antialias: 0,
    bloom: 0,
    tonemap: TONEMAP_REINHARD,
    clearColor: [0, 0, 0, 0] as const,
  };
  world.spawn({ component: Transform, data: {} }, { component: Camera, data: values }).unwrap();
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, cameraZ], quat: reverse ? [0, 1, 0, 0] : [0, 0, 0, 1] },
      },
      {
        component: Camera,
        data: { ...values, target: world.allocSharedRef('RenderTarget', target) },
      },
    )
    .unwrap();
  const planes = [
    { z: -4, color: [0.1, 2, 0.5], alpha: opaqueBack ? 1 : 0.35 },
    { z: -2, color: [4, 0.4, 0.1], alpha: 0.4 },
  ];
  for (const { z, color, alpha } of planes) {
    const mesh = testAssets(world).create(createPlaneGeometry(10, 10).unwrap()).unwrap();
    const material = testAssets(world)
      .create(
        Materials.unlit(
          [...color.map((v) => v * (premultiplied ? alpha : 1)), alpha] as [
            number,
            number,
            number,
            number,
          ],
          {
            queue: alpha === 1 ? 2000 : 3000,
            renderState: {
              cullMode: 'none',
              depthWriteEnabled: alpha === 1,
              ...(alpha === 1
                ? {}
                : {
                    blend: {
                      color: {
                        srcFactor: premultiplied ? 'one' : 'src-alpha',
                        dstFactor: 'one-minus-src-alpha',
                        operation: 'add',
                      },
                      alpha: {
                        srcFactor: 'one',
                        dstFactor: 'one-minus-src-alpha',
                        operation: 'add',
                      },
                    },
                  }),
            },
          },
        ),
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, z] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  }
  const fog = world
    .spawn({ component: Fog, data: { color: [0.3, 0.4, 0.5], density: 0, heightFalloff: 0 } })
    .unwrap();
  const lease = unwrap(renderer.attach(world));
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = unwrap(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    );
    unwrap(await receipt.completed);
    return receipt;
  };
  try {
    for (const density of [0, 0.08]) {
      world.set(fog, Fog, { density }).unwrap();
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      await drawReadyFrame(renderer, {
        leases: [lease],
        camera: { lease },
        environment: { lease },
      });
      const ticket = unwrap(renderer.requestTargetReadback(target, { mipLevel: 0 }));
      const receipt = await draw();
      const observed = unwrap(
        await renderer.observe(receipt, {
          include: ['target-readbacks'],
          targetReadbacks: [ticket],
        }),
      );
      const result = observed.targetReadbacks?.[0];
      if (result === undefined) throw new Error('Missing transparent target readback');
      const data = new DataView(
        result.bytes.buffer,
        result.bytes.byteOffset,
        result.bytes.byteLength,
      );
      const expected = [0, 0, 0, 0];
      // Independent ray-distance fog and back-to-front over operator, before tone/output.
      const rayLength = Math.hypot(
        (1 / 32) * Math.tan(Math.PI / 6),
        (1 / 32) * Math.tan(Math.PI / 6),
        1,
      );
      for (const plane of planes
        .slice()
        .sort((a, b) => Math.abs(b.z - cameraZ) - Math.abs(a.z - cameraZ))) {
        const t = Math.exp(-density * Math.abs(plane.z - cameraZ) * rayLength);
        for (let c = 0; c < 3; c++)
          expected[c] =
            (expected[c] ?? 0) * (1 - plane.alpha) +
            ((plane.color[c] ?? 0) * t + ([0.3, 0.4, 0.5][c] ?? 0) * (1 - t)) * plane.alpha;
        expected[3] = (expected[3] ?? 0) * (1 - plane.alpha) + plane.alpha;
      }
      for (let c = 0; c < 4; c++)
        expect(
          halfFloat.f16ToF32(data.getUint16(16 * result.bytesPerRow + 16 * 8 + c * 2, true)),
        ).toBeCloseTo(expected[c] ?? 0, 2);
    }
  } finally {
    lease.dispose();
    unwrap(renderer.destroyRenderTarget(target));
    unwrap(await renderer.dispose());
    surface.destroy();
  }
}, 120_000);
