import type { BoundRenderGraphResources } from '@forgeax/engine-render-graph';
import { type Buffer, err, ok, type Result, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { GpuDrivenPreparationError } from '../errors/gpu-driven';
import type { InstalledFrameGraph } from '../record/frame-snapshot';
import type { PipelineState } from '../record/render-context';
import type { RenderPipelineGpuDrivenSourcePreparation } from '../render-pipeline';
import { MaterialFrame } from '../scene/material-dispatch';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { GpuDrivenBatch } from './batch-topology';
import type { LiveRasterBatch } from './live-raster';
import type { PreparedRasterPassCache } from './prepared-raster-bundle';
import type {
  GpuDrivenGraphProjection,
  GpuDrivenMaterialBinding,
  GpuDrivenPrepareInput,
  PreparedGpuDrivenFrame,
} from './production-raster';
import type {
  PipelinePreparationJob,
  ProjectedRasterGraph,
  RasterProjectionFrame,
} from './production-raster-frame';
import type { MaterialAbiRasterAdapter } from './production-raster-material';
import {
  assembleFilteredGroups,
  type FilteredProductionPlan,
  type PreparedBatch,
} from './production-raster-prepare';
import {
  captureShadowBatchFacts,
  createShadowBatchProjection,
  type GpuDrivenShadowBatchProjection,
  type ShadowBatchFacts,
  type ShadowBatchProjections,
  sameShadowBatchProjection,
} from './production-raster-shadow';
import { isSkinPreparedBatch, requiresGpuSurfacePreparation } from './production-raster-support';
import { type ShadowViewIdentity, shadowViewIdentityKey } from './shadow-views';
import { prepareSourceRasterBundles, type SourceRasterPassBindings } from './source-raster-bundles';
import type { GpuDrivenView } from './view-gpu';

export function prospectiveMainRaster(
  input: GpuDrivenPrepareInput,
  filtered: FilteredProductionPlan,
): FilteredProductionPlan {
  if (
    input.geometryLane !== 'direct' ||
    requiresGpuSurfacePreparation(input) ||
    !filtered.batches.some(isSkinPreparedBatch)
  )
    return filtered;
  // Ordinary direct draws already own Skin demand. Preparing a rigid Source
  // must not require a GPU Skin task from a View that does not submit one.
  return assembleFilteredGroups(
    filtered.plan,
    filtered.batches.filter((batch) => !isSkinPreparedBatch(batch)),
    [...filtered.plan.batches].filter((batch) => batch.prepared?.identity.deformation !== 'skin'),
  );
}

export interface SourceShadowRow {
  readonly view: GpuDrivenView;
  readonly identity: ShadowViewIdentity;
  readonly batch: GpuDrivenBatch;
  readonly projection: GpuDrivenShadowBatchProjection;
  readonly isCurrent: () => boolean;
}

/** Actual Source-native demand; independent of ordinary execution and its resource read. */
export interface NativeMainGraphPreparation {
  readonly projection: GpuDrivenGraphProjection;
  readonly materials: MaterialFrame;
  readonly materialBindings: readonly GpuDrivenMaterialBinding[];
  readonly materialBuffer: Buffer;
  isCurrent(): boolean;
  attachPassResources(
    resources: BoundRenderGraphResources,
    prepare: InstalledFrameGraph['prepareGpuDrivenSource'],
  ): Generator<void, Result<void, RhiError>>;
  pipelineRequests(): Result<Iterable<() => boolean>, RhiError>;
  prepareBundles(input: SourceRasterPassBindings): Generator<void, Result<void, RhiError>>;
  shadowRows(): Generator<void, readonly SourceShadowRow[]>;
  holdShadow(row: SourceShadowRow, receipt: () => boolean): void;
  retain(): () => void;
}

/** Prospective frames issued by this Production, consumed by its actual graph projection. */
export class SourceRasterPreparations {
  constructor(
    private readonly device: RhiDevice,
    private readonly passes: PreparedRasterPassCache,
  ) {}
  clear(): void {
    this.held.clear();
    this.retained.clear();
  }
  private readonly held = new Map<
    number,
    Map<
      GpuDrivenGraphProjection,
      {
        readonly frame: RasterProjectionFrame;
        readonly live: LiveRasterBatch;
        readonly current: () => boolean;
        readonly rigid: object;
        readonly skin: object | undefined;
      }
    >
  >();
  private readonly retained = new Map<
    GpuDrivenGraphProjection,
    {
      readonly frame: RasterProjectionFrame;
      readonly current: () => boolean;
    }
  >();

  keepsEmptyView(
    view: GpuDrivenView | undefined,
    raster: MaterialAbiRasterAdapter | undefined,
  ): boolean {
    for (const demand of this.retained.values())
      if (demand.frame.view === view && demand.frame.materialRaster === raster && demand.current())
        return true;
    return false;
  }

  private readonly issued = new WeakMap<
    GpuDrivenGraphProjection,
    {
      readonly frame: RasterProjectionFrame;
      readonly current: () => boolean;
      readonly heldCurrent: () => boolean;
      readonly receipts: (() => boolean)[];
      readonly shadows: Map<Buffer, Map<number, SourceShadowRow>>;
    }
  >();

  issue(
    projection: GpuDrivenGraphProjection,
    frame: RasterProjectionFrame,
    current: () => boolean,
    heldCurrent: () => boolean,
  ): void {
    this.issued.set(projection, { frame, current, heldCurrent, receipts: [], shadows: new Map() });
  }

  isCurrent(projection: GpuDrivenGraphProjection): boolean {
    const demand = this.issued.get(projection);
    return demand?.heldCurrent() === true && demand.receipts.every((receipt) => receipt());
  }

  retain(projection: GpuDrivenGraphProjection): () => void {
    const demand = this.issued.get(projection);
    if (demand === undefined || !demand.current() || !demand.receipts.every((receipt) => receipt()))
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'current completed native Source command owners',
        hint: 'finish actual Pass preparation before retaining it',
      });
    const { frame } = demand;
    const retained = { frame, current: demand.heldCurrent };
    this.retained.set(projection, retained);
    const rows = frame.liveRasterBatches.map((live) => {
      let entries = this.held.get(live.batch.batchId);
      if (entries === undefined) {
        entries = new Map();
        this.held.set(live.batch.batchId, entries);
      }
      const entry = {
        frame,
        live,
        current: () => this.isCurrent(projection),
        rigid: frame.materialRaster.visibleBindingIdentity,
        skin: frame.skinRaster?.visibleBindingIdentity,
      };
      entries.set(projection, entry);
      return { id: live.batch.batchId, entries, entry };
    });
    return () => {
      if (this.retained.get(projection) === retained) this.retained.delete(projection);
      for (const { id, entries, entry } of rows) {
        if (entries.get(projection) === entry) entries.delete(projection);
        if (entries.size === 0 && this.held.get(id) === entries) this.held.delete(id);
      }
    };
  }

  borrow(
    prepared: PreparedBatch,
    visible: Buffer,
    rigid: object,
    skin: object | undefined,
  ): LiveRasterBatch | undefined {
    for (const entry of this.held.get(prepared.batch.batchId)?.values() ?? [])
      if (
        entry.live.batch.generation === prepared.batch.generation &&
        entry.frame.view.visibleBuffer === visible &&
        entry.rigid === rigid &&
        entry.skin === skin &&
        entry.current()
      )
        return entry.live;
    return undefined;
  }

  holdShadow(
    projection: GpuDrivenGraphProjection,
    row: SourceShadowRow,
    receipt: () => boolean,
  ): void {
    const demand = this.issued.get(projection),
      visible = row.view.visibleBuffer;
    if (
      demand === undefined ||
      visible === undefined ||
      !demand.current() ||
      !row.isCurrent() ||
      !receipt()
    )
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'current native shadow command receipt',
        hint: 'prepare its actual View and resources before retaining',
      });
    let rows = demand.shadows.get(visible);
    if (rows === undefined) {
      rows = new Map();
      demand.shadows.set(visible, rows);
    }
    rows.set(row.batch.batchId, row);
    demand.receipts.push(() => row.isCurrent() && receipt());
  }

  borrowShadow(
    visible: Buffer,
    batch: GpuDrivenBatch,
    facts: ShadowBatchFacts,
  ): GpuDrivenShadowBatchProjection | undefined {
    for (const [projection, held] of this.retained) {
      const row = this.issued.get(projection)?.shadows.get(visible)?.get(batch.batchId);
      if (
        row !== undefined &&
        held.current() &&
        sameShadowBatchProjection(row.batch, batch, row.projection, facts)
      )
        return row.projection;
    }
    return undefined;
  }

  *prepare(
    projection: GpuDrivenGraphProjection,
    projected: ProjectedRasterGraph,
    jobs: ReadonlyMap<string, PipelinePreparationJob>,
    graphCurrent: () => boolean,
    project: (live: LiveRasterBatch, frame: RasterProjectionFrame) => boolean,
  ): Generator<void, Result<RenderPipelineGpuDrivenSourcePreparation, RhiError>> {
    const demand = this.issued.get(projection);
    const invalid = () =>
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'the actual graph and a current prospective frame from its Production',
          hint: 'prepare the exact original Pass demand before adopting the Source',
        }),
      );
    if (
      demand === undefined ||
      !projected.target.rendererRecording ||
      projected.frame.view !== demand.frame.view ||
      projected.frame.materialRaster !== demand.frame.materialRaster ||
      jobs.size === 0
    )
      return invalid();
    const { frame, receipts } = demand;
    const current = () => graphCurrent() && demand.current() && graphCurrent();
    if (!current()) return invalid();
    const device = this.device,
      passes = this.passes;
    for (const live of frame.liveRasterBatches) {
      if (!current()) return invalid();
      if (!projected.rasterClasses.has(live.recordingClassKey) && !project(live, frame))
        return invalid();
      yield;
    }
    if (!current()) return invalid();
    return ok(
      Object.freeze({
        isCurrent: current,
        *pipelineRequests() {
          for (const job of jobs.values()) yield* job.sourceRequests(frame.liveRasterBatches);
        },
        prepareBundles: (input: SourceRasterPassBindings) =>
          prepareSourceRasterBundles(frame, projected, device, passes, input, current, receipts),
      }),
    );
  }
}

interface NativeMainHost {
  owns(view: GpuDrivenView): boolean;
  available(): boolean;
  raster(): MaterialAbiRasterAdapter | undefined;
  shadows(): ReadonlyMap<string, ShadowBatchProjections>;
  prepare(
    scene: PersistentGpuDrivenState,
    pipeline: PipelineState,
    visible: Buffer,
    current: () => boolean,
  ): Result<RasterProjectionFrame, RhiError | GpuDrivenPreparationError>;
  signatures(
    frame: RasterProjectionFrame,
  ): Pick<
    GpuDrivenGraphProjection,
    'topologySignature' | '_recordingTopologySignature' | 'cameraRasterIdentity'
  >;
  projectCamera(
    frame: RasterProjectionFrame,
    target: Parameters<NonNullable<PreparedGpuDrivenFrame['projectCamera']>>[0],
  ): ReturnType<NonNullable<PreparedGpuDrivenFrame['projectCamera']>>;
  project(
    frame: RasterProjectionFrame,
    args: Parameters<PreparedGpuDrivenFrame['project']>,
  ): ReturnType<PreparedGpuDrivenFrame['project']>;
}

/** Source-native construction delegates execution state and read custody to the original Production. */
export function prepareNativeMainGraph(
  preparations: SourceRasterPreparations,
  input: GpuDrivenPrepareInput,
  view: GpuDrivenView,
  current: () => boolean,
  host: NativeMainHost,
): Result<NativeMainGraphPreparation, RhiError | GpuDrivenPreparationError> {
  const invalid = () =>
    err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'the original prepared View and prospective main raster demand',
        hint: 'reprepare the current Source without recording it',
      }),
    );
  const owned = () => host.owns(view);
  const live = () => owned() && current() && owned();
  if (!host.available() || !live()) return invalid();
  const scene = input.scene,
    pipeline = input.materialPipelineState,
    visible = view.visibleBuffer;
  if (scene === undefined || pipeline === undefined || visible === undefined) return invalid();
  const prepared = host.prepare(scene, pipeline, visible, live);
  if (!prepared.ok) return prepared;
  if (!live()) return invalid();
  const frame = prepared.value;
  const table = scene.scene.tableBindingIdentity;
  const rigidBindings = frame.materialRaster.visibleBindingIdentity;
  const skinBindings = frame.skinRaster?.visibleBindingIdentity;
  const physicalCurrent = () =>
    owned() &&
    scene.scene.live &&
    scene.scene.tableBindingIdentity === table &&
    view.visibleBuffer === visible &&
    host.raster() === frame.materialRaster &&
    frame.materialRaster.visibleBindingIdentity === rigidBindings &&
    frame.skinRaster?.visibleBindingIdentity === skinBindings;
  const isCurrent = () => live() && physicalCurrent();
  let attached: RenderPipelineGpuDrivenSourcePreparation | undefined;
  const projection: GpuDrivenGraphProjection = Object.freeze({
    ...host.signatures(frame),
    projectCamera: (target) => host.projectCamera(frame, target),
    projectShadow: (builder, identity, _force, pyramid) =>
      frame.shadowViewPool.projectSource(builder, identity, scene.scene, pyramid),
    shadowViewPool: frame.shadowViewPool,
    project: (...args: Parameters<PreparedGpuDrivenFrame['project']>) => {
      if (!isCurrent()) return invalid();
      const result = host.project(frame, args);
      return isCurrent() ? result : invalid();
    },
  });
  preparations.issue(projection, frame, isCurrent, physicalCurrent);
  const pipelineRequests = () =>
    attached === undefined || !isCurrent() || !attached.isCurrent()
      ? invalid()
      : ok(attached.pipelineRequests());
  let materials = input.materialFrame ?? new MaterialFrame(undefined);
  for (const binding of frame.filtered.materialBindings)
    materials = materials.with(binding.material);
  return isCurrent()
    ? ok(
        Object.freeze({
          projection,
          materials,
          materialBindings: frame.filtered.materialBindings,
          materialBuffer: scene.scene.materialBuffer,
          isCurrent: () => physicalCurrent() && preparations.isCurrent(projection),
          *attachPassResources(
            resources: BoundRenderGraphResources,
            prepare: InstalledFrameGraph['prepareGpuDrivenSource'],
          ) {
            if (!isCurrent() || resources.isRetired()) return invalid();
            const work = prepare?.(projection, () => !resources.isRetired());
            if (work === undefined) return invalid();
            const result = yield* work;
            if (!result.ok) return result;
            if (!isCurrent() || resources.isRetired() || !result.value.isCurrent())
              return invalid();
            attached = result.value;
            return ok(undefined);
          },
          pipelineRequests,
          retain: () => preparations.retain(projection),
          shadowRows: () =>
            prepareSourceShadowRows(frame, host.shadows(), isCurrent, physicalCurrent),
          holdShadow: (row: SourceShadowRow, receipt: () => boolean) =>
            preparations.holdShadow(projection, row, receipt),
          prepareBundles: function* (
            bindings: import('./source-raster-bundles').SourceRasterPassBindings,
          ) {
            if (attached === undefined || !isCurrent()) return invalid();
            return yield* attached.prepareBundles(bindings);
          },
        }),
      )
    : invalid();
}

function* prepareSourceShadowRows(
  frame: RasterProjectionFrame,
  existing: ReadonlyMap<string, ShadowBatchProjections>,
  current: () => boolean,
  physicalCurrent: () => boolean,
): Generator<void, readonly SourceShadowRow[]> {
  const filtered = frame.shadowFiltered;
  if (filtered === undefined) return [];
  const rows: SourceShadowRow[] = [];
  const pass = {
    filtered,
    preparedByBatch: undefined,
    executions: frame.input.batchExecutions,
    materialRaster: frame.materialRaster,
  };
  const meshBinding = frame.materialRaster.primitiveBindGroup().unwrap();
  for (const scope of frame.shadowViewPool.sourceViews(frame.scene.scene)) {
    const visible = scope.view.visibleBuffer;
    if (visible === undefined)
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'native shadow View storage',
        hint: 'prepare its real capacity first',
      });
    const live = () => current() && scope.isCurrent() && scope.view.visibleBuffer === visible;
    const layer = frame.shadowViewPool.sourceLayerPlan(
      scope.identity,
      filtered.plan,
      frame.scene.scene,
    );
    if (layer === undefined)
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'the prepared Source shadow layer and filtered topology',
        hint: 'reprepare the original per-view shadow layer',
      });
    const skinTask = scope.view.skinTaskBinding();
    const skinMeshBinding =
      skinTask === undefined ? undefined : frame.skinRaster?.primitiveBindGroup(skinTask).unwrap();
    for (const batch of layer.batches) {
      if (batch.visibleCapacity === 0) continue;
      if (!live())
        throw new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'unchanged prospective shadow rows',
          hint: 'retry the original Source',
        });
      const facts = captureShadowBatchFacts(
        pass,
        batch,
        { visibleBuffer: visible, meshBinding, skinMeshBinding },
        frame.skinRaster,
      ).unwrap();
      const old = existing.get(shadowViewIdentityKey(scope.identity))?.get(batch.batchId);
      // Live recording can replace a pass variant while the hidden Source waits
      // for its selection frame. Let each owner retain its own variant.
      const projection = createShadowBatchProjection(
        batch,
        facts,
        visible,
        old?.bundles.fork(),
      ).unwrap();
      rows.push({
        ...scope,
        batch,
        projection,
        isCurrent: () =>
          physicalCurrent() && scope.isCurrent() && scope.view.visibleBuffer === visible,
      });
      yield;
    }
  }
  return rows;
}
