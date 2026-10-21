import type { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RhiError } from '@forgeax/engine-rhi';
import type { PassKind, PassSelector } from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuDrivenBatchBinding } from '../gpu-driven/batch-topology';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { CameraSnapshot } from '../render-contract';
import type { RenderPipelineFrame, RenderPipelineGpuDrivenFilter } from '../render-pipeline';
import type {
  DispatchEntry,
  DispatchList,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import { matchPass } from '../systems/pass-selector';
import { TransparentSortCache } from '../systems/transparent-dispatch';
import { standardTransmissionValue } from '../transmission/projection';
import { directDrawRows } from './direct-draws';
import { captureDispatchOverlays } from './dispatch-overlays';
import type { buildDispatchPlan } from './fold-buckets';
import type { ValidatedRenderable } from './frame-snapshot';
import { createMainPassMaterialSelectionOwner } from './main-pass';
import {
  isMediumMaterial,
  type MaterialRecordMode,
  materialMatchesPass,
} from './material-pass-selection';
import type { FoldBucket, FoldDispatchPlan, FoldRenderableLike } from './mesh-ssbo';
import type { _InternalRenderPipelineContext } from './render-context';

/** One actual graph node shares this request between preparation and recording. */
export interface ScenePassRequest {
  readonly selector: PassSelector | undefined;
  readonly excludeSelector: PassSelector | undefined;
  readonly recordMode: MaterialRecordMode | undefined;
  readonly passKind: PassKind;
  readonly gpu: boolean;
  readonly gpuFilter: RenderPipelineGpuDrivenFilter | undefined;
  readonly late: boolean;
  readonly capture: boolean;
  readonly camera?: () => CameraSnapshot | undefined;
}

const sortByRequest = new WeakMap<ScenePassRequest, TransparentSortCache>();

const requestsByGraph = new WeakMap<object, readonly ScenePassRequest[]>();

export function registerScenePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  request: ScenePassRequest,
): ScenePassRequest {
  const fixed = Object.freeze(request);
  requestsByGraph.set(graph, [...(requestsByGraph.get(graph) ?? []), fixed]);
  return fixed;
}

export function installScenePasses(builder: object, compiled: object): void {
  requestsByGraph.set(compiled, Object.freeze([...(requestsByGraph.get(builder) ?? [])]));
}

export function scenePassRequests(graph: object): readonly ScenePassRequest[] {
  return requestsByGraph.get(graph) ?? [];
}

export function directPassMaterial(
  request: ScenePassRequest,
  materials: MaterialFrame,
  gpu: GpuDrawSelection,
): (binding: GpuDrivenBatchBinding) => MaterialSnapshot | undefined {
  return (binding) => {
    if (request.late) return undefined;
    const accepted = materials.get(binding.material);
    if (accepted === undefined)
      throw new Error('Scene Pass requires its accepted material version');
    if (
      !materialMatchesPass(accepted, request.selector, request.recordMode, request.excludeSelector)
    )
      return undefined;
    if (
      request.gpu &&
      gpu.ownsBinding(
        binding,
        request.passKind,
        request.gpuFilter,
        isMediumMaterial(accepted.snapshot),
      )
    )
      return undefined;
    return accepted.snapshot;
  };
}

export interface ScenePassDraws {
  readonly validatedOrdered: readonly ValidatedRenderable[];
  readonly dispatch: DispatchList;
  readonly materialSlotIndices: readonly (readonly number[])[];
  readonly foldDispatchPlan: FoldDispatchPlan | null;
  readonly mainPassMaterialSelection: ReturnType<typeof createMainPassMaterialSelectionOwner>;
}

/** Called only after the actual compiled graphs are selected; no executeIf is evaluated here. */
export function prepareScenePasses(
  requests: readonly ScenePassRequest[],
  scene: Pick<PersistentGpuDrivenState, 'plan' | 'slotAt' | 'drawSnapshotAt' | 'unbatchedSlots'>,
  materials: MaterialFrame,
  gpu: GpuDrawSelection,
  meshes: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>,
  worlds: readonly RenderResourceScope[],
  prepareUnbatched: (sources: FrameList<RenderableSnapshot>) => readonly ValidatedRenderable[],
  viewDraws: FrameList<RenderableSnapshot>,
  prepareGeometry: (mesh: MeshGpuHandles, material: MaterialSnapshot) => MeshGpuHandles,
  projectDispatch: (rows: readonly ValidatedRenderable[]) => DispatchList,
  fold: (dispatch: DispatchList, rows: readonly FoldRenderableLike[]) => readonly FoldBucket[],
  lod: (
    rows: readonly ValidatedRenderable[],
    request: ScenePassRequest,
  ) => readonly ValidatedRenderable[],
  world: RenderResourceScope,
  camera: CameraSnapshot | undefined,
  cameraVisible?: (source: RenderableSnapshot) => boolean,
) {
  const rows: ValidatedRenderable[] = [];
  const dispatch: DispatchEntry[] = [];
  const buckets: FoldBucket[] = [];
  const prepared = new Map<
    ScenePassRequest,
    { readonly indices: ReadonlySet<number>; readonly dispatch: DispatchList }
  >();
  for (const request of new Set(requests)) {
    const eye = request.camera?.() ?? camera;
    const selected = directPassMaterial(request, materials, gpu);
    const matches = (resource: import('../material-resource').MaterialResource) => {
      const accepted = materials.get(resource);
      if (accepted === undefined) throw new Error('Direct draw requires its accepted material');
      return materialMatchesPass(
        accepted,
        request.selector,
        request.recordMode,
        request.excludeSelector,
      );
    };
    const localRows = request.late
      ? []
      : lod(
          directDrawRows(
            scene,
            selected,
            meshes,
            worlds,
            request.passKind,
            (sources) =>
              prepareUnbatched(
                sources.filter((source) =>
                  (source.materials.length === 0 ? [source.material] : source.materials).some(
                    matches,
                  ),
                ),
              ).flatMap((row) => {
                const submeshIndices = [
                  ...(row.submeshIndices ?? row.mesh.submeshes.keys()),
                ].filter((index) => {
                  const submesh = row.mesh.submeshes[index];
                  return (
                    submesh !== undefined &&
                    matches(row.source.materials[submesh.materialSlot] ?? row.source.material)
                  );
                });
                return submeshIndices.length === 0 ? [] : [{ ...row, submeshIndices }];
              }),
            viewDraws,
            prepareGeometry,
            request.capture || eye?.antialias === 'taa' ? undefined : cameraVisible,
          ),
          request,
        );
    const sortSources = localRows.map((row) => {
      const accepted = materials.get(row.source.material);
      if (accepted === undefined) throw new Error('Draw sorting requires its accepted material');
      return {
        transform: row.source.transform,
        material: accepted.snapshot,
        spriteRegion: row.source.spriteRegion,
      };
    });
    let sort = sortByRequest.get(request);
    if (sort === undefined) {
      sort = new TransparentSortCache();
      sortByRequest.set(request, sort);
    }
    const combinedTranslucency =
      request.recordMode === 'translucent' ||
      request.recordMode === 'translucent-before-transmission';
    let localDispatch = sort.sort(
      projectDispatch(localRows).filter(
        (entry) => request.selector === undefined || matchPass(entry.tags, request.selector),
      ),
      world,
      eye === undefined ? [] : [eye],
      sortSources,
      combinedTranslucency ||
        request.recordMode === 'transparent' ||
        request.recordMode === 'oit-residual',
    );
    if (combinedTranslucency) {
      const transmitting = new Set(
        localRows.flatMap((row) =>
          (row.source.materials.length === 0
            ? [row.source.material]
            : row.source.materials
          ).flatMap((resource) => {
            const material = materials.get(resource)?.snapshot;
            return material !== undefined && (standardTransmissionValue(material) ?? 0) > 0
              ? [material.materialHandle ?? 0]
              : [];
          }),
        ),
      );
      let boundary = 0;
      for (const entry of localDispatch) {
        if (transmitting.has(entry.materialHandle)) break;
        boundary++;
      }
      localDispatch =
        request.recordMode === 'translucent-before-transmission'
          ? localDispatch.slice(0, boundary)
          : localDispatch.slice(boundary);
      if (localDispatch.length === 0) {
        prepared.set(request, { indices: new Set(), dispatch: [] });
        continue;
      }
    }
    const overlays = captureDispatchOverlays(localDispatch).values;
    const offset = rows.length;
    const indices = new Set<number>();
    for (const row of localRows) {
      const index = offset + row.renderableIndex;
      indices.add(index);
      rows.push({ ...row, ...overlays.get(row.renderableIndex), renderableIndex: index });
    }
    const mappedDispatch = localDispatch.map((entry) => ({
      ...entry,
      renderableIndex: offset + entry.renderableIndex,
    }));
    dispatch.push(...mappedDispatch);
    if (
      !combinedTranslucency &&
      !request.capture &&
      request.passKind === 'forward' &&
      localRows.length > 0
    ) {
      for (const bucket of fold(localDispatch, sortSources)) {
        buckets.push({
          ...bucket,
          entries: bucket.entries.map((entry) => ({
            ...entry,
            renderableIndex: offset + entry.renderableIndex,
          })),
        });
      }
    }
    prepared.set(request, { indices, dispatch: mappedDispatch });
  }
  return {
    rows,
    dispatch,
    buckets,
    finish(
      plan: ReturnType<typeof buildDispatchPlan>,
    ): ReadonlyMap<ScenePassRequest, ScenePassDraws> {
      const work = new Map<ScenePassRequest, ScenePassDraws>();
      const rowsByIndex = new Map<number, number>();
      for (const [index, row] of plan.validatedOrdered.entries())
        rowsByIndex.set(row.renderableIndex, index);
      for (const [request, candidate] of prepared) {
        const indices = [...candidate.indices]
          .map((index) => rowsByIndex.get(index))
          .filter((index): index is number => index !== undefined)
          .sort((a, b) => a - b);
        const validatedOrdered = indices.map((index) => {
          const row = plan.validatedOrdered[index];
          if (row === undefined) throw new Error('Missing submitted direct row');
          return row;
        });
        const headBuckets = new Map<number, FoldBucket>();
        const skipIndices = new Set<number>();
        for (const [local, global] of indices.entries()) {
          const head = plan.foldDispatchPlan?.headBuckets.get(global);
          if (head !== undefined) headBuckets.set(local, head);
          if (plan.foldDispatchPlan?.skipIndices.has(global)) skipIndices.add(local);
        }
        const roster = {
          validatedOrdered,
          dispatch: candidate.dispatch,
          materialSlots: plan.materialSlots,
          materialSlotIndices: indices.map((index) => plan.materialSlotIndices[index] ?? []),
        };
        work.set(request, {
          ...roster,
          foldDispatchPlan:
            headBuckets.size === 0
              ? null
              : { headBuckets, skipIndices, foldedBucketCount: headBuckets.size },
          mainPassMaterialSelection: createMainPassMaterialSelectionOwner(roster),
        });
      }
      return work;
    },
  };
}

export function scenePassContext(
  c: _InternalRenderPipelineContext,
  request: ScenePassRequest,
): _InternalRenderPipelineContext {
  const work = c.scenePassWork?.get(request);
  if (c.scenePassWork === undefined) return c;
  if (work === undefined)
    throw new RhiError({
      code: 'internal-error',
      expected: 'prepared draw work for the executing Scene Pass',
      hint: 'prepare requests from the actual compiled graph before recording',
    });
  const { gpuDrivenSelection: _gpu, cameraVisible, ...context } = c;
  if (!request.capture && cameraVisible !== undefined)
    return { ...context, cameraVisible, ...work };
  return { ...context, ...work };
}
