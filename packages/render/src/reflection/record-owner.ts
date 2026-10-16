import { mat4, vec3 } from '@forgeax/engine-math';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  RenderPipeline,
  Sampler,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { toShared } from '@forgeax/engine-types';
import { buildCubeCameraFaceViews } from '../capture/cube-views';
import {
  createFaceUniformsBuffer,
  createPrefilterUniformsBuffer,
  writeAllFaceUniforms,
  writeAllPrefilterUniforms,
} from '../device/gpu-residency';
import type { SelectedEnvironmentFrame } from '../environment/frame';
import { type AtmosphereLease, retainAtmosphere } from '../environment/storage';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_UNIFORM,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import {
  CUBEMAP_FACE_VERTICES,
  createIblPipelines,
  getOrCreateIblCache,
  iblPrefilterGroup0Entries,
  PREFILTER_MIP_LEVELS,
} from '../ibl/IblPipelineCache';
import type {
  ReflectionFallbackReadbackReceipt,
  ReflectionFallbackReceipt,
  ReflectionProbeInspection,
  ReflectionProbeSelectionInspection,
} from '../inspection-types';
import type { ReflectionProbeRecordState, RenderSystemInternals } from '../record/render-context';
import type { ReflectionProbeGraphWork } from '../record/typed-frame-graph';
import { REFLECTION_PROBE_VIEW_SLOT_BASE, VIEW_UNIFORM_SLOT_STRIDE } from '../record/view-ubo';
import type { CameraSnapshot } from '../render-contract';
import type { SkyboxSnapshot, SkylightSnapshot } from '../render-system-extract';
import { createProbeBackgroundResources, type ProbeBackgroundResources } from './background';
import {
  advanceProbeFilter,
  commitProbeFilterStep,
  createProbeFilterState,
  type ProbeFilterState,
} from './filter';
import { buildReflectionProbeTable } from './gpu-table';
import { inspectReflectionFallback, type ReflectionFallbackFailureInput } from './inspection';
import {
  admitReflectionProbe,
  DEFAULT_REFLECTION_PROBE_LIMITS,
  deriveReflectionFallbackProjection,
  type ReflectionFallbackProjection,
  type ReflectionProbeFact,
  type ReflectionProbeSelectionResult,
  reflectionFallbackCoverage,
  reflectionFallbackProjectionSignature,
  reflectionFallbackSourceKey,
  resolveReflectionFallbackSource,
} from './projection';

type ProbeCubeSet = {
  readonly texture: Texture;
  readonly cubeView: TextureView;
  readonly faceViews: readonly TextureView[];
  readonly mipViews: readonly (readonly TextureView[])[];
  readonly depthTexture: Texture;
  readonly depthView: TextureView;
  readonly size: number;
};

type ProbeGpuResource = {
  fact: ReflectionProbeFact;
  captureFact: ReflectionProbeFact;
  diffusePayload: readonly number[];
  captureSceneRevision: string;
  captureStartedFrame: number;
  atmosphere: AtmosphereLease | undefined;
  lastCompletedFrame: number;
  activeFact?: ReflectionProbeFact;
  index: number;
  filter: ProbeFilterState;
  rawFaceCursor: number;
  readonly raw: ProbeCubeSet;
  active: ProbeCubeSet | undefined;
  candidate: ProbeCubeSet;
  spare: ProbeCubeSet | undefined;
  readonly sampler: Sampler;
  readonly uniformBuffer: Buffer;
  readonly filterGroup1: BindGroup;
  pending?: {
    readonly rawCaptureFace: number | undefined;
    readonly step: ReturnType<typeof advanceProbeFilter>;
  };
};

type ProbeSharedResources = {
  readonly background: ProbeBackgroundResources | undefined;
  readonly faceUniforms: Buffer;
  readonly prefilterUniforms: Buffer;
  readonly vertexBuffer: Buffer;
  readonly sampler: Sampler;
  readonly filterPipeline: RenderPipeline;
  readonly cubeGroup1Bgl: BindGroupLayout;
  readonly prefilterGroup0Bgl: BindGroupLayout;
};

type PendingFallback = {
  readonly ticket: number;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly projection: ReflectionFallbackProjection;
};

const REFLECTION_PROBE_PRODUCER_ID = 'forgeax::render::reflection-probe-record-owner';
// Probe uniforms share the existing Skylight ABI.  Offset the negative
// sentinel so a valid probe intensity of zero remains distinguishable from
// the ordinary Skylight payload's zero intensity.
const PROBE_INTENSITY_SENTINEL_OFFSET = 1;

/** Renderer-owned raw capture and incremental PMREM/LKG promotion owner. */
export class ReflectionProbeRecordOwner {
  private readonly resources = new Map<string, ProbeGpuResource>();
  private shared: ProbeSharedResources | undefined;
  private pipelineWarmup: Promise<void> | undefined;
  private pipelineWarmupFailure: string | undefined;
  private pipelineWarmupAttempts = 0;
  private lastFactCount = 0;
  private lastAcceptedCount = 0;
  private lastScheduledRawFaces = 0;
  private lastScheduledFilteredSteps = 0;
  private workCursor = 0;
  private currentFrame = 0;
  private lastSelection: ReflectionProbeSelectionInspection = { kind: 'skylight' };
  private outputFormat: TextureFormat;
  private fallbackFormatAvailable: boolean;
  private nextFallbackTicket = 0;
  // Submitted frames own their immutable candidates until completion. Keep
  // only the current projection here: preparing a source-identical frame
  // must not starve an earlier asynchronous readback of publication.
  private latestFallbackTickets = new Map<string, PendingFallback>();
  private fallbackRetiredFrames = new Map<string, number>();
  private fallbackCommittedFrames = new Map<string, number>();
  private fallbackGenerations = new Map<
    string,
    { readonly source: number; readonly projection: number }
  >();
  private fallbackSignatures = new Map<string, string>();
  private fallbackReceipts = new Map<string, ReflectionFallbackReceipt>();
  private fallbackReadback: ReflectionFallbackReadbackReceipt | undefined;
  private fallbackReceiptKey: string | undefined;
  private fallbackFailure: ReflectionFallbackFailureInput | undefined;
  private fallbackReceipt: ReflectionFallbackReceipt;

  constructor(private readonly internals: RenderSystemInternals) {
    this.outputFormat = internals.device.caps.rgba16floatRenderable ? 'rgba16float' : 'rgba8unorm';
    this.fallbackFormatAvailable = internals.device.caps.rgba16floatRenderable === true;
    this.fallbackReceipt = this.createFallbackReceipt(
      this.fallbackFormatAvailable ? 'neutral' : 'unavailable',
    );
  }

  inspect(): ReflectionProbeInspection {
    let rawFacesCaptured = 0;
    let filteredStepsCompleted = 0;
    const filteredMipLevels = new Set<number>();
    let activeCount = 0;
    for (const resource of this.resources.values()) {
      rawFacesCaptured += resource.rawFaceCursor;
      filteredStepsCompleted += resource.filter.cursor;
      const completedMipCount = Math.min(
        PREFILTER_MIP_LEVELS,
        Math.floor(resource.filter.cursor / resource.filter.faceCount),
      );
      for (let mip = 0; mip < completedMipCount; mip += 1) filteredMipLevels.add(mip);
      if (resource.active !== undefined) activeCount += 1;
    }
    return {
      updates: [...this.resources.values()].map((resource) => ({
        worldId: resource.fact.worldId,
        entityKey: resource.fact.entityKey,
        intent: resource.fact.updateIntent ?? 'once',
        activeGeneration: resource.filter.activeGeneration,
        requestedRevision: resource.fact.revision,
        capturedRevision: resource.captureFact.revision,
        pending: resource.filter.cursor < resource.filter.faceCount * resource.filter.mipCount,
        captureStartedFrame: resource.captureStartedFrame,
        lastCompletedFrame: resource.lastCompletedFrame,
        latencyFrames:
          resource.lastCompletedFrame < resource.captureStartedFrame
            ? undefined
            : resource.lastCompletedFrame - resource.captureStartedFrame,
      })),
      workBudgetPerFrame: 1,
      selection: this.lastSelection,
      factCount: this.lastFactCount,
      acceptedCount: this.lastAcceptedCount,
      activeCount,
      rawFacesCaptured,
      filteredStepsCompleted,
      filteredMipLevels: [...filteredMipLevels].sort((a, b) => a - b),
      scheduledRawFaces: this.lastScheduledRawFaces,
      scheduledFilteredSteps: this.lastScheduledFilteredSteps,
      pipelineReady: this.shared !== undefined,
      pipelineWarmupAttempts: this.pipelineWarmupAttempts,
      ...(this.pipelineWarmupFailure === undefined
        ? {}
        : { pipelineWarmupFailure: this.pipelineWarmupFailure }),
      reflectionFallback: this.fallbackReceipt,
      reflectionFallbacks: [...this.fallbackReceipts.values()],
      reflectionFallbackInspection: inspectReflectionFallback(
        this.fallbackReceipt,
        this.fallbackFailure,
      ),
      ...(this.fallbackReadback === undefined
        ? {}
        : { reflectionFallbackReadback: this.fallbackReadback }),
    };
  }

  private createFallbackReceipt(
    state: ReflectionFallbackReceipt['state'],
  ): ReflectionFallbackReceipt {
    return Object.freeze({
      rendererId: this.internals.deviceScope.owner,
      producerId: REFLECTION_PROBE_PRODUCER_ID,
      ...(this.internals.ssrIdentity === undefined ? {} : { identity: this.internals.ssrIdentity }),
      source: 'neutral',
      sourceKey: 'neutral',
      sourceGeneration: 0,
      projectionGeneration: 0,
      deviceGeneration: this.internals.deviceScope.generation,
      state,
      candidateVisible: false,
      coverage: 0,
      extent: [1, 1, 1] as const,
      brdfSignature: 'standard-pbr-ibl-v1',
    });
  }

  private refreshFallbackReceipt(): void {
    const preferred =
      this.fallbackReceiptKey === undefined
        ? undefined
        : this.fallbackReceipts.get(this.fallbackReceiptKey);
    if (preferred !== undefined) {
      this.fallbackReceipt = preferred;
      return;
    }
    let replacementKey: string | undefined;
    for (const key of this.fallbackReceipts.keys()) {
      if (replacementKey === undefined || key < replacementKey) replacementKey = key;
    }
    if (replacementKey !== undefined) {
      this.fallbackReceiptKey = replacementKey;
      this.fallbackReceipt = this.fallbackReceipts.get(replacementKey) as ReflectionFallbackReceipt;
      return;
    }
    this.fallbackReceiptKey = undefined;
    this.fallbackReceipt = this.createFallbackReceipt(
      this.fallbackFormatAvailable ? 'neutral' : 'unavailable',
    );
  }

  private recordFallbackFailure(failure: ReflectionFallbackFailureInput): void {
    this.fallbackFailure = Object.freeze({
      ...failure,
      ...(failure.detail === undefined ? {} : { detail: Object.freeze({ ...failure.detail }) }),
    });
  }

  private clearFallbackFailure(): void {
    this.fallbackFailure = undefined;
  }

  private refreshFallbackCapabilities(frameId: number): void {
    const available = this.internals.device.caps.rgba16floatRenderable === true;
    const previous = this.fallbackFormatAvailable;
    // resetForRecover() disposes device-bound probe resources before the
    // replacement device is observed. Update the ordinary IBL format only
    // when no old resource can still reference the previous device.
    if (
      this.resources.size === 0 &&
      this.shared === undefined &&
      this.pipelineWarmup === undefined
    ) {
      this.outputFormat = available ? 'rgba16float' : 'rgba8unorm';
    }
    this.fallbackFormatAvailable = available;
    if (!available) {
      this.retireFallbackState(frameId);
      this.recordFallbackFailure({
        stage: 'prepare',
        code: 'reflection-fallback-format-unavailable',
        expected: 'rgba16float render attachment capability on the current device generation',
        detail: { deviceGeneration: this.internals.deviceScope.generation },
      });
    } else if (!previous) {
      this.clearFallbackFailure();
      this.refreshFallbackReceipt();
    }
  }

  private retireFallbackState(frameId: number): void {
    for (const pending of this.latestFallbackTickets.values()) {
      const key = pending.projection.renderableKey;
      if (key !== undefined) this.fallbackRetiredFrames.set(key, frameId);
    }
    for (const key of this.fallbackReceipts.keys()) {
      this.fallbackRetiredFrames.set(key, frameId);
    }
    this.latestFallbackTickets.clear();
    this.fallbackReceipts.clear();
    this.fallbackSignatures.clear();
    this.fallbackCommittedFrames.clear();
    this.fallbackGenerations.clear();
    this.fallbackReadback = undefined;
    this.fallbackReceiptKey = undefined;
    this.refreshFallbackReceipt();
  }

  private ensurePipelineWarmup(): void {
    if (this.shared !== undefined || this.pipelineWarmup !== undefined) return;
    const factory = this.internals.shaderModuleFactory;
    if (factory === undefined) return;
    const attempt = this.pipelineWarmupAttempts + 1;
    this.pipelineWarmupAttempts = attempt;
    const device = this.internals.device;
    const warmup = createIblPipelines(
      this.internals.deviceScope,
      this.internals.device,
      (device, descriptor) => {
        const labeled = {
          ...descriptor,
          label: `${descriptor.label ?? 'ibl'}-reflection-probe-${attempt}`,
        };
        return this.internals.createShaderModule === undefined
          ? Promise.resolve(factory.createShaderModule(labeled))
          : this.internals.createShaderModule(device, labeled);
      },
      this.outputFormat,
    )
      .then(async (result) => {
        if (this.pipelineWarmup !== warmup) return;
        if (!result.ok) {
          this.pipelineWarmupFailure = `${result.error.code}: ${result.error.hint}`;
          console.warn('[forgeax] ReflectionProbe IBL warmup retry', this.pipelineWarmupFailure);
          this.pipelineWarmup = undefined;
          return;
        }
        const background = await createProbeBackgroundResources(this.internals, this.outputFormat);
        if (this.pipelineWarmup !== warmup) {
          if (background !== undefined) device.destroyBuffer(background.uniform);
          return;
        }
        this.shared = this.createSharedResources(result.value.prefilterPipeline, background);
        if (this.shared === undefined) {
          this.pipelineWarmupFailure = 'renderer-owned IBL resources could not be allocated';
          console.warn('[forgeax] ReflectionProbe IBL resource allocation retry');
          this.pipelineWarmup = undefined;
        }
      })
      .catch((cause: unknown) => {
        if (this.pipelineWarmup !== warmup) return;
        this.pipelineWarmupFailure = cause instanceof Error ? cause.message : String(cause);
        this.pipelineWarmup = undefined;
        this.internals.errorRegistry.fire(
          cause instanceof RhiError
            ? cause
            : new RhiError({
                code: 'shader-compile-failed',
                expected: 'complete reflection probe background and IBL pipelines',
                hint: `inspect the shader manifest and device error: ${this.pipelineWarmupFailure}`,
              }),
        );
      });
    this.pipelineWarmup = warmup;
  }

  prepare(
    facts: readonly ReflectionProbeFact[],
    selections: ReadonlyMap<string, ReflectionProbeSelectionResult>,
    displayCamera: CameraSnapshot | undefined,
    frameId = this.nextFallbackTicket + 1,
    skylight: SkylightSnapshot | undefined = undefined,
    sceneRevision = '',
    skybox?: SkyboxSnapshot,
    environment?: SelectedEnvironmentFrame,
  ): ReflectionProbeRecordState {
    this.currentFrame = frameId;
    this.refreshFallbackCapabilities(frameId);
    this.lastFactCount = facts.length;
    this.lastScheduledRawFaces = 0;
    this.lastScheduledFilteredSteps = 0;
    // The fallback MRT has one representative readback, so choose a stable
    // non-neutral probe consumer when the scene contains one. Renderable map
    // order is not a source-selection contract: the first entry is commonly
    // an outside panel while the local probe consumer appears later.
    const firstSelection =
      [...selections.values()].find((selection) => selection.kind === 'probe') ??
      (selections.values().next().value as ReflectionProbeSelectionResult | undefined);
    this.lastSelection =
      firstSelection?.kind === 'probe'
        ? {
            kind: 'probe',
            worldId: firstSelection.worldId,
            entityKey: firstSelection.entityKey,
          }
        : { kind: 'skylight' };
    if (facts.length > 0) this.ensurePipelineWarmup();
    void this.pipelineWarmup;
    const ordered = facts
      .slice()
      .sort((a, b) => a.worldId - b.worldId || a.entityKey - b.entityKey);
    let acceptedCount = 0;
    let acceptedBytes = 0;
    const accepted = new Map<string, ProbeGpuResource>();
    for (const fact of ordered) {
      const admission = admitReflectionProbe(
        fact,
        { acceptedCount, acceptedBytes },
        DEFAULT_REFLECTION_PROBE_LIMITS,
      );
      if (!admission.ok) continue;
      const key = `${fact.worldId}:${fact.entityKey}`;
      const resource = this.resourceFor(
        key,
        fact,
        acceptedCount,
        sceneRevision,
        skylight,
        environment,
      );
      if (resource === undefined) continue;
      acceptedCount += 1;
      acceptedBytes = admission.acceptedBytes;
      accepted.set(key, resource);
    }
    this.lastAcceptedCount = acceptedCount;
    const fallbackTickets = this.fallbackFormatAvailable
      ? this.stageFallbackProjections(facts, selections, accepted, frameId, skylight)
      : new Map<string, PendingFallback>();
    for (const [key, resource] of this.resources) {
      if (!accepted.has(key)) {
        this.destroyProbeResource(resource);
        this.resources.delete(key);
      } else resource.index = [...accepted.keys()].indexOf(key);
    }
    const rows = [...accepted.values()]
      .map((resource) => {
        const active = resource.activeFact?.center.every((v, i) => v === resource.fact.center[i])
          ? resource.active
          : undefined;
        if (active === undefined) return undefined;
        return {
          primitiveKey: `${resource.fact.worldId}:${resource.fact.entityKey}`,
          index: resource.index,
          worldId: resource.fact.worldId,
          entityKey: resource.fact.entityKey,
          center: resource.fact.center,
          halfExtents: resource.fact.halfExtents,
          intensity: resource.fact.intensity,
          generation: resource.filter.activeGeneration,
          filteredView: active.cubeView,
          sampler: resource.sampler,
          uniformBuffer: resource.uniformBuffer,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
    const table = buildReflectionProbeTable(rows);
    const work: ReflectionProbeGraphWork[] = [];
    const environmentReady = [skylight?.equirectHandle, skybox?.equirectHandle].every(
      (handle) =>
        handle === undefined ||
        handle === 0 ||
        this.internals.gpuStore.getCubemapGpuView(toShared<'EquirectAsset'>(handle)) !== undefined,
    );
    const candidates = [...accepted.values()];
    const captureTickets: Array<{
      resource: ProbeGpuResource;
      pending: NonNullable<ProbeGpuResource['pending']>;
    }> = [];
    const deviceGeneration = this.internals.deviceScope.generation;
    for (let offset = 0; offset < candidates.length; offset++) {
      const candidateIndex = (this.workCursor + offset) % candidates.length;
      const resource = candidates[candidateIndex];
      if (resource === undefined) continue;
      if (resource.pending !== undefined) continue;
      const rawCaptureFace =
        resource.rawFaceCursor < resource.raw.faceViews.length ? resource.rawFaceCursor : undefined;
      const step =
        resource.rawFaceCursor >= resource.raw.faceViews.length
          ? advanceProbeFilter(resource.filter)
          : undefined;
      if (this.shared === undefined) continue;
      if (!environmentReady || (rawCaptureFace === undefined && step === undefined)) continue;
      const filterGroup0 =
        step === undefined
          ? undefined
          : this.internals.device.createBindGroup({
              label: `reflection-probe-${resource.index}-pmrem-${step.mipLevel}-${step.faceIndex}`,
              layout: this.shared.prefilterGroup0Bgl,
              entries: iblPrefilterGroup0Entries(
                this.shared.faceUniforms,
                this.shared.prefilterUniforms,
                step.mipLevel,
                step.faceIndex,
              ),
            });
      if (filterGroup0 !== undefined && !filterGroup0.ok) continue;
      resource.pending = { rawCaptureFace, step };
      captureTickets.push({ resource, pending: resource.pending });
      if (rawCaptureFace !== undefined) this.lastScheduledRawFaces += 1;
      if (step !== undefined) this.lastScheduledFilteredSteps += 1;
      const face =
        rawCaptureFace === undefined
          ? undefined
          : buildCubeCameraFaceViews({
              position: resource.captureFact.center,
              near: 0.1,
              far: 100,
            })[rawCaptureFace];
      const faceCamera =
        face === undefined || displayCamera === undefined
          ? undefined
          : {
              ...displayCamera,
              clipping: { planes: [] },
              position: vec3.create(
                resource.captureFact.center[0] ?? 0,
                resource.captureFact.center[1] ?? 0,
                resource.captureFact.center[2] ?? 0,
              ),
              world: mat4.invert(mat4.create(), face.view),
              fov: Math.PI / 2,
              aspect: 1,
              near: face.near,
              far: face.far,
              projection: 'perspective' as const,
            };
      work.push({
        atmosphere: resource.atmosphere?.storage,
        captureGeneration: resource.captureStartedFrame,
        probeIndex: resource.index,
        rawTexture: resource.raw.texture,
        rawCubeView: resource.raw.cubeView,
        rawFaceViews: resource.raw.faceViews,
        rawDepthTexture: resource.raw.depthTexture,
        filteredTexture: resource.candidate.texture,
        filteredCubeView: resource.candidate.cubeView,
        filteredFaceViewsByMip: resource.candidate.mipViews,
        outputFormat: this.outputFormat,
        sampler: resource.sampler,
        filterPipeline: this.shared.filterPipeline,
        ...(this.shared.background === undefined ? {} : { background: this.shared.background }),
        filterGroup0: filterGroup0?.value,
        filterGroup1: resource.filterGroup1,
        cubeVertexBuffer: this.shared.vertexBuffer,
        rawCaptureFace,
        rawDepthView: resource.raw.depthView,
        rawSize: resource.raw.size,
        ...(faceCamera === undefined ? {} : { faceCamera }),
        ...(rawCaptureFace === undefined
          ? {}
          : {
              viewBindGroupDynamicOffset:
                (REFLECTION_PROBE_VIEW_SLOT_BASE + resource.index) * VIEW_UNIFORM_SLOT_STRIDE,
            }),
        filteredSize: resource.candidate.size,
        step,
      });
      this.workCursor = (candidateIndex + 1) % candidates.length;
      break;
    }
    return {
      table,
      selections,
      graph: { work },
      fallbackProjections: new Map(this.fallbackReceipts),
      // A neutral projection is an exact zero and needs no MRT, pipeline
      // variant, or readback work. Demand is therefore derived from the
      // selected producer source rather than from the presence of a
      // renderable row; scenes without a probe or Skylight stay on the
      // ordinary single-target path.
      fallbackDemand:
        this.fallbackFormatAvailable &&
        [...fallbackTickets.values()].some((ticket) => ticket.projection.source !== 'neutral'),
      fallbackHasNonNeutral:
        this.fallbackFormatAvailable &&
        [...fallbackTickets.values()].some((ticket) => ticket.projection.source !== 'neutral'),
      completeSubmission: (submitted, completed, fallbackOutput, fallbackRequested = true) =>
        this.completeSubmission(
          submitted,
          fallbackTickets,
          completed,
          fallbackOutput,
          fallbackRequested,
          captureTickets,
          deviceGeneration,
          frameId,
        ),
    };
  }

  private async completeSubmission(
    submitted: boolean,
    fallbackTickets: ReadonlyMap<string, PendingFallback>,
    completed?: Promise<unknown>,
    fallbackOutput?: {
      readonly format: import('@forgeax/engine-rhi').TextureFormat;
      readonly size: { readonly width: number; readonly height: number };
      readonly frameId: number;
      readonly graphGeneration: number;
      readonly textureIdentity: number;
      readonly readback?: Promise<{
        readonly linearHdr: readonly [number, number, number, number];
        readonly hash: string;
        readonly graphGeneration: number;
        readonly textureIdentity: number;
      }>;
    },
    fallbackRequested = true,
    captureTickets: readonly {
      resource: ProbeGpuResource;
      pending: NonNullable<ProbeGpuResource['pending']>;
    }[] = [],
    deviceGeneration = this.internals.deviceScope.generation,
    submittedFrame = this.currentFrame,
  ): Promise<void> {
    let completionFailure: ReflectionFallbackFailureInput | undefined;
    if (completed !== undefined) {
      try {
        await completed;
      } catch {
        submitted = false;
        completionFailure = {
          stage: 'completion',
          code: 'reflection-fallback-completion-failed',
          expected: 'the submitted frame completion promise to resolve',
        };
      }
    }
    if (fallbackRequested)
      await this.completeFallbackSubmission(
        submitted,
        fallbackTickets,
        fallbackOutput,
        completionFailure,
      );
    if (deviceGeneration !== this.internals.deviceScope.generation) return;
    for (const { resource, pending } of captureTickets) {
      if (
        resource.pending !== pending ||
        this.resources.get(`${resource.fact.worldId}:${resource.fact.entityKey}`) !== resource
      )
        continue;
      delete resource.pending;
      if (!submitted || pending === undefined) continue;
      if (pending.rawCaptureFace !== undefined) {
        resource.rawFaceCursor = Math.min(
          resource.rawFaceCursor + 1,
          resource.raw.faceViews.length,
        );
        continue;
      }
      if (pending.step === undefined) continue;
      resource.filter = commitProbeFilterStep(resource.filter, true);
      if (resource.filter.cursor >= resource.filter.faceCount * resource.filter.mipCount) {
        const previous = resource.active;
        resource.active = resource.candidate;
        resource.activeFact = resource.captureFact;
        resource.lastCompletedFrame = submittedFrame;
        resource.atmosphere?.release();
        resource.atmosphere = undefined;
        resource.candidate = resource.spare ?? previous ?? resource.candidate;
        resource.spare = undefined;
      }
    }
  }

  private stageFallbackProjections(
    facts: readonly ReflectionProbeFact[],
    selections: ReadonlyMap<string, ReflectionProbeSelectionResult>,
    accepted: ReadonlyMap<string, ProbeGpuResource>,
    frameId: number,
    skylight: SkylightSnapshot | undefined,
  ): ReadonlyMap<string, PendingFallback> {
    const tickets = new Map<string, PendingFallback>();
    // With no environment source every renderable resolves to the same exact
    // zero. Stage that producer fact once instead of allocating one
    // projection, signature, ticket, and map row per visible object. This is
    // source-absence compression, not a static-scene shortcut: animated
    // transforms and visibility still run normally every frame.
    const stagedSelections: ReadonlyMap<string, ReflectionProbeSelectionResult> =
      facts.length === 0 && skylight === undefined
        ? new Map([['__frame__', { kind: 'skylight' as const }]])
        : selections;
    const skylightSignature =
      skylight === undefined
        ? ''
        : `:${JSON.stringify([skylight.equirectHandle, skylight.intensity, ...skylight.color, ...skylight.rotation])}`;
    for (const [renderableKey, selection] of stagedSelections) {
      const probeKey =
        selection.kind === 'probe' ? `${selection.worldId}:${selection.entityKey}` : undefined;
      const resource = probeKey === undefined ? undefined : accepted.get(probeKey);
      const source = resolveReflectionFallbackSource(
        selection,
        resource?.active !== undefined &&
          resource.activeFact?.center.every((v, i) => v === resource.fact.center[i]) === true,
        skylight !== undefined,
      );
      const projection = deriveReflectionFallbackProjection({
        renderableKey,
        sourceKey:
          reflectionFallbackSourceKey(source, selection, skylight) +
          (source === 'probe' && resource !== undefined
            ? `@${resource.filter.activeGeneration}:${resource.fact.boxProjection === true}:${resource.fact.intensity}`
            : '') +
          skylightSignature +
          (source === 'neutral' ? '' : `:catalog:${this.internals.assets.catalogEpoch}`),
        source,
        coverage: reflectionFallbackCoverage(source, resource?.fact, selection),
        ...(resource === undefined ? {} : { extent: resource.fact.halfExtents }),
        linearHdr: [0, 0, 0, 0],
        brdfSignature: 'standard-pbr-ibl-v1',
      });
      if (!projection.ok) {
        this.recordFallbackFailure({
          stage: 'prepare',
          code: projection.error.code,
          expected: projection.error.expected,
          detail: { renderableKey, field: projection.error.field },
        });
        continue;
      }
      const signature = reflectionFallbackProjectionSignature(projection.value);
      const previousCandidate = this.latestFallbackTickets.get(renderableKey);
      if (
        previousCandidate !== undefined &&
        reflectionFallbackProjectionSignature(previousCandidate.projection) !== signature
      ) {
        this.fallbackRetiredFrames.set(renderableKey, frameId);
      }
      const previousSignature = this.fallbackSignatures.get(renderableKey);
      if (previousSignature !== undefined && previousSignature !== signature) {
        // A changed source, coverage, extent, or BRDF is not a compatible LKG.
        // Hide the old row until this new candidate has its own matching
        // submit/readback receipt; otherwise SSR could subtract a stale lobe.
        this.fallbackReceipts.delete(renderableKey);
        this.fallbackSignatures.delete(renderableKey);
        this.fallbackCommittedFrames.delete(renderableKey);
        this.fallbackRetiredFrames.set(renderableKey, frameId);
        this.fallbackReadback = undefined;
        if (this.fallbackReceiptKey === renderableKey) this.fallbackReceiptKey = undefined;
      }
      const pending: PendingFallback = {
        ticket: ++this.nextFallbackTicket,
        frameId,
        deviceGeneration: this.internals.deviceScope.generation,
        projection: projection.value,
      };
      tickets.set(renderableKey, pending);
      this.latestFallbackTickets.set(renderableKey, pending);
    }
    // Retire rows that disappeared from this frame's main-pass selection.
    // Keeping them would make a detached inspection row outlive its source.
    for (const renderableKey of this.fallbackReceipts.keys()) {
      if (tickets.has(renderableKey)) continue;
      this.fallbackReceipts.delete(renderableKey);
      this.fallbackSignatures.delete(renderableKey);
      this.fallbackCommittedFrames.delete(renderableKey);
      this.fallbackGenerations.delete(renderableKey);
      this.latestFallbackTickets.delete(renderableKey);
      this.fallbackRetiredFrames.set(renderableKey, frameId);
    }
    for (const renderableKey of this.fallbackGenerations.keys()) {
      if (!tickets.has(renderableKey)) this.fallbackGenerations.delete(renderableKey);
    }
    // Retire even uncommitted rows, so disappear/reappear cannot revive an
    // old completion. Storage stays bounded by current renderables.
    for (const key of this.latestFallbackTickets.keys()) {
      if (tickets.has(key)) continue;
      this.latestFallbackTickets.delete(key);
      this.fallbackRetiredFrames.set(key, frameId);
    }
    if (tickets.size === 0 && facts.length === 0) {
      const neutralKey = '__frame__';
      const projection = deriveReflectionFallbackProjection({
        renderableKey: neutralKey,
        sourceKey: 'neutral',
        source: 'neutral',
        coverage: 0,
        linearHdr: [0, 0, 0, 0],
        brdfSignature: 'standard-pbr-ibl-v1',
      });
      if (projection.ok) {
        const pending: PendingFallback = {
          ticket: ++this.nextFallbackTicket,
          frameId,
          deviceGeneration: this.internals.deviceScope.generation,
          projection: projection.value,
        };
        tickets.set(neutralKey, pending);
        this.latestFallbackTickets.set(neutralKey, pending);
      }
    }
    this.selectFallbackReceiptKey(tickets, skylight !== undefined);
    this.refreshFallbackReceipt();
    return tickets;
  }

  private selectFallbackReceiptKey(
    tickets: ReadonlyMap<string, PendingFallback>,
    skylightAvailable: boolean,
  ): void {
    // When the environment source is absent and the first selected consumer
    // is outside every probe, a neutral row is the only producer-owned zero
    // fallback that can represent that sample. Prefer it instead of retaining
    // the previous Skylight representative across the transition. A local
    // probe selection still wins through the source-key match below.
    if (!skylightAvailable && this.lastSelection.kind !== 'probe') {
      let neutralKey: string | undefined;
      for (const [key, pending] of tickets) {
        if (pending.projection.source !== 'neutral') continue;
        if (neutralKey === undefined || key < neutralKey) neutralKey = key;
      }
      if (neutralKey !== undefined) {
        this.fallbackReceiptKey = neutralKey;
        return;
      }
    }
    const selectedSourceKey =
      this.lastSelection.kind === 'probe'
        ? `probe:${this.lastSelection.worldId}:${this.lastSelection.entityKey}`
        : undefined;
    let sourceMatch: string | undefined;
    for (const [key, pending] of tickets) {
      const matches =
        (selectedSourceKey !== undefined &&
          pending.projection.sourceKey?.startsWith(`${selectedSourceKey}@`) === true) ||
        (selectedSourceKey === undefined && pending.projection.source === 'skylight');
      if (matches && (sourceMatch === undefined || key < sourceMatch)) sourceMatch = key;
    }
    if (sourceMatch !== undefined) {
      this.fallbackReceiptKey = sourceMatch;
      return;
    }
    if (this.fallbackReceiptKey !== undefined && tickets.has(this.fallbackReceiptKey)) return;
    let firstKey: string | undefined;
    for (const key of tickets.keys()) {
      if (firstKey === undefined || key < firstKey) firstKey = key;
    }
    this.fallbackReceiptKey = firstKey;
  }

  /** Commit exact-zero neutral rows even when a non-neutral MRT readback fails. */
  private commitNeutralFallbacks(fallbackTickets: ReadonlyMap<string, PendingFallback>): number {
    let committed = 0;
    for (const [renderableKey, pending] of fallbackTickets) {
      if (
        pending.projection.source === 'neutral' &&
        this.latestFallbackTickets.get(renderableKey) === pending &&
        pending.deviceGeneration === this.internals.deviceScope.generation
      ) {
        this.commitFallbackProjection(renderableKey, pending, 'neutral');
        committed += 1;
      }
    }
    return committed;
  }

  private commitFallbackProjection(
    renderableKey: string,
    pending: PendingFallback,
    state: ReflectionFallbackReceipt['state'],
  ): void {
    const signature = reflectionFallbackProjectionSignature(pending.projection);
    const previousSignature = this.fallbackSignatures.get(renderableKey);
    const changed = signature !== previousSignature;
    const previous = this.fallbackReceipts.get(renderableKey);
    const generations = this.fallbackGenerations.get(renderableKey) ?? {
      source: previous?.sourceGeneration ?? 0,
      projection: previous?.projectionGeneration ?? 0,
    };
    const { linearHdr: _referencePixel, ...projection } = pending.projection;
    const receipt = Object.freeze({
      ...projection,
      rendererId: this.internals.deviceScope.owner,
      producerId: REFLECTION_PROBE_PRODUCER_ID,
      ...(this.internals.ssrIdentity === undefined ? {} : { identity: this.internals.ssrIdentity }),
      frameId: pending.frameId,
      sourceGeneration: generations.source + (changed ? 1 : 0),
      projectionGeneration: generations.projection + (changed ? 1 : 0),
      deviceGeneration: pending.deviceGeneration,
      state,
      candidateVisible: false,
    }) satisfies ReflectionFallbackReceipt;
    this.fallbackGenerations.set(renderableKey, {
      source: receipt.sourceGeneration,
      projection: receipt.projectionGeneration,
    });
    this.fallbackSignatures.set(renderableKey, signature);
    this.fallbackReceipts.set(renderableKey, receipt);
    this.fallbackCommittedFrames.set(renderableKey, pending.frameId);
    if (this.fallbackReceiptKey === undefined) this.fallbackReceiptKey = renderableKey;
    this.refreshFallbackReceipt();
  }

  /** Retain only a source-identical committed row after candidate failure. */
  private preserveFallbackLkg(fallbackTickets: ReadonlyMap<string, PendingFallback>): void {
    for (const [renderableKey, pending] of fallbackTickets) {
      if (this.latestFallbackTickets.get(renderableKey) !== pending) continue;
      const previous = this.fallbackReceipts.get(renderableKey);
      const signature = reflectionFallbackProjectionSignature(pending.projection);
      const compatible =
        previous !== undefined && this.fallbackSignatures.get(renderableKey) === signature;
      if (compatible) {
        if (previous.state !== 'neutral' && pending.projection.source !== 'neutral') {
          this.fallbackReceipts.set(
            renderableKey,
            Object.freeze({ ...previous, state: 'lkg' }) satisfies ReflectionFallbackReceipt,
          );
        }
        continue;
      }
      // A source or coverage change cannot use the old row as LKG.  The stage
      // normally retires it eagerly; this second guard covers failed first
      // submissions and keeps stale rows fail-closed.
      this.fallbackReceipts.delete(renderableKey);
      this.fallbackSignatures.delete(renderableKey);
      this.fallbackCommittedFrames.delete(renderableKey);
      this.fallbackRetiredFrames.set(renderableKey, pending.frameId);
    }
    this.refreshFallbackReceipt();
  }

  private async completeFallbackSubmission(
    submitted: boolean,
    fallbackTickets: ReadonlyMap<string, PendingFallback>,
    fallbackOutput?: {
      readonly format: import('@forgeax/engine-rhi').TextureFormat;
      readonly size: { readonly width: number; readonly height: number };
      readonly frameId: number;
      readonly graphGeneration: number;
      readonly textureIdentity: number;
      readonly readback?: Promise<{
        readonly linearHdr: readonly [number, number, number, number];
        readonly hash: string;
        readonly graphGeneration: number;
        readonly textureIdentity: number;
      }>;
    },
    submissionFailure?: ReflectionFallbackFailureInput,
  ): Promise<void> {
    // A late completion from the previous device/capability generation must
    // not resurrect a projection after the current device has failed the
    // fallback attachment probe. The prepare phase already published the
    // structured capability failure and retired all current rows.
    if (!this.fallbackFormatAvailable) {
      return;
    }
    // Source/coverage publication follows real graph execution and GPU completion.
    // Pixel validation is a separate, explicitly requested diagnostic capability.
    if (!submitted || fallbackTickets.size === 0) {
      if (!submitted) {
        this.recordFallbackFailure(
          submissionFailure ?? {
            stage: 'submit',
            code: 'reflection-fallback-submit-failed',
            expected: 'the frame containing the fallback projection to submit successfully',
          },
        );
        this.preserveFallbackLkg(fallbackTickets);
      }
      return;
    }
    if (
      fallbackOutput === undefined ||
      (this.internals.captureReflectionFallbackReadback === true &&
        fallbackOutput.readback === undefined)
    ) {
      // Neutral rows require no attachment; non-neutral rows need an executed output.
      const committedNeutral = this.commitNeutralFallbacks(fallbackTickets);
      const nonNeutral = new Map(
        [...fallbackTickets].filter(([, pending]) => pending.projection.source !== 'neutral'),
      );
      if (nonNeutral.size === 0) this.fallbackReadback = undefined;
      if (nonNeutral.size === 0 && committedNeutral === fallbackTickets.size) {
        this.clearFallbackFailure();
      }
      if (nonNeutral.size > 0) {
        this.recordFallbackFailure({
          stage: 'completion',
          code:
            fallbackOutput === undefined
              ? 'reflection-fallback-output-missing'
              : 'reflection-fallback-readback-missing',
          expected: 'a completed fallback MRT output and, when requested, mapped diagnostic bytes',
          detail: { frameId: fallbackTickets.values().next().value?.frameId },
        });
      }
      this.preserveFallbackLkg(nonNeutral);
      return;
    }
    let readback:
      | {
          readonly linearHdr: readonly [number, number, number, number];
          readonly hash: string;
          readonly graphGeneration: number;
          readonly textureIdentity: number;
        }
      | undefined;
    try {
      readback = await fallbackOutput.readback;
    } catch (cause) {
      this.recordFallbackFailure({
        stage: 'completion',
        code: 'reflection-fallback-readback-failed',
        expected: 'the fallback MRT readback to map and resolve',
        detail: { reason: cause instanceof Error ? cause.message : String(cause) },
      });
      this.commitNeutralFallbacks(fallbackTickets);
      this.preserveFallbackLkg(
        new Map(
          [...fallbackTickets].filter(([, pending]) => pending.projection.source !== 'neutral'),
        ),
      );
      return;
    }
    if (
      readback !== undefined &&
      (readback.graphGeneration !== fallbackOutput.graphGeneration ||
        readback.textureIdentity !== fallbackOutput.textureIdentity)
    ) {
      this.recordFallbackFailure({
        stage: 'completion',
        code: 'reflection-fallback-identity-mismatch',
        expected:
          'mapped readback graph and texture identity to match the submitted fallback target',
        detail: {
          expectedGraphGeneration: fallbackOutput.graphGeneration,
          actualGraphGeneration: readback.graphGeneration,
          expectedTextureIdentity: fallbackOutput.textureIdentity,
          actualTextureIdentity: readback.textureIdentity,
        },
      });
      this.commitNeutralFallbacks(fallbackTickets);
      this.preserveFallbackLkg(
        new Map(
          [...fallbackTickets].filter(([, pending]) => pending.projection.source !== 'neutral'),
        ),
      );
      return;
    }
    const eligible: Array<[string, PendingFallback]> = [];
    let staleCount = 0;
    for (const [renderableKey, pending] of fallbackTickets) {
      const latest = this.latestFallbackTickets.get(renderableKey);
      const retiredAt = this.fallbackRetiredFrames.get(renderableKey);
      const committedFrame = this.fallbackCommittedFrames.get(renderableKey);
      if (
        latest === undefined ||
        reflectionFallbackProjectionSignature(latest.projection) !==
          reflectionFallbackProjectionSignature(pending.projection) ||
        pending.frameId !== fallbackOutput.frameId ||
        pending.deviceGeneration !== this.internals.deviceScope.generation ||
        (retiredAt !== undefined && pending.frameId < retiredAt) ||
        (committedFrame !== undefined && pending.frameId <= committedFrame)
      ) {
        staleCount += 1;
        continue;
      }
      eligible.push([renderableKey, pending]);
    }
    if (eligible.length === 0) {
      if (staleCount > 0) {
        this.recordFallbackFailure({
          stage: 'completion',
          code: 'reflection-fallback-stale-ticket',
          expected:
            'the completed fallback to match the current projection and device without rolling back a committed frame',
          detail: { staleCount },
        });
      }
      this.refreshFallbackReceipt();
      return;
    }
    const hasNonNeutral = eligible.some(([, pending]) => pending.projection.source !== 'neutral');
    const previousReadback = this.fallbackReadback;
    if (
      hasNonNeutral &&
      readback !== undefined &&
      (previousReadback === undefined || fallbackOutput.frameId >= previousReadback.frameId)
    ) {
      this.fallbackReadback = Object.freeze({
        rendererId: this.internals.deviceScope.owner,
        producerId: REFLECTION_PROBE_PRODUCER_ID,
        frameId: fallbackOutput.frameId,
        deviceGeneration: this.internals.deviceScope.generation,
        graphGeneration: readback.graphGeneration,
        textureIdentity: readback.textureIdentity,
        format: fallbackOutput.format,
        size: Object.freeze({ ...fallbackOutput.size }),
        linearHdr: Object.freeze([...readback.linearHdr]) as readonly [
          number,
          number,
          number,
          number,
        ],
        readbackHash: readback.hash,
        readbackStatus: 'complete',
      });
    }
    if (readback === undefined) this.fallbackReadback = undefined;
    for (const [renderableKey, pending] of eligible) {
      this.commitFallbackProjection(
        renderableKey,
        pending,
        pending.projection.source === 'neutral' ? 'neutral' : 'active',
      );
    }
    this.clearFallbackFailure();
    this.refreshFallbackReceipt();
  }

  dispose(): void {
    for (const resource of this.resources.values()) {
      this.destroyProbeResource(resource);
    }
    this.resources.clear();
    this.latestFallbackTickets.clear();
    this.fallbackRetiredFrames.clear();
    this.fallbackCommittedFrames.clear();
    this.fallbackGenerations.clear();
    this.fallbackSignatures.clear();
    this.fallbackReceipts.clear();
    this.fallbackReadback = undefined;
    this.fallbackReceiptKey = undefined;
    this.fallbackFailure = undefined;
    this.fallbackFormatAvailable = this.internals.device.caps.rgba16floatRenderable === true;
    this.fallbackReceipt = this.createFallbackReceipt('unavailable');
    if (this.shared !== undefined) {
      if (this.shared.background !== undefined)
        this.internals.device.destroyBuffer(this.shared.background.uniform);
      this.internals.device.destroyBuffer(this.shared.faceUniforms);
      this.internals.device.destroyBuffer(this.shared.prefilterUniforms);
      this.internals.device.destroyBuffer(this.shared.vertexBuffer);
    }
    this.shared = undefined;
    this.pipelineWarmup = undefined;
  }

  private destroyProbeResource(resource: ProbeGpuResource): void {
    resource.atmosphere?.release();
    resource.atmosphere = undefined;
    const sets = new Set<ProbeCubeSet>([resource.raw, resource.candidate]);
    if (resource.active !== undefined) sets.add(resource.active);
    if (resource.spare !== undefined) sets.add(resource.spare);
    for (const set of sets) this.destroyCubeSet(set);
    this.internals.device.destroyBuffer(resource.uniformBuffer);
  }

  private destroyCubeSet(set: ProbeCubeSet): void {
    this.internals.device.destroyTexture(set.texture);
    this.internals.device.destroyTexture(set.depthTexture);
  }

  private resourceFor(
    key: string,
    fact: ReflectionProbeFact,
    index: number,
    sceneRevision = '',
    skylight?: SkylightSnapshot,
    environment?: SelectedEnvironmentFrame,
  ): ProbeGpuResource | undefined {
    const cache =
      skylight !== undefined && skylight.equirectHandle !== 0
        ? getOrCreateIblCache(this.internals.deviceScope)
        : undefined;
    const diffuseAvailable =
      skylight !== undefined &&
      (skylight.equirectHandle === 0 ||
        (cache?.irradianceView !== undefined &&
          cache.prefilterView !== undefined &&
          cache.brdfLutView !== undefined));
    const diffuse =
      skylight === undefined
        ? [0, 0, 0, index + 1, 0, 0, 0, 1]
        : [
            ...(diffuseAvailable
              ? skylight.color.map((value) => value * skylight.intensity)
              : [0, 0, 0]),
            index + 1,
            ...skylight.rotation,
          ];
    let existing = this.resources.get(key);
    if (
      existing !== undefined &&
      existing.raw.size !== fact.resolution &&
      existing.pending === undefined
    ) {
      this.destroyProbeResource(existing);
      this.resources.delete(key);
      existing = undefined;
    }
    if (existing !== undefined) {
      const previous = existing.fact;
      const settled =
        existing.filter.cursor >= existing.filter.faceCount * existing.filter.mipCount;
      const moved = existing.captureFact.center.some((value, axis) => value !== fact.center[axis]);
      const requested =
        existing.captureFact.revision !== fact.revision ||
        moved ||
        fact.updateIntent === 'continuous' ||
        (fact.updateIntent === 'on-change' && existing.captureSceneRevision !== sceneRevision);
      // Finish the current bounded cycle. Coalesce newer changes into the next
      // cycle instead of continuously restarting face zero under motion.
      if (settled && existing.pending === undefined && requested) {
        existing.atmosphere?.release();
        existing.atmosphere =
          environment?.source.kind === 'atmosphere'
            ? retainAtmosphere(this.internals, environment)
            : undefined;
        existing.captureFact = fact;
        existing.captureSceneRevision = sceneRevision;
        existing.captureStartedFrame = this.currentFrame;
        existing.filter = createProbeFilterState({
          probeIndex: index,
          mipCount: PREFILTER_MIP_LEVELS,
          activeGeneration: existing.filter.activeGeneration,
        });
        existing.rawFaceCursor = 0;
      }
      existing.fact = fact;
      existing.index = index;
      if (
        previous.intensity !== fact.intensity ||
        previous.boxProjection !== fact.boxProjection ||
        previous.center.some((v, i) => v !== fact.center[i]) ||
        previous.halfExtents.some((v, i) => v !== fact.halfExtents[i]) ||
        existing.diffusePayload.some((v, i) => v !== diffuse[i])
      ) {
        const written = this.internals.device.queue.writeBuffer(
          existing.uniformBuffer,
          0,
          new Float32Array([
            -(Math.max(0, fact.intensity) + PROBE_INTENSITY_SENTINEL_OFFSET),
            ...fact.center,
            ...fact.halfExtents,
            fact.boxProjection === true ? 1 : 0,
            ...diffuse,
          ]),
        );
        if (!written.ok) this.internals.errorRegistry.fire(written.error);
        else existing.diffusePayload = diffuse;
      }
      return existing;
    }
    if (this.shared === undefined) return undefined;
    const raw = this.createCubeSet(`reflection-probe-${index}-raw`, fact.resolution, 1);
    const candidate = this.createCubeSet(`reflection-probe-${index}-candidate`, fact.resolution);
    const spare = this.createCubeSet(`reflection-probe-${index}-spare`, fact.resolution);
    const releaseSets = () => {
      for (const set of [raw, candidate, spare]) if (set !== undefined) this.destroyCubeSet(set);
    };
    if (raw === undefined || candidate === undefined || spare === undefined) {
      releaseSets();
      return undefined;
    }
    const uniformBuffer = this.internals.device.createBuffer({
      label: `reflection-probe-${index}-uniforms`,
      size: 64,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    });
    if (!uniformBuffer.ok) {
      releaseSets();
      return undefined;
    }
    const payload = new Float32Array([
      -(Math.max(0, fact.intensity) + PROBE_INTENSITY_SENTINEL_OFFSET),
      fact.center[0],
      fact.center[1],
      fact.center[2],
      fact.halfExtents[0],
      fact.halfExtents[1],
      fact.halfExtents[2],
      fact.boxProjection === true ? 1 : 0,
      ...diffuse,
    ]);
    const written = this.internals.device.queue.writeBuffer(uniformBuffer.value, 0, payload);
    if (!written.ok) {
      releaseSets();
      this.internals.device.destroyBuffer(uniformBuffer.value);
      return undefined;
    }
    const filterGroup1 = this.internals.device.createBindGroup({
      label: `reflection-probe-${index}-filter-input`,
      layout: this.shared.cubeGroup1Bgl,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: raw.cubeView } },
        { binding: 1, resource: { kind: 'sampler', value: this.shared.sampler } },
      ],
    });
    if (!filterGroup1.ok) {
      releaseSets();
      this.internals.device.destroyBuffer(uniformBuffer.value);
      return undefined;
    }
    const resource: ProbeGpuResource = {
      fact,
      captureFact: fact,
      atmosphere:
        environment?.source.kind === 'atmosphere'
          ? retainAtmosphere(this.internals, environment)
          : undefined,
      diffusePayload: diffuse,
      captureSceneRevision: sceneRevision,
      captureStartedFrame: this.currentFrame,
      lastCompletedFrame: 0,
      index,
      filter: createProbeFilterState({ probeIndex: index, mipCount: candidate.mipViews.length }),
      rawFaceCursor: 0,
      raw,
      active: undefined,
      candidate,
      spare,
      sampler: this.shared.sampler,
      uniformBuffer: uniformBuffer.value,
      filterGroup1: filterGroup1.value,
    };
    this.resources.set(key, resource);
    return resource;
  }

  private createSharedResources(
    filterPipeline: RenderPipeline,
    background?: ProbeBackgroundResources,
  ): ProbeSharedResources | undefined {
    const faceUniforms = createFaceUniformsBuffer(this.internals.device);
    const prefilterUniforms = createPrefilterUniformsBuffer(this.internals.device);
    if (!faceUniforms.ok || !prefilterUniforms.ok) return undefined;
    if (!writeAllFaceUniforms(this.internals.device, faceUniforms.value).ok) return undefined;
    if (!writeAllPrefilterUniforms(this.internals.device, prefilterUniforms.value, 1, 'camera').ok)
      return undefined;
    const vertexBuffer = this.internals.device.createBuffer({
      label: 'reflection-probe-capture-cube-vertices',
      size: CUBEMAP_FACE_VERTICES.byteLength,
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    });
    if (!vertexBuffer.ok) return undefined;
    const vertexWrite = this.internals.device.queue.writeBuffer(
      vertexBuffer.value,
      0,
      CUBEMAP_FACE_VERTICES,
    );
    if (!vertexWrite.ok) return undefined;
    const sampler = this.internals.device.createSampler({
      label: 'reflection-probe-pmrem-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });
    const cache = getOrCreateIblCache(this.internals.deviceScope);
    if (
      !sampler.ok ||
      cache.cubeGroup1Bgl === undefined ||
      cache.prefilterGroup0Bgl === undefined
    ) {
      return undefined;
    }
    return {
      background,
      faceUniforms: faceUniforms.value,
      prefilterUniforms: prefilterUniforms.value,
      vertexBuffer: vertexBuffer.value,
      sampler: sampler.value,
      filterPipeline,
      cubeGroup1Bgl: cache.cubeGroup1Bgl,
      prefilterGroup0Bgl: cache.prefilterGroup0Bgl,
    };
  }

  private createCubeSet(
    label: string,
    size: number,
    mipCount = PREFILTER_MIP_LEVELS,
  ): ProbeCubeSet | undefined {
    const texture = this.internals.device.createTexture({
      label,
      size: { width: size, height: size, depthOrArrayLayers: 6 },
      mipLevelCount: mipCount,
      sampleCount: 1,
      dimension: '2d',
      format: this.outputFormat,
      usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_SRC,
      viewFormats: [],
      textureBindingViewDimension: undefined,
    });
    if (!texture.ok) return undefined;
    const cubeView = this.internals.device.createTextureView(texture.value, {
      label: `${label}-cube`,
      dimension: 'cube',
      baseMipLevel: 0,
      mipLevelCount: mipCount,
      arrayLayerCount: 6,
    });
    if (!cubeView.ok) {
      this.internals.device.destroyTexture(texture.value);
      return undefined;
    }
    const faceViews: TextureView[] = [];
    const mipViews: TextureView[][] = [];
    for (let mip = 0; mip < mipCount; mip += 1) {
      const faces: TextureView[] = [];
      for (let face = 0; face < 6; face += 1) {
        const view = this.internals.device.createTextureView(texture.value, {
          label: `${label}-mip${mip}-face${face}`,
          dimension: '2d',
          baseMipLevel: mip,
          mipLevelCount: 1,
          baseArrayLayer: face,
          arrayLayerCount: 1,
        });
        if (!view.ok) {
          this.internals.device.destroyTexture(texture.value);
          return undefined;
        }
        if (mip === 0) faceViews.push(view.value);
        faces.push(view.value);
      }
      mipViews.push(faces);
    }
    const depthTexture = this.internals.device.createTexture({
      label: `${label}-depth`,
      size: { width: size, height: size, depthOrArrayLayers: 1 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: 'depth32float-stencil8',
      usage: 0x10,
      viewFormats: [],
      textureBindingViewDimension: undefined,
    });
    if (!depthTexture.ok) {
      this.internals.device.destroyTexture(texture.value);
      return undefined;
    }
    const depthView = this.internals.device.createTextureView(depthTexture.value, {
      label: `${label}-depth-view`,
      dimension: '2d',
    });
    if (!depthView.ok) {
      this.internals.device.destroyTexture(texture.value);
      this.internals.device.destroyTexture(depthTexture.value);
      return undefined;
    }
    return {
      texture: texture.value,
      cubeView: cubeView.value,
      faceViews,
      mipViews,
      depthTexture: depthTexture.value,
      depthView: depthView.value,
      size,
    };
  }
}
