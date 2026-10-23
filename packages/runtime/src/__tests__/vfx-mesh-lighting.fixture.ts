import { type EntityHandle, World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createPlaneGeometry,
  deriveVertexCount,
  deriveVertexLayoutProjection,
  packInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack';
import {
  Camera,
  createRenderPublisher,
  DirectionalLight,
  type FrameReceipt,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
  type RenderError,
  renderPublicationAssetTransfers,
  renderPublicationTransfers,
  Skylight,
  SpotLight,
} from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  type RecorderAttachment,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import { Transform } from '@forgeax/engine-scene';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { ok, type ParticleEffectAsset, type Result } from '@forgeax/engine-types';
import { ParticleEffectPlayer } from '@forgeax/engine-vfx';
import type { ParticleCodeModuleSet } from '@forgeax/engine-vfx-compiler';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { expect, onTestFailed, onTestFinished } from 'vitest';
import {
  completeReadyFrame,
  drawReadyFrame,
} from '../../../../scripts/test/ready-render-frame.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { loadBackendPack } from '../backend-selection';
import { constructRuntimeRendererHost, type RendererHostAssembly } from '../renderer-host';
import { testAssets } from './helpers/runtime-assets';

export type CookMeshLightingFixture = (
  source: unknown,
  modules: Readonly<Record<string, ParticleCodeModuleSet>>,
) => Promise<Result<{ readonly asset: ParticleEffectAsset }, unknown>>;

function inspect(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item instanceof Error ? { ...item, message: item.message } : item,
  );
}

/** Scope the existing opt-in binding receipt required by the active-IBL oracle. */
export async function verifyVfxMeshLighting(
  options: Parameters<typeof runVfxMeshLighting>[0],
): Promise<void> {
  const globals = globalThis as { process?: { env: Record<string, string | undefined> } };
  const priorProcess = globals.process;
  const diagnosticProcess = priorProcess ?? { env: {} };
  const priorFlag = diagnosticProcess.env.FORGEAX_MATERIAL_DIAGNOSTICS;
  globals.process = diagnosticProcess;
  diagnosticProcess.env.FORGEAX_MATERIAL_DIAGNOSTICS = '1';
  const verification = runVfxMeshLighting(options).finally(() => {
    if (priorFlag === undefined) delete diagnosticProcess.env.FORGEAX_MATERIAL_DIAGNOSTICS;
    else diagnosticProcess.env.FORGEAX_MATERIAL_DIAGNOSTICS = priorFlag;
    if (priorProcess === undefined) delete globals.process;
  });
  // Vitest aborts the test context at its original timeout, but does not
  // terminate its async body. Await that body's existing cleanup in the
  // runner's original finished-hook budget; an incomplete drain stays failed.
  onTestFinished(() =>
    verification.then(
      () => undefined,
      () => undefined,
    ),
  );
  await verification;
}

interface VfxMeshLightingOptions {
  readonly shaderManifestUrl: string;
  readonly signal: AbortSignal;
  readonly publication?: boolean;
  readonly sampledTextureLimit?: number;
  readonly cook: CookMeshLightingFixture;
  readonly tapePaths?: Readonly<Record<string, string | undefined>>;
  readonly saveTape?: (path: string, bytes: Uint8Array) => void;
  readonly onIblFailure?: (state: unknown, tape?: Uint8Array) => Promise<void>;
}

type BackendPack = Extract<Awaited<ReturnType<typeof loadBackendPack>>, { ok: true }>['value'];
type RecordableBackendPack = BackendPack & {
  readonly createShaderModule: NonNullable<BackendPack['createShaderModule']>;
};
type HostRenderer = RendererHostAssembly['renderer'];
type WorldLease = Extract<ReturnType<HostRenderer['attach']>, { ok: true }>['value'];
type RenderPublisher = ReturnType<typeof createRenderPublisher>;
type VfxRuntimeHost = ReturnType<typeof createVfxRuntimeHost>;
type Vec3 = readonly [number, number, number];
type SampleGuid = ReturnType<typeof AssetGuid.random>;

/** Failure-phase bookkeeping that survives the original timeout for diagnostics. */
class VfxMeshLightingPhases {
  failurePhase = 'backend-pack';
  sampleIndex = 0;
  sampleState: unknown = null;
  completedFrames = 0;
  cleanupStarted = false;
  iblFailureRecorded = false;
  inspectRenderer: (() => unknown) | undefined;
  readonly errors: unknown[] = [];
  private readonly signal: AbortSignal;
  private readonly startedAt = performance.now();
  private phaseStartedAt = this.startedAt;
  private readonly phaseTimings: Record<string, { calls: number; elapsedMs: number }> = {};
  private readonly cookWaitIntervals: {
    readonly sampleIndex: number;
    readonly startedAtUnixMs: number;
    readonly completedAtUnixMs: number;
  }[] = [];

  constructor(signal: AbortSignal) {
    this.signal = signal;
  }

  enter(next: string): void {
    this.signal.throwIfAborted();
    const now = performance.now();
    if (this.failurePhase === 'vfx-cook') {
      if (this.cookWaitIntervals.length >= 256) this.cookWaitIntervals.shift();
      this.cookWaitIntervals.push({
        sampleIndex: this.sampleIndex,
        startedAtUnixMs: performance.timeOrigin + this.phaseStartedAt,
        completedAtUnixMs: performance.timeOrigin + now,
      });
    }
    const timing = this.phaseTimings[this.failurePhase] ?? { calls: 0, elapsedMs: 0 };
    this.phaseTimings[this.failurePhase] = timing;
    timing.calls++;
    timing.elapsedMs += now - this.phaseStartedAt;
    this.failurePhase = next;
    this.phaseStartedAt = now;
  }

  inspectTimings() {
    return {
      elapsedMs: performance.now() - this.startedAt,
      completed: structuredClone(this.phaseTimings),
      cookWaitIntervals: structuredClone(this.cookWaitIntervals),
      pending: {
        phase: this.failurePhase,
        startedAtUnixMs: performance.timeOrigin + this.phaseStartedAt,
        elapsedMs: performance.now() - this.phaseStartedAt,
      },
      qualification:
        'Fixture wall durations including async waits. Unix intervals correlate with Node-host receipts only on the same clock; negative ordering remains unclassified. Not exclusive GPU or compiler CPU time.',
    };
  }
}

/** Minimal canvas whose configured device and 64x64 target the fixture reads back. */
class CapturedCanvasSurface {
  device: GPUDevice | undefined;
  target: GPUTexture | undefined;
  readonly canvas: unknown;

  constructor(errors: unknown[]) {
    this.canvas = {
      width: 64,
      height: 64,
      getContext: () => ({
        configure: (descriptor: GPUCanvasConfiguration) => {
          const device = descriptor.device;
          this.device = device;
          device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
          this.target = device.createTexture({
            size: [64, 64],
            format: descriptor.format,
            viewFormats: [
              descriptor.format === 'rgba8unorm' ? 'rgba8unorm-srgb' : 'bgra8unorm-srgb',
            ],
            usage: 0x10 | 0x01,
          });
        },
        unconfigure() {},
        getCurrentTexture: () => this.target,
      }),
      addEventListener() {},
      removeEventListener() {},
    };
  }

  /** Copy the center pixel of the presented target. */
  async centerPixel(): Promise<number[]> {
    const device = this.device;
    const target = this.target;
    if (device === undefined || target === undefined) throw new Error('No GPU surface');
    const buffer = device.createBuffer({ size: 256, usage: 0x01 | 0x08 });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: target, origin: [32, 32] },
        { buffer, bytesPerRow: 256 },
        [1, 1],
      );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(1);
      const result = [...new Uint8Array(buffer.getMappedRange()).slice(0, 4)];
      buffer.unmap();
      return result;
    } finally {
      buffer.destroy();
    }
  }
}

function sampledTextureLimitRhi(
  recorder: RecorderAttachment,
  sampledTextureLimit: number | undefined,
): RecorderAttachment['backend']['rhi'] {
  return {
    ...recorder.backend.rhi,
    async requestAdapter(request, surface) {
      const result = await recorder.backend.rhi.requestAdapter(request, surface);
      if (!result.ok || sampledTextureLimit === undefined) return result;
      const limit = sampledTextureLimit;
      return ok({
        ...result.value,
        limits: { ...result.value.limits, maxSampledTexturesPerShaderStage: limit },
        requestDevice: (descriptor) =>
          result.value.requestDevice({
            ...descriptor,
            requiredLimits: {
              ...descriptor?.requiredLimits,
              maxSampledTexturesPerShaderStage: limit,
            },
          }),
      });
    },
  };
}

/** One authored lighting sample: lighting mode, light intensity and optional subjects. */
interface LightingSample {
  readonly lighting: 'standard' | 'unlit';
  readonly receiveShadows: boolean;
  readonly intensity: number;
  readonly caster: { readonly enabled: boolean; readonly position: Vec3 } | undefined;
  readonly surface:
    | {
        readonly ordinary?: boolean;
        readonly roughness: number;
        readonly metallic: number;
      }
    | undefined;
  readonly geometryGuid: SampleGuid;
}

const VISIBLE_PREFIX_WGSL = `
#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(0.7, 0.0, 0.0);
  (*particle).color = vec4<f32>(1.0);
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  (*particle).mesh_scale = vec3<f32>(0.25);
  (*particle).lifetime = 100.0;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}`;

function meshSampleWgsl(position: Vec3): string {
  return `
#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(${position.map((value) => `${value.toFixed(2)}`).join(', ')});
  (*particle).color = vec4<f32>(1.0);
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  (*particle).mesh_scale = vec3<f32>(1.0);
  (*particle).lifetime = 100.0;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}`;
}

// Its ordinary raster precedes the off-camera caster in authored
// order. It must not delay the independent caster's GPU projection.
function visiblePrefixEmitters(sample: LightingSample, materialGuid: SampleGuid) {
  if (!sample.caster?.enabled) return [];
  return [
    {
      id: 'visible-prefix',
      capacity: 1,
      backend: { required: 'gpu' as const },
      space: 'world' as const,
      bounds: { kind: 'sphere' as const, center: [0.7, 0, 0], radius: 0.5 },
      schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
      program: { module: 'visible.wgsl' },
      renderers: [
        {
          kind: 'mesh' as const,
          mesh: AssetGuid.format(sample.geometryGuid),
          material: AssetGuid.format(materialGuid),
          lighting: 'unlit' as const,
          castShadows: false,
        },
      ],
    },
  ];
}

function sampleEffectSource(
  sample: LightingSample,
  materialGuid: SampleGuid,
  surfaceGuid: SampleGuid,
) {
  const { caster } = sample;
  return {
    schemaVersion: 3,
    emitters: [
      ...visiblePrefixEmitters(sample, materialGuid),
      {
        id: 'mesh',
        capacity: 1,
        backend: { required: 'gpu' },
        space: 'world',
        bounds: {
          kind: 'sphere',
          center: caster?.position ?? [0, 0, 0],
          radius: caster === undefined ? 4 : 0.5,
        },
        schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
        program: { module: 'mesh.wgsl' },
        renderers: [
          {
            kind: 'mesh',
            mesh: AssetGuid.format(sample.geometryGuid),
            material: AssetGuid.format(surfaceGuid),
            lighting: sample.lighting,
            receiveShadows: sample.receiveShadows,
            castShadows: caster?.enabled ?? false,
          },
        ],
      },
    ],
  };
}

type StandardMaterial = ReturnType<typeof createBuiltinMaterialAsset>;
type BoxMesh = ReturnType<ReturnType<typeof createBoxGeometry>['unwrap']>;

/** The constructed renderer, its World and the authored subjects every sample reuses. */
interface VfxMeshLightingRigParts {
  readonly options: VfxMeshLightingOptions;
  readonly phases: VfxMeshLightingPhases;
  readonly surface: CapturedCanvasSurface;
  readonly recorder: RecorderAttachment;
  readonly host: RendererHostAssembly;
  readonly world: World;
  readonly vfx: VfxRuntimeHost;
  readonly publisher: RenderPublisher | undefined;
  readonly lease: WorldLease | undefined;
  readonly receiverFeature: VfxRuntimeHost['feature'];
  readonly light: EntityHandle;
  readonly material: StandardMaterial;
  readonly mesh: BoxMesh;
  readonly materialGuid: SampleGuid;
  readonly meshGuid: SampleGuid;
}

class VfxMeshLightingRig {
  readonly options: VfxMeshLightingOptions;
  readonly phases: VfxMeshLightingPhases;
  readonly surface: CapturedCanvasSurface;
  readonly recorder: RecorderAttachment;
  readonly host: RendererHostAssembly;
  readonly renderer: HostRenderer;
  readonly world: World;
  readonly vfx: VfxRuntimeHost;
  readonly publisher: RenderPublisher | undefined;
  readonly lease: WorldLease | undefined;
  readonly light: EntityHandle;
  readonly material: StandardMaterial;
  readonly mesh: BoxMesh;
  readonly materialGuid: SampleGuid;
  readonly meshGuid: SampleGuid;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly capturedWork: unknown[] = [];
  receiverFeature: VfxRuntimeHost['feature'];
  pointShadowCaptureStage = 0;
  requireActiveIbl = false;

  constructor(parts: VfxMeshLightingRigParts) {
    this.options = parts.options;
    this.phases = parts.phases;
    this.surface = parts.surface;
    this.recorder = parts.recorder;
    this.host = parts.host;
    this.renderer = parts.host.renderer;
    this.world = parts.world;
    this.vfx = parts.vfx;
    this.publisher = parts.publisher;
    this.lease = parts.lease;
    this.receiverFeature = parts.receiverFeature;
    this.light = parts.light;
    this.material = parts.material;
    this.mesh = parts.mesh;
    this.materialGuid = parts.materialGuid;
    this.meshGuid = parts.meshGuid;
    this.env = parts.options.tapePaths ?? {};
  }

  async drawFrame(): Promise<Result<FrameReceipt, RenderError>> {
    this.options.signal.throwIfAborted();
    const renderer = this.renderer;
    const source = this.publisher;
    if (source === undefined) {
      const lease = this.lease;
      if (lease === undefined) throw new Error('Missing World lease');
      return ok(
        await drawReadyFrame(renderer, {
          leases: [lease],
          camera: { lease },
          environment: { lease },
        }),
      );
    }
    const receipt = await completeReadyFrame(async () => {
      const candidate = source.prepare(0).unwrap();
      const packet = structuredClone(candidate.packet, {
        transfer: [
          ...renderPublicationTransfers(candidate.packet),
          ...renderPublicationAssetTransfers(candidate.packet),
        ],
      });
      candidate.accept();
      try {
        const draw = renderer.draw({
          publication: packet,
          onFeatureSourceSubmitted: (identity, feedback) => {
            source
              .acknowledgeFeatures(packet.revision, [
                { identity, feedback: structuredClone(feedback) },
              ])
              .unwrap();
          },
        });
        if (!draw.ok) throw draw.error;
        const complete = await draw.value.completed;
        if (!complete.ok) throw complete.error;
        return draw.value;
      } finally {
        source.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
      }
    });
    return ok(receipt);
  }

  pixel(): Promise<number[]> {
    this.options.signal.throwIfAborted();
    return this.surface.centerPixel();
  }

  async present(): Promise<number[]> {
    const submitted = await this.drawFrame();
    if (!submitted.ok) throw submitted.error;
    const observed = await this.renderer.observe(submitted.value, { include: ['draws'] });
    if (!observed.ok) throw observed.error;
    return this.pixel();
  }

  async sample(
    lighting: 'standard' | 'unlit',
    receiveShadows: boolean,
    intensity: number,
    caster?: { readonly enabled: boolean; readonly position: Vec3 },
    surface?: {
      readonly ordinary?: boolean;
      readonly roughness: number;
      readonly metallic: number;
    },
    geometryGuid = this.meshGuid,
  ): Promise<number[]> {
    const { phases, world } = this;
    phases.sampleIndex++;
    phases.sampleState = {
      lighting,
      receiveShadows,
      intensity,
      caster,
      surface,
      requireActiveIbl: this.requireActiveIbl,
    };
    phases.completedFrames = 0;
    const sample: LightingSample = {
      lighting,
      receiveShadows,
      intensity,
      caster,
      surface,
      geometryGuid,
    };
    phases.enter('sample-authoring');
    world.set(this.light, DirectionalLight, { intensity }).unwrap();
    const surfaceMaterial = this.surfaceMaterialFor(sample);
    const surfaceGuid = await this.publishSurfaceMaterial(sample, surfaceMaterial);
    phases.enter('vfx-cook');
    const cooked = await this.options.cook(
      sampleEffectSource(sample, this.materialGuid, surfaceGuid),
      {
        'visible.wgsl': { entry: VISIBLE_PREFIX_WGSL },
        'mesh.wgsl': { entry: meshSampleWgsl(caster?.position ?? [0, 0, 0]) },
      },
    );
    if (!cooked.ok) throw cooked.error;
    phases.enter('sample-install');
    const player = this.spawnSamplePlayer(sample, surfaceMaterial, cooked.value.asset);
    try {
      await this.driveSampleFrames();
      if (this.requireActiveIbl) await this.expectActiveIbl();
      this.expectSampleSubmission(sample);
      if (this.capturesSampleWork(sample)) await this.captureSampleWork(sample);
      phases.enter('pixel-readback');
      const sampled = await this.pixel();
      if (surface?.ordinary && sampled[3] === 0)
        throw new Error(inspect({ work: this.capturedWork, renderer: this.renderer.inspect() }));
      return sampled;
    } finally {
      world.despawn(player).unwrap();
    }
  }

  spawnMeshCaster(position: Vec3, geometry: BoxMesh = this.mesh): EntityHandle {
    const world = this.world;
    return world
      .spawn(
        { component: Transform, data: { pos: position, quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        {
          component: MeshFilter,
          data: { assetHandle: testAssets(world).create(geometry).unwrap() },
        },
        {
          component: MeshRenderer,
          data: {
            materials: [
              testAssets(world)
                .create({
                  ...this.material,
                  passes: [
                    ...(this.material.passes ?? []),
                    {
                      name: 'ShadowCaster',
                      program: { module: 'forgeax::default-shadow-caster' },
                      renderState: {
                        tags: { LightMode: 'ShadowCaster' },
                        passKind: 'shadow-caster',
                      },
                    },
                  ],
                })
                .unwrap(),
            ],
          },
        },
      )
      .unwrap();
  }

  /**
   * Capture one following frame as an RHI tape, bracketed by recorder frame
   * boundaries. `complete` waits for GPU completion, `observe` observes its
   * draws, and `present` also reads back the center pixel.
   */
  async captureNextFrame(
    mode: 'complete' | 'observe' | 'present',
  ): Promise<{ readonly bytes: Uint8Array; readonly frame: number[] | undefined }> {
    const capture = this.recorder.captureFrame();
    const before = await this.recorder.frameBoundary();
    if (!before.ok) throw before.error;
    this.world.update(1 / 60).unwrap();
    let frame: number[] | undefined;
    switch (mode) {
      case 'present':
        frame = await this.present();
        break;
      case 'observe': {
        const draw = await this.drawFrame();
        if (!draw.ok) throw draw.error;
        const observed = await this.renderer.observe(draw.value, { include: ['draws'] });
        if (!observed.ok) throw observed.error;
        break;
      }
      case 'complete': {
        const draw = await this.drawFrame();
        if (!draw.ok) throw draw.error;
        const completed = await draw.value.completed;
        if (!completed.ok) throw completed.error;
        break;
      }
    }
    const after = await this.recorder.frameBoundary();
    if (!after.ok) throw after.error;
    const encoded = await capture;
    if (!encoded.ok) throw encoded.error;
    return { bytes: encoded.value.bytes, frame };
  }

  private surfaceMaterialFor(sample: LightingSample): StandardMaterial {
    return {
      ...this.material,
      values: {
        ...this.material.values,
        baseColor: [0.3, 0.3, 0.3, 1],
        metallic: sample.surface?.metallic ?? 0,
        roughness: sample.surface?.roughness ?? 1,
      },
    };
  }

  private async publishSurfaceMaterial(
    sample: LightingSample,
    surfaceMaterial: StandardMaterial,
  ): Promise<SampleGuid> {
    if (sample.surface === undefined) return this.materialGuid;
    const surfaceGuid = AssetGuid.random();
    publishRuntimeAssets(this.host.assets, [
      { guid: AssetGuid.format(surfaceGuid), asset: surfaceMaterial },
    ]);
    (await this.host.assets.load(surfaceGuid, 'material')).unwrap();
    return surfaceGuid;
  }

  private spawnSamplePlayer(
    sample: LightingSample,
    surfaceMaterial: StandardMaterial,
    effect: ParticleEffectAsset,
  ): EntityHandle {
    const world = this.world;
    if (sample.surface?.ordinary === true)
      return world
        .spawn(
          {
            component: Transform,
            data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          {
            component: MeshFilter,
            data: { assetHandle: testAssets(world).create(this.mesh).unwrap() },
          },
          {
            component: MeshRenderer,
            data: { materials: [testAssets(world).create(surfaceMaterial).unwrap()] },
          },
        )
        .unwrap();
    return world
      .spawn({
        component: ParticleEffectPlayer,
        data: {
          effect: testAssets(world).create(effect).unwrap(),
          playing: true,
          seed: 1,
          timeScale: 1,
        },
      })
      .unwrap();
  }

  private async driveSampleFrames(): Promise<void> {
    const { phases, world } = this;
    for (let index = 0; index < 300; index++) {
      world.update(1 / 60).unwrap();
      phases.enter('frame-submission');
      const submitted = await this.drawFrame();
      if (!submitted.ok)
        throw new Error(inspect({ error: submitted.error, events: phases.errors }));
      phases.enter('frame-completion');
      const completed = await submitted.value.completed;
      if (!completed.ok) throw completed.error;
      phases.completedFrames++;
      phases.enter('ibl-publication');
      // IBL precompute publishes asynchronously. Sequential material samples
      // must share active resources, not compare fallback with a later bake.
      if (
        index >= 7 &&
        (!this.requireActiveIbl || this.renderer.inspect().iblBinding?.active === 'active')
      )
        break;
    }
  }

  private async expectActiveIbl(): Promise<void> {
    try {
      expect(this.renderer.inspect().iblBinding?.active, 'IBL publication within 300 frames').toBe(
        'active',
      );
    } catch (failure) {
      const onIblFailure = this.options.onIblFailure;
      if (onIblFailure !== undefined) await this.recordIblFailure(onIblFailure);
      throw failure;
    }
  }

  private async recordIblFailure(
    onIblFailure: NonNullable<VfxMeshLightingOptions['onIblFailure']>,
  ): Promise<void> {
    const phases = this.phases;
    phases.iblFailureRecorded = true;
    const state = {
      phase: phases.failurePhase,
      phaseTimings: phases.inspectTimings(),
      sampleIndex: phases.sampleIndex,
      sampleState: phases.sampleState,
      completedFrames: phases.completedFrames,
      cleanupStarted: phases.cleanupStarted,
      renderer: this.renderer.inspect(),
      events: phases.errors,
      frameCount: 300,
    };
    // Preserve the failed original oracle before diagnostic GPU work.
    try {
      await onIblFailure(state);
      const captured = await this.captureNextFrame('complete');
      await onIblFailure(state, captured.bytes);
    } catch (captureError) {
      console.error('VFX IBL failure capture unavailable', inspect({ ...state, captureError }));
    }
  }

  private expectSampleSubmission(sample: LightingSample): void {
    if (this.options.sampledTextureLimit !== undefined) {
      expect(this.surface.device?.limits.maxSampledTexturesPerShaderStage).toBe(
        this.options.sampledTextureLimit,
      );
    }
    expect(this.phases.errors).toEqual([]);
    if (!sample.caster?.enabled) return;
    expect(
      this.vfx
        .inspect(this.world)
        ?.players.flatMap((player) => player.emitters)
        .map((emitter) => emitter.cameraVisible),
    ).toEqual([true, false]);
    const names = this.renderer.inspect().perFramePassNames;
    const projectIndices = names.flatMap((name, index) =>
      name.endsWith('.project') ? [index] : [],
    );
    expect(projectIndices.length).toBeGreaterThan(0);
    for (const projectIndex of projectIndices)
      expect(projectIndex, names.join('\n')).toBeLessThan(names.indexOf('shadowCascade0'));
  }

  private capturesSampleWork(sample: LightingSample) {
    const { caster, intensity, lighting, receiveShadows } = sample;
    const env = this.env;
    return (
      caster?.enabled === true ||
      sample.surface?.ordinary === true ||
      (env.FORGEAX_POINT_SHADOW_TAPE !== undefined && this.pointShadowCaptureStage === 2) ||
      (caster?.enabled &&
        intensity === 0 &&
        (env.FORGEAX_VFX_CAST_TAPE !== undefined || env.FORGEAX_POINT_SHADOW_TAPE !== undefined)) ||
      (lighting === 'standard' &&
        receiveShadows &&
        intensity === 3 &&
        this.capturedWork.length === 0)
    );
  }

  private saveSampleTapes(sample: LightingSample, bytes: Uint8Array): void {
    const env = this.env;
    const saveTape = this.options.saveTape;
    if (env.FORGEAX_VFX_LIGHTING_TAPE !== undefined) {
      saveTape?.(env.FORGEAX_VFX_LIGHTING_TAPE, bytes);
    }
    if (env.FORGEAX_POINT_SHADOW_TAPE !== undefined && this.pointShadowCaptureStage === 2) {
      saveTape?.(env.FORGEAX_POINT_SHADOW_TAPE, bytes);
    }
    if (
      env.FORGEAX_POINT_SHADOW_TAPE !== undefined &&
      sample.caster?.enabled === true &&
      sample.lighting === 'standard' &&
      sample.receiveShadows &&
      sample.intensity === 0 &&
      sample.surface === undefined
    ) {
      saveTape?.(env.FORGEAX_POINT_SHADOW_TAPE, bytes);
    }
    if (sample.caster?.enabled && env.FORGEAX_VFX_CAST_TAPE !== undefined) {
      saveTape?.(env.FORGEAX_VFX_CAST_TAPE, bytes);
    }
  }

  private async captureSampleWork(sample: LightingSample): Promise<void> {
    this.phases.enter('rhi-capture');
    const captured = await this.captureNextFrame('observe');
    this.saveSampleTapes(sample, captured.bytes);
    const decoded = decodeTape(captured.bytes);
    if (!decoded.ok) throw decoded.error;
    const model = buildFrameModel(decoded.value);
    if (sample.caster?.enabled) expectProjectionsBeforeShadows(model);
    this.capturedWork.push(
      ...model.works.map((work) => ({
        index: work.workIndex,
        kind: work.kind,
        pipeline: work.pipeline?.shaders?.map((shader) => shader.entryPoint),
        bindings: work.bindings.map((binding) => [binding.groupIndex, binding.binding]),
      })),
    );
  }
}

type FrameModel = ReturnType<typeof buildFrameModel>;

// Logical projections may share one native compute pass. Require
// both actual dispatches before any depth-only shadow draw.
function expectProjectionsBeforeShadows(model: FrameModel): void {
  const projects = model.works.filter((work) =>
    work.pipeline?.shaders.some((shader) => shader.entryPoint === 'forgeax_vfx_mesh_main'),
  );
  expect(projects).toHaveLength(2);
  const firstShadow = model.works.find(
    (work) =>
      work.attachments !== null &&
      work.attachments.depthStencilViewHandleId !== null &&
      work.attachments.colorViewHandleIds.length === 0,
  );
  if (firstShadow === undefined) throw new Error('Missing captured shadow draw');
  for (const project of projects) expect(project.workIndex).toBeLessThan(firstShadow.workIndex);
}

interface AuthoredLightingScene {
  readonly light: EntityHandle;
  readonly material: StandardMaterial;
  readonly mesh: BoxMesh;
  readonly materialGuid: SampleGuid;
  readonly meshGuid: SampleGuid;
}

async function authorLightingScene(
  world: World,
  assets: RendererHostAssembly['assets'],
): Promise<AuthoredLightingScene> {
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 10 } },
    )
    .unwrap();
  const light = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-1, 0, -1],
        color: [1, 1, 1],
        intensity: 3,
        castShadow: true,
        cascadeCount: 1,
        mapSize: testQuality.shadowMapSize,
        shadowDistance: 6,
        depthBias: 0.001,
        normalBias: 0.001,
      },
    })
    .unwrap();
  const material = createBuiltinMaterialAsset('standard');
  const mesh = createBoxGeometry(0.5, 0.5, 0.5).unwrap();
  const materialGuid = AssetGuid.random();
  const meshGuid = AssetGuid.random();
  publishRuntimeAssets(assets, [
    {
      guid: AssetGuid.format(materialGuid),
      asset: {
        ...material,
        values: { ...material.values, baseColor: [0.3, 0.3, 0.3, 1], metallic: 0, roughness: 1 },
      },
    },
    { guid: AssetGuid.format(meshGuid), asset: mesh },
  ]);
  (await assets.load(materialGuid, 'material')).unwrap();
  (await assets.load(meshGuid, 'mesh')).unwrap();
  return { light, material, mesh, materialGuid, meshGuid };
}

interface LightingBaseline {
  readonly lit: number[];
  readonly dark: number[];
  readonly unlit: number[];
}

async function verifyDirectionalLighting(rig: VfxMeshLightingRig): Promise<LightingBaseline> {
  const lit = await rig.sample('standard', true, 3);
  const dark = await rig.sample('standard', true, 0);
  const unlit = await rig.sample('unlit', true, 0);
  const unlitWithLight = await rig.sample('unlit', false, 3);
  expect(
    lit[0],
    JSON.stringify({ lit, dark, unlit, unlitWithLight, capturedWork: rig.capturedWork }),
  ).toBeGreaterThan((dark[0] ?? 0) + 30);
  expect(unlit[0]).toBeGreaterThan((dark[0] ?? 0) + 30);
  expect(unlitWithLight).toEqual(unlit);
  return { lit, dark, unlit };
}

async function verifyVertexColorSample(
  rig: VfxMeshLightingRig,
  baseline: LightingBaseline,
): Promise<void> {
  const { mesh } = rig;
  const { unlit } = baseline;
  const vertexCount = deriveVertexCount(
    mesh.vertices,
    deriveVertexLayoutProjection(mesh.attributes),
  );
  if (vertexCount === undefined) throw new Error('Invalid fixture mesh layout');
  const attributes = {
    ...mesh.attributes,
    color: new Float32Array(
      Array.from({ length: vertexCount * 4 }, (_, index) =>
        index % 4 === 1 || index % 4 === 3 ? 1 : 0.1,
      ),
    ),
    uv1: new Float32Array(vertexCount * 2).fill(0.75),
  };
  const packed = packInterleavedVertexAttributes(attributes, vertexCount).unwrap();
  const coloredMeshGuid = AssetGuid.random();
  publishRuntimeAssets(rig.host.assets, [
    {
      guid: AssetGuid.format(coloredMeshGuid),
      asset: { ...mesh, attributes, vertices: packed.vertices },
    },
  ]);
  (await rig.host.assets.load(coloredMeshGuid, 'mesh')).unwrap();
  const colored = await rig.sample('unlit', false, 0, undefined, undefined, coloredMeshGuid);
  expect(colored[1], JSON.stringify({ unlit, colored })).toBeGreaterThan((colored[0] ?? 0) + 20);
  expect(await rig.sample('unlit', false, 0)).toEqual(unlit);
}

async function verifyDirectionalOccluder(
  rig: VfxMeshLightingRig,
  baseline: LightingBaseline,
): Promise<void> {
  const { lit } = baseline;
  const occluder = rig.spawnMeshCaster([1, 0, 1.25]);
  const shadowed = await rig.sample('standard', true, 3);
  const noReceive = await rig.sample('standard', false, 3);
  expect(noReceive[0], JSON.stringify({ lit, shadowed, noReceive })).toBeGreaterThan(
    (shadowed[0] ?? 0) + 30,
  );
  expect(noReceive).toEqual(lit);
  rig.world.despawn(occluder).unwrap();
  expect(await rig.sample('standard', true, 3)).toEqual(lit);
}

// Reverse the caster witness: a GPU Mesh must receive the shared point
// shadow, respect receiveShadows, and consume live authored bias values.
async function verifyPointShadowReceiver(
  rig: VfxMeshLightingRig,
  baseline: LightingBaseline,
): Promise<void> {
  const world = rig.world;
  const receivingPoint = world
    .spawn(
      {
        component: Transform,
        data: { pos: [2.4, 0, 2.65], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
      { component: PointLight, data: { color: [1, 1, 1], intensity: 40, range: 10 } },
      {
        component: PointLightShadow,
        data: {
          mapSize: testQuality.shadowMapSize,
          nearPlane: 0.1,
          farPlane: 10,
          depthBias: 0.001,
          normalBias: 0.001,
        },
      },
    )
    .unwrap();
  rig.pointShadowCaptureStage = 1;
  const pointLit = await rig.sample('standard', true, 0);
  const receivingOccluder = rig.spawnMeshCaster([1.2, 0, 1.45]);
  rig.pointShadowCaptureStage = 2;
  const pointShadow = await rig.sample('standard', true, 0);
  const pointNoReceive = await rig.sample('standard', false, 0);
  expect(pointLit[0], JSON.stringify({ pointLit, pointShadow, pointNoReceive })).toBeGreaterThan(
    (pointShadow[0] ?? 0) + 30,
  );
  expect(pointNoReceive).toEqual(pointLit);
  world.set(receivingPoint, PointLightShadow, { depthBias: 1000, normalBias: 0 }).unwrap();
  expect(
    await rig.sample('standard', true, 0),
    'Authored point depth bias must reach the GPU receiver',
  ).toEqual(pointLit);
  world.set(receivingPoint, PointLightShadow, { depthBias: 0.001, normalBias: 400 }).unwrap();
  expect(
    await rig.sample('standard', true, 0),
    'Point slope bias must not be swapped with the depth floor',
  ).toEqual(pointLit);
  world.set(receivingPoint, PointLightShadow, { depthBias: 0.001, normalBias: 0.001 }).unwrap();
  expect(await rig.sample('standard', true, 0)).toEqual(pointShadow);
  world.despawn(receivingOccluder).unwrap();
  expect(await rig.sample('standard', true, 0)).toEqual(pointLit);
  world.set(receivingPoint, PointLight, { intensity: 0 }).unwrap();
  expect(await rig.sample('standard', true, 0)).toEqual(baseline.dark);
  world.despawn(receivingPoint).unwrap();
}

// A directional HDR panorama falsifies the constant-white fallback and
// exercises the renderer-owned diffuse, specular mip, and BRDF LUT path.
function spawnDirectionalSkylight(world: World): EntityHandle {
  const environmentBytes = new Uint8Array(16 * 8 * 8);
  const environmentView = new DataView(environmentBytes.buffer);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 16; x++) {
      const offset = (y * 16 + x) * 8;
      environmentView.setUint16(offset, x < 8 ? 0x4000 : 0x2800, true);
      environmentView.setUint16(offset + 2, 0x2800, true);
      environmentView.setUint16(offset + 4, x < 8 ? 0x2800 : 0x4000, true);
      environmentView.setUint16(offset + 6, 0x3c00, true);
    }
  return world
    .spawn({
      component: Skylight,
      data: {
        equirect: testAssets(world)
          .create({
            kind: 'equirect',
            width: 16,
            height: 8,
            format: 'rgba16float',
            colorSpace: 'linear',
            data: environmentBytes,
          })
          .unwrap(),
        intensity: 0.5,
      },
    })
    .unwrap();
}

async function verifyEnvironmentLighting(
  rig: VfxMeshLightingRig,
  baseline: LightingBaseline,
): Promise<void> {
  const world = rig.world;
  const sky = spawnDirectionalSkylight(world);
  rig.requireActiveIbl = true;
  const environmentSamples: number[][] = [];
  for (const metallic of [0, 1])
    for (const roughness of [0.05, 1]) {
      const surface = { metallic, roughness };
      const ordinary = await rig.sample('standard', true, 0, undefined, {
        ...surface,
        ordinary: true,
      });
      const particle = await rig.sample('standard', true, 0, undefined, surface);
      for (let channel = 0; channel < 3; channel++)
        expect(
          Math.abs((particle[channel] ?? 0) - (ordinary[channel] ?? 0)),
          JSON.stringify({ surface, particle, ordinary }),
        ).toBeLessThanOrEqual(2);
      expect(Math.max(...particle.slice(0, 3))).toBeGreaterThan(30);
      environmentSamples.push(particle);
    }
  expect(environmentSamples[2]).not.toEqual(environmentSamples[3]);
  const environmentLit = await rig.sample('standard', true, 0);
  world.set(sky, Skylight, { rotation: [0, 1, 0, 0] }).unwrap();
  const environmentRotated = await rig.sample('standard', true, 0);
  expect(
    Math.max(
      ...environmentLit
        .slice(0, 3)
        .map((value, index) => Math.abs(value - (environmentRotated[index] ?? 0))),
    ),
  ).toBeGreaterThan(30);
  expect(await rig.sample('standard', false, 0)).toEqual(environmentRotated);
  expect(await rig.sample('unlit', true, 0)).toEqual(baseline.unlit);
  world.set(sky, Skylight, { intensity: 0 }).unwrap();
  expect(await rig.sample('standard', true, 0)).toEqual(baseline.dark);
  world.despawn(sky).unwrap();
  rig.requireActiveIbl = false;
  expect(await rig.sample('standard', true, 0)).toEqual(baseline.dark);
}

function spawnForwardReceiver(rig: VfxMeshLightingRig): EntityHandle {
  const world = rig.world;
  return world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: MeshFilter, data: { assetHandle: testAssets(world).create(rig.mesh).unwrap() } },
      {
        component: MeshRenderer,
        data: {
          materials: [
            testAssets(world)
              .create({
                ...rig.material,
                passes: [
                  {
                    name: 'Forward',
                    program: { module: 'forgeax::default-standard-pbr' },
                    renderState: { tags: { LightMode: 'Forward' } },
                  },
                ],
              })
              .unwrap(),
          ],
        },
      },
    )
    .unwrap();
}

async function verifyDirectionalParticleCaster(rig: VfxMeshLightingRig): Promise<void> {
  const casterPosition = [1.2, 0, 1.45] as const;
  const clearReceiver = await rig.sample('unlit', false, 3, {
    enabled: false,
    position: casterPosition,
  });
  const particleShadow = await rig.sample('unlit', false, 3, {
    enabled: true,
    position: casterPosition,
  });
  expect(clearReceiver[0], JSON.stringify({ clearReceiver, particleShadow })).toBeGreaterThan(
    (particleShadow[0] ?? 0) + 30,
  );
  expect(await rig.sample('unlit', false, 3, { enabled: false, position: casterPosition })).toEqual(
    clearReceiver,
  );
}

type LocalLightKind = 'point' | 'spot';

function spawnLocalShadowLight(
  world: World,
  kind: LocalLightKind,
  sideX: number,
  sideY: number,
): EntityHandle {
  const transform = {
    component: Transform,
    data: {
      pos: [sideX * 2.4, sideY * 2.4, 2.65] as const,
      quat: [0, 0, 0, 1] as const,
      scale: [1, 1, 1] as const,
    },
  };
  if (kind === 'point')
    return world
      .spawn(
        transform,
        { component: PointLight, data: { color: [1, 1, 1], intensity: 40, range: 10 } },
        {
          component: PointLightShadow,
          data: {
            mapSize: testQuality.shadowMapSize,
            nearPlane: 0.1,
            farPlane: 10,
            depthBias: 0.001,
            normalBias: 0.001,
          },
        },
      )
      .unwrap();
  return world
    .spawn(transform, {
      component: SpotLight,
      data: {
        color: [1, 1, 1],
        intensity: 40,
        range: 10,
        direction: [-sideX, -sideY, -1],
        innerConeDeg: 20,
        outerConeDeg: 35,
        castShadow: true,
        mapSize: testQuality.shadowMapSize,
        nearPlane: 0.1,
        farPlane: 10,
        depthBias: 0.001,
        normalBias: 0.001,
      },
    })
    .unwrap();
}

async function verifyLocalLightCaster(
  rig: VfxMeshLightingRig,
  kind: LocalLightKind,
  sideX: number,
  sideY: number,
): Promise<void> {
  const world = rig.world;
  const localCaster = [sideX * 1.2, sideY * 1.2, 1.45] as const;
  const localLight = spawnLocalShadowLight(world, kind, sideX, sideY);
  const clear = await rig.sample('unlit', false, 0, { enabled: false, position: localCaster });
  const shadow = await rig.sample('unlit', false, 0, { enabled: true, position: localCaster });
  expect(clear[0], JSON.stringify({ kind, sideX, sideY, clear, shadow })).toBeGreaterThan(
    (shadow[0] ?? 0) + 30,
  );
  expect(await rig.sample('unlit', false, 0, { enabled: false, position: localCaster })).toEqual(
    clear,
  );
  const meshCaster = rig.spawnMeshCaster(localCaster, createPlaneGeometry(0.5, 0.5).unwrap());
  const ordinaryShadow = await rig.sample('unlit', false, 0, {
    enabled: false,
    position: localCaster,
  });
  expect(clear[0], JSON.stringify({ kind, sideX, sideY, clear, ordinaryShadow })).toBeGreaterThan(
    (ordinaryShadow[0] ?? 0) + 30,
  );
  world.set(meshCaster, Transform, { quat: [0, 1, 0, 0] }).unwrap();
  expect(await rig.sample('unlit', false, 0, { enabled: false, position: localCaster })).toEqual(
    clear,
  );
  world.despawn(meshCaster).unwrap();
  expect(await rig.sample('unlit', false, 0, { enabled: false, position: localCaster })).toEqual(
    clear,
  );
  world.despawn(localLight).unwrap();
}

const DEPTH_LATENCY_WGSL = `
#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
#import forgeax_vfx::data::scene_depth
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(1.2, 2.0, 1.45);
  (*particle).color = vec4<f32>(1.0);
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  (*particle).mesh_scale = vec3<f32>(1.0);
  (*particle).lifetime = 100.0;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  let depth = textureLoad(forgeax_vfx_scene_depth, vec2<i32>(32, 32), 0);
  let casts = depth < 0.99 && (ctx.tick % 2u) == 0u;
  (*particle).position = vec3<f32>(1.2, select(2.0, 0.0, casts), 1.45);
}`;

async function spawnDepthLatencyPlayer(rig: VfxMeshLightingRig): Promise<EntityHandle> {
  rig.options.signal.throwIfAborted();
  const depthCook = await rig.options.cook(
    {
      schemaVersion: 3,
      emitters: [
        {
          id: 'depth-latency',
          capacity: 1,
          backend: { required: 'gpu' },
          space: 'world',
          bounds: { kind: 'sphere', center: [1.2, 1, 1.45], radius: 1.5 },
          schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
          program: { module: 'depth-latency.wgsl' },
          renderers: [
            {
              kind: 'mesh',
              mesh: AssetGuid.format(rig.meshGuid),
              material: AssetGuid.format(rig.materialGuid),
              lighting: 'unlit',
              castShadows: true,
            },
          ],
        },
      ],
    },
    { 'depth-latency.wgsl': { entry: DEPTH_LATENCY_WGSL } },
  );
  if (!depthCook.ok) throw depthCook.error;
  return rig.world
    .spawn({
      component: ParticleEffectPlayer,
      data: {
        effect: testAssets(rig.world).create(depthCook.value.asset).unwrap(),
        playing: true,
        seed: 1,
        timeScale: 1,
      },
    })
    .unwrap();
}

function committedPhaseTick(rig: VfxMeshLightingRig, player: EntityHandle): number | undefined {
  return rig.vfx.inspect(rig.world)?.players.find((entry) => entry.player === player)?.lastCommitted
    ?.phaseTick;
}

interface DepthLatencyFrames {
  readonly depthClear: number[];
  readonly depthShadow: number[];
}

// Rebuild an independent receiver without ticking or resetting the source.
// A non-clear shadow proves retained state was reconstructed, not dropped.
async function verifyReceiverRebuild(
  rig: VfxMeshLightingRig,
  depthPlayer: EntityHandle,
  frames: DepthLatencyFrames,
): Promise<void> {
  const featureHost = rig.host.featureHost;
  const removed = await featureHost.uninstallRenderFeature(rig.receiverFeature);
  if (!removed.ok) throw removed.error;
  rig.receiverFeature = createVfxRuntimeHost({ camera: { read: () => undefined } }).feature;
  const installed = await featureHost.installRenderFeature(rig.receiverFeature);
  if (!installed.ok) throw installed.error;
  let restored: number[] = [];
  for (let attempt = 0; attempt < 32; attempt++) {
    restored = await rig.present();
    if (restored.every((value, index) => value === frames.depthShadow[index])) break;
  }
  expect(restored).toEqual(frames.depthShadow);
  expect(committedPhaseTick(rig, depthPlayer)).toBe(0);
}

/** First depth-latency frames: the clear frame, then the tick-0 shadow. */
async function verifyFirstDepthPhase(
  rig: VfxMeshLightingRig,
  depthPlayer: EntityHandle,
  depthClear: number[],
): Promise<number[]> {
  const phase = () => committedPhaseTick(rig, depthPlayer);
  rig.world.update(1 / 60).unwrap();
  let firstDepthFrame: number[] = [];
  for (let attempt = 0; attempt < 32; attempt++) {
    firstDepthFrame = await rig.present();
    if (phase() === 0) break;
  }
  expect(phase()).toBe(0);
  expect(firstDepthFrame).toEqual(depthClear);
  const depthShadow = await rig.present();
  expect(depthClear[0], JSON.stringify({ depthClear, depthShadow })).toBeGreaterThan(
    (depthShadow[0] ?? 0) + 30,
  );
  expect(phase()).toBe(0);
  expect(await rig.present()).toEqual(depthShadow);
  expect(phase()).toBe(0);
  return depthShadow;
}

type FrameWork = FrameModel['works'][number];

function textureSourceForView(
  model: FrameModel,
  view: string | null | undefined,
): string | undefined {
  const descriptor = model.resources.find((resource) => resource.resourceId === view)?.descriptor;
  return descriptor !== null &&
    typeof descriptor === 'object' &&
    !Array.isArray(descriptor) &&
    'kind' in descriptor &&
    descriptor.kind === 'createTextureView' &&
    'sourceHandleId' in descriptor &&
    typeof descriptor.sourceHandleId === 'string'
    ? descriptor.sourceHandleId
    : undefined;
}

function findDepthUpdateWork(model: FrameModel): FrameWork | undefined {
  return model.works.find((work) =>
    work.pipeline?.shaders.some(
      (shader) =>
        shader.entryPoint === 'forgeax_vfx_update_main' ||
        shader.entryPoint === 'forgeax_vfx_update_compact_main',
    ),
  );
}

/** The captured frame orders depth producers, the update, shadows, then mesh projection. */
function expectDepthCaptureOrdering(
  model: FrameModel,
  depthUpdate: FrameWork | undefined,
  submitCount: number,
): void {
  const shadowWork = model.works.find((work) => work.kind === 'drawIndexedIndirect');
  expect(depthUpdate).toBeDefined();
  expect(shadowWork).toBeDefined();
  const depthBinding = depthUpdate?.bindings.find(
    (binding) => binding.groupIndex === 0 && binding.binding === 13,
  );
  expect(depthBinding).toBeDefined();
  const simulationDepth = textureSourceForView(model, depthBinding?.resourceId);
  expect(simulationDepth).toBeDefined();
  const depthProducers = model.works.filter(
    (work) =>
      work.attachments?.depthStencilViewHandleId !== null &&
      textureSourceForView(model, work.attachments?.depthStencilViewHandleId) === simulationDepth,
  );
  expect(depthProducers.length).toBeGreaterThan(0);
  for (const producer of depthProducers)
    expect(producer.workIndex).toBeLessThan(depthUpdate?.workIndex ?? -1);
  expect(depthUpdate?.workIndex).toBeLessThan(shadowWork?.workIndex ?? -1);
  const meshProjection = model.works.find((work) =>
    work.pipeline?.shaders.some((shader) => shader.entryPoint === 'forgeax_vfx_mesh_main'),
  );
  expect(meshProjection).toBeDefined();
  expect(meshProjection?.workIndex).toBeGreaterThan(shadowWork?.workIndex ?? Infinity);
  expect(
    textureSourceForView(
      model,
      meshProjection?.bindings.find((binding) => binding.groupIndex === 0 && binding.binding === 13)
        ?.resourceId,
    ),
  ).toBe(simulationDepth);
  expect(submitCount).toBe(1);
}

interface DepthLatencyCapture {
  readonly tape: Extract<ReturnType<typeof decodeTape>, { ok: true }>['value'];
  readonly model: FrameModel;
  readonly changedDepthFrame: number[];
}

async function captureDepthLatencyFrame(
  rig: VfxMeshLightingRig,
  depthPlayer: EntityHandle,
  frames: DepthLatencyFrames,
): Promise<DepthLatencyCapture> {
  const phase = () => committedPhaseTick(rig, depthPlayer);
  const captured = await rig.captureNextFrame('present');
  const changedDepthFrame = captured.frame ?? [];
  if (rig.env.FORGEAX_VFX_DEPTH_LATENCY_TAPE !== undefined)
    rig.options.saveTape?.(rig.env.FORGEAX_VFX_DEPTH_LATENCY_TAPE, captured.bytes);
  const decoded = decodeTape(captured.bytes);
  if (!decoded.ok) throw decoded.error;
  const depthModel = buildFrameModel(decoded.value);
  expect(
    changedDepthFrame,
    JSON.stringify({ phase: phase(), passes: rig.renderer.inspect().perFramePassNames }),
  ).toEqual(frames.depthShadow);
  expect(phase()).toBe(1);
  const depthUpdate = findDepthUpdateWork(depthModel);
  const onIblFailure = rig.options.onIblFailure;
  if (depthUpdate === undefined && onIblFailure !== undefined) {
    rig.phases.iblFailureRecorded = true;
    await onIblFailure(
      {
        phase: 'depth-update-selection',
        capture: 'original-depth-latency-frame',
        completedFrames: rig.phases.completedFrames,
        work: depthModel.works,
        events: rig.phases.errors,
      },
      captured.bytes,
    );
  }
  expectDepthCaptureOrdering(
    depthModel,
    depthUpdate,
    decoded.value.events.filter((event) => event.kind === 'submit').length,
  );
  return { tape: decoded.value, model: depthModel, changedDepthFrame };
}

// Queue two distinct simulation ticks without awaiting either receipt.
// Each pixel copy is enqueued directly after its draw, before the next
// draw overwrites the shared target. Shadows must still use tick N-1.
async function verifyQueuedPublicationTicks(
  rig: VfxMeshLightingRig,
  source: RenderPublisher,
  depthPlayer: EntityHandle,
  frames: DepthLatencyFrames,
): Promise<void> {
  const { renderer, world } = rig;
  const flights = [6, 7].map((tick) => {
    world.update(1 / 60).unwrap();
    const candidate = source.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: [
        ...renderPublicationTransfers(candidate.packet),
        ...renderPublicationAssetTransfers(candidate.packet),
      ],
    });
    candidate.accept();
    const submitted = renderer.draw({
      publication: packet,
      onFeatureSourceSubmitted: (identity, feedback) => {
        source
          .acknowledgeFeatures(packet.revision, [{ identity, feedback: structuredClone(feedback) }])
          .unwrap();
      },
    });
    if (!submitted.ok) throw submitted.error;
    const draw = submitted.value;
    expect(committedPhaseTick(rig, depthPlayer)).toBe(tick);
    return { packet, draw, pixels: rig.pixel() };
  });
  for (const [index, flight] of flights.entries()) {
    const completed = await flight.draw.completed;
    if (!completed.ok) throw completed.error;
    expect(await flight.pixels).toEqual(index === 0 ? frames.depthClear : frames.depthShadow);
    const buffers = renderPublicationTransfers(flight.packet);
    source
      .recycle(flight.packet.revision, structuredClone(buffers, { transfer: buffers }))
      .unwrap();
  }
  expect(committedPhaseTick(rig, depthPlayer)).toBe(7);
}

/** Later depth-latency ticks alternate clear and shadow frames, including catch-up. */
async function verifyDepthTickCadence(
  rig: VfxMeshLightingRig,
  depthPlayer: EntityHandle,
  frames: DepthLatencyFrames,
): Promise<void> {
  const { world } = rig;
  const phase = () => committedPhaseTick(rig, depthPlayer);
  expect(await rig.present()).toEqual(frames.depthClear);
  expect(phase()).toBe(1);
  world.update(1 / 60).unwrap();
  expect(await rig.present()).toEqual(frames.depthClear);
  expect(phase()).toBe(2);
  expect(await rig.present()).toEqual(frames.depthShadow);
  // Catch-up may submit several ordered ticks together. Early shadows still
  // use the previous projection; the following draw sees only the final tick.
  world.update(1 / 60).unwrap();
  world.update(1 / 60).unwrap();
  world.update(1 / 60).unwrap();
  expect(await rig.present()).toEqual(frames.depthShadow);
  expect(phase()).toBe(5);
  expect(await rig.present()).toEqual(frames.depthClear);
  expect(phase()).toBe(5);
}

// Explicit simulation depth is captured before the shared update. The view's
// depth-bound mesh projection remains after its shadow lane, so the light
// consumes the last submitted projection without rerunning a simulation tick.
async function verifyDepthLatency(rig: VfxMeshLightingRig): Promise<DepthLatencyCapture> {
  const world = rig.world;
  world.set(rig.light, DirectionalLight, { intensity: 3 }).unwrap();
  world.update(1 / 60).unwrap();
  const depthClear = await rig.present();
  const depthPlayer = await spawnDepthLatencyPlayer(rig);
  const depthShadow = await verifyFirstDepthPhase(rig, depthPlayer, depthClear);
  const frames: DepthLatencyFrames = { depthClear, depthShadow };
  if (rig.options.publication) await verifyReceiverRebuild(rig, depthPlayer, frames);
  const capture = await captureDepthLatencyFrame(rig, depthPlayer, frames);
  await verifyDepthTickCadence(rig, depthPlayer, frames);
  if (rig.publisher !== undefined)
    await verifyQueuedPublicationTicks(rig, rig.publisher, depthPlayer, frames);
  world.despawn(depthPlayer).unwrap();
  world.update(1 / 60).unwrap();
  expect(await rig.present()).toEqual(depthClear);
  return capture;
}

/** The backend's opaque raw device; this fixture only needs its native destroy. */
function isNativeDevice(value: unknown): value is { destroy(): void } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'destroy' in value &&
    typeof value.destroy === 'function'
  );
}

/** A fresh-device replay of the captured depth-latency frame reproduces its center pixel. */
async function verifyCapturedReplay(
  pack: RecordableBackendPack,
  capture: DepthLatencyCapture,
): Promise<void> {
  const replayAdapter = await pack.rhi.requestAdapter();
  if (!replayAdapter.ok) throw replayAdapter.error;
  const replayDevice = await replayAdapter.value.requestDevice(
    replayDeviceRequest(capture.tape, replayAdapter.value.features, replayAdapter.value.limits),
  );
  if (!replayDevice.ok) throw replayDevice.error;
  // Native lifetime cleanup stays in this Dawn fixture, outside Render/VFX.
  const replayRaw = pack._internal_getRawDevice?.(replayDevice.value);
  if (!isNativeDevice(replayRaw)) throw new Error('Missing native replay device');
  try {
    const replay = await openReplay(capture.tape, {
      device: replayDevice.value,
      createShaderModule: pack.createShaderModule,
    });
    if (!replay.ok) throw replay.error;
    let disposalError: unknown;
    try {
      const lastWork = capture.model.works.at(-1);
      if (lastWork === undefined) throw new Error('Missing captured output work');
      const inspection = await replay.value.inspectWork(lastWork.workIndex, ['pixels']);
      if (!inspection.ok) throw inspection.error;
      const attachment = inspection.value.attachment;
      if (attachment === undefined) throw new Error('Missing replay pixels');
      expect(attachment.width).toBe(64);
      expect(attachment.height).toBe(64);
      const offset = (32 * 64 + 32) * 4;
      expect([...attachment.bytes.slice(offset, offset + 4)]).toEqual(capture.changedDepthFrame);
    } finally {
      const disposed = await replay.value.dispose();
      if (!disposed.ok) disposalError = disposed.error;
    }
    if (disposalError !== undefined) throw disposalError;
  } finally {
    replayRaw.destroy();
  }
}

/** Every lighting, shadow, environment and depth-latency oracle on one constructed rig. */
async function verifyLightingScenario(
  rig: VfxMeshLightingRig,
  pack: RecordableBackendPack,
): Promise<void> {
  const baseline = await verifyDirectionalLighting(rig);
  await verifyVertexColorSample(rig, baseline);
  await verifyDirectionalOccluder(rig, baseline);
  await verifyPointShadowReceiver(rig, baseline);
  await verifyEnvironmentLighting(rig, baseline);
  const receiver = spawnForwardReceiver(rig);
  await verifyDirectionalParticleCaster(rig);
  for (const [kind, sideX, sideY] of [
    ['point', 1, 0],
    ['point', -1, 0],
    ['point', 0, 1],
    ['point', 0, -1],
    ['spot', 1, 0],
  ] as const) {
    await verifyLocalLightCaster(rig, kind, sideX, sideY);
  }
  const capture = await verifyDepthLatency(rig);
  rig.world.despawn(receiver).unwrap();
  rig.options.signal.throwIfAborted();
  await verifyCapturedReplay(pack, capture);
  if (rig.options.sampledTextureLimit !== undefined) {
    expect(rig.surface.device?.limits.maxSampledTexturesPerShaderStage).toBe(
      rig.options.sampledTextureLimit,
    );
  }
  expect(rig.phases.errors).toEqual([]);
}

function vfxCameraHost(): VfxRuntimeHost {
  const focal = 1 / Math.tan(Math.PI / 8);
  const viewProjection = new Float32Array([
    focal,
    0,
    0,
    0,
    0,
    focal,
    0,
    0,
    0,
    0,
    -10 / 9.9,
    -1,
    0,
    0,
    29 / 9.9,
    3,
  ]);
  return createVfxRuntimeHost({
    camera: {
      read: () => ({
        position: new Float32Array([0, 0, 3]),
        right: new Float32Array([1, 0, 0]),
        up: new Float32Array([0, 1, 0]),
        viewProjection,
      }),
    },
  });
}

function recordTimeoutFailures(
  phases: VfxMeshLightingPhases,
  onIblFailure: NonNullable<VfxMeshLightingOptions['onIblFailure']>,
): void {
  onTestFailed(async () => {
    if (phases.iblFailureRecorded) return;
    // Preserve the operation at the original timeout, including a producer
    // failure before Renderer construction or a state observed after cleanup.
    await onIblFailure({
      phase: phases.failurePhase,
      phaseTimings: phases.inspectTimings(),
      sampleIndex: phases.sampleIndex,
      sampleState: phases.sampleState,
      completedFrames: phases.completedFrames,
      cleanupStarted: phases.cleanupStarted,
      renderer: phases.inspectRenderer?.() ?? null,
      events: phases.errors,
      reason: 'test-failed-or-timed-out',
      captureUnavailable:
        'The original frame may still be in flight; no following frame was submitted.',
    });
  });
}

/** One real-device acceptance path shared by native Dawn and browser WebGPU. */
async function runVfxMeshLighting(options: VfxMeshLightingOptions): Promise<void> {
  options.signal.throwIfAborted();
  const phases = new VfxMeshLightingPhases(options.signal);
  if (options.onIblFailure !== undefined) recordTimeoutFailures(phases, options.onIblFailure);
  const world = new World();
  const vfx = vfxCameraHost();
  const publicationIdentity = { source: 'vfx-lighting-proof', epoch: 1 };
  const receiverFeature = options.publication
    ? createVfxRuntimeHost({ camera: { read: () => undefined } }).feature
    : vfx.feature;
  let publisher: RenderPublisher | undefined;
  const pack = await loadBackendPack({});
  if (!pack.ok) throw pack.error;
  if (pack.value.createShaderModule === undefined) throw new Error('No shader factory');
  const backend: RecordableBackendPack = {
    ...pack.value,
    createShaderModule: pack.value.createShaderModule,
  };
  const recording = attachRecorder(backend);
  if (!recording.ok) throw recording.error;
  const recorder = recording.value;
  const surface = new CapturedCanvasSurface(phases.errors);
  phases.enter('renderer-construction');
  const constructed = await constructRuntimeRendererHost(
    surface.canvas,
    {
      features: [receiverFeature],
      ...(options.publication ? { publicationSource: publicationIdentity } : {}),
      rhi: sampledTextureLimitRhi(recorder, options.sampledTextureLimit),
      rhiInstrumentation: {
        resolveSurfaceDevice(device) {
          const unwrapped = recorder.backend.unwrapDeviceForSurface(device);
          if (!unwrapped.ok) throw unwrapped.error;
          return ok(unwrapped.value);
        },
      },
    },
    {
      shaderManifestUrl: options.shaderManifestUrl,
    },
  );
  if (!constructed.ok) throw constructed.error;
  const { renderer, assets } = constructed.value;
  world.bindAssets(assets).unwrap();
  phases.inspectRenderer = () => renderer.inspect();
  renderer.subscribe((event) => {
    if (event.kind === 'error') phases.errors.push(event.error);
  });
  let vfxAttached = false;
  try {
    phases.enter('scene-authoring');
    const scene = await authorLightingScene(world, assets);
    const attached = options.publication ? undefined : renderer.attach(world);
    if (attached !== undefined && !attached.ok) throw attached.error;
    if (options.publication)
      publisher = createRenderPublisher(
        world,
        assets,
        publicationIdentity,
        renderer.inspect().capabilities,
        [vfx.feature],
      );
    const attachedVfx = await vfx.attachWorld({ world, assets });
    if (!attachedVfx.ok) throw attachedVfx.error;
    vfxAttached = true;
    const rig = new VfxMeshLightingRig({
      options,
      phases,
      surface,
      recorder,
      host: constructed.value,
      world,
      vfx,
      publisher,
      lease: attached?.value,
      receiverFeature,
      ...scene,
    });
    await verifyLightingScenario(rig, backend);
  } finally {
    phases.cleanupStarted = true;
    publisher?.dispose();
    if (vfxAttached) await vfx.detachWorld({ world });
    renderer.dispose();
    surface.target?.destroy();
    await recorder.dispose();
  }
}
