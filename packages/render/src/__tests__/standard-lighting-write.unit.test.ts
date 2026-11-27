import { mat4, vec3 } from '@forgeax/engine-math';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { RhiError, err as rhiErr, ok as rhiOk } from '@forgeax/engine-rhi';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import {
  createHdrpClusterMembershipBindGroupLayoutDescriptor,
  getOrCreateHdrpBuffers,
  resetHdrpBuffers,
} from '../hdrp-buffers';
import { captureStandardLighting } from '../pipeline/standard-lighting/inspection';
import { DEFAULT_CLUSTER_GRID } from '../pipeline/standard-lighting/layout';
import { StandardClusterMembershipOwner } from '../pipeline/standard-lighting/membership-owner';
import { SubmittedClusterBounds } from '../pipeline/standard-lighting/membership-publication';
import { prepareStandardLighting } from '../pipeline/standard-lighting/prepare';
import {
  COOKIE_MIP_LEVEL_COUNT,
  COOKIE_SLICE_MIP_CHAIN_BYTES,
} from '../prepare/extended-lighting/resources';
import {
  buildPerFrameBindGroups,
  prepareFrameLighting,
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
import type { RenderableSnapshot } from '../render-system-extract';
import { getOrCreateSsaoBuffers } from '../ssao-buffers';
import { buildSsaoUniformPayload } from '../ssao-uniform';
import { createTemporalView } from '../temporal/view';
import type { ViewLights } from '../world/render-lights';
import {
  STANDARD_CLUSTER_TEST_ABI,
  selectTestStandardClusterTransport as selectStandardClusterTransport,
} from './cluster-test-abi';

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
      standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
    },
  };
}

describe('Standard Cluster upload ownership', () => {
  it('writes published moving rows to their physical storage and restores CPU membership after compute or failed partial writes', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const runtime = {
      device,
      errorRegistry: {
        fire: (error: unknown) => {
          throw error;
        },
      },
      standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
    } as unknown as RenderSystemRuntime;
    const buffers = getOrCreateHdrpBuffers(runtime);
    if (buffers?.kind !== 'storage') throw new Error('expected physical Cluster storage');
    const local = Array.from({ length: 1024 }, () => ({
      kind: 'point' as const,
      shadowed: false,
      position: vec3.create(0, 0, -10),
      range: 1.25,
    }));
    const frame = {
      directional: undefined,
      local,
      view: mat4.identity(mat4.create()),
      projection: mat4.perspective(mat4.create(), Math.PI / 3, 16 / 9, 0.1, 200),
      near: 0.1,
      far: 200,
      grid: DEFAULT_CLUSTER_GRID,
      lightCount: 1024 as const,
      renderPath: 'forward' as const,
    };
    const left = local[10],
      right = local[1000];
    if (left === undefined || right === undefined)
      throw new Error('expected both test light slots');
    const owner = new StandardClusterMembershipOwner();
    const sample = () => prepareStandardLighting(frame, undefined, undefined, owner).unwrap();
    const write = (value: ReturnType<typeof sample>, gpu = true) =>
      buffers.membership.write(device.queue, buffers, value, gpu);
    const original = device.queue.writeBuffer.bind(device.queue);
    const writes = vi.spyOn(device.queue, 'writeBuffer');
    const words = (target: typeof buffers.clusterGridBuffer) =>
      writes.mock.calls.filter((call) => call[0] === target).map((call) => [call[1], call[4]]);
    const reference = prepareStandardLighting(frame).unwrap().lightBounds;
    const first = sample();
    const observe = vi.spyOn(SubmittedClusterBounds.prototype, 'materialize');
    let prior = first.boundsColumn;
    expect(prior?.pages.length).toBe(81);
    write(first).unwrap();
    expect(words(buffers.lightBoundsBuffer)).toEqual([[0, 20488]]);
    expect(words(buffers.clusterGridBuffer)).toEqual([[0, 6912]]);
    expect(words(buffers.lightIndexListBuffer)).toEqual([]);
    for (let moving = 0; moving < 12; moving++) {
      writes.mockClear();
      left.position[0] = 0.01 + moving * 0.0001;
      const current = sample();
      const column = current.boundsColumn;
      if (column === undefined || prior === undefined)
        throw new Error('missing issued light pages');
      let allocated = 0;
      for (let page = 0; page < column.pages.length; page++) {
        const data = column.pages[page];
        if (data !== undefined && data !== prior.pages[page]) allocated += data.byteLength;
      }
      expect(allocated).toBe(1024);
      prior = column;
      const transport = selectStandardClusterTransport(
        { compute: true, storageBuffer: true, membershipPipelineReady: true },
        current,
      ).unwrap();
      const read = captureStandardLighting({ kind: 'clustered', transport, prepared: current });
      expect(read().admitted).toBe(1024);
      write(current).unwrap();
      expect(words(buffers.lightBoundsBuffer)).toEqual([[(8 + 10 * 20 + 8) * 4, 1]]);
      expect(words(buffers.clusterGridBuffer)).toEqual([]);
    }
    left.position[0] = 0.1;
    right.position[0] = 0.1;
    const separate = sample();
    writes.mockClear();
    write(separate).unwrap();
    expect(words(buffers.lightBoundsBuffer)).toEqual([
      [(8 + 10 * 20 + 8) * 4, 1],
      [(8 + 1000 * 20 + 8) * 4, 1],
    ]);
    writes.mockClear();
    write(separate, false).unwrap();
    expect(words(buffers.clusterGridBuffer)).toEqual([[0, 6912]]);
    expect(words(buffers.lightIndexListBuffer)).toEqual([[0, separate.membershipEntryCount]]);
    writes.mockClear();
    write(separate, false).unwrap();
    expect(writes).not.toHaveBeenCalled();
    write(separate).unwrap();
    left.position[0] = 0.05;
    right.position[0] = 0.05;
    const changed = sample();
    writes.mockClear();
    writes.mockImplementationOnce(original).mockImplementationOnce(() =>
      rhiErr(
        new RhiError({
          code: 'queue-write-buffer-out-of-bounds',
          expected: 'the second submitted range',
          hint: 'injected range write failure',
        }),
      ),
    );
    expect(write(changed)).toMatchObject({ ok: false, error: { product: 'light-bounds' } });
    writes.mockClear();
    write(changed).unwrap();
    expect(words(buffers.lightBoundsBuffer)).toEqual([[0, 20488]]);
    const reduced = prepareStandardLighting(
      { ...frame, local: local.slice(0, 2) },
      undefined,
      undefined,
      owner,
    ).unwrap();
    const small = reduced.boundsColumn;
    if (small === undefined) throw new Error('expected a submitted bounds column');
    expect(small.pages.every((page) => page.buffer.byteLength <= small.length * 4)).toBe(true);
    expect(observe).not.toHaveBeenCalled();
    owner.clear();
    expect(first.lightBounds).toEqual(reference);
    writes.mockClear();
    write(first).unwrap();
    expect(words(buffers.lightBoundsBuffer)).toEqual([[0, 20488]]);
    const other = prepareStandardLighting(
      frame,
      undefined,
      undefined,
      new StandardClusterMembershipOwner(),
    ).unwrap();
    writes.mockClear();
    write(other).unwrap();
    expect(words(buffers.clusterGridBuffer)).toEqual([[0, 6912]]);
    // Borrowed producers can change an array in place and have no predecessor proof.
    const mutable = prepareStandardLighting(frame).unwrap();
    write(mutable).unwrap();
    mutable.lightBounds[8] = 2;
    writes.mockClear();
    write(mutable).unwrap();
    expect(words(buffers.lightBoundsBuffer)).toEqual([[0, 20488]]);
    writes.mockRestore();
    observe.mockRestore();
    resetHdrpBuffers(runtime);
  });

  it('keeps the published Cluster generation across failed creation and advances only on recovery', async () => {
    const adapter = new RhiNullAdapter();
    const requested = await adapter.requestDevice();
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    const baseDevice = requested.value;
    let failTextureCreation = true;
    const errors: unknown[] = [];
    const device = new Proxy(baseDevice, {
      get(target, property) {
        if (property === 'caps') return { ...target.caps, storageBuffer: false };
        if (property === 'createTexture') {
          const createTexture = Reflect.get(target, property, target) as (
            ...args: unknown[]
          ) => unknown;
          return (...args: unknown[]) => {
            if (failTextureCreation) {
              return rhiErr(
                new RhiError({
                  code: 'device-lost',
                  expected: 'Cluster texture creation succeeds',
                  hint: 'recover the device and retry allocation',
                }),
              );
            }
            return createTexture.apply(target, args);
          };
        }
        const member = Reflect.get(target, property, target) as unknown;
        return typeof member === 'function' ? member.bind(target) : member;
      },
    }) as RhiDevice;
    const runtime = {
      device,
      errorRegistry: { fire: (error: unknown) => errors.push(error) },
      standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
    } as unknown as RenderSystemRuntime;

    expect(getOrCreateHdrpBuffers(runtime, { x: 4, y: 3, z: 4 })).toBeNull();
    expect(errors).toMatchObject([{ code: 'device-lost' }]);
    failTextureCreation = false;
    const original = getOrCreateHdrpBuffers(runtime, { x: 4, y: 3, z: 4 });
    expect(original?.kind).toBe('texture');
    if (original?.kind !== 'texture') throw new Error('Expected texture Cluster transport');
    expect(original.clusterTransportGeneration).toBeGreaterThan(0);
    expect(getOrCreateHdrpBuffers(runtime, { x: 4, y: 3, z: 4 })?.clusterTransportGeneration).toBe(
      original.clusterTransportGeneration,
    );

    failTextureCreation = true;
    expect(getOrCreateHdrpBuffers(runtime, { x: 4, y: 3, z: 4 }, { atmosphere: true })).toBeNull();
    expect(errors).toMatchObject([{ code: 'device-lost' }, { code: 'device-lost' }]);
    expect(getOrCreateHdrpBuffers(runtime, { x: 4, y: 3, z: 4 })).toBe(original);
    expect(original.clusterTransportGeneration).toBeGreaterThan(0);

    failTextureCreation = false;
    const recovered = getOrCreateHdrpBuffers(runtime, { x: 4, y: 3, z: 4 }, { atmosphere: true });
    expect(recovered?.kind).toBe('texture');
    if (recovered?.kind !== 'texture')
      throw new Error('Expected recovered atmosphere texture transport');
    expect(recovered.clusterTransportGeneration).toBe(original.clusterTransportGeneration + 1);
    expect(getOrCreateHdrpBuffers(runtime, { x: 4, y: 3, z: 4 }, { atmosphere: true })).toBe(
      recovered,
    );
    resetHdrpBuffers(runtime);
    await Promise.resolve();
  });

  it('keeps transport generation stable and advances it only when the atmosphere texture layout replaces the bundle', async () => {
    const adapter = new RhiNullAdapter();
    const requested = await adapter.requestDevice();
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    const baseDevice = requested.value;
    const device = new Proxy(baseDevice, {
      get(target, property) {
        if (property === 'caps') return { ...target.caps, storageBuffer: false };
        const member = Reflect.get(target, property, target) as unknown;
        return typeof member === 'function' ? member.bind(target) : member;
      },
    }) as RhiDevice;
    const errors: unknown[] = [];
    const runtime = {
      device,
      errorRegistry: { fire: (error: unknown) => errors.push(error) },
      standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
    } as unknown as RenderSystemRuntime;
    const grid = { x: 4, y: 3, z: 4 };
    const base = getOrCreateHdrpBuffers(runtime, grid);
    expect(base?.kind).toBe('texture');
    if (base?.kind !== 'texture') throw new Error('Expected texture Cluster transport');
    expect(getOrCreateHdrpBuffers(runtime, grid)).toBe(base);
    expect(getOrCreateHdrpBuffers(runtime, grid)?.clusterTransportGeneration).toBe(
      base.clusterTransportGeneration,
    );

    const atmosphere = getOrCreateHdrpBuffers(runtime, grid, { atmosphere: true });
    expect(atmosphere?.kind).toBe('texture');
    if (atmosphere?.kind !== 'texture')
      throw new Error('Expected atmosphere texture Cluster transport');
    expect(atmosphere).not.toBe(base);
    expect(atmosphere.clusterTransportGeneration).toBeGreaterThan(base.clusterTransportGeneration);
    expect(getOrCreateHdrpBuffers(runtime, grid, { atmosphere: true })).toBe(atmosphere);

    const restored = getOrCreateHdrpBuffers(runtime, grid);
    expect(restored?.kind).toBe('texture');
    if (restored?.kind !== 'texture') throw new Error('Expected base texture Cluster transport');
    expect(restored).not.toBe(atmosphere);
    expect(restored.clusterTransportGeneration).toBeGreaterThan(
      atmosphere.clusterTransportGeneration,
    );
    expect(getOrCreateHdrpBuffers(runtime, grid)?.clusterTransportGeneration).toBe(
      restored.clusterTransportGeneration,
    );
    resetHdrpBuffers(runtime);
    await Promise.resolve();
    expect(errors).toEqual([]);
  });

  it.each([
    'none',
    'ao',
    'capsule',
  ] as const)('resolves no-storage Cluster topology for Forward %s with no local lights', (consumer) => {
    const aoEnabled = consumer === 'ao';
    const internals = {
      device: {
        caps: { storageBuffer: false, compute: false },
        limits: { maxTextureDimension2D: 4096 },
      },
      standardProfile: undefined,
      getPipelineState: () => ({ perPassResources: { ssaoScreenPipeline: vi.fn() } }),
      depthPyramidShaders: { seed: 'depth seed shader' },
      standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
      errorRegistry: { fire: vi.fn() },
    } as unknown as RenderSystemInternals;
    const frameState = {
      warnedMultiLightDirectional: false,
      pointShadowSnapshots: [],
      spotShadowSnapshots: [],
      installedPipelineConfig: {
        ambientOcclusion: aoEnabled
          ? {
              enabled: true,
              method: 'gtao',
              quality: 'low',
              radius: 2,
              bias: 0.1,
              intensity: 1,
            }
          : undefined,
      },
    } as unknown as RenderFrameState;
    const lights = {
      directional: undefined,
      directionalCount: 0,
      point: [],
      spot: [],
      rect: [],
      depthBias: undefined,
      normalBias: undefined,
      directionalShadowError: undefined,
      pointShadow: [],
      directionalCsmConfig: undefined,
      directionalCsmDirection: undefined,
      cascades: undefined,
      shadowViews: [],
    } as unknown as ViewLights;

    const result = prepareFrameLighting(
      internals,
      frameState,
      lights,
      camera(),
      undefined,
      consumer === 'capsule' ? [{ capsuleShadowRequested: true } as RenderableSnapshot] : undefined,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (consumer !== 'capsule') {
      expect(result.value.standard.kind).toBe('no-local-lights');
      return;
    }
    expect(result.value.standard.kind).toBe('clustered');
    if (result.value.standard.kind !== 'clustered') return;
    expect(result.value.standard.transport.kind).toBe('cpu-texture');
    expect(result.value.standard.prepared.local).toHaveLength(0);
  });

  it.each([
    'perspective',
    'orthographic',
    'stereo',
    'capture',
  ] as const)('keeps the sampled %s projection in the graph-owned AO payload', async (kind) => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const errors: unknown[] = [];
    const internals = {
      device,
      errorRegistry: { fire: (error: unknown) => errors.push(error) },
      standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
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
    const cluster = getOrCreateHdrpBuffers(internals);
    if (cluster?.kind !== 'storage') throw new Error('Cluster storage allocation failed');
    const ssao = getOrCreateSsaoBuffers(internals);
    if (ssao === null) throw new Error('SSAO allocation failed');
    const writes = vi.spyOn(device.queue, 'writeBuffer');
    const frameState = {
      hdrpClusterMembership: null,
      installedPipelineConfig: {
        ambientOcclusion: {
          enabled: true,
          method: 'gtao',
          quality: 'low',
          radius: 2,
          bias: 0.1,
          intensity: 0.75,
        },
      },
    } as unknown as RenderFrameState;
    const result = writeHdrpClusterAndSsaoBuffers(
      internals,
      frameState,
      sampledCamera,
      prepared,
      transport,
    );
    expect(result.ok).toBe(true);
    const upload = writes.mock.calls.find(([buffer]) => buffer === ssao.uniformBuffer);
    expect(upload).toBeUndefined();
    const payload = buildSsaoUniformPayload(
      sampledCamera,
      frameState.installedPipelineConfig?.ambientOcclusion,
    );
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
    const clusterUpload = writes.mock.calls.find(
      ([buffer]) => buffer === cluster.clusterUniformBuffer,
    )?.[2] as Uint8Array | undefined;
    expect(clusterUpload?.byteLength).toBe(96);
    if (clusterUpload === undefined) throw new Error('Cluster uniform upload missing');
    const clusterFields = new Float32Array(clusterUpload.buffer, clusterUpload.byteOffset, 24);
    const clusterWords = new Uint32Array(clusterUpload.buffer, clusterUpload.byteOffset, 24);
    expect(clusterFields[12]).toBe(0);
    expect(clusterFields[7]).toBe(0.75);
    expect(Array.from(clusterFields.subarray(13, 16))).toEqual([0, 0, 0]);
    expect(Array.from(clusterWords.subarray(16, 20))).toEqual([6, 0, 0, 0]);
    expect(Array.from(clusterWords.subarray(20, 24))).toEqual([2, 1, 0, 0]);
    expect(errors).toEqual([]);

    const uploadedStrengths: number[] = [];
    for (const strength of [0, 1, 0]) {
      frameState.installedPipelineConfig = {
        ambientOcclusion: {
          ...frameState.installedPipelineConfig?.ambientOcclusion,
          enabled: true,
          intensity: strength,
        },
      };
      const updated = writeHdrpClusterAndSsaoBuffers(
        internals,
        frameState,
        sampledCamera,
        prepared,
        transport,
      );
      expect(updated.ok).toBe(true);
      const payload = writes.mock.calls
        .filter(([buffer]) => buffer === cluster.clusterUniformBuffer)
        .at(-1)?.[2] as Uint8Array | undefined;
      if (payload === undefined) throw new Error('Updated Cluster uniform upload is missing');
      const values = new Float32Array(payload.buffer, payload.byteOffset, 24);
      expect(values[12]).toBe(0);
      uploadedStrengths.push(values[7] ?? Number.NaN);
    }
    expect(uploadedStrengths).toEqual([0, 1, 0]);
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

  it('publishes the current modifier sources and shadow slots in each prepared view', () => {
    const internals = {
      device: {
        caps: { storageBuffer: true, compute: false },
        limits: { maxTextureDimension2D: 4096 },
      },
      standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
      errorRegistry: {
        fire: (error: unknown) => {
          throw error;
        },
      },
    } as unknown as RenderSystemInternals;
    const state = {
      pointShadowSnapshots: [],
      spotShadowSnapshots: [],
    } as unknown as RenderFrameState;
    const point = {
      kind: 'point' as const,
      color: vec3.create(1, 1, 1),
      position: vec3.create(0, 0, -2),
      intensity: 1,
      invRangeSquared: 1,
      shadowAtlasLayer: 0,
      iesProfileSlice: 0,
      iesProfileData: new Uint8Array(2),
    };
    const plain = { ...point, shadowAtlasLayer: -1, iesProfileSlice: undefined };
    const prepare = (points: readonly (typeof plain | typeof point)[]) =>
      prepareFrameLighting(
        internals,
        state,
        {
          point: points,
          spot: [],
          rect: [],
          pointShadow: [],
          shadowViews: [],
        } as unknown as ViewLights,
        camera(),
      ).unwrap().standard.prepared.slotWork;
    const first = prepare([point, plain]);
    const next = prepare([plain, point]);
    expect(first?.shadowSlots).toEqual([0]);
    expect(next?.shadowSlots).toEqual([1]);
    expect(next?.point).toEqual([point]);
    expect(next?.complete).toBe(true);
    const removed = prepare([plain]);
    expect(removed?.point).toHaveLength(0);
    expect(removed?.shadowSlots).toHaveLength(0);
    expect(first?.point[0]).toBe(point);
  });

  it('publishes both projector poses when their 32-bit byte digests collide', () => {
    const matrix = mat4.identity(mat4.create());
    const translations: number[] = [];
    const internals = {
      device: {
        queue: {
          writeBuffer(_buffer: unknown, _offset: number, data: Float32Array) {
            translations.push(data[12] as number);
            return rhiOk(undefined);
          },
        },
      },
    } as unknown as RenderSystemInternals;
    const pipeline = { cookieMatrixBuffer: {} } as PipelineState;
    const spot = { kind: 'spot', projectorSlice: 0, projectorMatrix: matrix } as never;
    const lights = { point: [], spot: [spot], rect: [] };
    for (const [x, y] of [
      [181.421875, 350.98046875],
      [380.3046875, 321.70703125],
    ] as const) {
      matrix[12] = x;
      matrix[13] = y;
      writeLightModifierTextures(internals, pipeline, lights);
      writeLightModifierTextures(internals, pipeline, lights);
    }
    expect(translations).toEqual([181.421875, 380.3046875]);
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
      standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
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
      standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
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
        standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
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
        standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
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
      standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
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
