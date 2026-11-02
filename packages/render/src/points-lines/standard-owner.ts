import {
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexLayoutProjection,
} from '@forgeax/engine-geometry';
import { err, ok } from '@forgeax/engine-rhi';
import type { AssetHandle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { PointShapeValue, PointSizeUnitsValue } from '../components/points';
import { ResidencyLifetime } from '../device/residency-lifetime';
import { PointsLinesMaterialUnsupportedError } from '../errors/render';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import type { RenderResourceScope } from '../publication/resource-scope';
import { renderAssetRevision } from '../publication/resource-scope';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import type { PointsLinesRecordSubmission, RenderSystemInternals } from '../record/render-context';
import type { RenderableSnapshot } from '../render-system-extract';
import { type FrameList, sparseRowsOf } from '../scene/frame-list';
import { admitPointsLines } from './admission';
import { PointsLinesExpansionCache, pointsLinesSourceSlot } from './expansion-cache';
import type { PointsLinesInspection, PointsLinesSourceError } from './inspection';
import { inspectPointsLines } from './inspection';
import {
  createPointsLinesLanePreparationAdapter,
  type PointsLinesLanePreparationAdapter,
} from './prepare';
import {
  createPointsLinesLaneAdapter,
  type PointsLinesBackend,
  type PointsLinesLane,
} from './record';
import type { PointsLinesPreparedSnapshot } from './snapshot';

type PointsLinesGpuResources = {
  readonly lifetime: ResidencyLifetime;
  readonly vertexBuffer: import('@forgeax/engine-rhi').Buffer;
  readonly indexBuffer: import('@forgeax/engine-rhi').Buffer;
};
type PointsLinesPreparationAdapter = PointsLinesLanePreparationAdapter<PointsLinesGpuResources>;

/** One Points/Lines row a view prepared in RenderPrepare; `submission` is undefined for a refused row. */
export interface PreparedPointsLines {
  readonly submission: PointsLinesRecordSubmission | undefined;
  /** The row's dense address in the view's Points/Lines parameter buffer, below the outcome's `slots`. */
  readonly slot: number;
  /** True once the row's mesh or material changed since it was prepared. */
  stale(): boolean;
}

/** The view's Points/Lines preparation of one Renderer frame, or the cause it recovers from. */
export type PointsLinesFrameOutcome =
  | {
      readonly ok: true;
      readonly rows: ReadonlyMap<string, PreparedPointsLines>;
      /** The parameter-buffer slots the prepared rows address; the view buffer grows to hold them. */
      readonly slots: number;
    }
  | { readonly ok: false; readonly cause: unknown };

/** The identity a prepared row is taken by. */
export function pointsLinesRowKey(
  source: Pick<RenderableSnapshot, 'worldId' | 'entityKey'>,
): string {
  return `${source.worldId}:${source.entityKey}`;
}

/**
 * The Standard renderer's single Points/Lines prepare owner.
 *
 * The retained snapshot is the identity boundary; this owner only resolves
 * the source assets, runs admission, and publishes the existing preparation
 * and record contracts to the main geometry loop. The expansion cache is
 * shared across lanes and this owner keeps the one prepared vertex/index
 * resource pair for each retained identity.
 */
export class StandardPointsLinesOwner {
  private readonly cache = new PointsLinesExpansionCache();
  private readonly preparations = new Map<string, PointsLinesPreparationAdapter>();
  private readonly retiring = new Set<PointsLinesPreparationAdapter>();
  /** What this view's current attempt prepared; promoted by `commit`, dropped by `discard`. */
  private pending = new Map<string, PointsLinesInspection>();
  private published = new Map<string, PointsLinesInspection>();
  private readonly layoutProjection = deriveVertexLayoutProjection(DEFAULT_VERTEX_ATTRIBUTE_MAP);
  /** The RenderPrepare outcome of the Renderer frame it names; recording takes it. */
  private frameOutcome: { frame: number; outcome: PointsLinesFrameOutcome } | undefined;

  constructor(private readonly internals: RenderSystemInternals) {}

  /**
   * Admit and upload every Points/Lines row of the view's frame for one lane;
   * never throws. Refusals are rows without a submission and publish their
   * inspection; any other failure is the outcome's cause.
   */
  prepareFrame(
    rows: FrameList<RenderableSnapshot>,
    scopeOf: (worldId: number) => RenderResourceScope,
    clustered: boolean,
  ): PointsLinesFrameOutcome {
    try {
      // This frame's attempt observes only what it prepares here.
      this.pending = new Map();
      const prepared = new Map<string, PreparedPointsLines>();
      for (const source of sparseRowsOf(rows, 'pointsLines')) {
        const points = source.pointsLines;
        // Every retained row is prepared: the camera cull is a draw-time predicate, and a
        // capture pass admits rows without it.
        if (points === undefined) continue;
        const world = scopeOf(source.worldId);
        const mesh = renderAssetRevision(world, points.meshHandle) ?? 0;
        const material = renderAssetRevision(world, points.materialHandle) ?? 0;
        prepared.set(pointsLinesRowKey(source), {
          submission: this.prepare({ source, world }, clustered),
          slot: prepared.size,
          stale: () =>
            (renderAssetRevision(world, points.meshHandle) ?? 0) !== mesh ||
            (renderAssetRevision(world, points.materialHandle) ?? 0) !== material,
        });
      }
      return { ok: true, rows: prepared, slots: prepared.size };
    } catch (cause) {
      return { ok: false, cause };
    }
  }

  /** Keep the outcome `prepareFrame` produced for the Renderer frame `frame`. */
  stage(frame: number, outcome: PointsLinesFrameOutcome): void {
    this.frameOutcome = { frame, outcome };
  }

  /** Drop the staged outcome once the Renderer frame is over. */
  settle(): void {
    this.frameOutcome = undefined;
  }

  /** The outcome staged for `frame`; undefined when no preparation ran for it. */
  stagedOutcome(frame: number): PointsLinesFrameOutcome | undefined {
    return this.frameOutcome?.frame === frame ? this.frameOutcome.outcome : undefined;
  }

  prepare(
    entry: Pick<ValidatedRenderable, 'source' | 'world'>,
    clustered: boolean,
  ): PointsLinesRecordSubmission | undefined {
    return this.prepareWithMaps(entry, clustered, this.internals, this.preparations, this.pending);
  }

  private prepareWithMaps(
    entry: Pick<ValidatedRenderable, 'source' | 'world'>,
    clustered: boolean,
    runtime: RenderSystemInternals,
    preparations: Map<string, PointsLinesPreparationAdapter>,
    inspections: Map<string, PointsLinesInspection>,
  ): PointsLinesRecordSubmission | undefined {
    const source = entry.source.pointsLines;
    if (source === undefined || source.component === undefined || entry.world === undefined) {
      return undefined;
    }
    const snapshot: PointsLinesPreparedSnapshot = {
      ...source,
      meshGeneration: renderAssetRevision(entry.world, source.meshHandle) ?? 0,
      materialGeneration: renderAssetRevision(entry.world, source.materialHandle) ?? 0,
    };
    const key = `${snapshot.worldId}:${snapshot.entityKey}`;
    const backend = this.backend(runtime);
    const lane = backend === 'wgpu-webgl2' ? 'cpu-webgl2' : clustered ? 'clustered' : 'direct';
    const meshResult = entry.world.resolveAsset<MeshAsset>(
      entry.source.assetHandle as AssetHandle<'mesh'>,
    );
    const materialResult = entry.world.resolveAsset<MaterialAsset>(
      snapshot.materialHandle as AssetHandle<'material'>,
    );
    if (!meshResult.ok || !materialResult.ok) {
      this.publishRefusal(
        inspections,
        snapshot,
        new PointsLinesMaterialUnsupportedError({
          entity: snapshot.entityKey,
          material: 'unresolved',
          pass: 'forward',
          module: 'asset-resolution',
          reason: 'source MeshAsset or MaterialAsset could not be resolved',
        }),
      );
      return undefined;
    }
    const admission = admitPointsLines({
      entity: snapshot.entityKey,
      mesh: meshResult.value,
      material: materialResult.value,
      ...(snapshot.style?.kind === 'points'
        ? {
            points: {
              size: snapshot.style.size,
              sizeUnits: PointSizeUnitsValue[snapshot.style.sizeUnits],
              shape: PointShapeValue[snapshot.style.shape],
            },
          }
        : { lines: snapshot.style ?? {} }),
    });
    if (!admission.ok) {
      this.publishRefusal(inspections, snapshot, admission.error);
      return undefined;
    }
    const topology =
      meshResult.value.submeshes[admission.value.submeshes[0] ?? 0]?.topology === 'line-strip'
        ? 'line-strip'
        : snapshot.component === 'Points'
          ? 'point-list'
          : 'line-list';
    const geometryKey = this.cache.getOrCreate(snapshot, meshResult.value).key;
    // One preparation per source slot: a newer generation rewrites its buffers.
    const prepKey = `${pointsLinesSourceSlot(snapshot)}:${lane}:${backend}`;
    let preparation = preparations.get(prepKey);
    if (preparation === undefined) {
      preparation = this.createPreparation(runtime, geometryKey, lane, backend);
      preparations.set(prepKey, preparation);
      if (preparations === this.preparations && preparations.size > 256) {
        const oldest = preparations.entries().next().value;
        if (oldest !== undefined) {
          preparations.delete(oldest[0]);
          this.retiring.add(oldest[1]);
        }
      }
    } else {
      preparations.delete(prepKey);
      preparations.set(prepKey, preparation);
    }
    const prepared = preparation.prepare(snapshot, meshResult.value);
    if (!prepared.ok) {
      const lkg = preparation.lastKnownGood();
      if (lkg !== undefined) {
        const lkgPlan = createPointsLinesLaneAdapter(lane, backend).createRecordPlan(
          lkg.snapshot,
          lkg.geometry,
        );
        const state = preparation.inspect();
        inspections.set(
          key,
          inspectPointsLines({
            snapshot,
            topology,
            lane,
            pointCount: lkg.geometry.pointCount,
            segmentCount: lkg.geometry.segmentCount,
            sourceBytes: lkg.geometry.sourceBytes,
            derivedBytes: lkg.geometry.derivedBytes,
            cache: { hit: true, rebuilds: state.rebuilds, evictions: 0 },
            drawCount: lkgPlan.drawCount,
            uploadBytes: 0,
            lastKnownGood: true,
            refusal: {
              code: prepared.error.code,
              expected: prepared.error.expected,
              hint: prepared.error.hint,
              detail: prepared.error.detail,
              generation: prepared.error.detail.generation,
              lastKnownGood: true,
            },
          }),
        );
        return {
          plan: lkgPlan,
          vertexBuffer: lkg.resource.vertexBuffer,
          indexBuffer: lkg.resource.indexBuffer,
          layoutProjection: this.layoutProjection,
        };
      }
      this.publishRefusal(inspections, snapshot, prepared.error);
      return undefined;
    }
    const plan = createPointsLinesLaneAdapter(lane, backend).createRecordPlan(
      snapshot,
      prepared.value.geometry,
    );
    const state = preparation.inspect();
    inspections.set(
      key,
      inspectPointsLines({
        snapshot,
        topology,
        lane,
        pointCount: prepared.value.geometry.pointCount,
        segmentCount: prepared.value.geometry.segmentCount,
        sourceBytes: prepared.value.geometry.sourceBytes,
        derivedBytes: prepared.value.geometry.derivedBytes,
        cache: {
          hit: prepared.value.uploadedBytes === 0,
          rebuilds: state.rebuilds,
          evictions: 0,
        },
        drawCount: plan.drawCount,
        uploadBytes: prepared.value.uploadedBytes,
        lastKnownGood: prepared.value.lastKnownGood,
      }),
    );
    return {
      plan,
      vertexBuffer: prepared.value.resource.vertexBuffer,
      indexBuffer: prepared.value.resource.indexBuffer,
      layoutProjection: this.layoutProjection,
    };
  }

  /** The accepted attempt's observations become the published inspection, fenced by its GPU work. */
  commit(completed: Promise<unknown> | undefined): void {
    this.published = this.pending;
    this.pending = new Map();
    if (completed !== undefined) this.track(completed);
  }

  /** A rejected attempt publishes nothing; the previous inspection stays. */
  discard(): void {
    this.pending = new Map();
  }

  /** Retired cache rows may still be named by an earlier view in this submission. */
  track(completed: Promise<unknown>): void {
    for (const preparation of this.preparations.values())
      preparation.lastKnownGood()?.resource.lifetime.track(completed);
    for (const preparation of this.retiring) {
      preparation.lastKnownGood()?.resource.lifetime.track(completed);
      preparation.resetForDeviceLoss();
    }
    this.retiring.clear();
  }

  resetForDeviceLoss(): void {
    for (const preparation of this.preparations.values()) preparation.resetForDeviceLoss();
    for (const preparation of this.retiring) preparation.resetForDeviceLoss();
    this.retiring.clear();
    this.pending.clear();
    this.published.clear();
    this.frameOutcome = undefined;
  }

  abandonForDeviceLoss(): void {
    for (const preparation of this.preparations.values()) {
      preparation.abandonForDeviceLoss();
    }
    for (const preparation of this.retiring) preparation.abandonForDeviceLoss();
    this.retiring.clear();
    this.pending.clear();
    this.published.clear();
    this.frameOutcome = undefined;
  }

  dispose(): void {
    this.resetForDeviceLoss();
    this.preparations.clear();
    this.cache.clear();
  }

  /** Detached copies of the last accepted attempt's observations. */
  inspections(): readonly PointsLinesInspection[] {
    return [...this.published.values()].map((inspection) => ({
      ...inspection,
      cache: { ...inspection.cache },
      ...(inspection.refusal === undefined ? {} : { refusal: { ...inspection.refusal } }),
    }));
  }

  private backend(runtime: RenderSystemInternals): PointsLinesBackend {
    switch (runtime.device.caps.backendKind) {
      case 'wgpu-webgl2':
        return 'wgpu-webgl2';
      case 'null':
        return 'null';
      default:
        return 'webgpu';
    }
  }

  private publishRefusal(
    inspections: Map<string, PointsLinesInspection>,
    snapshot: PointsLinesPreparedSnapshot,
    error: PointsLinesSourceError,
  ): void {
    inspections.set(
      `${snapshot.worldId}:${snapshot.entityKey}`,
      inspectPointsLines({
        snapshot,
        topology: snapshot.component === 'Points' ? 'point-list' : 'line-list',
        lane: 'refused',
        pointCount: 0,
        segmentCount: 0,
        sourceBytes: 0,
        derivedBytes: 0,
        cache: { hit: false, rebuilds: 0, evictions: 0 },
        drawCount: 0,
        uploadBytes: 0,
        lastKnownGood: false,
        refusal: {
          code: error.code,
          expected: error.expected,
          hint: error.hint,
          detail: error.detail,
          generation: snapshot.meshGeneration,
          lastKnownGood: false,
        },
      }),
    );
  }

  private createPreparation(
    runtime: RenderSystemInternals,
    geometryKey: string,
    lane: PointsLinesLane,
    backend: PointsLinesBackend,
  ): PointsLinesPreparationAdapter {
    return createPointsLinesLanePreparationAdapter(lane, backend, {
      cache: this.cache,
      adapter: {
        create: (geometry) => {
          const vertex = runtime.device.createBuffer({
            label: `points-lines-vertices:${geometryKey}`,
            size: Math.max(4, geometry.vertices.byteLength),
            usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          });
          if (!vertex.ok) return err(vertex.error);
          const index = runtime.device.createBuffer({
            label: `points-lines-indices:${geometryKey}`,
            size: Math.max(4, geometry.indices.byteLength),
            usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          });
          if (!index.ok) {
            runtime.device.destroyBuffer(vertex.value);
            return err(index.error);
          }
          return ok({
            vertexBuffer: vertex.value,
            indexBuffer: index.value,
            lifetime: new ResidencyLifetime(() => {
              runtime.device.destroyBuffer(vertex.value);
              runtime.device.destroyBuffer(index.value);
            }),
          });
        },
        upload: (resource, geometry) => {
          if (geometry.vertices.byteLength > 0) {
            const vertexWrite = runtime.device.queue.writeBuffer(
              resource.vertexBuffer,
              0,
              geometry.vertices,
            );
            if (!vertexWrite.ok) return err(vertexWrite.error);
          }
          if (geometry.indices.byteLength > 0) {
            const indexWrite = runtime.device.queue.writeBuffer(
              resource.indexBuffer,
              0,
              geometry.indices,
            );
            if (!indexWrite.ok) return err(indexWrite.error);
          }
          return ok(geometry.derivedBytes);
        },
        validate: (_resource, geometry) =>
          geometry.expandedVertexCount > 0 && geometry.expandedIndexCount > 0
            ? ok(undefined)
            : err(new Error('Points/Lines expansion contains no drawable triangles')),
        destroy: (resource) => resource.lifetime.retire(),
      },
    });
  }
}
