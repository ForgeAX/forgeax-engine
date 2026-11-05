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
import { type FrameList, FrameProjection } from '../scene/frame-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import {
  COLOR_PASS_SELECTOR,
  DEFERRED_PASS_SELECTOR,
  FORWARD_PASS_SELECTOR,
} from '../systems/pass-selector';
import { standardTransmissionValue } from '../transmission/projection';
import type {
  DirectDrawOutput,
  DirectDrawPhase,
  DirectDrawScene,
  ViewDrawPhases,
} from './direct-draw-phase';
import type { buildDispatchPlan } from './fold-buckets';
import type { ValidatedRenderable } from './frame-snapshot';
import { createMainPassMaterialSelectionOwner } from './main-pass';
import type { MaterialRelationFrame } from './material-binding-index';
import type { PreparedGeometryMaterialPasses } from './material-pass-groups';
import {
  isMediumMaterial,
  type MaterialRecordMode,
  materialMatchesPass,
} from './material-pass-selection';
import {
  type FoldBucket,
  type FoldDispatchPlan,
  type FoldRenderableLike,
  foldRenderableSnapshot,
} from './mesh-ssbo';
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
  readonly materialSlotIndices: FrameList<readonly number[]>;
  readonly foldDispatchPlan: FoldDispatchPlan | null;
  readonly mainPassMaterialSelection: ReturnType<typeof createMainPassMaterialSelectionOwner>;
  readonly geometryMaterialPasses?: PreparedGeometryMaterialPasses | undefined;
}

/** Borrowed values and capacity-clipped rows still need ordinary record selection. */
function completeOwnedPassRequest(
  request: ScenePassRequest,
  materials: MaterialFrame,
  submittedRows: number,
  preparedRows: number,
): ScenePassRequest | undefined {
  return materials.hasBorrowedValues || submittedRows !== preparedRows ? undefined : request;
}

/** Only the exact complete emitted dispatch may consume its phase-owned groups. */
function preparedGeometryPasses(
  request: ScenePassRequest | undefined,
  candidate: { readonly dispatch: DispatchList; readonly output: DirectDrawOutput },
  validatedOrdered: readonly ValidatedRenderable[],
  ordered: boolean,
): PreparedGeometryMaterialPasses | undefined {
  const groups = candidate.output.materialPasses;
  if (
    request === undefined ||
    request.passKind === 'shadow' ||
    !stockGeometrySelector(request.selector) ||
    candidate.dispatch !== candidate.output.dispatch ||
    groups === undefined
  )
    return undefined;
  return {
    dispatch: candidate.dispatch,
    validatedOrdered,
    ordered,
    temporal: request.passKind === 'temporal',
    groups,
  };
}

function stockGeometrySelector(selector: PassSelector | undefined): boolean {
  return (
    selector === FORWARD_PASS_SELECTOR ||
    selector === DEFERRED_PASS_SELECTOR ||
    selector === COLOR_PASS_SELECTOR
  );
}

/** The existing submitted-position join also owns this request's order proof. */
interface PassPositions {
  readonly indices: number[];
  readonly start: number;
  ordered: boolean;
}

function appendPassPosition(
  owner: PassPositions | undefined,
  index: number,
  position: number,
): void {
  if (owner === undefined) return;
  owner.ordered &&= index === owner.start + owner.indices.length;
  owner.indices.push(position);
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
  readonly retainMaterialBindings?: boolean | undefined;
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
  /** The retained phases of the view this preparation records. */
  readonly phases: ViewDrawPhases;
}

/** The facts a fold reads from one row. */
function foldSource(row: ValidatedRenderable, materials: MaterialFrame): FoldRenderableLike {
  const accepted = materials.get(row.source.material);
  if (accepted === undefined) throw new Error('Draw folding requires its accepted material');
  return foldRenderableSnapshot(row.source, accepted.snapshot);
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
  /** Fold and transmission admission read values independently of Pass placement. */
  materials: MaterialFrame;
  readonly output: DirectDrawOutput;
  readonly dispatch: DispatchList;
  readonly buckets: readonly FoldBucket[];
}

/** Combined graph-selected rows owned by one view's retained phases. */
export interface ScenePassPreparation {
  readonly materialRows: readonly MaterialRelationFrame[] | undefined;
  readonly rows: readonly ValidatedRenderable[];
  readonly dispatch: DispatchList;
  readonly buckets: readonly FoldBucket[];
  finish(plan: ReturnType<typeof buildDispatchPlan>): ReadonlyMap<ScenePassRequest, ScenePassDraws>;
}

export interface ScenePassPreparationMemo {
  readonly queued: readonly {
    readonly request: ScenePassRequest;
    readonly work: RequestWork;
    readonly start: number;
    readonly end: number;
  }[];
  readonly value: ScenePassPreparation;
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
function queueScenePass(
  request: ScenePassRequest,
  inputs: ScenePassInputs,
  offset: number,
): ScenePassPreparationMemo['queued'][number] {
  const { materials, gpu, world, camera } = inputs;
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
  // The Record graph owner selected this request roster. Its per-pass row
  // cache queues only consumers of that compiled graph; frame-independent
  // phase sorting and pass plans were already produced in RenderQueue.
  const phase = inputs.phases.of(request);
  phase.queue({
    retainMaterialBindings: inputs.retainMaterialBindings,
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
    entries: { selector: request.selector, temporal: request.passKind === 'temporal' },
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
  const output = phase.emit(offset);
  const work = projectScenePassWork(request, inputs, phase, output, offset, combinedTranslucency);
  const end =
    combinedTranslucency && work.dispatch.length === 0 ? offset : offset + output.rows.length;
  return { request, work, start: offset, end };
}

/** Value-dependent projections follow their own consumed material cursor. */
function projectScenePassWork(
  request: ScenePassRequest,
  inputs: ScenePassInputs,
  phase: DirectDrawPhase,
  output: DirectDrawOutput,
  offset: number,
  combinedTranslucency: boolean,
): RequestWork {
  const materials = inputs.materials;
  let work = requestWork.get(phase);
  const folding =
    !combinedTranslucency &&
    !request.capture &&
    request.passKind === 'forward' &&
    (materials.hasBorrowedValues || materials.hasFoldableSprites);
  const valuesChanged =
    work !== undefined &&
    (combinedTranslucency || folding || work.buckets.length > 0) &&
    phase.materialValuesChanged(work.materials, materials);
  if (work === undefined || work.output !== output || valuesChanged) {
    const dispatch = combinedTranslucency
      ? transmissionSlice(
          output,
          materials,
          request.recordMode === 'translucent-before-transmission',
        )
      : output.dispatch;
    const buckets =
      folding && output.rows.length > 0
        ? inputs.fold(dispatch, () => foldRows(output.rows, offset, materials))
        : [];
    work = { materials, output, dispatch, buckets };
  }
  // This cursor is private to the retained phase, not captured output. Advance
  // through unrelated changes without rebuilding its fixed combined arrays.
  work.materials = materials;
  requestWork.set(phase, work);
  return work;
}

export function prepareScenePasses(
  requests: readonly ScenePassRequest[],
  inputs: ScenePassInputs,
): ScenePassPreparation {
  const queued: ScenePassPreparationMemo['queued'][number][] = [];
  let offset = 0;
  for (const request of new Set(requests)) {
    const entry = queueScenePass(request, inputs, offset);
    queued.push(entry);
    offset = entry.end;
  }
  const previous = inputs.phases.scenePassWork;
  if (
    previous !== undefined &&
    previous.queued.length === queued.length &&
    queued.every((entry, index) => {
      const before = previous.queued[index];
      return (
        before?.request === entry.request &&
        before.work === entry.work &&
        before.start === entry.start &&
        before.end === entry.end
      );
    })
  )
    return previous.value;
  const rows: ValidatedRenderable[] = [];
  let materialRows: MaterialRelationFrame[] | undefined = [];
  const dispatch: DispatchEntry[] = [];
  const buckets: FoldBucket[] = [];
  const prepared = new Map<ScenePassRequest, PreparedPassRange>();
  for (const { request, work, start, end } of queued) {
    const empty = start === end && work.dispatch.length === 0;
    if (!empty) {
      if (materialRows !== undefined) {
        if (work.output.materialRows === undefined) materialRows = undefined;
        else materialRows.push(work.output.materialRows);
      }
      for (const row of work.output.rows) rows.push(row);
      for (const entry of work.dispatch) dispatch.push(entry);
      for (const bucket of work.buckets) buckets.push(bucket);
    }
    prepared.set(request, {
      start,
      end,
      dispatch: empty ? [] : work.dispatch,
      output: work.output,
    });
  }
  const value = createScenePassPreparation(
    materialRows,
    rows,
    dispatch,
    buckets,
    prepared,
    inputs.materials,
  );
  inputs.phases.scenePassWork = { queued, value };
  return value;
}

/** A captured pass range; no link to the preparation that preceded it. */
interface PreparedPassRange {
  readonly start: number;
  readonly end: number;
  readonly dispatch: DispatchList;
  readonly output: DirectDrawOutput;
}

/** Isolate closure storage from the caller's previous memo and full frame inputs. */
function createScenePassPreparation(
  materialRows: readonly MaterialRelationFrame[] | undefined,
  rows: readonly ValidatedRenderable[],
  dispatch: DispatchList,
  buckets: readonly FoldBucket[],
  prepared: ReadonlyMap<ScenePassRequest, PreparedPassRange>,
  materials: MaterialFrame,
): ScenePassPreparation {
  return {
    materialRows,
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
      const owners: (PassPositions | undefined)[] = new Array(rows.length);
      const positionsByRequest = new Map<ScenePassRequest, PassPositions>();
      for (const [request, candidate] of prepared) {
        const positions: PassPositions = { indices: [], start: candidate.start, ordered: true };
        positionsByRequest.set(request, positions);
        owners.fill(positions, candidate.start, candidate.end);
      }
      const submitted = plan.validatedOrdered;
      for (let position = 0; position < submitted.length; position++) {
        const index = (submitted[position] as ValidatedRenderable).renderableIndex;
        if (index >= 0 && index < owners.length) appendPassPosition(owners[index], index, position);
      }
      const fold = plan.foldDispatchPlan;
      for (const [request, candidate] of prepared) {
        const positions = positionsByRequest.get(request) as PassPositions;
        const indices = positions.indices;
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
          materialSlotIndices: Array.isArray(plan.materialSlotIndices)
            ? indices.map((index) => plan.materialSlotIndices.at(index) ?? [])
            : new FrameProjection(indices, (index) => plan.materialSlotIndices.at(index) ?? []),
        };
        const owned = completeOwnedPassRequest(
          request,
          materials,
          indices.length,
          candidate.end - candidate.start,
        );
        work.set(request, {
          ...roster,
          geometryMaterialPasses: preparedGeometryPasses(
            owned,
            candidate,
            validatedOrdered,
            positions.ordered,
          ),
          foldDispatchPlan:
            headBuckets === undefined
              ? null
              : {
                  headBuckets,
                  skipIndices: skipIndices ?? new Set(),
                  foldedBucketCount: headBuckets.size,
                },
          mainPassMaterialSelection: createMainPassMaterialSelectionOwner(roster, owned),
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
