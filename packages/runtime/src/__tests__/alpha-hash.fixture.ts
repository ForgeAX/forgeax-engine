import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  DynamicResolution,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  type RenderResult,
} from '@forgeax/engine-render';
import type { EncodedTape, RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MaterialValue, TextureAsset } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };

export const ALPHA_HASH_SIZE = testQuality.squareSize;

function unwrap<T>(result: RenderResult<T, unknown> | undefined): T {
  if (result === undefined) throw new Error('Required Renderer operation unavailable');
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function statistics(values: readonly number[]) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { mean, variance: values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length };
}

/** Real Renderer path, shared by browser WebGPU and native Dawn. */
export async function verifyAlphaHash(
  renderer: Renderer,
  assets: AssetRegistry,
  options: {
    kind: 'standard' | 'unlit' | 'skin';
    taaScale?: number;
    taaRenderPath?: 'forward' | 'deferred';
    recorder?: RecorderAttachment;
    image?: (
      name: string,
      bytes: Uint8Array,
      metadata: { width: number; height: number; format: string; bytesPerRow: number },
    ) => void;
    capture?: (tape: EncodedTape, live: readonly number[]) => Promise<void>;
    captureIndependent?: (tape: EncodedTape) => void;
  },
) {
  const world = new World({ assets });
  const lease = unwrap(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  let geometry = createPlaneGeometry(4, 4).unwrap();
  if (options.kind === 'skin') {
    const positions = geometry.attributes.position;
    if (!(positions instanceof Float32Array)) throw new Error('Missing plane positions');
    const count = positions.length / 3;
    const attributes = {
      ...geometry.attributes,
      skinIndex: new Uint16Array(count * 4),
      skinWeight: Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
    };
    geometry = {
      ...geometry,
      attributes,
      vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
    };
  }
  const mesh = assets.create(geometry).unwrap();
  const material = (
    alpha: number,
    hash = true,
    queue = 2000,
    baseColorTexture?: MaterialValue,
    alphaTexture?: MaterialValue,
  ) => {
    const asset =
      options.kind !== 'unlit'
        ? Materials.standard({
            baseColor: [0, 0, 0, alpha],
            emissive: [1, 1, 1],
            emissiveIntensity: 1,
            specular: 0,
            ...(alphaTexture === undefined ? {} : { alphaTexture, alphaChannel: 3 }),
            alphaHash: hash,
            queue,
            ...(baseColorTexture === undefined ? {} : { baseColorTexture }),
            renderState: { cullMode: 'none' },
          })
        : Materials.unlit([1, 1, 1, alpha], {
            alphaHash: hash,
            queue,
            ...(baseColorTexture === undefined ? {} : { baseColorTexture }),
            renderState: { cullMode: 'none' },
          });
    if (asset.passes === undefined) throw new Error('material root passes are required');
    return assets
      .create(
        options.kind === 'skin'
          ? {
              ...asset,
              passes: asset.passes.map((pass) => ({
                ...pass,
                program: {
                  ...pass.program,
                  module:
                    pass.program.module === 'forgeax_material::standard'
                      ? 'forgeax::pbr-skin'
                      : pass.program.module,
                },
              })) as unknown as NonNullable<typeof asset.passes>,
            }
          : asset,
      )
      .unwrap();
  };
  const object = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material(0.5)] } },
    )
    .unwrap();
  if (options.kind === 'skin') {
    const joint = world.spawn({ component: Transform, data: {} }).unwrap();
    const inverseBindMatrices = new Float32Array(16);
    for (const lane of [0, 5, 10, 15]) inverseBindMatrices[lane] = 1;
    const skeleton = assets
      .create({
        kind: 'skeleton',
        jointCount: 1,
        inverseBindMatrices,
        bounds: new Float32Array([-2, -2, -0.1, 2, 2, 0.1]),
      })
      .unwrap();
    world
      .addComponent(object, {
        component: Skin,
        data: { skeleton, joints: new Uint32Array([joint]) },
      })
      .unwrap();
  }
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
          near: 0.1,
          far: 10,
          aspect: 1,
          antialias: 0,
          tonemap: 1,
          bloom: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0.7, 0, -1],
        intensity: 1,
        castShadow: true,
        mapSize: testQuality.shadowMapSize,
        cascadeCount: 1,
        shadowDistance: 10,
      },
    })
    .unwrap();
  const profile = renderer.inspect().profile;
  unwrap(renderer.setProfile({ ...profile, renderPath: 'forward', ssao: false }));
  let completedFrames = 0;
  const sample = async (capture = false, final = false, imageName?: string) => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const domain = final ? 'linear-ldr' : 'linear-hdr';
    const pending = capture ? options.recorder?.captureFrame() : undefined;
    if (pending !== undefined && options.recorder !== undefined)
      (await options.recorder.frameBoundary()).unwrap();
    const frame = await drawReadyFrame(
      renderer,
      { leases: [lease], camera: { lease }, environment: { lease } },
      [domain],
    );
    completedFrames++;
    if (pending !== undefined && options.recorder !== undefined)
      (await options.recorder.frameBoundary()).unwrap();
    const observation = unwrap(
      await renderer.observe(frame, { include: [domain] }),
    ).observations?.find((entry) => entry.domain === domain);
    if (observation === undefined) throw new Error(`Missing ${domain} observation`);
    if (imageName !== undefined)
      options.image?.(imageName, observation.bytes, observation.metadata);
    const data = new DataView(
      observation.bytes.buffer,
      observation.bytes.byteOffset,
      observation.bytes.byteLength,
    );
    const pixels: number[] = [];
    for (let y = 16; y < ALPHA_HASH_SIZE - 16; y++)
      for (let x = 16; x < ALPHA_HASH_SIZE - 16; x++) {
        const offset = y * observation.metadata.bytesPerRow;
        if (observation.metadata.format === 'rgba16float') {
          const bits = data.getUint16(offset + x * 8, true);
          const exponent = (bits >>> 10) & 31;
          pixels.push(
            (bits & 0x8000 ? -1 : 1) *
              (exponent === 0
                ? (bits & 1023) * 2 ** -24
                : (1 + (bits & 1023) / 1024) * 2 ** (exponent - 15)),
          );
        } else {
          pixels.push(data.getUint8(offset + x * 4) / 255);
        }
      }
    if (pending !== undefined) await options.capture?.((await pending).unwrap(), pixels);
    return pixels;
  };
  try {
    const coverage = [];
    for (const alpha of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      world.set(object, MeshRenderer, { materials: [material(alpha)] }).unwrap();
      const pixels = await sample(alpha === 0.5);
      const stats = statistics(pixels);
      expect(
        Math.abs(stats.mean - alpha),
        `coverage alpha=${alpha}: ${JSON.stringify(stats)}`,
      ).toBeLessThan(0.045);
      if (alpha === 0 || alpha === 1) expect(stats.variance).toBeLessThan(0.00001);
      coverage.push({ alpha, ...stats });
    }
    world.set(object, MeshRenderer, { materials: [material(0.5, false)] }).unwrap();
    const disabled = statistics(await sample());
    expect(disabled.mean).toBe(1);
    expect(disabled.variance).toBe(0);
    const fenceTexture: TextureAsset = {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array([
        255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0,
      ]),
    };
    const texture = assets.create(fenceTexture).unwrap();
    world
      .set(object, MeshRenderer, {
        materials: [material(0.5, true, 2000, { texture: texture as never })],
      })
      .unwrap();
    const fence = statistics(await sample());
    expect(Math.abs(fence.mean - 0.25)).toBeLessThan(0.045);
    let independentAlpha: ReturnType<typeof statistics> | undefined;
    if (options.kind !== 'unlit') {
      world
        .set(object, MeshRenderer, {
          materials: [material(0.5, true, 2000, undefined, { texture: texture as never })],
        })
        .unwrap();
      const pending =
        options.captureIndependent === undefined ? undefined : options.recorder?.captureFrame();
      if (pending !== undefined) (await options.recorder?.frameBoundary())?.unwrap();
      independentAlpha = statistics(await sample());
      if (pending !== undefined) {
        (await options.recorder?.frameBoundary())?.unwrap();
        options.captureIndependent?.((await pending).unwrap());
      }
      expect(Math.abs(independentAlpha.mean - 0.25)).toBeLessThan(0.045);
    }
    const positions = geometry.attributes.position;
    if (!(positions instanceof Float32Array)) throw new Error('Missing plane positions');
    const vertexCount = positions.length / 3;
    const coloredAttributes = {
      ...geometry.attributes,
      color: Float32Array.from({ length: vertexCount * 4 }, (_, i) => (i % 4 === 3 ? 0.5 : 1)),
    };
    const coloredMesh = assets
      .create({
        ...geometry,
        attributes: coloredAttributes,
        vertices: packInterleavedVertexAttributes(coloredAttributes, vertexCount).unwrap().vertices,
      })
      .unwrap();
    world.set(object, MeshFilter, { assetHandle: coloredMesh }).unwrap();
    world.set(object, MeshRenderer, { materials: [material(0.5)] }).unwrap();
    const vertexAlpha = statistics(await sample());
    expect(Math.abs(vertexAlpha.mean - 0.25)).toBeLessThan(0.045);
    world.set(object, MeshFilter, { assetHandle: mesh }).unwrap();
    const behind = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -0.5] } },
        {
          component: MeshFilter,
          data: {
            assetHandle: assets.create(createPlaneGeometry(4, 4).unwrap()).unwrap(),
          },
        },
        {
          component: MeshRenderer,
          data: {
            materials: [
              assets
                .create(
                  Materials.unlit([0.2, 0.2, 0.2, 1], {
                    queue: 2000,
                    renderState: { cullMode: 'none' },
                  }),
                )
                .unwrap(),
            ],
          },
        },
      )
      .unwrap();
    world.set(object, MeshRenderer, { materials: [material(0.5, true, 1990)] }).unwrap();
    const frontFirst = await sample();
    world.set(object, MeshRenderer, { materials: [material(0.5, true, 2010)] }).unwrap();
    expect(await sample()).toEqual(frontFirst);
    world.despawn(behind).unwrap();
    world.set(object, MeshRenderer, { materials: [material(0.5)] }).unwrap();
    // 2.5 / 128 gives a hash scale of exactly 1024: the CDF tail must
    // stay finite where the two logarithmic scales coincide.
    world.set(camera, Camera, { left: -1.25, right: 1.25 }).unwrap();
    const octave = statistics(await sample());
    expect(Math.abs(octave.mean - 0.5)).toBeLessThan(0.045);
    world.set(camera, Camera, { left: -1, right: 1 }).unwrap();
    const stationary = await sample();
    expect(await sample()).toEqual(stationary);
    // Forward and Deferred must commit the same mask from the shared Surface.
    if (options.kind !== 'unlit') {
      unwrap(renderer.setProfile({ ...profile, renderPath: 'deferred', ssao: false }));
      const deferred = await sample();
      expect(deferred.map((value) => value > 0.5)).toEqual(stationary.map((value) => value > 0.5));
      unwrap(renderer.setProfile({ ...profile, renderPath: 'forward', ssao: false }));
    }
    unwrap(
      renderer.setProfile({
        ...profile,
        renderPath: options.taaRenderPath ?? 'forward',
        ssao: false,
      }),
    );
    const noTaa = statistics(await sample(false, true, 'raw'));
    world.set(camera, Camera, { antialias: 3 }).unwrap();
    if (options.taaScale !== undefined)
      world
        .addComponent(camera, {
          component: DynamicResolution,
          data: { minScale: options.taaScale, maxScale: options.taaScale },
        })
        .unwrap();
    let accumulated = stationary;
    for (let i = 0; i < 60; i++)
      accumulated = await sample(
        options.taaRenderPath === 'deferred' && i === 59,
        true,
        i === 59 ? 'taa-60' : undefined,
      );
    const taa = statistics(accumulated);
    expect(taa.variance, `TAA ${JSON.stringify(taa)} vs raw ${JSON.stringify(noTaa)}`).toBeLessThan(
      noTaa.variance * 0.85,
    );
    const next = await sample(false, true);
    const temporalDelta =
      next.reduce((sum, value, i) => sum + Math.abs(value - (accumulated[i] ?? 0)), 0) /
      next.length;
    expect(temporalDelta).toBeLessThan(0.15);
    // Moving the camera changes sampling without globally reseeding the object.
    const movingMeans: number[] = [];
    for (let i = 0; i < 12; i++) {
      world.set(camera, Transform, { pos: [0.015 * (i + 1), 0, 3] }).unwrap();
      const moving = await sample(false, true, i === 11 ? 'camera-motion' : undefined);
      const mean = statistics(moving).mean;
      expect(Math.abs(mean - taa.mean)).toBeLessThan(0.15);
      movingMeans.push(mean);
    }
    // Fade-out must remove both current coverage and accumulated history.
    world.set(object, MeshRenderer, { materials: [material(0)] }).unwrap();
    let faded = next;
    for (let i = 0; i < 8; i++) faded = await sample(false, true);
    expect(statistics(faded).mean).toBeLessThan(0.03);
    expect(errors).toEqual([]);
    return {
      kind: options.kind,
      taaScale: options.taaScale ?? 1,
      taaRenderPath: options.taaRenderPath ?? 'forward',
      coverage,
      disabled,
      fence,
      independentAlpha,
      vertexAlpha,
      octave,
      noTaa,
      taa,
      temporalDelta,
      movingMeans,
      completedFrames,
    };
  } finally {
    unsubscribe();
    lease.dispose();
    unwrap(renderer.setProfile(profile));
  }
}
