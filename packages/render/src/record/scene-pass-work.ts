import type { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RhiError } from '@forgeax/engine-rhi';
import type { PassKind, PassSelector } from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuDrivenBatchBinding } from '../gpu-driven/batch-topology';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import type { MaterialResource } from '../material-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { CameraSnapshot } from '../render-contract';
import type { RenderPipelineFrame, RenderPipelineGpuDrivenFilter } from '../render-pipeline';
import type {
  CameraAdmission,
  DispatchEntry,
  DispatchList,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import { standardTransmissionValue } from '../transmission/projection';
import {
  type DirectDrawOutput,
  type DirectDrawPhase,
  type DirectDrawScene,
  directDrawPhase,
} from './direct-draw-phase';
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

const DETACHED_VIEW = {};

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

/**
 * A request's Pass match is a pure function of one immutable accepted version.
 * It survives GPU selection and plan replacements, which re-join only ownership.
 */
const passMatches = new WeakMap<ScenePassRequest, WeakMap<object, boolean>>();

export function selectDirectPassMaterial(
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

export interface ScenePassDraws {
  readonly validatedOrdered: readonly ValidatedRenderable[];
  readonly dispatch: DispatchList;
  readonly materialSlotIndices: readonly (readonly number[])[];
  readonly foldDispatchPlan: FoldDispatchPlan | null;
  readonly mainPassMaterialSelection: ReturnType<typeof createMainPassMaterialSelectionOwner>;
}

const emptyDrawRows: readonly ValidatedRenderable[] = Object.freeze([]);
const emptyDispatch: DispatchList = Object.freeze([]);
const emptyMaterialSlots: readonly MaterialSnapshot[] = Object.freeze([]);
const emptyMaterialIndices: readonly (readonly number[])[] = Object.freeze([]);
const emptyScenePassDraws: ScenePassDraws = Object.freeze({
  validatedOrdered: emptyDrawRows,
  dispatch: emptyDispatch,
  materialSlotIndices: emptyMaterialIndices,
  foldDispatchPlan: null,
  mainPassMaterialSelection: createMainPassMaterialSelectionOwner({
    validatedOrdered: emptyDrawRows,
    dispatch: emptyDispatch,
    materialSlots: emptyMaterialSlots,
    materialSlotIndices: emptyMaterialIndices,
  }),
});

export interface ScenePassInputs {
  readonly scene: DirectDrawScene;
  readonly materials: MaterialFrame;
  readonly gpu: GpuDrawSelection;
  readonly meshes: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>;
  readonly worlds: readonly RenderResourceScope[];
  readonly prepareUnbatched: (
    sources: FrameList<RenderableSnapshot>,
  ) => readonly ValidatedRenderable[];
  readonly viewDraws: FrameList<RenderableSnapshot>;
  readonly prepareGeometry: (
    mesh: MeshGpuHandles,
    material: MaterialSnapshot,
    source?: RenderableSnapshot,
  ) => MeshGpuHandles;
  readonly fold: (
    dispatch: DispatchList,
    rows: () => readonly FoldRenderableLike[],
  ) => readonly FoldBucket[];
  readonly lod: (
    rows: readonly ValidatedRenderable[],
    request: ScenePassRequest,
  ) => readonly ValidatedRenderable[];
  readonly world: RenderResourceScope;
  readonly camera: CameraSnapshot | undefined;
  readonly cameraVisible?: ((source: RenderableSnapshot) => boolean) | undefined;
  readonly cameraAdmission?: CameraAdmission | undefined;
  /** Resident geometry versions validation reads; see {@link DirectDrawInput.geometry}. */
  readonly geometry?: readonly unknown[] | undefined;
  /** Stable key of the view owning this preparation's retained phases. */
  readonly view?: object | undefined;
}

/** The facts a fold reads from one row. */
function foldSource(row: ValidatedRenderable, materials: MaterialFrame): FoldRenderableLike {
  const accepted = materials.get(row.source.material);
  if (accepted === undefined) throw new Error('Draw folding requires its accepted material');
  return {
    transform: row.source.transform,
    material: accepted.snapshot,
    spriteRegion: row.source.spriteRegion,
  };
}

/** Camera facts CPU LOD selection reads. */
function lodCameraTokens(camera: CameraSnapshot | undefined): readonly unknown[] {
  if (camera === undefined) return [];
  const position = camera.position;
  return [
    position[0],
    position[1],
    position[2],
    camera.projection,
    camera.fov,
    camera.orthoTop,
    camera.orthoBottom,
  ];
}

/** One request's prepared output under the combined index space, retained while unchanged. */
interface RequestWork {
  readonly output: DirectDrawOutput;
  readonly dispatch: DispatchList;
  readonly buckets: readonly FoldBucket[];
}

const requestWork = new WeakMap<DirectDrawPhase, RequestWork>();

function transmissionSlice(
  output: DirectDrawOutput,
  materials: MaterialFrame,
  before: boolean,
): readonly DispatchEntry[] {
  const transmitting = new Set<number>();
  for (const row of output.rows)
    for (const resource of row.source.materials.length === 0
      ? [row.source.material]
      : row.source.materials) {
      const material = materials.get(resource)?.snapshot;
      if (material !== undefined && (standardTransmissionValue(material) ?? 0) > 0)
        transmitting.add(material.materialHandle ?? 0);
    }
  let boundary = 0;
  for (const entry of output.dispatch) {
    if (transmitting.has(entry.materialHandle)) break;
    boundary++;
  }
  return before ? output.dispatch.slice(0, boundary) : output.dispatch.slice(boundary);
}

/** Fold sources addressed by combined `renderableIndex`, without copying earlier requests. */
function foldRows(
  rows: readonly ValidatedRenderable[],
  offset: number,
  materials: MaterialFrame,
): readonly FoldRenderableLike[] {
  const sources: FoldRenderableLike[] = [];
  sources.length = offset;
  for (const row of rows) sources.push(foldSource(row, materials));
  return sources;
}

/**
 * Called only after the actual compiled graphs are selected; no executeIf is
 * evaluated here. Each request of each view owns one retained
 * {@link DirectDrawPhase}: a frame feeds it only entered, left and changed
 * rows, and a request whose phase output and offset are unchanged reuses its
 * combined rows, dispatch and fold buckets.
 */
export function prepareScenePasses(requests: readonly ScenePassRequest[], inputs: ScenePassInputs) {
  const { materials, gpu, world, camera } = inputs;
  const view = inputs.view ?? DETACHED_VIEW;
  const rows: ValidatedRenderable[] = [];
  const dispatch: DispatchEntry[] = [];
  const buckets: FoldBucket[] = [];
  const prepared = new Map<
    ScenePassRequest,
    { readonly start: number; readonly end: number; readonly dispatch: DispatchList }
  >();
  for (const request of new Set(requests)) {
    const eye = request.camera?.() ?? camera;
    const matches = (resource: MaterialResource) => {
      const accepted = materials.get(resource);
      if (accepted === undefined) throw new Error('Direct draw requires its accepted material');
      return materialMatchesPass(
        accepted,
        request.selector,
        request.recordMode,
        request.excludeSelector,
      );
    };
    const combinedTranslucency =
      request.recordMode === 'translucent' ||
      request.recordMode === 'translucent-before-transmission';
    const admitted = !(request.capture || eye?.antialias === 'taa');
    const phase = directDrawPhase(view, request);
    const offset = rows.length;
    const output = phase.sync({
      offset,
      scene: inputs.scene,
      selection: [request.late],
      gpu,
      select: selectDirectPassMaterial(request, materials, gpu),
      meshes: inputs.meshes,
      worlds: inputs.worlds,
      shadow: request.passKind === 'shadow',
      materials,
      prepareUnbatched: inputs.prepareUnbatched,
      admits: matches,
      viewDraws: request.late ? [] : inputs.viewDraws,
      prepareGeometry: inputs.prepareGeometry,
      visible: admitted ? inputs.cameraVisible : undefined,
      admission: admitted ? inputs.cameraAdmission : undefined,
      lod: (lodRows) => inputs.lod(lodRows, request),
      lodCamera: lodCameraTokens(eye),
      geometry: inputs.geometry,
      entries: { selector: request.selector },
      sort: {
        mode: world.transparentSort.mode,
        yzAlpha: world.transparentSort.yzAlpha,
        camera: eye,
        all:
          combinedTranslucency ||
          request.recordMode === 'transparent' ||
          request.recordMode === 'oit-residual',
      },
    });
    let work = requestWork.get(phase);
    if (work === undefined || work.output !== output) {
      const dispatch = combinedTranslucency
        ? transmissionSlice(
            output,
            materials,
            request.recordMode === 'translucent-before-transmission',
          )
        : output.dispatch;
      const buckets =
        !combinedTranslucency &&
        !request.capture &&
        request.passKind === 'forward' &&
        output.rows.length > 0
          ? inputs.fold(dispatch, () => foldRows(output.rows, offset, materials))
          : [];
      work = { output, dispatch, buckets };
    }
    requestWork.set(phase, work);
    if (combinedTranslucency && work.dispatch.length === 0) {
      prepared.set(request, { start: offset, end: offset, dispatch: [] });
      continue;
    }
    for (const row of output.rows) rows.push(row);
    for (const entry of work.dispatch) dispatch.push(entry);
    for (const bucket of work.buckets) buckets.push(bucket);
    prepared.set(request, { start: offset, end: rows.length, dispatch: work.dispatch });
  }
  return {
    rows,
    dispatch,
    buckets,
    finish(
      plan: ReturnType<typeof buildDispatchPlan>,
    ): ReadonlyMap<ScenePassRequest, ScenePassDraws> {
      const work = new Map<ScenePassRequest, ScenePassDraws>();
      if (rows.length === 0) {
        let empty = true;
        for (const candidate of prepared.values()) empty &&= candidate.dispatch.length === 0;
        if (empty) {
          for (const request of prepared.keys()) work.set(request, emptyScenePassDraws);
          return work;
        }
      }
      // Each combined row index belongs to one request's range; one ordered
      // walk of the submitted plan yields every request's ascending positions.
      const owners: (number[] | undefined)[] = new Array(rows.length);
      const positionsByRequest = new Map<ScenePassRequest, number[]>();
      for (const [request, candidate] of prepared) {
        const positions: number[] = [];
        positionsByRequest.set(request, positions);
        owners.fill(positions, candidate.start, candidate.end);
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
  // Ownership was consumed while preparing this pass's CPU rows. Keep the
  // complete detached frame shape and clear selection instead of rebuilding
  // every property through object-rest exclusion.
  return { ...c, ...work, gpuDrivenSelection: undefined };
}
