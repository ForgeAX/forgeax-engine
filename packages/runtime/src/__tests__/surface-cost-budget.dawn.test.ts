import { execFileSync } from 'node:child_process';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack';
import type {
  DynamicInputRange,
  SurfaceDynamicInputFrame,
  SurfaceDynamicInputMemberIdentity,
} from '@forgeax/engine-render';
import { ReadonlyDynamicInputPage, type Renderer } from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBackendPack } from '../backend-selection';
import { createDevImportTransport } from '../dev-import-transport';
import { constructRuntimeRendererHost } from '../renderer-host';
import { startSurfaceMaterialPublicationServer } from './material-publication.server';
import { shaderManifestUrl as createShaderManifestUrl } from './shader-manifest-url.fixture';
import { populateSurfaceWorld } from './surface-standard-pipeline.runtime-fixture';

const WATER_BLOCK_COUNTS = [2, 4, 8] as const;
const EVENT_K_VALUES = [1, 2, 4] as const;
const RESOLUTIONS = [
  { width: 320, height: 180 },
  { width: 640, height: 360 },
] as const;
const WARMUP_FRAMES = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 12 : 300;
const EVIDENCE_SOURCE_SHA = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const EVIDENCE_BUILD_ID = `vitest-dawn-${EVIDENCE_SOURCE_SHA.slice(0, 12)}`;
const GPU_PASS_TIMING_OPTIONS = {
  maxPassesPerFrame: 64,
  maxFramesInFlight: 2,
  retentionFrames: 8,
} as const;

type Resolution = (typeof RESOLUTIONS)[number];

type GpuDrivenInspection = ReturnType<Renderer['inspect']>['renderScene']['gpuDriven'];
type ResourceClassSplit = NonNullable<GpuDrivenInspection['resourceClassSplits']>[number];
type ResourceAllocation = NonNullable<GpuDrivenInspection['resourceAllocation']>;
type RenderGraphResourceAllocation = NonNullable<
  ReturnType<Renderer['inspect']>['renderGraphResourceAllocation']
>;

type CostTiming =
  | {
      readonly status: 'measured';
      readonly measuredPassNanoseconds: number;
      readonly passes: readonly {
        readonly name: string;
        readonly durationNanoseconds: number;
      }[];
    }
  | {
      readonly status: 'unavailable';
      readonly reason: string;
    }
  | {
      readonly status: 'partial' | 'failed';
      readonly reason: string;
    };

interface CostSample {
  readonly coverageWaterBlocks: number;
  readonly eventK: number;
  readonly resolution: Resolution;
  readonly cpuSubmitElapsedMs: number;
  readonly gpuPass: CostTiming;
  readonly dirtyUploadBytes: number;
  /** Upload bytes observed on the topology/input transition preceding this stable frame. */
  readonly transitionUploadBytes: {
    readonly surfaceDynamicInput: number;
    readonly sceneTable: number;
    readonly palette: number;
    readonly candidate: number;
    readonly batch: number;
    readonly viewConstants: number;
  };
  readonly batchCount: number;
  readonly resourceHighWater: {
    readonly candidateCapacity: number;
    readonly batchCapacity: number;
    readonly indirectCapacity: number;
    /** Logical Engine allocation bytes from the GPU-driven view owner. */
    readonly allocation: Pick<
      ResourceAllocation,
      | 'unit'
      | 'physicalResidency'
      | 'liveBytes'
      | 'pendingRetirementBytes'
      | 'peakBytes'
      | 'pendingRetirementCount'
      | 'failedAllocationRollbacks'
      | 'failedAllocationRollbackBytes'
    >;
    readonly materialRasterAllocation:
      | Pick<
          ResourceAllocation,
          | 'unit'
          | 'physicalResidency'
          | 'liveBytes'
          | 'pendingRetirementBytes'
          | 'peakBytes'
          | 'pendingRetirementCount'
          | 'failedAllocationRollbacks'
          | 'failedAllocationRollbackBytes'
        >
      | undefined;
    readonly renderGraphAllocation: Pick<
      RenderGraphResourceAllocation,
      | 'unit'
      | 'physicalResidency'
      | 'liveBytes'
      | 'pendingRetirementBytes'
      | 'peakBytes'
      | 'pendingRetirementCount'
      | 'failedAllocationRollbacks'
      | 'failedAllocationRollbackBytes'
      | 'unknownByteSizeCount'
      | 'importedResourceCount'
    >;
    readonly unavailableOwners: readonly string[];
  };
  readonly splitReasons: readonly string[];
  /** `splitReasons` is a view-pass lane diagnostic, not resource-class attribution. */
  readonly splitReasonScope: 'view-pass-lane';
  readonly resourceClassAttribution: 'measured' | 'unavailable';
  readonly resourceClassCount: number | undefined;
  readonly resourceClassSplitReasons: readonly string[] | undefined;
  readonly resourceClassSplits: readonly ResourceClassSplit[] | undefined;
  readonly worldEntitiesScanned: number;
  readonly validatedGpuOwnedRows: number;
  readonly gpuOwnedEntityCount: number;
  readonly candidateUploadBytes: number;
  readonly batchUploadBytes: number;
  readonly viewConstantsUploadBytes: number;
  readonly sceneTableUploadBytes: number;
  readonly paletteUploadBytes: number;
  readonly indirectDrawCount: number;
  readonly cpuFallbackDrawItems: number;
  readonly mainGpuDrawCount: number;
  readonly mainResidualDrawCount: number;
  readonly surfaceFrameMemberScans: number;
  readonly surfaceFrameRowAllocations: number;
  readonly topologyRevision: number | undefined;
  readonly surfaceFrameRangeBuilds: number;
  readonly filteredPlanBuilds: number;
  readonly stableFrame: boolean;
  readonly frameIdentity: {
    readonly frameId: number;
    readonly deviceGeneration: number;
    readonly graphGeneration: number | undefined;
    readonly backendId: string | undefined;
  };
}

interface BudgetCanvas extends HTMLCanvasElement {
  target?: GPUTexture;
}

function createBudgetCanvas(initial: Resolution): BudgetCanvas {
  let configured: { readonly device: GPUDevice; readonly format: GPUTextureFormat } | undefined;
  let targetSize = { width: 0, height: 0 };
  const canvas = {
    width: initial.width,
    height: initial.height,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(descriptor: { readonly device: GPUDevice; readonly format?: GPUTextureFormat }) {
          if (configured?.device !== descriptor.device) {
            canvas.target?.destroy();
            canvas.target = undefined;
            targetSize = { width: 0, height: 0 };
          }
          configured = {
            device: descriptor.device,
            format: descriptor.format ?? 'rgba8unorm',
          };
          ensureTarget();
        },
        unconfigure() {},
        getCurrentTexture() {
          return ensureTarget();
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as BudgetCanvas;
  function ensureTarget(): GPUTexture {
    if (configured === undefined) throw new Error('surface-cost-budget: target not configured');
    if (
      canvas.target === undefined ||
      targetSize.width !== canvas.width ||
      targetSize.height !== canvas.height
    ) {
      canvas.target?.destroy();
      canvas.target = configured.device.createTexture({
        size: { width: canvas.width, height: canvas.height, depthOrArrayLayers: 1 },
        format: configured.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: ['rgba8unorm-srgb'],
      });
      targetSize = { width: canvas.width, height: canvas.height };
    }
    return canvas.target;
  }
  return canvas;
}

function inspectError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      readonly code?: unknown;
      readonly expected?: unknown;
      readonly hint?: unknown;
      readonly detail?: unknown;
      readonly message?: unknown;
      readonly cause?: unknown;
    };
    return JSON.stringify({
      code: candidate.code,
      expected: candidate.expected,
      hint: candidate.hint,
      detail: candidate.detail,
      message: candidate.message,
      cause: candidate.cause,
    });
  }
  return String(error);
}

function waterRecord(schema: NonNullable<MaterialAsset['surface']>['dynamicInput'], index: number) {
  if (schema === undefined) throw new Error('surface-cost-budget: dynamic schema unavailable');
  return {
    position: [index * 0.25, (index % 2) * 0.1, 0] as const,
    time: index * 0.05,
    eventId: 1000 + index,
    ...(schema.fields.some((field) => field.name === 'strength') ? { strength: 1 } : {}),
  };
}

function createBudgetInput(
  material: MaterialAsset,
  members: readonly SurfaceDynamicInputMemberIdentity[],
  deviceGeneration: number,
  eventK: number,
  projectionRevision: number,
): SurfaceDynamicInputFrame {
  const schema = material.surface?.dynamicInput;
  if (schema === undefined) throw new Error('surface-cost-budget: water schema unavailable');
  if (eventK < 1 || eventK > schema.maxEventsPerSample) {
    throw new Error(`surface-cost-budget: eventK=${eventK} exceeds authored page limit`);
  }
  const page = ReadonlyDynamicInputPage.create({
    sourceId: `surface-cost-budget-k${eventK}`,
    pageId: projectionRevision,
    schema,
  }).unwrap();
  page.reconfigureDevice(deviceGeneration).unwrap();
  const recordsPerDomain = eventK;
  const domainRecordCount = recordsPerDomain * 2;
  for (let index = 0; index < domainRecordCount; index += 1) {
    page.writeRecord(index, waterRecord(schema, index)).unwrap();
  }
  const ranges: DynamicInputRange[] = members.map((member, index) =>
    page
      .reserveRange({
        domain: index % 2 === 0 ? 'water-domain-a' : 'water-domain-b',
        recordStart: (index % 2) * recordsPerDomain,
        recordCount: recordsPerDomain,
        instanceIndex: index,
        member,
      })
      .unwrap(),
  );
  return { page, ranges, projectionRevision, frameTime: 0 };
}

function setWaterCoverage(
  world: World,
  waterEntities: readonly number[],
  visibleBlocks: number,
): void {
  const columns = visibleBlocks <= 2 ? 2 : visibleBlocks <= 4 ? 2 : 4;
  const rows = visibleBlocks / columns;
  const tileScaleX = 4 / columns;
  const tileScaleY = 2 / rows;
  for (const [index, entity] of waterEntities.entries()) {
    const visible = index < visibleBlocks;
    const column = index % columns;
    const row = Math.floor(index / columns);
    world
      .set(entity, Transform, {
        // Keep one fixed 5.2 x 2.6 outer footprint while the sweep changes
        // admitted block count. Active 1.3 x 1.3 planes tile that rectangle
        // edge-to-edge (no area overlap); inactive blocks move out of view.
        pos: visible
          ? [
              (column - (columns - 1) / 2) * 1.3 * tileScaleX,
              (row - (rows - 1) / 2) * 1.3 * tileScaleY,
              0,
            ]
          : [100 + index * 10, 0, 0],
        scale: visible ? [tileScaleX, tileScaleY, 1] : [1, 1, 1],
      })
      .unwrap();
  }
  propagateTransforms(world).unwrap();
}

function timingReport(observed: Awaited<ReturnType<Renderer['observe']>>): CostTiming {
  if (!observed.ok) return { status: 'failed', reason: inspectError(observed.error) };
  const timing = observed.value.timings;
  if (timing === undefined) return { status: 'unavailable', reason: 'timings-not-requested' };
  if (timing.status === 'unavailable') {
    return { status: 'unavailable', reason: timing.reason.code };
  }
  if (timing.status === 'failed') return { status: 'failed', reason: timing.error.code };
  return {
    status: timing.status === 'complete' ? 'measured' : 'partial',
    ...(timing.status === 'complete'
      ? {
          measuredPassNanoseconds: timing.frame.measuredPassNanoseconds,
          passes: timing.frame.passes.flatMap((pass) =>
            pass.status === 'measured'
              ? [{ name: pass.passName, durationNanoseconds: pass.durationNanoseconds }]
              : [],
          ),
        }
      : { reason: timing.reason.code }),
  } as CostTiming;
}

function collectSplitReasons(gpuDriven: GpuDrivenInspection): readonly string[] {
  return Object.freeze(
    [
      ...new Set(gpuDriven.channels.map((channel) => `${channel.viewPass}:${channel.reason}`)),
    ].sort(),
  );
}

function collectResourceClassFacts(
  gpuDriven: GpuDrivenInspection,
): Pick<
  CostSample,
  | 'resourceClassAttribution'
  | 'resourceClassCount'
  | 'resourceClassSplitReasons'
  | 'resourceClassSplits'
> {
  if (
    gpuDriven.resourceClassCount === undefined ||
    gpuDriven.resourceClassSplitReasons === undefined ||
    gpuDriven.resourceClassSplits === undefined
  ) {
    return {
      resourceClassAttribution: 'unavailable',
      resourceClassCount: undefined,
      resourceClassSplitReasons: undefined,
      resourceClassSplits: undefined,
    };
  }
  return {
    resourceClassAttribution: 'measured',
    resourceClassCount: gpuDriven.resourceClassCount,
    resourceClassSplitReasons: gpuDriven.resourceClassSplitReasons,
    resourceClassSplits: gpuDriven.resourceClassSplits,
  };
}

function mainGpuAndResidualDraws(
  channels: ReturnType<Renderer['inspect']>['renderScene']['gpuDriven']['channels'],
): { readonly gpu: number; readonly residual: number } {
  return channels
    .filter((channel) => channel.viewPass === 'main')
    .reduce(
      (totals, channel) => ({
        gpu: totals.gpu + (channel.lane === 'gpu' ? channel.drawCount : 0),
        residual: totals.residual + channel.residualDrawCount,
      }),
      { gpu: 0, residual: 0 },
    );
}

describe('Surface water bounded cost budget', () => {
  let renderer: Renderer | undefined;
  let canvas: BudgetCanvas | undefined;
  let publicationServer:
    | Awaited<ReturnType<typeof startSurfaceMaterialPublicationServer>>
    | undefined;

  afterEach(async () => {
    await renderer?.dispose();
    canvas?.target?.destroy();
    await publicationServer?.close();
    renderer = undefined;
    canvas = undefined;
    publicationServer = undefined;
  }, 120_000);

  it('warms the configured frame window and records bounded coverage/K/resolution cost without fabricating GPU time', async () => {
    publicationServer = await startSurfaceMaterialPublicationServer();
    const manifest = await buildEngineShaderManifest();
    const backend = await loadBackendPack({});
    if (!backend.ok) throw backend.error;
    canvas = createBudgetCanvas(RESOLUTIONS[0] as Resolution);
    const constructed = await constructRuntimeRendererHost(
      canvas,
      {
        rhi: backend.value.rhi,
        gpuPassTiming: GPU_PASS_TIMING_OPTIONS,
      },
      {
        shaderManifestUrl: createShaderManifestUrl(manifest),
        importTransport: createDevImportTransport(publicationServer.binding),
      },
    );
    expect(constructed.ok, constructed.ok ? '' : inspectError(constructed.error)).toBe(true);
    if (!constructed.ok) throw constructed.error;
    renderer = constructed.value.renderer;
    const activeRenderer = renderer;
    const renderErrors: unknown[] = [];
    activeRenderer.subscribe((event) => {
      if (event.kind === 'error') renderErrors.push(event.error);
    });
    const { assets } = constructed.value;
    assets.configureRuntimeBinding(publicationServer.binding);
    const catalogDeadline = Date.now() + 60_000;
    while (!(await assets.refreshCatalog())) {
      if (Date.now() >= catalogDeadline) throw new Error('surface-cost-budget: catalog timeout');
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    const guid = AssetGuid.parse(publicationServer.guid);
    if (!guid.ok) throw guid.error;
    const loaded = await assets.loadByGuid<MaterialAsset>(guid.value);
    expect(loaded.ok, loaded.ok ? '' : inspectError(loaded.error)).toBe(true);
    if (!loaded.ok) throw loaded.error;
    const material = loaded.value;
    const catalogRecord = assets.packIndexCache?.get(publicationServer.guid.toLowerCase());
    expect(catalogRecord).toBeDefined();
    const publicationIdentity = {
      guid: publicationServer.guid,
      packageUrl: catalogRecord?.packageUrl ?? null,
      sourceKey: catalogRecord?.sourceKey ?? null,
      revision: catalogRecord?.revision ?? null,
      publication: catalogRecord?.publication ?? null,
    };

    const world = new World();
    const materials = Array.from({ length: 8 }, () => material);
    const { mediumMembers } = populateSurfaceWorld(world, materials);
    // Query rows are a reused mutable facade. The fixture already publishes
    // the renderer-facing stable member identities, so derive the coverage
    // entity order from that owner rather than retaining query rows.
    const waterEntities = [...new Set(mediumMembers.map((member) => member.entityKey))];
    expect(waterEntities).toHaveLength(8);
    // Every resident medium member is admitted (the GPU culls), so each
    // scenario publishes all ranges; coverage only moves blocks out of view.
    const attached = renderer.attach(world);
    expect(attached.ok, attached.ok ? '' : inspectError(attached.error)).toBe(true);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    const generation = activeRenderer.inspect().frame.deviceGeneration;
    let projectionRevision = 1;
    let frameTime = 0;
    const warmupInput = createBudgetInput(
      material,
      mediumMembers,
      generation,
      2,
      projectionRevision,
    );

    const drawFrame = async (
      input: SurfaceDynamicInputFrame,
      resolution: Resolution,
      captureTiming: boolean,
    ): Promise<CostSample> => {
      canvas.width = resolution.width;
      canvas.height = resolution.height;
      frameTime += 1 / 60;
      activeRenderer.setSurfaceDynamicInput({ ...input, frameTime });
      world.update(1 / 60).unwrap();
      const pendingUpload = input.page.beginUpload();
      if (!pendingUpload.ok) throw pendingUpload.error;
      const started = performance.now();
      const drawn = activeRenderer.draw({
        leases: [lease],
        camera: { lease },
        environment: { lease },
      });
      const cpuSubmitElapsedMs = performance.now() - started;
      if (drawn === undefined || !drawn.ok) {
        throw new Error(
          `surface-cost-budget: draw failed ${inspectError(drawn?.error)} errors=${JSON.stringify(
            renderErrors.map((error) => inspectError(error)),
          )}`,
        );
      }
      const completed = await drawn.value.completed;
      if (!completed.ok) throw completed.error;
      const inspection = activeRenderer.inspect();
      const gpuDriven = inspection.renderScene.gpuDriven;
      const allocation = gpuDriven.resourceAllocation;
      if (allocation === undefined) {
        throw new Error(
          'surface-cost-budget: gpu-driven view allocation inspection unavailable; refusing to fabricate memory bytes',
        );
      }
      const renderGraphAllocation = inspection.renderGraphResourceAllocation;
      if (renderGraphAllocation === undefined) {
        throw new Error(
          'surface-cost-budget: render-graph allocation inspection unavailable; refusing to fabricate owner bytes',
        );
      }
      const mainDraws = mainGpuAndResidualDraws(gpuDriven.channels);
      const timing = captureTiming
        ? timingReport(await activeRenderer.observe(drawn.value, { include: ['timings'] }))
        : { status: 'unavailable' as const, reason: 'capture-not-requested' };
      return {
        coverageWaterBlocks: 0,
        eventK: input.ranges?.[0]?.recordCount ?? 0,
        resolution,
        cpuSubmitElapsedMs,
        gpuPass: timing,
        dirtyUploadBytes: pendingUpload.value.bytes,
        transitionUploadBytes: {
          surfaceDynamicInput: 0,
          sceneTable: 0,
          palette: 0,
          candidate: 0,
          batch: 0,
          viewConstants: 0,
        },
        batchCount: gpuDriven.batchCount,
        resourceHighWater: {
          candidateCapacity: gpuDriven.candidateCapacity,
          batchCapacity: gpuDriven.batchCapacity,
          indirectCapacity: gpuDriven.indirectCapacity,
          allocation: {
            unit: allocation.unit,
            physicalResidency: allocation.physicalResidency,
            liveBytes: allocation.liveBytes,
            pendingRetirementBytes: allocation.pendingRetirementBytes,
            peakBytes: allocation.peakBytes,
            pendingRetirementCount: allocation.pendingRetirementCount,
            failedAllocationRollbacks: allocation.failedAllocationRollbacks,
            failedAllocationRollbackBytes: allocation.failedAllocationRollbackBytes,
          },
          materialRasterAllocation:
            gpuDriven.resourceAllocationOwners?.materialRaster === undefined
              ? undefined
              : {
                  unit: gpuDriven.resourceAllocationOwners.materialRaster.unit,
                  physicalResidency:
                    gpuDriven.resourceAllocationOwners.materialRaster.physicalResidency,
                  liveBytes: gpuDriven.resourceAllocationOwners.materialRaster.liveBytes,
                  pendingRetirementBytes:
                    gpuDriven.resourceAllocationOwners.materialRaster.pendingRetirementBytes,
                  peakBytes: gpuDriven.resourceAllocationOwners.materialRaster.peakBytes,
                  pendingRetirementCount:
                    gpuDriven.resourceAllocationOwners.materialRaster.pendingRetirementCount,
                  failedAllocationRollbacks:
                    gpuDriven.resourceAllocationOwners.materialRaster.failedAllocationRollbacks,
                  failedAllocationRollbackBytes:
                    gpuDriven.resourceAllocationOwners.materialRaster.failedAllocationRollbackBytes,
                },
          renderGraphAllocation: {
            unit: renderGraphAllocation.unit,
            physicalResidency: renderGraphAllocation.physicalResidency,
            liveBytes: renderGraphAllocation.liveBytes,
            pendingRetirementBytes: renderGraphAllocation.pendingRetirementBytes,
            peakBytes: renderGraphAllocation.peakBytes,
            pendingRetirementCount: renderGraphAllocation.pendingRetirementCount,
            failedAllocationRollbacks: renderGraphAllocation.failedAllocationRollbacks,
            failedAllocationRollbackBytes: renderGraphAllocation.failedAllocationRollbackBytes,
            unknownByteSizeCount: renderGraphAllocation.unknownByteSizeCount,
            importedResourceCount: renderGraphAllocation.importedResourceCount,
          },
          unavailableOwners:
            gpuDriven.resourceAllocationOwners?.materialRaster === undefined
              ? ['material-raster']
              : [],
        },
        splitReasons: collectSplitReasons(gpuDriven),
        splitReasonScope: 'view-pass-lane',
        ...collectResourceClassFacts(gpuDriven),
        worldEntitiesScanned: gpuDriven.worldEntitiesScanned,
        validatedGpuOwnedRows: gpuDriven.validatedGpuOwnedRows,
        gpuOwnedEntityCount: gpuDriven.gpuOwnedEntityCount,
        candidateUploadBytes: gpuDriven.candidateUploadBytes,
        batchUploadBytes: gpuDriven.batchUploadBytes,
        viewConstantsUploadBytes: gpuDriven.viewConstantsUploadBytes,
        sceneTableUploadBytes: gpuDriven.sceneTableUploadBytes,
        paletteUploadBytes: gpuDriven.paletteUploadBytes,
        indirectDrawCount: gpuDriven.indirectDrawCount,
        cpuFallbackDrawItems: gpuDriven.cpuFallbackDrawItems,
        mainGpuDrawCount: mainDraws.gpu,
        mainResidualDrawCount: mainDraws.residual,
        surfaceFrameMemberScans: gpuDriven.surfaceFrameMemberScans,
        surfaceFrameRowAllocations: gpuDriven.surfaceFrameRowAllocations,
        topologyRevision: gpuDriven.topologyRevision,
        surfaceFrameRangeBuilds: gpuDriven.surfaceFrameRangeBuilds,
        filteredPlanBuilds: gpuDriven.filteredPlanBuilds,
        stableFrame: false,
        frameIdentity: {
          frameId: drawn.value.frameId,
          deviceGeneration: drawn.value.deviceGeneration,
          graphGeneration: drawn.value.graphGeneration,
          backendId: drawn.value.backendId,
        },
      };
    };

    setWaterCoverage(world, waterEntities, 8);
    for (let frame = 0; frame < WARMUP_FRAMES; frame += 1) {
      const sample = await drawFrame(warmupInput, RESOLUTIONS[0] as Resolution, false);
      if (frame >= WARMUP_FRAMES - 2) {
        expect(sample.dirtyUploadBytes).toBe(0);
        expect(sample.surfaceFrameRangeBuilds).toBeGreaterThan(0);
      }
    }

    const samples: CostSample[] = [];
    const measureScenario = async (
      input: SurfaceDynamicInputFrame,
      blocks: number,
      resolution: Resolution,
      eventK: number,
    ): Promise<void> => {
      setWaterCoverage(world, waterEntities, blocks);
      const transition = await drawFrame(input, resolution, false);
      const stable = await drawFrame(input, resolution, true);
      expect(stable.dirtyUploadBytes).toBe(0);
      expect(stable.surfaceFrameRangeBuilds).toBe(transition.surfaceFrameRangeBuilds);
      expect(stable.surfaceFrameMemberScans).toBe(transition.surfaceFrameMemberScans);
      expect(stable.surfaceFrameRowAllocations).toBe(transition.surfaceFrameRowAllocations);
      // filteredPlanBuilds is a per-frame build delta: a transition may
      // rebuild the filtered plan, while the following stable frame must
      // report zero additional builds.
      expect(stable.filteredPlanBuilds).toBe(0);
      expect(stable.topologyRevision).toBe(transition.topologyRevision);
      expect(stable.resourceClassAttribution).toBe(transition.resourceClassAttribution);
      if (
        stable.resourceClassAttribution === 'measured' &&
        transition.resourceClassAttribution === 'measured'
      ) {
        expect(stable.resourceClassCount).toBe(transition.resourceClassCount);
        expect(stable.resourceClassSplitReasons).toEqual(transition.resourceClassSplitReasons);
        expect(stable.resourceClassSplits).toEqual(transition.resourceClassSplits);
      }
      samples.push({
        ...stable,
        transitionUploadBytes: {
          surfaceDynamicInput: transition.dirtyUploadBytes,
          sceneTable: transition.sceneTableUploadBytes,
          palette: transition.paletteUploadBytes,
          candidate: transition.candidateUploadBytes,
          batch: transition.batchUploadBytes,
          viewConstants: transition.viewConstantsUploadBytes,
        },
        coverageWaterBlocks: blocks,
        eventK,
        resolution,
        stableFrame:
          stable.dirtyUploadBytes === 0 &&
          stable.surfaceFrameRangeBuilds === transition.surfaceFrameRangeBuilds &&
          stable.surfaceFrameMemberScans === transition.surfaceFrameMemberScans &&
          stable.surfaceFrameRowAllocations === transition.surfaceFrameRowAllocations &&
          stable.filteredPlanBuilds === 0 &&
          stable.topologyRevision === transition.topologyRevision &&
          stable.resourceClassAttribution === transition.resourceClassAttribution &&
          (stable.resourceClassAttribution === 'unavailable' ||
            (stable.resourceClassCount === transition.resourceClassCount &&
              JSON.stringify(stable.resourceClassSplitReasons) ===
                JSON.stringify(transition.resourceClassSplitReasons) &&
              JSON.stringify(stable.resourceClassSplits) ===
                JSON.stringify(transition.resourceClassSplits))),
      });
    };

    for (const blocks of WATER_BLOCK_COUNTS) {
      projectionRevision += 1;
      const input = createBudgetInput(material, mediumMembers, generation, 2, projectionRevision);
      await measureScenario(input, blocks, RESOLUTIONS[0] as Resolution, 2);
    }
    for (const eventK of EVENT_K_VALUES) {
      projectionRevision += 1;
      const input = createBudgetInput(
        material,
        mediumMembers,
        generation,
        eventK,
        projectionRevision,
      );
      await measureScenario(input, 4, RESOLUTIONS[0] as Resolution, eventK);
    }
    projectionRevision += 1;
    const resolutionInput = createBudgetInput(
      material,
      mediumMembers,
      generation,
      2,
      projectionRevision,
    );
    await measureScenario(resolutionInput, 4, RESOLUTIONS[1] as Resolution, 2);

    expect(samples).toHaveLength(WATER_BLOCK_COUNTS.length + EVENT_K_VALUES.length + 1);
    expect(samples.every((sample) => sample.dirtyUploadBytes === 0)).toBe(true);
    expect(samples.every((sample) => sample.stableFrame)).toBe(true);
    expect(samples.every((sample) => sample.batchCount > 0)).toBe(true);
    expect(samples.every((sample) => sample.resourceHighWater.indirectCapacity > 0)).toBe(true);
    expect(samples.every((sample) => sample.resourceHighWater.allocation.peakBytes > 0)).toBe(true);
    expect(
      samples.every(
        (sample) =>
          sample.resourceHighWater.allocation.peakBytes >=
          sample.resourceHighWater.allocation.liveBytes +
            sample.resourceHighWater.allocation.pendingRetirementBytes,
      ),
    ).toBe(true);
    expect(
      samples.every(
        (sample) => sample.resourceHighWater.allocation.unit === 'engine-allocation-bytes',
      ),
    ).toBe(true);
    expect(
      samples.every(
        (sample) => sample.resourceHighWater.allocation.physicalResidency === 'unknown',
      ),
    ).toBe(true);
    expect(
      samples.every((sample) =>
        sample.resourceHighWater.unavailableOwners.every((owner) => owner === 'material-raster'),
      ),
    ).toBe(true);
    const materialRasterSamples = samples.filter(
      (sample) => sample.resourceHighWater.materialRasterAllocation !== undefined,
    );
    expect(
      materialRasterSamples.every(
        (sample) =>
          sample.resourceHighWater.materialRasterAllocation?.unit === 'engine-allocation-bytes' &&
          sample.resourceHighWater.materialRasterAllocation.physicalResidency === 'unknown',
      ),
    ).toBe(true);
    expect(
      samples.every(
        (sample) =>
          sample.resourceHighWater.renderGraphAllocation.unit === 'engine-allocation-bytes' &&
          sample.resourceHighWater.renderGraphAllocation.physicalResidency === 'unknown' &&
          sample.resourceHighWater.renderGraphAllocation.importedResourceCount >= 0,
      ),
    ).toBe(true);
    expect(samples.every((sample) => sample.worldEntitiesScanned === 0)).toBe(true);
    expect(samples.every((sample) => sample.indirectDrawCount > 0)).toBe(true);
    expect(samples.every((sample) => sample.gpuOwnedEntityCount > 0)).toBe(true);
    expect(samples.every((sample) => sample.mainGpuDrawCount > 0)).toBe(true);
    expect(samples.every((sample) => sample.mainResidualDrawCount === 0)).toBe(true);
    expect(samples.every((sample) => sample.cpuFallbackDrawItems === 0)).toBe(true);
    expect(
      samples.every((sample) => sample.validatedGpuOwnedRows <= sample.gpuOwnedEntityCount),
    ).toBe(true);
    expect(samples.every((sample) => sample.splitReasonScope === 'view-pass-lane')).toBe(true);
    const measuredResourceClassSamples = samples.filter(
      (sample) => sample.resourceClassAttribution === 'measured',
    );
    expect(measuredResourceClassSamples).toHaveLength(samples.length);
    // Coverage, K, and resolution change the dynamic ranges but retain one
    // resource identity in this fixture. A second batch for the same identity
    // would indicate range/page data leaked into resource-class partitioning.
    expect(measuredResourceClassSamples.every((sample) => sample.resourceClassCount === 1)).toBe(
      true,
    );
    expect(
      measuredResourceClassSamples.every((sample) => {
        const identities = new Set(
          (sample.resourceClassSplits ?? []).map((split) => split.resourceIdentity),
        );
        return identities.size === sample.resourceClassCount;
      }),
    ).toBe(true);
    expect(samples.every((sample) => sample.transitionUploadBytes.surfaceDynamicInput > 0)).toBe(
      true,
    );
    // The RHI capability is the only authority for GPU pass time. A Dawn
    // adapter without timestamp-query yields a structured unavailable value;
    // this test never substitutes CPU wall time as a GPU measurement.
    const timestampCapability = activeRenderer.inspect().capabilities;
    if (
      !timestampCapability.timestampQuery ||
      timestampCapability.timestampPeriodNanoseconds === null
    ) {
      expect(samples.every((sample) => sample.gpuPass.status === 'unavailable')).toBe(true);
    } else {
      expect(samples.every((sample) => sample.gpuPass.status === 'measured')).toBe(true);
    }
    const resourceClassVariation = measuredResourceClassSamples.some(
      (sample) => (sample.resourceClassSplitReasons?.length ?? 0) > 0,
    )
      ? 'measured-split'
      : 'unknown-no-resource-class-change-fixture';
    // biome-ignore lint/suspicious/noConsole: bounded cost receipt is the verification artifact.
    console.log(
      JSON.stringify({
        kind: 'surface-water-cost-budget',
        sourceSha: EVIDENCE_SOURCE_SHA,
        buildId: EVIDENCE_BUILD_ID,
        backend: activeRenderer.inspect().capabilities.backendKind,
        source: 'runtime-water-fixture',
        publicationIdentity,
        resourceHighWaterScope: {
          capacities: 'candidate/batch/indirect logical capacities',
          allocationBytes: {
            unit: 'engine-allocation-bytes',
            physicalResidency: 'unknown',
            measuredOwners: [
              'gpu-driven-view',
              ...(materialRasterSamples.length === samples.length ? ['material-raster'] : []),
              'render-graph',
            ],
            unavailableOwners: [
              ...(materialRasterSamples.length === samples.length ? [] : ['material-raster']),
            ],
            fields: [
              'liveBytes',
              'pendingRetirementBytes',
              'peakBytes',
              'failedAllocationRollbacks',
            ],
          },
          uploadBytes: 'transition and stable per-frame owner counters',
          splitReasons: 'gpuDriven resourceIdentity attribution',
        },
        warmupFrames: WARMUP_FRAMES,
        timestampQuery: timestampCapability.timestampQuery,
        timestampPeriodNanoseconds: timestampCapability.timestampPeriodNanoseconds,
        stableFrameContract: {
          dirtyUploadBytes: 0,
          repeatedSurfaceFrameRangeBuilds: false,
          repeatedFilteredPlanBuilds: false,
          repeatedTopologyRevision: false,
        },
        resourceClassVariation,
        sweeps: {
          coverageWaterBlocks: WATER_BLOCK_COUNTS,
          eventK: EVENT_K_VALUES,
          resolutions: RESOLUTIONS,
        },
        samples,
      }),
    );
  }, 300_000);
});
