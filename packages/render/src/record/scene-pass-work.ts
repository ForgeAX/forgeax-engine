import type { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RhiError } from '@forgeax/engine-rhi';
import type { PassKind, PassSelector } from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuDrivenBatch, GpuDrivenBatchBinding } from '../gpu-driven/batch-topology';
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
import { type FrameList, FrameProjection } from '../scene/frame-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import { matchPass } from '../systems/pass-selector';
import { TransparentSortCache } from '../systems/transparent-dispatch';
import { standardTransmissionValue } from '../transmission/projection';
import { directDrawRows } from './direct-draws';
import { captureDispatchOverlays } from './dispatch-overlays';
import type { buildDispatchPlan } from './fold-buckets';
import type { ValidatedRenderable } from './frame-snapshot';
import { variantSetFromDefines } from './helpers';
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

/** Per-request selections; fixed material frames and GPU selections survive pose frames. */
const directSelections = new WeakMap<
  ScenePassRequest,
  {
    materials: MaterialFrame;
    gpu: GpuDrawSelection;
    readonly selected: Map<GpuDrivenBatchBinding, MaterialSnapshot | null>;
    /** The plan's batches this request draws directly, for one fixed plan. */
    direct?: { readonly plan: object; readonly batches: readonly GpuDrivenBatch[] };
  }
>();

/**
 * Direct draw work visits only batches whose material this request selects.
 * With a fixed material frame and GPU selection the subset is fixed per plan,
 * so steady frames no longer walk every GPU-owned batch for each scene pass.
 */
function directPassScene<
  S extends Pick<PersistentGpuDrivenState, 'plan' | 'slotAt' | 'drawSnapshotAt' | 'unbatchedSlots'>,
>(request: ScenePassRequest, scene: S, select: (binding: GpuDrivenBatchBinding) => unknown): S {
  const cache = directSelections.get(request);
  if (cache === undefined) return scene;
  let direct = cache.direct;
  if (direct?.plan !== scene.plan) {
    const batches: GpuDrivenBatch[] = [];
    const live = new Set<GpuDrivenBatchBinding>();
    for (const batch of scene.plan.batches) {
      if (batch.binding !== undefined) live.add(batch.binding);
      if (batch.binding === undefined || select(batch.binding) !== undefined) batches.push(batch);
    }
    // Retained answers are bounded by the current plan's bindings.
    for (const binding of cache.selected.keys())
      if (!live.has(binding)) cache.selected.delete(binding);
    direct = { plan: scene.plan, batches };
    cache.direct = direct;
  }
  return { ...scene, plan: { ...scene.plan, batches: direct.batches } };
}

export function directPassMaterial(
  request: ScenePassRequest,
  materials: MaterialFrame,
  gpu: GpuDrawSelection,
): (binding: GpuDrivenBatchBinding) => MaterialSnapshot | undefined {
  let cache = directSelections.get(request);
  if (cache !== undefined && cache.materials !== materials) {
    // Material adoption re-selects only bindings of changed accepted versions;
    // the direct roster survives unless one of them changes admission.
    const changedMaterials = new Set<object>();
    materials.changesSince(cache.materials, (before, after) => {
      const resource = (after ?? before)?.resource;
      if (resource !== undefined) changedMaterials.add(resource);
    });
    const reselect = selectDirectPassMaterial(request, materials, cache.gpu);
    for (const [binding, previous] of cache.selected) {
      if (!changedMaterials.has(binding.material)) continue;
      if (materials.get(binding.material) === undefined) {
        if (previous !== null) delete cache.direct;
        cache.selected.delete(binding);
        continue;
      }
      const next = reselect(binding) ?? null;
      if ((next === null) !== (previous === null)) delete cache.direct;
      cache.selected.set(binding, next);
    }
    cache.materials = materials;
  }
  if (cache?.materials === materials && cache.gpu !== gpu) {
    // A replaced selection re-joins only bindings whose owned executions changed.
    const changed = gpu.changedBindingsSince(cache.gpu);
    for (const binding of changed) cache.selected.delete(binding);
    if (changed.size > 0) delete cache.direct;
    cache.gpu = gpu;
  }
  if (cache?.materials !== materials || cache.gpu !== gpu) {
    cache = { materials, gpu, selected: new Map() };
    directSelections.set(request, cache);
  }
  const { selected } = cache;
  const select = selectDirectPassMaterial(request, materials, gpu);
  return (binding) => {
    let material = selected.get(binding);
    if (material === undefined) {
      material = select(binding) ?? null;
      selected.set(binding, material);
    }
    return material ?? undefined;
  };
}

/**
 * A request's Pass match is a pure function of one immutable accepted version.
 * It survives GPU selection and plan replacements, which re-join only ownership.
 */
const passMatches = new WeakMap<ScenePassRequest, WeakMap<object, boolean>>();

function selectDirectPassMaterial(
  request: ScenePassRequest,
  materials: MaterialFrame,
  gpu: GpuDrawSelection,
): (binding: GpuDrivenBatchBinding) => MaterialSnapshot | undefined {
  let matches = passMatches.get(request);
  if (matches === undefined) {
    matches = new WeakMap();
    passMatches.set(request, matches);
  }
  const matched = matches;
  return (binding) => {
    if (request.late) return undefined;
    const accepted = materials.get(binding.material);
    if (accepted === undefined)
      throw new Error('Scene Pass requires its accepted material version');
    let match = matched.get(accepted);
    if (match === undefined) {
      match = materialMatchesPass(
        accepted,
        request.selector,
        request.recordMode,
        request.excludeSelector,
      );
      matched.set(accepted, match);
    }
    if (!match) return undefined;
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

/** A retained projection keeps its selected entries, so later stages see a fixed list. */
const selectedByRequest = new WeakMap<
  ScenePassRequest,
  { readonly projected: DispatchList; readonly selected: DispatchList }
>();

export function selectRequestDispatch(
  request: ScenePassRequest,
  projected: DispatchList,
): DispatchList {
  const selector = request.selector;
  if (selector === undefined) return projected;
  const previous = selectedByRequest.get(request);
  if (previous?.projected === projected) return previous.selected;
  const selected = projected.filter((entry) => matchPass(entry.tags, selector));
  selectedByRequest.set(request, { projected, selected });
  return selected;
}

interface TransparentSortSource {
  readonly transform: RenderableSnapshot['transform'];
  readonly material: MaterialSnapshot;
  readonly spriteRegion: RenderableSnapshot['spriteRegion'];
}

function sortSource(row: ValidatedRenderable, materials: MaterialFrame): TransparentSortSource {
  const accepted = materials.get(row.source.material);
  if (accepted === undefined) throw new Error('Draw sorting requires its accepted material');
  return {
    transform: row.source.transform,
    material: accepted.snapshot,
    spriteRegion: row.source.spriteRegion,
  };
}

type MutableRow = { -readonly [K in keyof ValidatedRenderable]: ValidatedRenderable[K] };

/**
 * Append one pass's rows under the combined index space. The last dispatch
 * entry of a row owns its overlay (render state, stencil, variant). Rows are
 * this frame's fresh projections owned by this pass, so their addresses and
 * overlays are written in place instead of copying every row again.
 */
function appendPassRows(
  rows: ValidatedRenderable[],
  localRows: readonly ValidatedRenderable[],
  localDispatch: DispatchList,
  offset: number,
  indices: Set<number>,
): void {
  const positional = localRows.every((row, index) => row.renderableIndex === index);
  if (!positional) {
    const overlays = captureDispatchOverlays(localDispatch).values;
    for (const row of localRows) {
      const index = offset + row.renderableIndex;
      indices.add(index);
      rows.push({ ...row, ...overlays.get(row.renderableIndex), renderableIndex: index });
    }
    return;
  }
  for (const entry of localDispatch) {
    const row = localRows[entry.renderableIndex] as MutableRow | undefined;
    if (row === undefined) continue;
    row.renderState = entry.renderState;
    row.stencilReference = entry.stencilReference;
    row.variantSet = variantSetFromDefines(entry.defines);
  }
  for (const row of localRows) {
    const index = offset + row.renderableIndex;
    (row as MutableRow).renderableIndex = index;
    indices.add(index);
    rows.push(row);
  }
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
  fold: (
    dispatch: DispatchList,
    rows: () => readonly FoldRenderableLike[],
  ) => readonly FoldBucket[],
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
            directPassScene(request, scene, selected),
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
    // Sort and fold read these per row only when they actually order or fold.
    let sortSources: readonly TransparentSortSource[] | undefined;
    const sortRows = () => (sortSources ??= localRows.map((row) => sortSource(row, materials)));
    let sort = sortByRequest.get(request);
    if (sort === undefined) {
      sort = new TransparentSortCache();
      sortByRequest.set(request, sort);
    }
    const combinedTranslucency =
      request.recordMode === 'translucent' ||
      request.recordMode === 'translucent-before-transmission';
    let localDispatch = sort.sort(
      selectRequestDispatch(request, projectDispatch(localRows)),
      world,
      eye === undefined ? [] : [eye],
      new FrameProjection(localRows, (row: ValidatedRenderable) => sortSource(row, materials)),
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
    const offset = rows.length;
    const indices = new Set<number>();
    appendPassRows(rows, localRows, localDispatch, offset, indices);
    // The first pass keeps its own indices; its dispatch needs no remapped copy.
    const mappedDispatch: DispatchList =
      offset === 0
        ? localDispatch
        : localDispatch.map((entry) => ({
            ...entry,
            renderableIndex: offset + entry.renderableIndex,
          }));
    for (const entry of mappedDispatch) dispatch.push(entry);
    if (
      !combinedTranslucency &&
      !request.capture &&
      request.passKind === 'forward' &&
      localRows.length > 0
    ) {
      for (const bucket of fold(localDispatch, sortRows)) {
        buckets.push(
          offset === 0
            ? bucket
            : {
                ...bucket,
                entries: bucket.entries.map((entry) => ({
                  ...entry,
                  renderableIndex: offset + entry.renderableIndex,
                })),
              },
        );
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
      // Each combined row index belongs to at most one request; one ordered
      // walk of the submitted plan yields every request's ascending positions.
      const owners: (number[] | undefined)[] = new Array(rows.length);
      const positionsByRequest = new Map<ScenePassRequest, number[]>();
      for (const [request, candidate] of prepared) {
        const positions: number[] = [];
        positionsByRequest.set(request, positions);
        for (const index of candidate.indices) owners[index] = positions;
      }
      const submitted = plan.validatedOrdered;
      for (let position = 0; position < submitted.length; position++) {
        const index = (submitted[position] as ValidatedRenderable).renderableIndex;
        if (index >= 0 && index < owners.length) owners[index]?.push(position);
      }
      const fold = plan.foldDispatchPlan;
      for (const [request, candidate] of prepared) {
        const indices = positionsByRequest.get(request) as number[];
        const validatedOrdered = indices.map((index) => {
          const row = submitted[index];
          if (row === undefined) throw new Error('Missing submitted direct row');
          return row;
        });
        let headBuckets: Map<number, FoldBucket> | undefined;
        let skipIndices: Set<number> | undefined;
        if (fold != null)
          for (let local = 0; local < indices.length; local++) {
            const global = indices[local] as number;
            const head = fold.headBuckets.get(global);
            if (head !== undefined) {
              headBuckets ??= new Map();
              headBuckets.set(local, head);
            }
            if (fold.skipIndices.has(global)) {
              skipIndices ??= new Set();
              skipIndices.add(local);
            }
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
            headBuckets === undefined
              ? null
              : {
                  headBuckets,
                  skipIndices: skipIndices ?? new Set(),
                  foldedBucketCount: headBuckets.size,
                },
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
