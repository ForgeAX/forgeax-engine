import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { rewriteShaderTemplateSources, shaderManifestUrl } from './shader-manifest-url.fixture';

const size = 48;

function unwrap<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

async function render(manifest: string, antialias: number) {
  let texture: GPUTexture | undefined;
  const canvas = {
    width: size,
    height: size,
    getContext: () => ({
      configure: (options: GPUCanvasConfiguration) => {
        texture?.destroy();
        texture = options.device.createTexture({
          size: [size, size],
          format: options.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure: () => {},
      getCurrentTexture: () => texture,
    }),
  };
  const recorder = attachRecorder(webgpu).unwrap();
  const { assets, renderer } = unwrap(
    await constructRuntimeRendererHost(
      canvas,
      { rhi: recorder.backend.rhi },
      { shaderManifestUrl: manifest },
    ),
  );
  const world = new World({ assets });
  const lease = unwrap(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  try {
    unwrap(
      renderer.setProfile({
        ...renderer.inspect().profile,
        renderPath: 'forward',
        ambientOcclusion: { enabled: false },
      }),
    );
    const mesh = assets.create(createBoxGeometry(1, 1.5, 1).unwrap()).unwrap();
    for (const [x, masked] of [
      [-0.6, false],
      [0.6, true],
    ] as const) {
      const material = assets
        .create(
          Materials.standard({
            baseColor: [0, 0, 0, masked ? 0.55 : 1],
            emissive: masked ? [0, 0.75, 0] : [0.75, 0, 0],
            emissiveIntensity: 1,
            specular: 0,
            alphaHash: masked,
          }),
        )
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: [x, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    }
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: {
            projection: 1,
            left: -1.6,
            right: 1.6,
            bottom: -1.6,
            top: 1.6,
            near: 0.1,
            far: 10,
            aspect: 1,
            antialias,
            tonemap: 0,
            bloom: 0,
            clearColor: [0, 0, 0, 1],
          },
        },
      )
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0.2, 0, -1], intensity: 1, castShadow: false },
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    await drawReadyFrame(renderer, { source: lease });
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const receipt = await drawReadyFrame(renderer, { source: lease }, ['linear-hdr']);
    (await recorder.frameBoundary()).unwrap();
    const encoded = (await capture).unwrap();
    const model = buildFrameModel(decodeTape(encoded.bytes).unwrap());
    const observation = unwrap(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations?.find((row) => row.domain === 'linear-hdr');
    if (observation === undefined) throw new Error('Missing complete Forward picture');
    expect(errors).toEqual([]);
    expect(observation.metadata).toMatchObject({ width: size, height: size });
    const pixel = new DataView(
      observation.bytes.buffer,
      observation.bytes.byteOffset,
      observation.bytes.byteLength,
    );
    const hdr = observation.metadata.format === 'rgba16float';
    const center = (size / 2) * observation.metadata.bytesPerRow + 14 * (hdr ? 8 : 4);
    expect(hdr ? pixel.getUint16(center, true) : pixel.getUint8(center)).toBeGreaterThan(0);
    return { model, pixels: observation.bytes };
  } finally {
    unsubscribe();
    lease.dispose();
    await renderer.dispose();
    (await recorder.dispose()).unwrap();
    texture?.destroy();
  }
}

it.each([
  ANTIALIAS_NONE,
  ANTIALIAS_MSAA,
])('keeps the Forward picture exact with position-only opaque depth and AA mode %s', {
  timeout: 180_000,
}, async (antialias) => {
  const manifest = await buildEngineShaderTemplateManifest();
  const full = rewriteShaderTemplateSources(manifest, (source) =>
    source.replace('fn vs_position_only(', 'fn vs_unused_position_only('),
  );
  expect(full.patched).toBeGreaterThan(0);
  const baseline = await render(shaderManifestUrl(full.manifest), antialias);
  const actual = await render(shaderManifestUrl(manifest), antialias);
  const positions = actual.model.works.filter((work) =>
    work.pipeline.shaders.some((shader) => shader.entryPoint === 'vs_position_only'),
  );
  const raster = actual.model.works
    .filter((work) => work.vertexBuffers.length > 0)
    .map((work) => ({
      entries: work.pipeline.shaders.map(({ entryPoint }) => entryPoint),
      ranges: work.vertexBuffers,
    }));
  expect(positions.length, JSON.stringify(raster)).toBeGreaterThan(0);
  for (const draw of positions) {
    expect(draw.pipeline.shaders.map((shader) => shader.stage)).toEqual(['vertex']);
    expect(draw.vertexBuffers.map(({ slot }) => slot)).toEqual([0]);
    expect(draw.vertexBuffers[0]?.size).toBe(24 * 12);
  }
  expect(
    actual.model.works.some((work) =>
      work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_depth_masked'),
    ),
  ).toBe(true);
  expect(equalBytes(baseline.pixels, actual.pixels)).toBe(true);
});
