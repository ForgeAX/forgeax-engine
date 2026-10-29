import { mat4, vec3 } from '@forgeax/engine-math';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { RhiError, err as rhiErr, ok as rhiOk } from '@forgeax/engine-rhi';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import {
  createHdrpClusterMembershipBindGroupLayoutDescriptor,
  getOrCreateHdrpBuffers,
} from '../hdrp-buffers';
import { prepareStandardLighting } from '../pipeline/standard-lighting/prepare';
import { selectStandardClusterTransport } from '../pipeline/standard-lighting/transport';
import {
  COOKIE_MIP_LEVEL_COUNT,
  COOKIE_SLICE_MIP_CHAIN_BYTES,
} from '../prepare/extended-lighting/resources';
import {
  buildPerFrameBindGroups,
  writeHdrpClusterAndSsaoBuffers,
  writeLightModifierTextures,
} from '../record/frame-lighting';
import type { RenderFrameState } from '../record/frame-snapshot';
import { computeProjectionMatrix } from '../record/helpers';
import type {
  PipelineState,
  RenderSystemInternals,
  RenderSystemRuntime,
} from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import { getOrCreateSsaoBuffers } from '../ssao-buffers';
import { createTemporalView } from '../temporal/view';

function camera(): CameraSnapshot {
  return {
    position: vec3.create(0, 0, 5),
    world: mat4.create(),
    fov: Math.PI / 4,
    aspect: 1,
    near: 0.1,
    far: 100,
    projection: 'perspective',
    orthoLeft: -1,
    orthoRight: 1,
    orthoBottom: -1,
    orthoTop: 1,
    tonemap: 'none',
    exposure: 1,
    whitePoint: 4,
    antialias: 'none',
    bloom: 'off',
    bloomThreshold: 1,
    bloomIntensity: 1,
    bloomSmoothWidth: 0.01,
    bloomRadius: 0,
    clearColor: [0, 0, 0, 1],
  };
}

function internalsWithFirstWriteFailure() {
  const writes: string[] = [];
  const payloads = new Map<string, Uint8Array>();
  const errors: unknown[] = [];
  const device = {
    caps: { storageBuffer: true, compute: false, backendKind: 'webgpu' },
    limits: { maxStorageBufferBindingSize: 1024 * 1024 * 1024 },
    queue: {
      writeBuffer(buffer: { readonly label?: string }, _offset: number, data: ArrayBufferView) {
        const label = buffer.label ?? 'unknown';
        writes.push(label);
        payloads.set(label, new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
        return writes.length === 1
          ? rhiErr(
              new RhiError({
                code: 'webgpu-runtime-error',
                expected: 'upload succeeds',
                hint: 'test failure',
              }),
            )
          : rhiOk(undefined);
      },
      onSubmittedWorkDone: async () => undefined,
    },
    createBuffer: (descriptor: { readonly label?: string }) =>
      rhiOk({ label: descriptor.label } as never),
    createBindGroupLayout: () => rhiOk({} as never),
    destroyBuffer: () => rhiOk(undefined),
  } as unknown as RhiDevice;
  return {
    writes,
    payloads,
    errors,
    internals: {
      device,
      errorRegistry: { fire: (error: unknown) => errors.push(error) },
      standardProfile: undefined,
    },
  };
}

describe('Standard Cluster upload ownership', () => {
  it.each([
    'perspective',
    'orthographic',
    'stereo',
    'capture',
  ] as const)('uploads the sampled %s projection to SSAO before graph recording', async (kind) => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const errors: unknown[] = [];
    const internals = {
      device,
      errorRegistry: { fire: (error: unknown) => errors.push(error) },
    } as unknown as RenderSystemInternals;
    const sampledCamera: CameraSnapshot = {
      ...camera(),
      world: mat4.identity(mat4.create()),
      projection: kind === 'orthographic' ? 'orthographic' : 'perspective',
      ...(kind === 'stereo'
        ? { eye: { side: 'left' as const }, projectionOffset: [-0.04, 0] as const }
        : {}),
      ...(kind === 'capture'
        ? { captureProjection: mat4.orthographicReverseZ(mat4.create(), -2, 3, -4, 5, 0.3, 70) }
        : {}),
      temporal: createTemporalView({ antialias: 'taa', width: 320, height: 200, frameIndex: 3 }),
    };
    const prepared = prepareStandardLighting({
      directional: undefined,
      local: [],
      view: mat4.identity(mat4.create()),
      projection: computeProjectionMatrix(sampledCamera, mat4.create()),
      near: 0.1,
      far: 100,
      grid: { x: 2, y: 2, z: 2 },
      lightCount: 1,
      renderPath: 'forward',
    }).unwrap();
    const transport = selectStandardClusterTransport(
      { compute: false, storageBuffer: true, membershipPipelineReady: false },
      prepared,
    ).unwrap();
    const ssao = getOrCreateSsaoBuffers(internals);
    if (ssao === null) throw new Error('SSAO allocation failed');
    const writes = vi.spyOn(device.queue, 'writeBuffer');
    const result = writeHdrpClusterAndSsaoBuffers(
      internals,
      {
        hdrpClusterMembership: null,
        installedPipelineConfig: {
          ssao: {
            enabled: true,
            algorithm: 'gtao',
            quality: 'low',
            radius: 2,
            bias: 0.1,
            intensity: 0.75,
          },
        },
      } as unknown as RenderFrameState,
      sampledCamera,
      prepared,
      transport,
    );
    expect(result.ok).toBe(true);
    const upload = writes.mock.calls.find(([buffer]) => buffer === ssao.uniformBuffer);
    expect(upload).toBeDefined();
    const payload = upload?.[2] as Float32Array;
    const projection = computeProjectionMatrix(sampledCamera, mat4.create());
    const jitter = sampledCamera.temporal?.currentJitterUv;
    if (jitter === undefined) throw new Error('Expected sampled camera jitter');
    // Clip translation shifts x/w and y/w independently of lens or capture kind.
    const shift = mat4.identity(mat4.create());
    shift[12] = jitter[0] * 2;
    shift[13] = -jitter[1] * 2;
    const expected = mat4.multiply(mat4.create(), shift, projection);
    expect(payload.slice(16, 32)).toEqual(expected);
    expect(payload.slice(32, 48)).toEqual(mat4.invert(mat4.create(), expected));
    expect(Array.from(payload.slice(48, 53))).toEqual([0.75, 2, Math.fround(0.1), 4, 1]);
    expect(Array.from(payload.slice(53, 56))).toEqual([1, 1, 1]);
    expect(payload.slice(56).every((value) => value === 0)).toBe(true);
    expect(errors).toEqual([]);
    writes.mockRestore();
  });

  it('uploads Spot and Rect light textures as full mip chains and caches the content identity', () => {
    const cookieTexture = { label: 'fallback-cookie-array' };
    const cookieMatrixBuffer = { label: 'fallback-cookie-matrices' };
    const textureWrites: { destination: unknown; data: Uint8Array; size: unknown }[] = [];
    const bufferWrites: unknown[] = [];
    const cookieData = new Uint8Array(COOKIE_SLICE_MIP_CHAIN_BYTES);
    cookieData[0] = 0x12;
    const sourceTextureData = new Uint8Array(COOKIE_SLICE_MIP_CHAIN_BYTES);
    sourceTextureData[0] = 0x34;
    const cookieMatrix = new Float32Array(16);
    cookieMatrix[0] = 0.7;
    cookieMatrix[5] = 1;
    cookieMatrix[10] = 1;
    cookieMatrix[15] = 1;
    const internals = {
      device: {
        queue: {
          writeTexture(destination: unknown, data: Uint8Array, _layout: unknown, size: unknown) {
            textureWrites.push({ destination, data, size });
            return rhiOk(undefined);
          },
          writeBuffer(destination: unknown, offset: number, data: Float32Array) {
            bufferWrites.push({ destination, offset, data });
            return rhiOk(undefined);
          },
        },
      },
    } as unknown as RenderSystemInternals;
    const pipelineState = {
      iesProfileTexture: undefined,
      cookieTexture,
      cookieMatrixBuffer,
      spotModifierUploadState: undefined,
    } as unknown as PipelineState;
    const spot = {
      kind: 'spot' as const,
      cookieSlice: 0,
      cookieSource: { kind: 'mip-chain', data: cookieData },
      cookieMatrix,
    } as never;
    const rect = {
      kind: 'rect-area' as const,
      cookieSlice: 1,
      cookieSource: { kind: 'mip-chain', data: sourceTextureData },
    } as never;

    writeLightModifierTextures(internals, pipelineState, { point: [], spot: [spot], rect: [rect] });
    writeLightModifierTextures(internals, pipelineState, { point: [], spot: [spot], rect: [rect] });

    expect(textureWrites).toHaveLength(COOKIE_MIP_LEVEL_COUNT * 2);
    expect(bufferWrites).toHaveLength(1);
    expect(textureWrites[0]?.destination).toMatchObject({ mipLevel: 0, origin: { z: 0 } });
    expect(textureWrites[0]?.size).toMatchObject({ width: 256, height: 256 });
    expect(textureWrites[COOKIE_MIP_LEVEL_COUNT - 1]?.destination).toMatchObject({
      mipLevel: COOKIE_MIP_LEVEL_COUNT - 1,
    });
    expect(textureWrites[COOKIE_MIP_LEVEL_COUNT - 1]?.size).toMatchObject({ width: 1, height: 1 });
    expect(textureWrites[COOKIE_MIP_LEVEL_COUNT]?.destination).toMatchObject({
      mipLevel: 0,
      origin: { z: 1 },
    });
    expect(textureWrites[0]?.data[0]).toBe(0x12);
    expect(textureWrites[COOKIE_MIP_LEVEL_COUNT]?.data[0]).toBe(0x34);
    expect(textureWrites[0]?.data.byteLength).toBe(256 * 256 * 4);
    expect(bufferWrites[0]).toMatchObject({
      destination: cookieMatrixBuffer,
      offset: 0,
      data: cookieMatrix,
    });
    expect(pipelineState.spotModifierUploadState?.cookie.has(0)).toBe(true);
    expect(pipelineState.spotModifierUploadState?.cookie.has(1)).toBe(true);
    expect(pipelineState.spotModifierUploadState?.cookieMatrix.has(0)).toBe(true);
    expect(pipelineState.spotModifierUploadState?.cookieMatrix.has(1)).toBe(false);
  });

  it('reports an unavailable GPU resample once and leaves the slice white', () => {
    const textureWrites: { destination: unknown; data: Uint8Array }[] = [];
    const fired: unknown[] = [];
    const internals = {
      device: {
        caps: { compute: true },
        features: new Set<string>(),
        queue: {
          writeTexture(destination: unknown, data: Uint8Array) {
            textureWrites.push({ destination, data });
            return rhiOk(undefined);
          },
        },
      },
      errorRegistry: { fire: (error: unknown) => fired.push(error) },
    } as unknown as RenderSystemInternals;
    const pipelineState = {
      iesProfileTexture: undefined,
      cookieTexture: { label: 'fallback-cookie-array' },
      cookieMatrixBuffer: undefined,
      spotModifierUploadState: undefined,
    } as unknown as PipelineState;
    const rect = {
      kind: 'rect-area' as const,
      cookieSlice: 3,
      cookieSource: {
        kind: 'gpu-resample',
        asset: {
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
          format: 'bc7-rgba-unorm-srgb',
          colorSpace: 'srgb',
          mips: { kind: 'none' },
          data: new Uint8Array(16),
        },
      },
    } as never;

    writeLightModifierTextures(internals, pipelineState, { point: [], spot: [], rect: [rect] });
    writeLightModifierTextures(internals, pipelineState, { point: [], spot: [], rect: [rect] });

    expect(fired).toEqual([expect.objectContaining({ code: 'feature-not-enabled' })]);
    expect(textureWrites).toHaveLength(COOKIE_MIP_LEVEL_COUNT);
    expect(textureWrites[0]?.destination).toMatchObject({ mipLevel: 0, origin: { z: 3 } });
    expect(textureWrites.every(({ data }) => data.every((byte) => byte === 255))).toBe(true);
  });

  it('returns device-operation-failed instead of publishing after a required upload fails', () => {
    const source = {
      kind: 'point' as const,
      position: vec3.create(0, 0, -4),
      color: vec3.create(1, 1, 1),
      intensity: 1,
      invRangeSquared: 0.25,
      shadowAtlasLayer: -1,
    };
    const prepared = prepareStandardLighting({
      directional: undefined,
      local: [{ kind: 'point', shadowed: false, position: source.position, range: 2, source }],
      view: mat4.create(),
      projection: mat4.create(),
      near: 0.1,
      far: 100,
      grid: { x: 4, y: 3, z: 4 },
      lightCount: 1,
      renderPath: 'forward',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const transport = selectStandardClusterTransport(
      { compute: false, storageBuffer: true, membershipPipelineReady: false },
      prepared.value,
    );
    expect(transport.ok).toBe(true);
    if (!transport.ok) return;
    const { internals, writes, errors } = internalsWithFirstWriteFailure();
    const result = writeHdrpClusterAndSsaoBuffers(
      internals as never,
      { hdrpClusterMembership: null, installedPipelineConfig: undefined } as never,
      camera(),
      prepared.value,
      transport.value,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('device-operation-failed');
    expect(writes).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('rejects local lights without storage and performs no upload', () => {
    const source = {
      kind: 'point' as const,
      position: vec3.create(0, 0, -4),
      color: vec3.create(1, 1, 1),
      intensity: 1,
      invRangeSquared: 0.25,
      shadowAtlasLayer: -1,
    };
    const prepared = prepareStandardLighting({
      directional: undefined,
      local: [{ kind: 'point', shadowed: false, position: source.position, range: 2, source }],
      view: mat4.create(),
      projection: mat4.create(),
      near: 0.1,
      far: 100,
      grid: { x: 4, y: 3, z: 4 },
      lightCount: 1,
      renderPath: 'forward',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const transport = selectStandardClusterTransport(
      { compute: true, storageBuffer: false, membershipPipelineReady: false },
      prepared.value,
    );
    expect(transport.ok).toBe(false);
    if (transport.ok) return;
    expect(transport.error.code).toBe('standard-cluster-transport-unavailable');
  });

  it('grows the persistent bundle atomically and retires the old buffers after the fence', async () => {
    const adapter = new RhiNullAdapter();
    const deviceResult = await adapter.requestDevice();
    expect(deviceResult.ok).toBe(true);
    if (!deviceResult.ok) return;
    const baseDevice = deviceResult.value;
    let releaseFence!: () => void;
    const fence = new Promise<undefined>((resolve) => {
      releaseFence = () => resolve(undefined);
    });
    const device = {
      caps: baseDevice.caps,
      features: baseDevice.features,
      limits: baseDevice.limits,
      lost: baseDevice.lost,
      queue: {
        writeBuffer: baseDevice.queue.writeBuffer.bind(baseDevice.queue),
        onSubmittedWorkDone: () => fence,
      },
      createBuffer: baseDevice.createBuffer.bind(baseDevice),
      createBindGroupLayout: baseDevice.createBindGroupLayout.bind(baseDevice),
      destroyBuffer: baseDevice.destroyBuffer.bind(baseDevice),
    } as unknown as RhiDevice;
    const errors: unknown[] = [];
    const runtime = {
      device,
      errorRegistry: { fire: (error: unknown) => errors.push(error) },
    } as unknown as RenderSystemRuntime;

    const small = getOrCreateHdrpBuffers(runtime, { x: 2, y: 2, z: 2 });
    expect(small).not.toBeNull();
    if (small?.kind !== 'storage') throw new Error('Expected Standard storage allocation');
    expect(getOrCreateHdrpBuffers(runtime, { x: 1, y: 1, z: 1 })).toBe(small);

    const grown = getOrCreateHdrpBuffers(runtime, { x: 4, y: 4, z: 4 });
    expect(grown).not.toBeNull();
    if (grown?.kind !== 'storage') throw new Error('Expected Standard storage allocation');
    expect(grown).not.toBe(small);
    expect(grown.clusterGridBytes).toBeGreaterThan(small.clusterGridBytes);

    await Promise.resolve();
    const ledger = baseDevice as unknown as {
      readonly bookkeeper: { isDestroyed(handle: unknown): boolean };
    };
    expect(ledger.bookkeeper.isDestroyed(small.lightDataBuffer)).toBe(false);
    expect(ledger.bookkeeper.isDestroyed(small.clusterGridBuffer)).toBe(false);
    releaseFence();
    await Promise.resolve();
    expect(ledger.bookkeeper.isDestroyed(small.lightDataBuffer)).toBe(true);
    expect(ledger.bookkeeper.isDestroyed(small.clusterGridBuffer)).toBe(true);
    expect(ledger.bookkeeper.isDestroyed(grown.lightDataBuffer)).toBe(false);
    expect(errors).toEqual([]);
  });

  it('retires a cached bundle when the runtime switches devices', async () => {
    const adapter = new RhiNullAdapter();
    const first = await adapter.requestDevice();
    const second = await adapter.requestDevice();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const errors: unknown[] = [];
    const runtime = {
      device: first.value,
      errorRegistry: { fire: (error: unknown) => errors.push(error) },
    } as unknown as RenderSystemRuntime & { device: RhiDevice };
    const old = getOrCreateHdrpBuffers(runtime, { x: 2, y: 2, z: 2 });
    expect(old).not.toBeNull();
    if (old?.kind !== 'storage') throw new Error('Expected Standard storage allocation');
    runtime.device = second.value;
    const next = getOrCreateHdrpBuffers(runtime, { x: 2, y: 2, z: 2 });
    expect(next).not.toBeNull();
    const ledger = first.value as unknown as {
      readonly bookkeeper: { isDestroyed(handle: unknown): boolean };
    };
    await vi.waitFor(() => expect(ledger.bookkeeper.isDestroyed(old.lightDataBuffer)).toBe(true));
    expect(errors).toEqual([]);
  });

  it('rebuilds the membership bind group when a same-device grid grows', () => {
    const adapter = new RhiNullAdapter();
    return adapter.requestDevice().then((deviceResult) => {
      expect(deviceResult.ok).toBe(true);
      if (!deviceResult.ok) return;
      const device = deviceResult.value;
      const errors: unknown[] = [];
      const runtime = {
        device,
        errorRegistry: { fire: (error: unknown) => errors.push(error) },
      } as unknown as RenderSystemRuntime;
      const layout = device
        .createBindGroupLayout(createHdrpClusterMembershipBindGroupLayoutDescriptor())
        .unwrap();
      const emptyFrame = (grid: { x: number; y: number; z: number }) => {
        const result = prepareStandardLighting({
          directional: undefined,
          local: [],
          view: mat4.create(),
          projection: mat4.create(),
          near: 0.1,
          far: 100,
          grid,
          lightCount: 1,
          renderPath: 'forward',
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw result.error;
        return result.value;
      };
      const small = emptyFrame({ x: 2, y: 2, z: 2 });
      const large = emptyFrame({ x: 4, y: 4, z: 4 });
      const smallTransport = selectStandardClusterTransport(
        { compute: true, storageBuffer: true, membershipPipelineReady: true },
        small,
      );
      const largeTransport = selectStandardClusterTransport(
        { compute: true, storageBuffer: true, membershipPipelineReady: true },
        large,
      );
      expect(smallTransport.ok && largeTransport.ok).toBe(true);
      if (!smallTransport.ok || !largeTransport.ok) return;
      const frameState = {
        hdrpClusterMembership: null,
        installedPipelineConfig: undefined,
      } as unknown as RenderFrameState;
      const internals = {
        device,
        errorRegistry: runtime.errorRegistry,
      } as unknown as RenderSystemInternals;
      const first = writeHdrpClusterAndSsaoBuffers(
        internals,
        frameState,
        camera(),
        small,
        smallTransport.value,
        undefined,
        true,
        layout,
      );
      expect(first.ok).toBe(true);
      const firstMembership = frameState.hdrpClusterMembership;
      expect(firstMembership).not.toBeNull();
      if (firstMembership === null) return;
      const firstGridBuffer = firstMembership.clusterGridBuffer;
      const projected = buildPerFrameBindGroups(
        internals,
        frameState,
        { hdrpClusterMembershipBindGroupLayout: layout } as PipelineState,
        false,
        { createBindGroup: 0, keys: [] },
        undefined,
        false,
      );
      expect(projected.hdrpClusterMembershipBindGroup).toBeNull();
      expect(frameState.hdrpClusterMembership).toBe(firstMembership);
      writeHdrpClusterAndSsaoBuffers(
        internals,
        frameState,
        camera(),
        small,
        smallTransport.value,
        undefined,
        true,
        layout,
      ).unwrap();
      expect(frameState.hdrpClusterMembership?.bindGroup).toBe(firstMembership.bindGroup);
      const second = writeHdrpClusterAndSsaoBuffers(
        internals,
        frameState,
        camera(),
        large,
        largeTransport.value,
        undefined,
        true,
        layout,
      );
      expect(second.ok).toBe(true);
      expect(frameState.hdrpClusterMembership).not.toBeNull();
      expect(frameState.hdrpClusterMembership?.bindGroup).not.toBe(firstMembership.bindGroup);
      expect(frameState.hdrpClusterMembership?.clusterGridBuffer).not.toBe(firstGridBuffer);
      expect(errors).toEqual([]);
    });
  });

  it('keeps the cached LKG and cleans partial candidate buffers after growth allocation fails', async () => {
    const adapter = new RhiNullAdapter();
    const baseResult = await adapter.requestDevice();
    expect(baseResult.ok).toBe(true);
    if (!baseResult.ok) return;
    const base = baseResult.value;
    let createCalls = 0;
    let failOnCall = Number.POSITIVE_INFINITY;
    const candidateBuffers: unknown[] = [];
    const errors: unknown[] = [];
    const device = {
      caps: base.caps,
      features: base.features,
      limits: base.limits,
      queue: base.queue,
      lost: base.lost,
      createBuffer: (descriptor: Parameters<typeof base.createBuffer>[0]) => {
        createCalls += 1;
        if (createCalls === failOnCall) {
          return rhiErr(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'candidate buffer allocation succeeds',
              hint: 'test candidate allocation failure',
            }),
          );
        }
        const created = base.createBuffer(descriptor);
        if (created.ok) candidateBuffers.push(created.value);
        return created;
      },
      createBindGroupLayout: (descriptor: Parameters<typeof base.createBindGroupLayout>[0]) =>
        base.createBindGroupLayout(descriptor),
      destroyBuffer: (buffer: Parameters<typeof base.destroyBuffer>[0]) =>
        base.destroyBuffer(buffer),
    } as unknown as RhiDevice;
    const runtime = {
      device,
      errorRegistry: { fire: (error: unknown) => errors.push(error) },
    } as unknown as RenderSystemRuntime;
    const small = getOrCreateHdrpBuffers(runtime, { x: 2, y: 2, z: 2 });
    expect(small).not.toBeNull();
    if (small?.kind !== 'storage') throw new Error('Expected Standard storage allocation');
    const oldCandidateCount = candidateBuffers.length;
    failOnCall = createCalls + 3;
    const failed = getOrCreateHdrpBuffers(runtime, { x: 8, y: 8, z: 8 });
    expect(failed).toBeNull();
    expect(candidateBuffers.length).toBe(oldCandidateCount + 2);
    const ledger = base as unknown as {
      readonly bookkeeper: { isDestroyed(handle: unknown): boolean };
    };
    expect(ledger.bookkeeper.isDestroyed(candidateBuffers[oldCandidateCount])).toBe(true);
    expect(ledger.bookkeeper.isDestroyed(candidateBuffers[oldCandidateCount + 1])).toBe(true);
    expect(ledger.bookkeeper.isDestroyed(small.lightDataBuffer)).toBe(false);
    expect(getOrCreateHdrpBuffers(runtime, { x: 2, y: 2, z: 2 })).toBe(small);
    expect(errors).toHaveLength(1);
  });
});
