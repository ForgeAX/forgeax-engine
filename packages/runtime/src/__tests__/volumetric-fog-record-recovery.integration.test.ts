// @perf-budget-skip: intentional full Renderer submit-failure and LKG recovery integration gate.
import { World } from '@forgeax/engine-ecs';
import {
  BarrelDistortion,
  Camera,
  DepthOfField,
  DirectionalLight,
  perspective,
  TONEMAP_ACES_FILMIC,
  VolumetricFog,
} from '@forgeax/engine-render';
import type { CommandBuffer, RhiQueue } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi as nullRhi, RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { err, type Result, type TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  renderLifecycleManifestUrl,
  standardPbrManifestRow,
} from '../../../render/src/__tests__/shader-manifest-fixture';
import { createRenderer } from '../createRenderer';

const VOLUME_MANIFEST = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    entries: [
      { hash: 'pbr', wgsl: 'f_schlick', glsl: '', bindings: '' },
      { hash: 'unlit', wgsl: 'unlit', glsl: '', bindings: '' },
      { hash: 'tonemap', wgsl: 'struct TonemapParams {}', glsl: '', bindings: '' },
      { hash: 'volume-inject', wgsl: 'fn volume_inject() {}', glsl: '', bindings: '' },
      { hash: 'volume-integrate', wgsl: 'fn volume_integrate() {}', glsl: '', bindings: '' },
      { hash: 'volume-temporal', wgsl: 'fn volume_temporal() {}', glsl: '', bindings: '' },
      { hash: 'volume-composite', wgsl: 'fn volume_fs() {}', glsl: '', bindings: '' },
    ],
    materialShaders: [standardPbrManifestRow('f_schlick')],
  }),
)}`;

const VOLUME_FIXTURE_SURFACE = { width: 64, height: 64 } as const;
const VOLUME_LOGICAL_DEPTH = 64;
const VOLUME_FIXTURE_EXTENT = { ...VOLUME_FIXTURE_SURFACE, depth: VOLUME_LOGICAL_DEPTH } as const;
const VOLUME_FROXEL_XY_PACKING = 2;
const VOLUME_FROXEL_Z_PACKING = 4;
const VOLUME_FROXEL_BYTES_PER_TEXEL = 4;
const VOLUME_RESOLVED_XY_PACKING = 4;
const VOLUME_RESOLVED_BYTES_PER_PIXEL = 8;
const VOLUME_HISTORY_SLOT_COUNT = 2;
/** One scene block plus eleven owner blocks, each with nine vec4 lanes. */
const VOLUME_PARAMETER_BLOCK_COUNT = 1 + 11;
const VOLUME_PARAMETER_VEC4_COUNT = 9;
const VOLUME_PARAMETER_VEC4_BYTES = 4 * Float32Array.BYTES_PER_ELEMENT;

function canvas(): HTMLCanvasElement {
  return {
    width: VOLUME_FIXTURE_SURFACE.width,
    height: VOLUME_FIXTURE_SURFACE.height,
    getContext: () => null,
  } as unknown as HTMLCanvasElement;
}

function density(): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: VOLUME_FIXTURE_EXTENT },
    format: 'r8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(
      VOLUME_FIXTURE_EXTENT.width * VOLUME_FIXTURE_EXTENT.height * VOLUME_FIXTURE_EXTENT.depth,
    ).fill(32),
  };
}

function expectedVolumeResourceFacts(densityAsset: TextureAsset) {
  if (densityAsset.shape.viewDimension !== '3d') {
    throw new Error('the recovery fixture must use a 3D density texture');
  }
  const { width, height, depth } = densityAsset.shape.extent;
  if (depth !== VOLUME_LOGICAL_DEPTH) {
    throw new Error('the recovery fixture must use the documented logical volume depth');
  }
  const densityVoxelCount = width * height * depth;
  const densityBytesPerVoxel = densityAsset.data.byteLength / densityVoxelCount;
  const froxelWidth = Math.ceil(VOLUME_FIXTURE_SURFACE.width / VOLUME_FROXEL_XY_PACKING);
  const froxelHeight = Math.ceil(VOLUME_FIXTURE_SURFACE.height / VOLUME_FROXEL_XY_PACKING);
  const froxelDepth = Math.ceil(VOLUME_LOGICAL_DEPTH / VOLUME_FROXEL_Z_PACKING);
  const sampleCount = froxelWidth * froxelHeight * froxelDepth * VOLUME_FROXEL_Z_PACKING;
  const resolvedPixelCount =
    Math.ceil(VOLUME_FIXTURE_SURFACE.width / VOLUME_RESOLVED_XY_PACKING) *
    Math.ceil(VOLUME_FIXTURE_SURFACE.height / VOLUME_RESOLVED_XY_PACKING);
  const scratchBytes = froxelWidth * froxelHeight * froxelDepth * VOLUME_FROXEL_BYTES_PER_TEXEL;
  const currentBytes = resolvedPixelCount * VOLUME_RESOLVED_BYTES_PER_PIXEL;
  const historyBytes = currentBytes * VOLUME_HISTORY_SLOT_COUNT;
  const bufferBytes =
    VOLUME_PARAMETER_BLOCK_COUNT * VOLUME_PARAMETER_VEC4_COUNT * VOLUME_PARAMETER_VEC4_BYTES;
  return {
    sampleCount,
    resolvedPixelCount,
    currentBytes,
    historyBytes,
    scratchBytes,
    bufferBytes,
    totalBytes: currentBytes + historyBytes + scratchBytes + bufferBytes,
    densityBytesPerVoxel,
  };
}

function failingNullRhi(controller: { failNext: boolean; failEncode?: boolean }) {
  const adapter = new RhiNullAdapter();
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (options) => {
    const result = await requestDevice(options);
    if (!result.ok) return result;
    const createEncoder = result.value.createCommandEncoder.bind(result.value);
    result.value.createCommandEncoder = (descriptor) => {
      const encoded = createEncoder(descriptor);
      if (!encoded.ok) return encoded;
      const beginRenderPass = encoded.value.beginRenderPass.bind(encoded.value);
      encoded.value.beginRenderPass = (passDescriptor) => {
        if (controller.failEncode) {
          controller.failEncode = false;
          return err(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'render pass encoding succeeds',
              hint: 'the recovery regression intentionally rejects one encode',
            }),
          );
        }
        return beginRenderPass(passDescriptor);
      };
      return encoded;
    };
    const queue: RhiQueue = result.value.queue;
    const submit = queue.submit.bind(queue);
    queue.submit = (buffers: readonly CommandBuffer[]): Result<void, RhiError> => {
      if (controller.failNext) {
        controller.failNext = false;
        return err(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'queue submission to succeed',
            hint: 'the recovery regression intentionally rejects one submit',
          }),
        );
      }
      return submit(buffers);
    };
    return result;
  };
  return {
    ...nullRhi,
    requestAdapter: async () => ({ ok: true, value: adapter }),
  };
}

describe('volumetric fog record recovery projection', () => {
  it('keeps accepted LKG inspection on a failed submit and clears it after repair', async () => {
    const controller = { failNext: false };
    const created = await createRenderer(
      canvas(),
      { rhi: failingNullRhi(controller) as never },
      { shaderManifestUrl: VOLUME_MANIFEST },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const renderer = created.value;

    const world = new World();
    const densityAsset = density();
    const expectedFacts = expectedVolumeResourceFacts(densityAsset);
    const { densityBytesPerVoxel, ...expectedResourceFacts } = expectedFacts;
    const expectedDoubleBufferedFacts = {
      ...expectedResourceFacts,
      bufferBytes: expectedResourceFacts.bufferBytes * 2,
      totalBytes: expectedResourceFacts.totalBytes + expectedResourceFacts.bufferBytes,
    };
    const densityHandle = world.allocSharedRef('TextureAsset', densityAsset);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: {
            ...perspective({ fov: Math.PI / 4, aspect: 1 }),
            tonemap: TONEMAP_ACES_FILMIC,
          },
        },
      )
      .unwrap();
    const directionalLight = world
      .spawn({
        component: DirectionalLight,
        data: { direction: [-0.4, -0.8, -0.3], castShadow: true },
      })
      .unwrap();
    const fogEntity = world
      .spawn({
        component: VolumetricFog,
        data: {
          light: directionalLight,
          density: densityHandle,
          boundsMin: [-1, -1, -1],
          boundsMax: [1, 1, 1],
          extinction: [0.2, 0.2, 0.2],
          albedo: [0.8, 0.8, 0.8],
          emission: [0, 0, 0],
          anisotropy: 0,
          maxDistance: 50,
        },
      })
      .unwrap();
    expect(world.update(1 / 60).ok).toBe(true);

    const lease = renderer.attach(world);
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    const request = {
      leases: [lease.value],
      camera: { lease: lease.value },
      environment: { lease: lease.value },
    } as const;

    expect(renderer.draw(request).ok).toBe(true);
    const accepted = renderer.inspect().volumetricFog;
    expect(accepted).toMatchObject({
      status: 'available',
      ownerCount: 1,
      resourceStage: 'accepted',
      generation: 1,
      passCount: 4,
      sampleCount: expectedFacts.sampleCount,
      memoryBytes: expectedFacts.totalBytes,
      resourceFacts: expectedResourceFacts,
    });
    expect(densityBytesPerVoxel).toBe(1);
    const acceptedMemoryBytes = accepted.memoryBytes;

    controller.failNext = true;
    expect(renderer.draw(request).ok).toBe(false);
    expect(renderer.inspect().volumetricFog).toMatchObject({
      status: 'degraded',
      resourceStage: 'lkg',
      generation: 1,
      lkgGeneration: 1,
      candidateGeneration: 1,
      candidateFailure: 'submit-failed',
      passCount: 4,
      sampleCount: expectedFacts.sampleCount,
      memoryBytes: acceptedMemoryBytes,
      resourceFacts: expectedResourceFacts,
    });

    expect(renderer.draw(request).ok).toBe(true);
    expect(renderer.inspect().volumetricFog).toMatchObject({
      status: 'available',
      resourceStage: 'accepted',
      generation: 1,
      passCount: 4,
      sampleCount: expectedFacts.sampleCount,
      memoryBytes: expectedDoubleBufferedFacts.totalBytes,
      resourceFacts: expectedDoubleBufferedFacts,
      candidateFailure: undefined,
    });

    expect(renderer.draw(request).ok).toBe(true);
    expect(renderer.inspect().volumetricFog).toMatchObject({
      status: 'available',
      resourceStage: 'accepted',
      generation: 1,
      passCount: 4,
      sampleCount: expectedFacts.sampleCount,
      memoryBytes: expectedDoubleBufferedFacts.totalBytes,
      resourceFacts: expectedDoubleBufferedFacts,
      candidateFailure: undefined,
    });

    expect(world.removeComponent(fogEntity, VolumetricFog).ok).toBe(true);
    expect(world.update(1 / 60).ok).toBe(true);
    expect(renderer.draw(request).ok).toBe(true);
    expect(renderer.inspect().volumetricFog).toMatchObject({
      status: 'off',
      passCount: 0,
      sampleCount: 0,
      memoryBytes: 0,
    });
    expect((await renderer.dispose()).ok).toBe(true);
  });
});

it.each([
  'encode',
  'submit',
] as const)('rolls back a shared volume, DoF and barrel resize after %s failure, then accepts the retry', async (stage) => {
  const manifest = JSON.parse(
    decodeURIComponent(renderLifecycleManifestUrl().slice('data:application/json,'.length)),
  );
  const volume = JSON.parse(
    decodeURIComponent(VOLUME_MANIFEST.slice('data:application/json,'.length)),
  );
  manifest.entries.push(
    ...volume.entries.filter((entry: { hash: string }) => entry.hash.startsWith('volume-')),
  );
  manifest.entries.push({
    hash: 'fixture-dof',
    wgsl: '// DepthOfFieldParams',
    glsl: '',
    bindings: '[]',
  });
  const surface = canvas();
  const controller = { failNext: false, failEncode: false };
  const renderer = (
    await createRenderer(
      surface,
      { rhi: failingNullRhi(controller) as never },
      {
        shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`,
      },
    )
  ).unwrap();
  const world = new World();
  try {
    const attached = renderer.attach(world).unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: { ...perspective({ fov: Math.PI / 4, aspect: 1 }), tonemap: TONEMAP_ACES_FILMIC },
        },
        { component: DepthOfField, data: { focusDistance: 3, maxRadiusPixels: 4 } },
        { component: BarrelDistortion, data: { strength: 0.2 } },
      )
      .unwrap();
    const light = world
      .spawn({ component: DirectionalLight, data: { direction: [0, -1, -1], castShadow: true } })
      .unwrap();
    const texture = world.allocSharedRef('TextureAsset', density());
    const fog = world
      .spawn({
        component: VolumetricFog,
        data: {
          light,
          density: texture,
          boundsMin: [-1, -1, -1],
          boundsMax: [1, 1, 1],
          extinction: [0.2, 0.2, 0.2],
          albedo: [0.8, 0.8, 0.8],
        },
      })
      .unwrap();
    const request = {
      leases: [attached],
      camera: { lease: attached },
      environment: { lease: attached },
    };
    world.update(1 / 60).unwrap();
    const errors: unknown[] = [];
    renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    const firstResult = renderer.draw(request);
    expect(firstResult.ok, JSON.stringify(errors)).toBe(true);
    const first = firstResult.unwrap();
    expect(errors).toEqual([]);
    expect(first).toBeDefined();
    expect(
      renderer.inspect().perFramePassNames,
      JSON.stringify(renderer.inspect().perFramePassNames),
    ).toEqual(expect.arrayContaining(['volume-composite', 'dof-composite']));
    expect(first?.barrelDistortion?.strength).toBeCloseTo(0.2);
    const previousPasses = [...renderer.inspect().perFramePassNames];
    surface.width = 96;
    world.removeComponent(camera, DepthOfField).unwrap();
    world.removeComponent(fog, VolumetricFog).unwrap();
    world.set(camera, BarrelDistortion, { strength: 0.3 }).unwrap();
    world.update(1 / 60).unwrap();
    controller.failNext = stage === 'submit';
    controller.failEncode = stage === 'encode';
    expect(renderer.draw(request).ok).toBe(false);
    expect(controller.failNext).toBe(false);
    expect(controller.failEncode).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    expect(
      renderer.inspect().perFramePassNames,
      JSON.stringify(renderer.inspect().perFramePassNames),
    ).toEqual(previousPasses);
    const retry = renderer.draw(request).unwrap();
    expect(retry?.barrelDistortion?.strength).toBeCloseTo(0.3);
    expect(retry?.barrelDistortion?.width).toBe(96);
    expect(renderer.inspect().perFramePassNames).not.toContain('volume-composite');
    expect(renderer.inspect().perFramePassNames).not.toContain('dof-composite');
    expect(renderer.draw(request).ok).toBe(true);
  } finally {
    await renderer.dispose();
  }
});
