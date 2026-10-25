import type { TextureAsset } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, withVertexColor } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { assert, expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRendererHost } from '../../../render/src/construct-renderer';
import {
  ANTIALIAS_TAA,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '../../../render/src/index';
import { installDefaultAssetDecoders } from '../asset-contributions';
import { loadBackendPack } from '../backend-selection';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifestUrl = shaderManifestUrl(
  await (await import('@forgeax/engine-vite-plugin-shader')).buildEngineShaderManifest(),
);
const SIZE = 128;
const FRAMES = 60;
// Both lanes run the same unlit program family; only the row address differs.
const EPSILON = 2 / 255;

function checker(alphaOnly: boolean): TextureAsset {
  const data = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < 64; i++) {
    const on = ((i % 8) + Math.floor(i / 8)) % 2 === 0;
    data.set(
      alphaOnly ? [255, 255, 255, on ? 255 : 0] : on ? [240, 200, 40, 255] : [30, 90, 220, 255],
      i * 4,
    );
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 8, height: 8 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data,
  };
}

it('renders opaque unlit rows identically from the GPU-driven lane and the direct lane', async () => {
  let target: GPUTexture | undefined;
  const canvas = {
    width: SIZE,
    height: SIZE,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        target?.destroy();
        target = config.device.createTexture({
          size: [SIZE, SIZE],
          format: config.format,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  const backend = await loadBackendPack();
  assert(backend.ok);
  const constructed = await constructRendererHost(
    canvas,
    {},
    { shaderManifestUrl: manifestUrl },
    backend.value,
  );
  assert(constructed.ok, constructed.ok ? undefined : JSON.stringify(constructed.error));
  const { renderer, assets } = constructed.value;
  const errors: unknown[] = [];
  const stop = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  try {
    installDefaultAssetDecoders(assets);
    const world = new World({ assets });
    const box = createBoxGeometry(1, 1, 1).unwrap();
    const plainBox = assets.create(box).unwrap();
    const coloredBox = assets.create(withVertexColor(box, [0.2, 0.9, 0.6, 1]).unwrap()).unwrap();
    const colorTexture = assets.create(checker(false)).unwrap();
    const alphaTexture = assets.create(checker(true)).unwrap();
    const rows: readonly (readonly [number, number, number, ReturnType<typeof assets.create>])[] = [
      [-2.4, 0.9, 0, assets.create(Materials.unlit([0.9, 0.2, 0.1, 1]))],
      [
        -0.8,
        0.9,
        0,
        assets.create(Materials.unlit([1, 1, 1, 1], { baseColorTexture: colorTexture })),
      ],
      [
        0.8,
        0.9,
        0,
        assets.create(
          Materials.unlit([0.2, 0.9, 0.3, 1], { alphaTexture, alphaChannel: 3, alphaCutoff: 0.5 }),
        ),
      ],
      [2.4, 0.9, 1, assets.create(Materials.unlit([1, 1, 1, 1]))],
      [-1.6, 2.4, 0, assets.create(Materials.normal())],
      [1.6, 2.4, 0, assets.create(Materials.unlit([0.4, 0.4, 0.9, 0.6], { alphaHash: true }))],
    ];
    const cameraData = {
      fov: Math.PI / 3,
      aspect: 1,
      near: 0.1,
      far: 60,
      antialias: 0,
      bloom: 0,
      tonemap: 0,
      clearColor: [0.05, 0.05, 0.05, 1],
    };
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 2.4, 7.5] } },
        { component: Camera, data: cameraData },
      )
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [-0.4, -1, -0.5],
          castShadow: true,
          mapSize: 256,
          cascadeCount: 1,
          shadowDistance: 30,
        },
      })
      .unwrap();
    const ground = assets.create(Materials.standard({ baseColor: [0.7, 0.7, 0.7, 1] })).unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, -0.1, 0], scale: [10, 0.2, 10] } },
        { component: MeshFilter, data: { assetHandle: plainBox } },
        { component: MeshRenderer, data: { materials: [ground] } },
      )
      .unwrap();
    for (const [x, y, colored, material] of rows)
      world
        .spawn(
          { component: Transform, data: { pos: [x, y, 0], quat: [0.2, 0.3, 0, 0.93] } },
          { component: MeshFilter, data: { assetHandle: colored ? coloredBox : plainBox } },
          { component: MeshRenderer, data: { materials: [material.unwrap()] } },
        )
        .unwrap();
    // An empty MeshRenderer selects the built-in Unlit fallback material.
    world
      .spawn(
        { component: Transform, data: { pos: [0, 3.6, -1], quat: [0.2, 0.3, 0, 0.93] } },
        { component: MeshFilter, data: { assetHandle: plainBox } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
    const attached = renderer.attach(world);
    assert(attached.ok);
    const lease = attached.value;
    const native = renderer.nativeDevice();
    assert(native.ok);
    const device = native.value;
    device.pushErrorScope('validation');
    const render = async (geometryLane: 'automatic' | 'direct') => {
      let frame: Awaited<ReturnType<typeof drawReadyFrame>> | undefined;
      for (let index = 0; index < FRAMES; index++) {
        world.update(1 / 60).unwrap();
        propagateTransforms(world).unwrap();
        frame = await drawReadyFrame(
          renderer,
          { leases: [lease], camera: { lease }, environment: { lease }, geometryLane },
          index === FRAMES - 1 ? ['linear-ldr'] : undefined,
        );
      }
      assert(frame);
      const observed = await renderer.observe(frame, { include: ['linear-ldr'] });
      assert(observed.ok);
      const image = observed.value.observations?.find((entry) => entry.domain === 'linear-ldr');
      assert(image && image.metadata.format === 'rgba16float');
      const half = new Uint16Array(
        image.bytes.buffer,
        image.bytes.byteOffset,
        image.bytes.byteLength / 2,
      );
      return {
        pixels: Float32Array.from(half, (bits) => halfFloat.f16ToF32(bits)),
        channels: renderer.inspect().renderScene.gpuDriven.channels,
      };
    };
    const gpu = await render('automatic');
    const direct = await render('direct');
    // Every row, unlit included, is claimed by the GPU-driven color and shadow lanes.
    const residual = (pass: string, run: typeof gpu) =>
      run.channels
        .filter((channel) => channel.viewPass === pass && channel.lane === 'gpu')
        .map((channel) => channel.residualDrawCount);
    expect(residual('main', gpu)).toEqual([0]);
    expect(residual('directional-shadow', gpu)).toEqual([0]);
    expect(
      direct.channels.some(
        (channel) => channel.viewPass === 'main' && channel.lane === 'gpu' && channel.drawCount > 0,
      ),
    ).toBe(false);
    let maxDelta = 0;
    let lit = 0;
    for (let index = 0; index < gpu.pixels.length; index++) {
      maxDelta = Math.max(
        maxDelta,
        Math.abs((gpu.pixels[index] ?? 0) - (direct.pixels[index] ?? 0)),
      );
      if (index % 4 !== 3 && (gpu.pixels[index] ?? 0) > 0.1) lit++;
    }
    expect(lit).toBeGreaterThan(SIZE * SIZE);
    expect(maxDelta).toBeLessThanOrEqual(EPSILON);
    // TAA adds the scene-index temporal producer for the same unlit batches.
    world.set(camera, Camera, { ...cameraData, antialias: ANTIALIAS_TAA }).unwrap();
    const temporal = await render('automatic');
    expect(residual('main', temporal)).toEqual([0]);
    expect(await device.popErrorScope()).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    stop();
    try {
      expect((await renderer.dispose()).ok).toBe(true);
    } finally {
      target?.destroy();
      assets.dispose();
    }
  }
}, 240_000);
