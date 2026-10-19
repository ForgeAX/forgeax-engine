import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Time, World } from '@forgeax/engine-ecs';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type {
  BindGroupLayoutDescriptor,
  Buffer,
  ComputePipelineDescriptor,
  RenderPipelineDescriptor,
  RhiAdapter,
  RhiDevice,
  RhiError,
  SamplerDescriptor,
  TextureDescriptor,
} from '@forgeax/engine-rhi';
import { RhiError as RuntimeRhiError } from '@forgeax/engine-rhi';
import {
  rhi as nullRhi,
  RhiNullCommandEncoder,
  RhiNullDevice,
  RhiNullQueue,
  RhiNullRenderPassEncoder,
} from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { err, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { Camera, perspective, TONEMAP_ACES_FILMIC } from '../components/camera';
import { CameraView } from '../components/camera-view';
import { DirectionalLight } from '../components/directional-light';
import { constructRendererHost } from '../construct-renderer';
import { resolveVolumetricFogProfile } from '../pipeline/standard-profile';
import type { RenderPipelineFrame } from '../render-pipeline';
import { VolumetricFog } from '../volume/component';
import { inspectVolumetricFog } from '../volume/inspection';
import * as volumeProgramOwner from '../volume/programs';
import { recoverVolumetricFog, stageVolumetricFog } from '../volume/recovery';
import {
  createVolumetricFogResources,
  deriveVolumetricFogExtent,
  deriveVolumetricFogResolvedExtent,
  inspectVolumetricFogResources,
  VOLUMETRIC_FOG_PARAMS_BYTES,
} from '../volume/resources';
import { resolveVolumeTemporalReset } from '../volume/temporal';
import { standardPbrManifestRow } from './shader-manifest-fixture';

const MAX_MEMORY_BYTES = 48 * 1024 * 1024;

const VOLUME_MANIFEST = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    entries: [
      { hash: 'pbr', wgsl: 'f_schlick', glsl: '', bindings: '' },
      { hash: 'unlit', wgsl: 'unlit', glsl: '', bindings: '' },
      { hash: 'tonemap', wgsl: 'struct TonemapParams {}', glsl: '', bindings: '' },
      { hash: 'volume-inject', wgsl: 'fn volume_inject() {}', glsl: '', bindings: '' },
      { hash: 'volume-temporal', wgsl: 'fn volume_temporal() {}', glsl: '', bindings: '' },
      { hash: 'volume-integrate', wgsl: 'fn volume_integrate() {}', glsl: '', bindings: '' },
      { hash: 'volume-composite', wgsl: 'fn volume_fs() {}', glsl: '', bindings: '' },
    ],
    materialShaders: [standardPbrManifestRow('f_schlick')],
  }),
)}`;

type LostInfo = { readonly reason: 'destroyed' | 'unknown'; readonly message: string };

/** A null-device that can drive the real Renderer lost -> recover lifecycle. */
class RecoverableNullDevice extends RhiNullDevice {
  readonly renderPipelineDescriptors: RenderPipelineDescriptor[] = [];
  readonly computePipelineDescriptors: ComputePipelineDescriptor[] = [];
  readonly bindGroupLayoutDescriptors: BindGroupLayoutDescriptor[] = [];
  readonly samplerDescriptors: SamplerDescriptor[] = [];
  readonly textureDescriptors: TextureDescriptor[] = [];
  private readonly resolveLost: (info: LostInfo) => void;
  private readonly lostPromise: Promise<LostInfo>;

  constructor(queue: RhiNullQueue = new RhiNullQueue()) {
    let resolveLost!: (info: LostInfo) => void;
    const lostPromise = new Promise<LostInfo>((resolve) => {
      resolveLost = resolve;
    });
    super(queue, (bookkeeper, device) => new RhiNullCommandEncoder(bookkeeper, device));
    this.resolveLost = resolveLost;
    this.lostPromise = lostPromise;
  }

  override get lost(): Promise<LostInfo> {
    return this.lostPromise;
  }

  override createRenderPipeline(descriptor: RenderPipelineDescriptor) {
    this.renderPipelineDescriptors.push(descriptor);
    return super.createRenderPipeline(descriptor);
  }

  override createComputePipeline(descriptor: ComputePipelineDescriptor) {
    this.computePipelineDescriptors.push(descriptor);
    return super.createComputePipeline(descriptor);
  }

  override createBindGroupLayout(descriptor: BindGroupLayoutDescriptor) {
    this.bindGroupLayoutDescriptors.push(descriptor);
    return super.createBindGroupLayout(descriptor);
  }

  override createTexture(descriptor: TextureDescriptor) {
    this.textureDescriptors.push(descriptor);
    return super.createTexture(descriptor);
  }

  override createSampler(descriptor?: SamplerDescriptor) {
    this.samplerDescriptors.push(descriptor ?? {});
    return super.createSampler(descriptor);
  }

  lose(): void {
    this.resolveLost({ reason: 'unknown', message: 'AC-22 lifecycle recovery probe' });
  }
}

class RecoverableNullAdapter implements RhiAdapter {
  readonly features: ReadonlySet<GPUFeatureName> = new Set();
  readonly limits: Readonly<Record<string, number>> = {};
  readonly devices: RecoverableNullDevice[] = [];

  constructor(private readonly queueFactory: () => RhiNullQueue = () => new RhiNullQueue()) {}

  requestDevice(): Promise<Result<RhiDevice, RhiError>> {
    const device = new RecoverableNullDevice(this.queueFactory());
    this.devices.push(device);
    return Promise.resolve(ok(device));
  }
}

interface CapturedQueueWrite {
  readonly buffer: Buffer;
  readonly offset: number;
  readonly bytes: Uint8Array;
}

/** Captures the real record-stage volume parameter writes without adding a
 * second render implementation. */
class RecordingNullQueue extends RhiNullQueue {
  readonly writes: CapturedQueueWrite[] = [];

  override writeBuffer(
    buffer: Buffer,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number,
    size?: number,
  ) {
    const source =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const start = dataOffset ?? 0;
    const end = size === undefined ? source.byteLength : start + size;
    this.writes.push({ buffer, offset: bufferOffset, bytes: source.slice(start, end) });
    return super.writeBuffer(buffer, bufferOffset, data, dataOffset, size);
  }
}

function surfaceCanvas(width = 1920, height = 1080): HTMLCanvasElement {
  return { width, height, getContext: () => null } as unknown as HTMLCanvasElement;
}

function densityAsset(): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: 64, height: 64, depth: 64 } },
    format: 'r8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(64 * 64 * 64).fill(32),
  };
}

interface LedgerSnapshot {
  readonly liveTextures: number;
  readonly liveBuffers: number;
  readonly liveHandles: number;
}

function snapshotLedger(device: RecoverableNullDevice): LedgerSnapshot {
  const live = device.bookkeeper.allRecords().filter((record) => !record.destroyed);
  return {
    liveTextures: live.filter((record) => record.kind === 'Texture').length,
    liveBuffers: live.filter((record) => record.kind === 'Buffer').length,
    liveHandles: live.length,
  };
}

async function persistAc22Receipt(receipt: unknown): Promise<void> {
  const target = process.env.FORGEAX_AC22_RECEIPT;
  if (target === undefined) return;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(receipt, null, 2)}\n`);
}

describe('volumetric fog budget and recovery contract', () => {
  it('limits the real composite draw to all owner bounds and restores full scissor across camera and view changes', async () => {
    const adapter = new RecoverableNullAdapter();
    const made = await constructRendererHost(
      surfaceCanvas(640, 360),
      {
        rhi: { ...nullRhi, requestAdapter: () => Promise.resolve(ok(adapter)) },
      },
      { shaderManifestUrl: VOLUME_MANIFEST },
    );
    if (!made.ok) throw made.error;
    const renderer = made.value.renderer;
    onTestFinished(async () => {
      await renderer.dispose();
    });
    const world = new World();
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: {
            ...perspective({ fov: Math.PI / 2, aspect: 16 / 9 }),
            tonemap: TONEMAP_ACES_FILMIC,
          },
        },
      )
      .unwrap();
    const light = world
      .spawn({
        component: DirectionalLight,
        data: { castShadow: true, direction: [-0.4, -0.8, -0.3] },
      })
      .unwrap();
    const fogs = [-3, 3].map((x) =>
      world
        .spawn({
          component: VolumetricFog,
          data: {
            light,
            density: world.allocSharedRef('TextureAsset', densityAsset()),
            boundsMin: [x - 0.4, -0.4, -18],
            boundsMax: [x + 0.4, 0.4, -16],
            extinction: [0.2, 0.2, 0.2],
            albedo: [0.8, 0.8, 0.8],
            emission: [0, 0, 0],
            maxDistance: 200,
          },
        })
        .unwrap(),
    );
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value,
      request = { leases: [lease], camera: { lease }, environment: { lease } };
    const scissors = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setScissorRect');
    const draw = async () => {
      scissors.mockClear();
      world.update(1 / 60).unwrap();
      const result = renderer.draw(request);
      if (!result.ok) throw result.error;
      const done = await result.value.completed;
      if (!done.ok) throw done.error;
      return scissors.mock.calls.filter((_row, index) => {
        const encoder = scissors.mock.contexts[index];
        return (
          encoder instanceof RhiNullRenderPassEncoder && encoder.passName === 'volume-composite'
        );
      });
    };
    await draw();
    await draw();
    const partial = await draw();
    expect(partial.some((rect) => rect[2] < 640 && rect[3] < 360)).toBe(true);
    expect(partial.at(-1)).toEqual([0, 0, 640, 360]);
    // Both disconnected owners must fit inside the same compositing rectangle.
    const clipped = partial.find((rect) => rect[2] < 640 && rect[3] < 360);
    expect(clipped?.[0]).toBeLessThan(300);
    expect((clipped?.[0] ?? 0) + (clipped?.[2] ?? 0)).toBeGreaterThan(340);
    world.set(camera, Transform, { pos: [-3, 0, -17] }).unwrap();
    expect((await draw()).every((rect) => rect[2] === 640 && rect[3] === 360)).toBe(true);
    world.set(camera, Transform, { pos: [0, 0, 3] }).unwrap();
    world
      .addComponent(camera, { component: CameraView, data: { viewport: [0.2, 0.2, 0.6, 0.5] } })
      .unwrap();
    // A composed viewport remains owned by its original graph; this optimization opts out.
    expect((await draw()).length).toBe(0);
    world.removeComponent(camera, CameraView).unwrap();
    expect((await draw()).some((rect) => rect[2] < 640 && rect[3] < 360)).toBe(true);
    for (const fog of fogs) world.despawn(fog).unwrap();
    expect((await draw()).length).toBe(0);
  });

  it('skips actual offscreen density uploads and all volume passes without losing visible, abort or recovery ownership', async () => {
    const adapter = new RecoverableNullAdapter();
    const backend = { ...nullRhi, requestAdapter: () => Promise.resolve(ok(adapter)) };
    const made = await constructRendererHost(
      surfaceCanvas(96, 96),
      { rhi: backend },
      { shaderManifestUrl: VOLUME_MANIFEST },
    );
    if (!made.ok) throw made.error;
    const renderer = made.value.renderer;
    onTestFinished(async () => {
      await renderer.dispose();
    });
    const world = new World();
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: { ...perspective({ fov: Math.PI / 2, aspect: 1 }), tonemap: TONEMAP_ACES_FILMIC },
        },
      )
      .unwrap();
    const light = world
      .spawn({
        component: DirectionalLight,
        data: { direction: [-0.4, -0.8, -0.3], castShadow: true, cascadeCount: 1, mapSize: 32 },
      })
      .unwrap();
    const outside = [100, -1, -2] as const;
    const fogs = [outside, [-102, -1, -2] as const, [100, -1, 5] as const].map((min) =>
      world
        .spawn({
          component: VolumetricFog,
          data: {
            light,
            density: world.allocSharedRef('TextureAsset', densityAsset()),
            boundsMin: min,
            boundsMax: [min[0] + 2, min[1] + 2, min[2] + 2],
            extinction: [0.2, 0.2, 0.2],
            albedo: [0.8, 0.8, 0.8],
            emission: [0, 0, 0],
            anisotropy: 0,
            maxDistance: 200,
          },
        })
        .unwrap(),
    );
    const firstFog = fogs[0];
    if (firstFog === undefined) throw Error('missing fog');
    world.update(1 / 60).unwrap();
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    const request = { leases: [lease], camera: { lease }, environment: { lease } };
    let device = adapter.devices.at(-1);
    if (device === undefined) throw Error('missing device');
    let created = vi.spyOn(device, 'createTexture');
    const computePasses = vi.spyOn(RhiNullCommandEncoder.prototype, 'beginComputePass');
    const rasterPasses = vi.spyOn(RhiNullCommandEncoder.prototype, 'beginRenderPass');
    const volumePassCount = () =>
      [...computePasses.mock.calls, ...rasterPasses.mock.calls].filter(([descriptor]) =>
        descriptor?.label?.includes('volume'),
      ).length;
    const stages: unknown[] = [];
    let writes = vi.spyOn(device.queue, 'writeTexture');
    const densityCreations = () =>
      created.mock.calls.filter(([descriptor]) => descriptor.dimension === '3d').length;
    const draw = async () => {
      world.update(1 / 60).unwrap();
      const drawn = renderer.draw(request);
      if (!drawn.ok) throw drawn.error;
      const completion = await drawn.value.completed;
      if (!completion.ok) throw completion.error;
      return renderer.inspect();
    };
    for (let i = 0; i < 3; i++) {
      const inspection = (await draw()).volumetricFog;
      expect({
        status: inspection?.status,
        passCount: inspection?.passCount,
        densityTextures: densityCreations(),
        densityWrites: writes.mock.calls.length,
        encodedVolumePasses: volumePassCount(),
      }).toEqual({
        status: 'off',
        passCount: 0,
        densityTextures: 0,
        densityWrites: 0,
        encodedVolumePasses: 0,
      });
    }
    expect(densityCreations()).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    expect(volumePassCount()).toBe(0);
    stages.push({
      stage: 'cold-offscreen-3-frames',
      densityTextures: densityCreations(),
      densityWrites: writes.mock.calls.length,
      encodedVolumePasses: volumePassCount(),
    });
    world.set(firstFog, VolumetricFog, { boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1] }).unwrap();
    expect((await draw()).volumetricFog).toMatchObject({ status: 'available', passCount: 4 });
    expect(densityCreations()).toBe(3);
    expect(volumePassCount()).toBe(4);
    stages.push({
      stage: 'first-visible-full-mixed-set',
      densityTextures: densityCreations(),
      densityWrites: writes.mock.calls.length,
      encodedVolumePasses: volumePassCount(),
    });
    const priorWrites = writes.mock.calls.length;
    world.set(firstFog, VolumetricFog, { boundsMin: outside, boundsMax: [102, 1, 0] }).unwrap();
    world.update(1 / 60).unwrap();
    const submit = vi.spyOn(device.queue, 'submit').mockReturnValueOnce(
      err(
        new RuntimeRhiError({
          code: 'queue-submit-failed',
          expected: 'test submit failure',
          hint: 'retry',
        }),
      ),
    );
    const failed = renderer.draw(request);
    if (failed.ok) expect((await failed.value.completed).ok).toBe(false);
    else expect(failed.ok).toBe(false);
    submit.mockRestore();
    expect((await draw()).volumetricFog).toMatchObject({ status: 'off', passCount: 0 });
    expect(writes.mock.calls.length).toBe(priorWrites);
    // A culled view must retain the accepted source for the existing degraded LKG path.
    world.set(firstFog, VolumetricFog, { anisotropy: 2 }).unwrap();
    expect((await draw()).volumetricFog?.status).toBe('degraded');
    world.set(firstFog, VolumetricFog, { anisotropy: 0 }).unwrap();
    expect((await draw()).volumetricFog).toMatchObject({ status: 'off', passCount: 0 });
    world.set(firstFog, VolumetricFog, { boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1] }).unwrap();
    expect((await draw()).volumetricFog).toMatchObject({ status: 'available', passCount: 4 });
    expect(writes.mock.calls.length).toBe(priorWrites);
    world.set(firstFog, VolumetricFog, { boundsMin: outside, boundsMax: [102, 1, 0] }).unwrap();
    await draw();
    device.lose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderer.state()).toBe('device-lost');
    const recovered = await renderer.recover();
    if (!recovered.ok) throw recovered.error;
    device = adapter.devices.at(-1);
    if (device === undefined) throw Error('missing recovered device');
    const recoveredDensityTextures = device.textureDescriptors.filter(
      (descriptor) => descriptor.dimension === '3d' && descriptor.format === 'r8unorm',
    ).length;
    expect(recoveredDensityTextures).toBe(1);
    created = vi.spyOn(device, 'createTexture');
    writes = vi.spyOn(device.queue, 'writeTexture');
    const beforeRecoveredViewPasses = volumePassCount();
    expect((await draw()).volumetricFog).toMatchObject({ status: 'off', passCount: 0 });
    expect(densityCreations()).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    expect(volumePassCount()).toBe(beforeRecoveredViewPasses);
    stages.push({
      stage: 'recovered-offscreen',
      recoveryDensityTextures: recoveredDensityTextures,
      viewDensityTextures: densityCreations(),
      viewDensityWrites: writes.mock.calls.length,
      encodedVolumePasses: volumePassCount() - beforeRecoveredViewPasses,
    });
    world.set(firstFog, VolumetricFog, { boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1] }).unwrap();
    expect((await draw()).volumetricFog).toMatchObject({ status: 'available', passCount: 4 });
    // Recovery restored the primary accepted density; the first visible view
    // restores its two additional owners through the ordinary residency path.
    expect(densityCreations()).toBe(2);
    expect(
      device.textureDescriptors.filter(
        (descriptor) => descriptor.dimension === '3d' && descriptor.format === 'r8unorm',
      ),
    ).toHaveLength(3);
    expect(volumePassCount() - beforeRecoveredViewPasses).toBe(4);
    stages.push({
      stage: 'recovered-visible-full-mixed-set',
      totalDensityTextures: device.textureDescriptors.filter(
        (descriptor) => descriptor.dimension === '3d' && descriptor.format === 'r8unorm',
      ).length,
      encodedVolumePasses: volumePassCount() - beforeRecoveredViewPasses,
    });
    for (const entity of fogs) world.removeComponent(entity, VolumetricFog).unwrap();
    expect((await draw()).volumetricFog).toMatchObject({ status: 'off', passCount: 0 });
    const receipt = process.env.FORGEAX_OFFSCREEN_VOLUME_RECEIPT;
    if (receipt !== undefined) {
      await mkdir(dirname(receipt), { recursive: true });
      await writeFile(
        receipt,
        `${JSON.stringify({ stages, validationErrorPreserved: true, failedSubmitRetried: true, explicitRemovalOff: true }, null, 2)}\n`,
      );
    }
  });

  it('keeps one active generation and bounded resources through 20 resizes', () => {
    let signature = {
      cameraRevision: 1,
      fogRevision: 1,
      lightRevision: 1,
      densityGeneration: 4,
      width: 320,
      height: 180,
    };
    let resets = 0;
    for (let index = 0; index < 20; index += 1) {
      const next = { ...signature, width: 320 + index + 1, height: 180 + index + 1 };
      const reset = resolveVolumeTemporalReset(signature, next);
      expect(reset).toEqual({ reset: true, reason: 'resize' });
      signature = next;
      resets += 1;
    }
    const inspection = inspectVolumetricFog({
      authored: true,
      capability: 'available',
      recovery: {
        guid: '019f0000-0000-7000-8000-0000000003f1',
        generation: signature.densityGeneration,
        deviceEpoch: 0,
        status: 'accepted',
      },
      acceptedDigest: 'sha256:volume',
      format: 'r8unorm',
      passCount: 1,
      sampleCount: 1,
      memoryBytes: 320 * 180 * 4,
    });
    expect(resets).toBe(20);
    expect(inspection.generation).toBe(4);
    expect(inspection.memoryBytes).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
    expect(inspection.passCount).toBe(1);
    expect(inspection.sampleCount).toBe(1);
  });

  it('records three recovery transitions without zeroing unavailable timing evidence', () => {
    const initial = {
      guid: '019f0000-0000-7000-8000-0000000003f1',
      generation: 4,
      deviceEpoch: 0,
      status: 'accepted' as const,
    };
    const candidate = stageVolumetricFog(initial, { generation: 5, digest: 'sha256:candidate' });
    const lost = recoverVolumetricFog(candidate, { kind: 'device-lost', deviceEpoch: 1 });
    const degraded = recoverVolumetricFog(lost, { kind: 'submit-failed' });
    const stale = recoverVolumetricFog(degraded, { kind: 'accepted', generation: 5 });
    const inspection = inspectVolumetricFog({
      authored: true,
      capability: 'available',
      degraded: true,
      recovery: stale,
      acceptedDigest: 'sha256:accepted',
      passCount: 1,
      sampleCount: 1,
      memoryBytes: 1024,
    });
    expect(stale.candidateFailure).toBe('stale-generation');
    expect(inspection.resourceStage).toBe('lkg');
    expect(inspection.memoryBytes).toBeGreaterThan(0);
    expect(Number.isFinite(inspection.memoryBytes)).toBe(true);
  });

  it('derives high-profile bytes and samples from compiled descriptors', () => {
    expect(
      resolveVolumetricFogProfile({ volumetricFog: { quality: 'low', depth: 48, tileSize: 16 } }),
    ).toEqual({
      quality: 'low',
      depth: 48,
      tileSize: 16,
    });
    expect(deriveVolumetricFogExtent({ width: 1920, height: 1080 }, 48, 16)).toEqual({
      width: 240,
      height: 135,
      depth: 48,
    });
    expect(deriveVolumetricFogExtent({ width: 1920, height: 1080 })).toEqual({
      width: 960,
      height: 540,
      depth: 64,
    });
    expect(deriveVolumetricFogResolvedExtent({ width: 1920, height: 1080 }, 4)).toEqual({
      width: 480,
      height: 270,
      depth: 1,
    });
    expect(deriveVolumetricFogResolvedExtent({ width: 1920, height: 1080 }, 16)).toEqual({
      width: 240,
      height: 135,
      depth: 1,
    });
    const extent = { width: 960, height: 540, depthOrArrayLayers: 16 };
    const graph = {
      generation: 17,
      passes: [],
      resources: [
        {
          label: 'volume-froxel',
          kind: 'texture',
          origin: 'created',
          descriptor: {
            kind: 'texture',
            format: 'rgba8unorm',
            size: extent,
            width: extent.width,
            height: extent.height,
            depthOrArrayLayers: extent.depthOrArrayLayers,
            mipLevelCount: 1,
            sampleCount: 1,
          },
          firstUse: 0,
          lastUse: 1,
          derivedUsage: 8,
          format: 'rgba8unorm',
          extent,
          byteSize: 960 * 540 * 16 * 4,
        },
        {
          label: 'volume-resolved-current',
          kind: 'texture',
          origin: 'created',
          descriptor: {
            kind: 'texture',
            format: 'rgba16float',
            size: { width: 960, height: 540, depthOrArrayLayers: 1 },
            width: 960,
            height: 540,
            depthOrArrayLayers: 1,
            mipLevelCount: 1,
            sampleCount: 1,
          },
          firstUse: 1,
          lastUse: 2,
          derivedUsage: 8,
          format: 'rgba16float',
          extent: { width: 960, height: 540, depthOrArrayLayers: 1 },
          byteSize: 960 * 540 * 8,
        },
        {
          label: 'volume-history',
          kind: 'texture',
          origin: 'created',
          descriptor: {
            kind: 'texture',
            format: 'rgba16float',
            size: { width: 960, height: 540, depthOrArrayLayers: 1 },
            width: 960,
            height: 540,
            depthOrArrayLayers: 1,
            mipLevelCount: 1,
            sampleCount: 1,
          },
          firstUse: 1,
          lastUse: 3,
          derivedUsage: 8,
          format: 'rgba16float',
          extent: { width: 960, height: 540, depthOrArrayLayers: 1 },
          byteSize: 960 * 540 * 8,
        },
        {
          label: 'volume-temporal',
          kind: 'texture',
          origin: 'created',
          descriptor: {
            kind: 'texture',
            format: 'rgba16float',
            size: { width: 960, height: 540, depthOrArrayLayers: 1 },
            width: 960,
            height: 540,
            depthOrArrayLayers: 1,
            mipLevelCount: 1,
            sampleCount: 1,
          },
          firstUse: 1,
          lastUse: 3,
          derivedUsage: 8,
          format: 'rgba16float',
          extent: { width: 960, height: 540, depthOrArrayLayers: 1 },
          byteSize: 960 * 540 * 8,
        },
        {
          label: 'volume-params',
          kind: 'buffer',
          origin: 'imported',
          descriptor: { kind: 'buffer', size: VOLUMETRIC_FOG_PARAMS_BYTES },
          firstUse: 0,
          lastUse: 3,
          derivedUsage: 64,
          byteSize: VOLUMETRIC_FOG_PARAMS_BYTES,
        },
      ],
    } as const;
    const facts = inspectVolumetricFogResources(graph);
    expect(facts.generation).toBe(17);
    expect(facts.sampleCount).toBe(960 * 540 * 64);
    expect(facts.resolvedPixelCount).toBe(960 * 540);
    expect(facts.currentBytes).toBe(960 * 540 * 8);
    expect(facts.bufferBytes).toBe(VOLUMETRIC_FOG_PARAMS_BYTES);
    expect(facts.liveResourceCount).toBe(5);
    expect(facts.historyBytes).toBe(960 * 540 * 8 * 2);
    expect(facts.physicalResourceCount).toBe(5);
    expect(facts.totalBytes).toBe(
      960 * 540 * 16 * 4 + 960 * 540 * 8 * 3 + VOLUMETRIC_FOG_PARAMS_BYTES,
    );
    expect(facts.totalBytes).toBe(
      facts.currentBytes + facts.historyBytes + facts.scratchBytes + facts.bufferBytes,
    );
    expect(facts.totalBytes).toBeLessThanOrEqual(MAX_MEMORY_BYTES);

    const doubleBuffered = inspectVolumetricFogResources(graph, { parameterBufferCount: 2 });
    expect(doubleBuffered.bufferBytes).toBe(VOLUMETRIC_FOG_PARAMS_BYTES * 2);
    expect(doubleBuffered.liveResourceCount).toBe(6);
    expect(doubleBuffered.physicalResourceCount).toBe(6);
    expect(doubleBuffered.totalBytes).toBe(
      960 * 540 * 16 * 4 + 960 * 540 * 8 * 3 + VOLUMETRIC_FOG_PARAMS_BYTES * 2,
    );
    expect(doubleBuffered.totalBytes).toBe(
      doubleBuffered.currentBytes +
        doubleBuffered.historyBytes +
        doubleBuffered.scratchBytes +
        doubleBuffered.bufferBytes,
    );
  });

  it.each([
    { ownerCount: 1, sampling: 0 },
    { ownerCount: 2, sampling: 0 },
    { ownerCount: 2, sampling: 2 },
  ])('uses the canonical World clock and history with $ownerCount owners and sampling $sampling', async ({
    ownerCount,
    sampling,
  }) => {
    const queue = new RecordingNullQueue();
    const adapter = new RecoverableNullAdapter(() => queue);
    const backend = {
      ...nullRhi,
      requestAdapter: async () => ok(adapter),
    };
    const created = await constructRendererHost(
      surfaceCanvas(640, 360),
      { rhi: backend },
      { shaderManifestUrl: VOLUME_MANIFEST },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { renderer } = created.value;
    const world = new World();
    const scalar = densityAsset();
    const density = world.allocSharedRef(
      'TextureAsset',
      sampling === 2
        ? { ...scalar, format: 'rgba8unorm', data: new Uint8Array(4 * 64 ** 3).fill(32) }
        : scalar,
    );
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: {
            ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
            tonemap: TONEMAP_ACES_FILMIC,
          },
        },
      )
      .unwrap();
    const sun = world
      .spawn({
        component: DirectionalLight,
        data: { direction: [-0.4, -0.8, -0.3], castShadow: true },
      })
      .unwrap();
    for (let owner = 0; owner < ownerCount; owner++)
      world
        .spawn({
          component: VolumetricFog,
          data: {
            light: sun,
            density,
            sampling,
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

    const lease = renderer.attach(world);
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    const request = {
      leases: [lease.value],
      camera: { lease: lease.value },
      environment: { lease: lease.value },
    } as const;
    const drawAndRead = async (): Promise<{
      readonly history: number;
      readonly worldTime: number;
      readonly delta: number;
    }> => {
      queue.writes.length = 0;
      const frame = renderer.draw(request);
      expect(frame.ok).toBe(true);
      if (!frame.ok) return { history: -1, worldTime: -1, delta: -1 };
      expect((await frame.value.completed).ok).toBe(true);
      const paramsWrite = queue.writes
        .filter(
          (write) => write.offset === 0 && write.bytes.byteLength === VOLUMETRIC_FOG_PARAMS_BYTES,
        )
        .at(-1);
      expect(paramsWrite).toBeDefined();
      if (paramsWrite === undefined) return { history: -1, worldTime: -1, delta: -1 };
      const params = new Float32Array(paramsWrite.bytes.buffer, paramsWrite.bytes.byteOffset);
      expect(params[3]).toBe(ownerCount);
      for (let owner = 0; owner < ownerCount; owner++) {
        expect(params[(owner + 1) * 36 + 7]).toBe(sampling);
        expect(params[(owner + 1) * 36 + 32]).toBeCloseTo(world.getResource(Time).elapsed, 5);
      }
      const historyWrite = queue.writes
        .filter(
          (write) =>
            write.buffer === paramsWrite.buffer &&
            write.offset === 31 * Float32Array.BYTES_PER_ELEMENT &&
            write.bytes.byteLength === 3 * Float32Array.BYTES_PER_ELEMENT,
        )
        .at(-1);
      expect(historyWrite).toBeDefined();
      if (historyWrite === undefined) return { history: -1, worldTime: -1, delta: -1 };
      return {
        history: new Float32Array(
          historyWrite.bytes.buffer,
          historyWrite.bytes.byteOffset,
          1,
        )[0] as number,
        worldTime: new Float32Array(
          historyWrite.bytes.buffer,
          historyWrite.bytes.byteOffset,
          3,
        )[1] as number,
        delta: new Float32Array(
          historyWrite.bytes.buffer,
          historyWrite.bytes.byteOffset,
          3,
        )[2] as number,
      };
    };

    world.update(1 / 60).unwrap();
    const firstTime = world.getResource(Time).elapsed;
    const first = await drawAndRead();
    expect(first.worldTime).toBeCloseTo(firstTime, 5);
    expect(first.history).toBe(0);

    const stable = await drawAndRead();
    expect(world.getResource(Time).elapsed).toBe(firstTime);
    expect(stable.worldTime).toBeCloseTo(firstTime, 5);
    expect(stable.history).toBe(1);

    world.update(1 / 60).unwrap();
    const movedTime = world.getResource(Time).elapsed;
    const moved = await drawAndRead();
    expect(moved.worldTime).toBeCloseTo(movedTime, 5);
    expect(moved.worldTime).toBeGreaterThan(first.worldTime);
    expect(moved.history).toBe(1);
    expect(moved.delta).toBeCloseTo(1 / 60, 6);
    expect(stable.delta).toBe(0);
    for (let index = 0; index < 12; index += 1) world.update(1 / 60).unwrap();
    const jumped = await drawAndRead();
    expect(jumped.history).toBe(0);
    expect(jumped.delta).toBeGreaterThan(0.1);
    await renderer.dispose();
  }, 30_000);

  it('derives a same-XY resolve descriptor when the packed raw extent is supplied alone', async () => {
    const adapter = await nullRhi.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) return;
    const createdDevice = await adapter.value.requestDevice();
    expect(createdDevice.ok).toBe(true);
    if (!createdDevice.ok) return;
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const resources = createVolumetricFogResources(graph, { width: 960, height: 540, depth: 64 });
    expect(resources.ok).toBe(true);
    if (!resources.ok) return;
    const compiled = graph.compile({
      device: createdDevice.value,
      surfaceSize: { width: 1920, height: 1080 },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const resolved = compiled.value
      .inspect()
      .resources.find((resource) => resource.label === 'volume-resolved-current');
    expect(resolved?.extent).toEqual({ width: 960, height: 540, depthOrArrayLayers: 1 });
  });

  it('keeps one real Renderer volume generation through 20 resizes, 3 recoveries, and 60 frames', async () => {
    const compositeSelections = vi.spyOn(volumeProgramOwner, 'volumeCompositeState');
    onTestFinished(() => compositeSelections.mockRestore());
    const adapter = new RecoverableNullAdapter();
    const backend = {
      ...nullRhi,
      requestAdapter: async () => ok(adapter),
    };
    const canvas = surfaceCanvas();
    const created = await constructRendererHost(
      canvas,
      { rhi: backend },
      { shaderManifestUrl: VOLUME_MANIFEST },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { renderer } = created.value;
    const readyVolumePipelines = adapter.devices[0]?.renderPipelineDescriptors.filter(
      (descriptor) => descriptor.label === 'volume_composite',
    );
    expect(readyVolumePipelines?.map((descriptor) => descriptor.fragment?.constants)).toEqual([
      { VOLUME_COMPOSITE_NEIGHBORS: 2 },
      { VOLUME_COMPOSITE_NEIGHBORS: 4 },
      { VOLUME_COMPOSITE_NEIGHBORS: 8 },
    ]);
    expect(
      adapter.devices[0]?.computePipelineDescriptors.filter((descriptor) =>
        descriptor.label?.startsWith('volume_'),
      ),
    ).toHaveLength(3);

    const world = new World();
    const density = world.allocSharedRef('TextureAsset', densityAsset());
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: {
            ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
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
    world
      .spawn({
        component: VolumetricFog,
        data: {
          light: directionalLight,
          density,
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
    const draw = async () => {
      const frame = renderer.draw(request);
      expect(frame.ok).toBe(true);
      if (!frame.ok) return undefined;
      expect((await frame.value.completed).ok).toBe(true);
      return renderer.inspect();
    };

    compositeSelections.mockClear();
    const initial = await draw();
    expect(compositeSelections.mock.calls.map((call) => call[3])).toContain(8);
    expect(initial?.volumetricFog).toMatchObject({
      status: 'available',
      resourceStage: 'accepted',
      passCount: 4,
    });
    const initialFacts = initial?.volumetricFog?.resourceFacts;
    expect(initialFacts).toBeDefined();
    if (initialFacts === undefined) return;
    const warmup = await draw();
    expect(warmup?.volumetricFog).toMatchObject({ status: 'available', passCount: 4 });
    const warmedFacts = warmup?.volumetricFog?.resourceFacts;
    expect(warmedFacts).toBeDefined();
    if (warmedFacts === undefined) return;
    const warmedSamplers = adapter.devices[0]?.samplerDescriptors.length;
    await draw();
    expect(adapter.devices[0]?.samplerDescriptors.slice(warmedSamplers)).toEqual([]);
    const integrateLayout = adapter.devices[0]?.bindGroupLayoutDescriptors.find(
      (descriptor) =>
        Array.from(descriptor.entries).filter((entry) => entry.texture?.viewDimension === '3d')
          .length === 11,
    );
    const sampledBindings = Array.from(integrateLayout?.entries ?? [])
      .filter((entry) => entry.texture !== undefined)
      .map((entry) => entry.binding)
      .sort((a, b) => a - b);
    // Disabled atmosphere/projector/cloud still have bindings, so their five
    // auxiliary textures are part of the portable sixteen-texture budget.
    expect(sampledBindings).toEqual([0, 1, 6, 12, 16, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 29]);
    const compositeDescriptors = adapter.devices[0]?.renderPipelineDescriptors.filter(
      (descriptor) => descriptor.label === 'volume_composite',
    );
    expect(compositeDescriptors?.length).toBeGreaterThan(0);
    expect(
      compositeDescriptors?.every(
        (descriptor) => descriptor.fragment?.targets[0]?.format === 'rgba16float',
      ),
    ).toBe(true);
    expect(
      adapter.devices[0]?.bindGroupLayoutDescriptors.find(
        (descriptor) => descriptor.label === 'volume_composite.bind-group-layout',
      )?.entries,
    ).toEqual([
      {
        binding: 0,
        visibility: 3,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
      { binding: 1, visibility: 3, sampler: { type: 'filtering' } },
      { binding: 2, visibility: 3, texture: { sampleType: 'depth', viewDimension: '2d' } },
      { binding: 3, visibility: 3, buffer: { type: 'uniform' } },
    ]);
    expect(
      adapter.devices[0]?.samplerDescriptors.find(
        (descriptor) => descriptor.label === 'volume_composite.sampler',
      ),
    ).toMatchObject({ minFilter: 'linear', magFilter: 'linear' });
    expect(
      adapter.devices[0]?.samplerDescriptors.find(
        (descriptor) => descriptor.label === 'volume_inject.density-sampler',
      ),
    ).toBeUndefined();
    const initialLedger = snapshotLedger(adapter.devices[0] as RecoverableNullDevice);
    expect(initialFacts.totalBytes).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
    expect(initialFacts.liveResourceCount).toBe(5);
    expect(initialFacts.physicalResourceCount).toBe(5);
    expect(warmedFacts.liveResourceCount).toBe(6);
    expect(warmedFacts.physicalResourceCount).toBe(6);
    expect(snapshotLedger(adapter.devices[0] as RecoverableNullDevice).liveTextures).toBe(
      initialLedger.liveTextures,
    );
    expect(snapshotLedger(adapter.devices[0] as RecoverableNullDevice).liveBuffers).toBe(
      initialLedger.liveBuffers,
    );
    const resizeFacts: Array<{
      readonly deviceGeneration: number;
      readonly volumeGeneration: number | undefined;
      readonly graphGeneration: number;
      readonly liveResourceCount: number;
      readonly totalBytes: number;
      readonly physicalResourceCount: number;
    }> = [];
    for (let index = 0; index < 20; index += 1) {
      canvas.width = 1921 + index;
      canvas.height = 1081 + index;
      const inspection = await draw();
      const facts = inspection?.volumetricFog?.resourceFacts;
      expect(facts).toBeDefined();
      if (facts === undefined || inspection === undefined) return;
      resizeFacts.push({
        deviceGeneration: inspection.frame.deviceGeneration,
        volumeGeneration: inspection.volumetricFog?.generation,
        graphGeneration: facts.generation,
        liveResourceCount: facts.liveResourceCount,
        totalBytes: facts.totalBytes,
        physicalResourceCount: facts.physicalResourceCount,
      });
      expect(inspection.volumetricFog).toMatchObject({ status: 'available', passCount: 4 });
      expect(facts.liveResourceCount).toBe(6);
      expect(facts.physicalResourceCount).toBe(6);
      expect(facts.totalBytes).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
      const ledger = snapshotLedger(adapter.devices[0] as RecoverableNullDevice);
      expect(ledger.liveTextures).toBe(initialLedger.liveTextures);
      expect(ledger.liveBuffers).toBe(initialLedger.liveBuffers);
    }

    const originalProfile = renderer.inspect().profile;
    expect(
      renderer.setProfile({
        ...originalProfile,
        volumetricFog: { quality: 'low', depth: 48, tileSize: 16 },
      }).ok,
    ).toBe(true);
    compositeSelections.mockClear();
    await draw();
    expect(compositeSelections.mock.calls.map((call) => call[3])).toContain(4);
    expect(compositeSelections.mock.calls.map((call) => call[3])).not.toContain(2);
    expect(
      adapter.devices[0]?.renderPipelineDescriptors.filter(
        (descriptor) => descriptor.label === 'volume_composite',
      ),
    ).toHaveLength(3);
    expect(renderer.setProfile(originalProfile).ok).toBe(true);
    compositeSelections.mockClear();
    await draw();
    expect(compositeSelections.mock.calls.map((call) => call[3])).toContain(8);
    const compositeVariants = adapter.devices[0]?.renderPipelineDescriptors.filter(
      (descriptor) => descriptor.label === 'volume_composite',
    );
    expect(compositeVariants?.map((descriptor) => descriptor.fragment?.constants)).toEqual([
      { VOLUME_COMPOSITE_NEIGHBORS: 2 },
      { VOLUME_COMPOSITE_NEIGHBORS: 4 },
      { VOLUME_COMPOSITE_NEIGHBORS: 8 },
    ]);

    const recoveryGenerations: number[] = [];
    const recoveryLedgers: LedgerSnapshot[] = [];
    for (let index = 0; index < 3; index += 1) {
      const device = adapter.devices.at(-1);
      expect(device).toBeDefined();
      if (device === undefined) return;
      device.lose();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(renderer.state()).toBe('device-lost');
      expect(renderer.draw(request).ok).toBe(false);
      const recovered = await renderer.recover();
      expect(recovered.ok).toBe(true);
      expect(renderer.state()).toBe('alive');
      const firstAfterRecovery = await draw();
      expect(firstAfterRecovery?.volumetricFog).toMatchObject({
        status: 'available',
        passCount: 4,
      });
      const firstFacts = firstAfterRecovery?.volumetricFog?.resourceFacts;
      expect(firstFacts).toBeDefined();
      if (firstFacts === undefined || firstAfterRecovery === undefined) return;
      expect(firstFacts.liveResourceCount).toBe(5);
      expect(firstFacts.physicalResourceCount).toBe(5);
      expect(firstFacts.totalBytes).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
      const inspection = await draw();
      expect(inspection?.volumetricFog).toMatchObject({ status: 'available', passCount: 4 });
      const facts = inspection?.volumetricFog?.resourceFacts;
      expect(facts).toBeDefined();
      if (facts === undefined || inspection === undefined) return;
      recoveryGenerations.push(inspection.frame.deviceGeneration);
      expect(facts.liveResourceCount).toBe(6);
      expect(facts.physicalResourceCount).toBe(6);
      expect(facts.totalBytes).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
      recoveryLedgers.push(snapshotLedger(adapter.devices.at(-1) as RecoverableNullDevice));
    }
    expect(adapter.devices).toHaveLength(4);
    expect(new Set(recoveryGenerations).size).toBe(3);
    expect(recoveryGenerations[2]).toBeGreaterThan(recoveryGenerations[0] ?? -1);

    const steadyFacts: Array<{
      readonly deviceGeneration: number;
      readonly volumeGeneration: number | undefined;
      readonly graphGeneration: number;
      readonly liveResourceCount: number;
      readonly totalBytes: number;
      readonly physicalResourceCount: number;
    }> = [];
    for (let frame = 0; frame < 60; frame += 1) {
      const inspection = await draw();
      const facts = inspection?.volumetricFog?.resourceFacts;
      expect(facts).toBeDefined();
      if (facts === undefined || inspection === undefined) return;
      steadyFacts.push({
        deviceGeneration: inspection.frame.deviceGeneration,
        volumeGeneration: inspection.volumetricFog?.generation,
        graphGeneration: facts.generation,
        liveResourceCount: facts.liveResourceCount,
        totalBytes: facts.totalBytes,
        physicalResourceCount: facts.physicalResourceCount,
      });
    }
    const steadyBaseline = steadyFacts[0];
    expect(steadyBaseline).toBeDefined();
    if (steadyBaseline === undefined) return;
    for (const facts of steadyFacts) expect(facts).toEqual(steadyBaseline);
    expect(new Set(resizeFacts.map((facts) => facts.liveResourceCount)).size).toBe(1);
    expect(new Set(resizeFacts.map((facts) => facts.physicalResourceCount)).size).toBe(1);
    expect(new Set(resizeFacts.map((facts) => facts.deviceGeneration)).size).toBe(1);
    expect(new Set(resizeFacts.map((facts) => facts.volumeGeneration)).size).toBe(1);
    expect(new Set(resizeFacts.map((facts) => facts.graphGeneration)).size).toBe(20);
    expect(steadyBaseline.liveResourceCount).toBe(6);
    expect(steadyBaseline.physicalResourceCount).toBe(6);
    expect(steadyBaseline.totalBytes).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
    const steadyLedger = snapshotLedger(adapter.devices.at(-1) as RecoverableNullDevice);
    expect(steadyLedger.liveTextures).toBeGreaterThan(0);
    expect(steadyLedger.liveBuffers).toBeGreaterThan(0);
    for (const ledger of recoveryLedgers) {
      expect(ledger.liveTextures).toBe(steadyLedger.liveTextures);
      expect(ledger.liveBuffers).toBe(steadyLedger.liveBuffers);
    }
    const volumePrograms = adapter.devices.map((device) =>
      Object.fromEntries(
        ['volume_inject', 'volume_integrate', 'volume_temporal', 'volume_composite'].map(
          (label) => [
            label,
            [...device.computePipelineDescriptors, ...device.renderPipelineDescriptors].filter(
              (descriptor) => descriptor.label === label,
            ).length,
          ],
        ),
      ),
    );
    await persistAc22Receipt({
      schemaVersion: '1',
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      runnerClass: 'null-structural',
      source: 'renderer.inspect+RhiNull.bookkeeper',
      resizeCount: resizeFacts.length,
      resizeFacts,
      recoveryCount: recoveryGenerations.length,
      recoveryGenerations,
      steadyFrameCount: steadyFacts.length,
      steadyFirst: steadyFacts[0],
      steadyLast: steadyFacts.at(-1),
      resourceBudgetBytes: MAX_MEMORY_BYTES,
      activeLedger: steadyLedger,
      volumePrograms,
    });
    for (const programs of volumePrograms)
      expect(programs).toEqual({
        volume_inject: 1,
        volume_integrate: 1,
        volume_temporal: 1,
        volume_composite: 3,
      });
    await renderer.dispose();
  }, 30_000);
});
