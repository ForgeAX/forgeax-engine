import {
  allocateRenderPassGeneration,
  type RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import { RhiError } from '@forgeax/engine-rhi';
import type { PassKind, PassSelector } from '@forgeax/engine-types';
import { isTemporalAntialias } from '../components/camera';
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
import {
  type FrameList,
  FrameListBase,
  FrameProjection,
  type FrameRange,
  JoinedFrameRows,
} from '../scene/frame-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { PersistentShadowCasterProjection } from '../scene/render-scene';
import {
  COLOR_PASS_SELECTOR,
  DEFERRED_PASS_SELECTOR,
  FORWARD_PASS_SELECTOR,
} from '../systems/pass-selector';
import { TRANSPARENT_SORT_MODE_LAYER_Z } from '../systems/transparent-sort-config';
import { viewDrawOrder } from '../systems/view-draw-order';
import { standardTransmissionValue } from '../transmission/projection';
import {
  partitionWaterMaterialDraws,
  type WaterMaterialAdmissionDrawClosure,
} from '../water/mesh-source-admission';
import { CaptureCull } from './capture-cull';
import type {
  DirectDrawOutput,
  DirectDrawPhase,
  DirectDrawScene,
  NativeMeshRowSpan,
  ViewDrawPhases,
} from './direct-draw-phase';
import { JoinedDrawRows } from './draw-row-pages';
import type { buildDispatchPlan } from './fold-buckets';
import type { DrawRows, ValidatedRenderable } from './frame-snapshot';
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
  readonly currentTransparencyPass?:
    | 'accumulate'
    | 'residual'
    | 'ordinary'
    | 'backs'
    | 'prefix'
    | 'sorted-front'
    | 'weighted-front';
  /** A live entity selection may split material-compatible fold buckets. */
  readonly selectsEntities?: boolean;
  readonly camera?: () => CameraSnapshot | undefined;
  readonly captureCull?: CaptureCull;
}

/** Stable consumers of one retained capture view, independent of its short-lived graphs.
 * The camera is refreshed before synchronous Scene Pass preparation, like the view UBO.
 */
export class CaptureScenePasses {
  private readonly cull = new CaptureCull();
  readonly opaque: ScenePassRequest;
  readonly transparent: ScenePassRequest;
  readonly probe: ScenePassRequest;
  readonly probeRequests: readonly [ScenePassRequest];
  private readonly opaqueOnly: readonly ScenePassRequest[];
  private readonly color: readonly ScenePassRequest[];
  private nativeGeneration = 0;
  get physicalGeneration(): number {
    if (this.nativeGeneration === 0) this.nativeGeneration = allocateRenderPassGeneration();
    return this.nativeGeneration;
  }

  faceRequests(face: {
    readonly sceneInput?: true;
    readonly write?: { readonly clearOnly?: boolean };
  }): readonly ScenePassRequest[] {
    if (face.write?.clearOnly) return EMPTY_SCENE_PASSES;
    return face.sceneInput ? this.opaqueOnly : this.color;
  }

  constructor(public camera: CameraSnapshot) {
    const request = (
      recordMode: MaterialRecordMode | undefined,
      selector: PassSelector | undefined,
    ): ScenePassRequest =>
      Object.freeze({
        selector,
        excludeSelector: undefined,
        recordMode,
        passKind: 'forward',
        gpu: false,
        gpuFilter: undefined,
        late: false,
        capture: true,
        captureCull: this.cull,
        camera: () => this.camera,
      });
    this.opaque = request('opaque', FORWARD_PASS_SELECTOR);
    this.transparent = request('transparent', FORWARD_PASS_SELECTOR);
    this.probe = request(undefined, undefined);
    this.probeRequests = Object.freeze([this.probe]);
    this.opaqueOnly = Object.freeze([this.opaque]);
    this.color = Object.freeze([this.opaque, this.transparent]);
  }
}

const EMPTY_SCENE_PASSES: readonly ScenePassRequest[] = Object.freeze([]);

/** A graph declares draw selections once. Physical rasters can consume the same
 * Standard opaque selection while retaining independent attachments and programs. */
class ScenePassDeclarations {
  private rows: ScenePassRequest[];
  private forwardOpaque: (ScenePassRequest | undefined)[] | undefined;

  constructor(existing?: readonly ScenePassRequest[]) {
    this.rows = existing?.slice() ?? [];
  }

  declare(request: ScenePassRequest, standardOpaque: boolean): ScenePassRequest {
    const share =
      standardOpaque &&
      request.selector === FORWARD_PASS_SELECTOR &&
      request.recordMode === 'opaque' &&
      request.passKind === 'forward' &&
      request.gpuFilter === 'opaque' &&
      request.excludeSelector === undefined &&
      !request.capture &&
      !request.selectsEntities &&
      request.camera === undefined &&
      request.captureCull === undefined &&
      request.currentTransparencyPass === undefined;
    // Direct/indirect and early/late geometry have independent ownership.
    const slot = (request.gpu ? 2 : 0) + Number(request.late);
    const existing = share ? this.forwardOpaque?.[slot] : undefined;
    if (existing !== undefined) return existing;
    const fixed = Object.freeze(request);
    if (Object.isFrozen(this.rows)) this.rows = this.rows.slice();
    this.rows.push(fixed);
    if (share) {
      this.forwardOpaque ??= [];
      this.forwardOpaque[slot] = fixed;
    }
    return fixed;
  }

  snapshot(): readonly ScenePassRequest[] {
    return Object.isFrozen(this.rows) ? this.rows : Object.freeze(this.rows);
  }
}

const requestsByGraph = new WeakMap<object, ScenePassDeclarations | readonly ScenePassRequest[]>();

export function registerScenePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  request: ScenePassRequest,
  standardOpaque = false,
): ScenePassRequest {
  let owner = requestsByGraph.get(graph);
  if (!(owner instanceof ScenePassDeclarations)) {
    owner = new ScenePassDeclarations(owner);
    requestsByGraph.set(graph, owner);
  }
  return owner.declare(request, standardOpaque);
}

/** Subsequent declarations preserve the already published roster and its order. */
export function scenePassRequests(graph: object): readonly ScenePassRequest[] {
  const owner = requestsByGraph.get(graph);
  return owner instanceof ScenePassDeclarations ? owner.snapshot() : (owner ?? EMPTY_SCENE_PASSES);
}

export function installScenePasses(builder: object, compiled: object): void {
  const requests = scenePassRequests(builder);
  if (requests.length === 0) requestsByGraph.delete(compiled);
  else requestsByGraph.set(compiled, requests);
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
  readonly materialSlots: _InternalRenderPipelineContext['materialSlots'];
  /** Source addresses of this physical pass, before dispatch ordering and capacity clipping. */
  readonly start: number;
  readonly end: number;
  readonly validatedOrdered: DrawRows;
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
  validatedOrdered: DrawRows,
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

/** Submitted rows normally occupy a single interval. Only an interleaved pass
 * owns an explicit position for each of its rows. Published after the join. */
class PassPositions extends FrameListBase<number> {
  length = 0;
  first = 0;
  ordered = true;
  private sparse: number[] | undefined;

  constructor(
    readonly start: number,
    readonly end: number,
  ) {
    super();
  }

  append(sourceIndex: number, position: number): void {
    this.ordered &&= sourceIndex === this.start + this.length;
    if (this.length === 0) this.first = position;
    if (this.sparse === undefined && position !== this.first + this.length) {
      this.sparse = new Array<number>(this.length);
      for (let i = 0; i < this.length; i++) this.sparse[i] = this.first + i;
    }
    this.sparse?.push(position);
    this.length++;
  }

  position(local: number): number {
    return this.sparse === undefined ? this.first + local : (this.sparse[local] as number);
  }

  at(index: number): number | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    return index < 0 || index >= this.length ? undefined : this.position(index);
  }

  *[Symbol.iterator](): IterableIterator<number> {
    for (let i = 0; i < this.length; i++) yield this.position(i);
  }

  select<T>(rows: FrameList<T>): FrameList<T> {
    if (this.length === rows.length) return rows;
    if (this.sparse === undefined) return rows.slice(this.first, this.first + this.length);
    return this.sparse.map((position) => rows.at(position) as T);
  }
}

/** Manually ordered or interleaved rows must be joined to their pass ranges by address. */
function indexSubmittedPositions(
  ranges: readonly PassPositions[],
  submitted: DrawRows,
  sourceLength: number,
): void {
  let current = ranges[0];
  let cursor = 0;
  for (let position = 0; position < submitted.length; position++) {
    const index = (submitted.at(position) as ValidatedRenderable).renderableIndex;
    if (!Number.isInteger(index) || index < 0 || index >= sourceLength) continue;
    if (current === undefined || index < current.start || index >= current.end) {
      const next = ranges[cursor + 1];
      cursor =
        next !== undefined && index >= next.start && index < next.end
          ? cursor + 1
          : findSubmittedRange(ranges, index);
      current = ranges[cursor];
    }
    current?.append(index, position);
  }
}

/** Physical phase ranges are disjoint in preparation order, including empty ranges. */
function findSubmittedRange(ranges: readonly { readonly end: number }[], index: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((ranges[middle] as { readonly end: number }).end <= index) low = middle + 1;
    else high = middle;
  }
  return low;
}

const emptyDrawRows: readonly ValidatedRenderable[] = Object.freeze([]);
const emptyDispatch: DispatchList = Object.freeze([]);
const emptyMaterialSlots: readonly MaterialSnapshot[] = Object.freeze([]);
const emptySlotRow: readonly number[] = Object.freeze([]);
const emptyMaterialIndices: readonly (readonly number[])[] = Object.freeze([]);
const emptyScenePassDraws: ScenePassDraws = Object.freeze({
  materialSlots: emptyMaterialSlots,
  start: 0,
  end: 0,
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

type TransparencyTopology = import('../render-pipeline').RenderPipelineTopology['transparency'];

export function isCurrentTransparencyPassActive(
  request: ScenePassRequest,
  topology: TransparencyTopology,
  demand?: import('../transmission/projection').TransmissionDemand,
): boolean {
  const phase = request.currentTransparencyPass;
  if (phase === undefined) return true;
  const weighted = topology?.weightedBlended === true;
  const active = (demand?.activeCount ?? 0) > 0;
  switch (phase) {
    case 'accumulate':
      return weighted;
    case 'residual':
      return topology?.residual ?? true;
    case 'ordinary':
      return (!active || weighted) && (topology?.residual ?? true);
    case 'backs':
      return active && !weighted && demand?.needsBackPass === true;
    case 'prefix':
    case 'sorted-front':
      return active && !weighted;
    case 'weighted-front':
      return active && weighted;
  }
}

export interface ScenePassInputs {
  readonly currentTransparency?: TransparencyTopology;
  readonly currentTransmissionDemand?: import('../transmission/projection').TransmissionDemand;
  readonly retainMaterialBindings?: boolean | undefined;
  readonly scene: DirectDrawScene;
  readonly materials: MaterialFrame;
  readonly gpu: GpuDrawSelection;
  readonly meshes: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>;
  readonly sourceScope: RenderResourceScope;
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
  readonly lod:
    | 'cpu'
    | 'gpu'
    | ((rows: readonly ValidatedRenderable[], request: ScenePassRequest) => DrawRows);
  readonly world: RenderResourceScope;
  readonly camera: CameraSnapshot | undefined;
  /** The same accepted slot, Mesh, material and Skin roots used by Scene culling. */
  readonly boundsOf?: PersistentShadowCasterProjection['worldBoundsOf'];
  readonly captureVisibility?:
    | ((eye: CameraSnapshot, visible: ((row: RenderableSnapshot) => boolean) | undefined) => void)
    | undefined;
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
export interface ScenePassPreparation extends NativeMeshRowSpan {
  /** The producer has already laid these rows out in final dispatch order. */
  readonly dispatchOrdered: boolean;
  readonly materialRows: readonly MaterialRelationFrame[] | undefined;
  readonly rows: DrawRows;
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
  rows: DrawRows,
  offset: number,
  materials: MaterialFrame,
): readonly FoldRenderableLike[] {
  const sources: FoldRenderableLike[] = [];
  sources.length = offset;
  for (const row of rows) sources.push(foldSource(row, materials));
  return sources;
}

function scenePassVisibility(
  request: ScenePassRequest,
  inputs: ScenePassInputs,
  eye: CameraSnapshot | undefined,
) {
  const admitted = !(request.capture || isTemporalAntialias(eye?.antialias));
  const capture =
    request.capture && eye !== undefined && inputs.boundsOf !== undefined
      ? request.captureCull?.prepare(eye, inputs.scene, inputs.materials, inputs.boundsOf)
      : undefined;
  if (request.capture && eye) inputs.captureVisibility?.(eye, capture?.visible);
  const cameraVisible = capture?.visible ?? (admitted ? inputs.cameraVisible : undefined);
  const visible =
    request.recordMode === 'opaque-depth'
      ? (source: RenderableSnapshot) =>
          source.waterOwner === undefined && cameraVisible?.(source) !== false
      : cameraVisible;
  return {
    visible,
    admission: capture?.admission ?? (admitted ? inputs.cameraAdmission : undefined),
  };
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
  previous: ScenePassPreparationMemo['queued'][number] | undefined,
): ScenePassPreparationMemo['queued'][number] {
  const { materials, gpu, world, camera } = inputs;
  const eye = request.camera?.() ?? camera;
  const orderOpaque =
    request.passKind !== 'shadow' &&
    eye?.orderOpaqueByLayer === true &&
    (request.recordMode === undefined || request.recordMode.startsWith('opaque'));
  const matches = (resource: MaterialResource) => {
    const accepted = materials.get(resource);
    if (accepted === undefined) {
      throw new Error('Direct draw requires its accepted material');
    }
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
  const { visible, admission } = scenePassVisibility(request, inputs, eye);
  // The Record graph owner selected this request roster. Its per-pass row
  // cache queues only consumers of that compiled graph; frame-independent
  // phase sorting and pass plans were already produced in RenderQueue.
  const phase = inputs.phases.of(request);
  const lod = inputs.lod;
  phase.queue({
    retainMaterialBindings: inputs.retainMaterialBindings,
    scene: inputs.scene,
    selection: [request.late, request.passKind === 'shadow' ? undefined : eye?.cullMask],
    gpu,
    select: selectDirectPassMaterial(request, materials, gpu),
    meshes: inputs.meshes,
    sourceScope: inputs.sourceScope,
    shadow: request.passKind === 'shadow',
    materials,
    prepareUnbatched: inputs.prepareUnbatched,
    admits: matches,
    viewDraws: request.late ? [] : inputs.viewDraws,
    prepareGeometry: inputs.prepareGeometry,
    visible,
    ...(request.passKind === 'shadow' ? {} : { cullMask: eye?.cullMask ?? 0xffffffff }),
    admission,
    lod: typeof lod === 'function' ? (rows) => lod(rows, request) : lod === 'cpu' ? eye : undefined,
    lodCamera: lodCameraTokens(eye),
    geometry: inputs.geometry,
    entries: { selector: request.selector, temporal: request.passKind === 'temporal' },
    sort: {
      sourceOrder:
        request.passKind === 'shadow' || orderOpaque
          ? undefined
          : viewDrawOrder(world.world ?? inputs.sourceScope.world),
      mode: orderOpaque ? TRANSPARENT_SORT_MODE_LAYER_Z : world.transparentSort.mode,
      yzAlpha: world.transparentSort.yzAlpha,
      camera: eye,
      all:
        orderOpaque ||
        combinedTranslucency ||
        request.recordMode === 'transparent' ||
        request.recordMode === 'oit-residual',
    },
  });
  const output = phase.emit(offset);
  const work = projectScenePassWork(request, inputs, phase, output, offset, combinedTranslucency);
  const end =
    combinedTranslucency && work.dispatch.length === 0 ? offset : offset + output.rows.length;
  return previous?.request === request &&
    previous.work === work &&
    previous.start === offset &&
    previous.end === end
    ? previous
    : { request, work, start: offset, end };
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
    request.selectsEntities !== true &&
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

/** A pose publication changes row values independently of its immutable command sequence. */
function combinedDispatch(
  queued: ScenePassPreparationMemo['queued'],
  previous: ScenePassPreparationMemo | undefined,
): DispatchList {
  let only: DispatchList | undefined;
  let populated = 0;
  let same = previous !== undefined && previous.queued.length === queued.length;
  let segment = 0;
  for (const { work } of queued) {
    const dispatch = work.dispatch;
    if (dispatch.length > 0) {
      only = dispatch;
      populated++;
    }
    const before = previous?.queued[segment++]?.work.dispatch;
    if (before !== dispatch && (dispatch.length !== 0 || before?.length !== 0)) same = false;
  }
  if (populated <= 1) return only ?? [];
  if (same && previous !== undefined) return previous.value.dispatch;
  // Each phase has already sealed its address space and ordered commands.
  // Joining a changed roster costs one range per nonempty phase.
  const ranges: FrameRange<DispatchEntry>[] = [];
  let start = 0;
  for (const { work } of queued) {
    if (work.dispatch.length === 0) continue;
    ranges.push({ start, rows: work.dispatch });
    start += work.dispatch.length;
  }
  return new JoinedFrameRows(ranges);
}

export function prepareScenePasses(
  requests: Iterable<ScenePassRequest>,
  inputs: ScenePassInputs,
): ScenePassPreparation {
  const previous = inputs.phases.scenePassWork;
  let changed: ScenePassPreparationMemo['queued'][number][] | undefined;
  let index = 0;
  let offset = 0;
  let onlyWork: RequestWork | undefined;
  let populated = 0;
  // Record supplies a unique declaration iterator or the union of actual captures.
  // A direct caller can also supply an authored array containing repeated requests.
  const ordered =
    Array.isArray(requests) && requests.length > 1 ? new Set<ScenePassRequest>(requests) : requests;
  for (const request of ordered) {
    if (
      !isCurrentTransparencyPassActive(
        request,
        inputs.currentTransparency,
        inputs.currentTransmissionDemand,
      )
    )
      continue;
    const before = previous?.queued[index];
    const entry = queueScenePass(request, inputs, offset, before);
    if (entry !== before) changed ??= previous?.queued.slice(0, index) ?? [];
    changed?.push(entry);
    index++;
    if (entry.end !== offset || entry.work.dispatch.length !== 0) {
      onlyWork = entry.work;
      populated++;
    }
    offset = entry.end;
  }
  if (changed === undefined && previous !== undefined && previous.queued.length === index)
    return previous.value;
  const queued = changed ?? previous?.queued.slice(0, index) ?? [];
  // Empty depth, capture or transparent phases have a range but contribute no rows.
  const single = populated === 1 ? onlyWork : undefined;
  const ranges: { start: number; rows: DrawRows }[] = [];
  let materialRows: MaterialRelationFrame[] | undefined = [];
  const buckets: FoldBucket[] = [];
  const prepared = new Map<ScenePassRequest, PreparedPassRange>();
  let dispatchOrdered = true;
  let nativeStart = 0;
  let nativeEnd = 0;
  let undispatchedTail = false;
  for (const { request, work, start, end } of queued) {
    const empty = start === end && work.dispatch.length === 0;
    if (!empty) {
      if (work.output.nativeEnd > 0) {
        if (nativeEnd === 0) nativeStart = start + work.output.nativeStart;
        nativeEnd = start + work.output.nativeEnd;
      }
      const prefix = work.dispatch.length === 0 ? 0 : work.output.dispatchedPrefix;
      if (
        work.dispatch !== work.output.dispatch ||
        prefix === undefined ||
        (undispatchedTail && prefix > 0)
      )
        dispatchOrdered = false;
      if (prefix !== work.output.rows.length) undispatchedTail = true;
      if (materialRows !== undefined) {
        if (work.output.materialRows === undefined) materialRows = undefined;
        else materialRows.push(work.output.materialRows);
      }
      if (single === undefined) {
        if (start !== end) ranges.push({ start, rows: work.output.rows });
        for (const bucket of work.buckets) buckets.push(bucket);
      }
    }
    prepared.set(request, {
      start,
      end,
      dispatch: work.dispatch,
      output: work.output,
    });
  }
  const value = createScenePassPreparation(
    dispatchOrdered,
    nativeStart,
    nativeEnd,
    materialRows,
    single?.output.rows ?? (ranges.length === 0 ? emptyDrawRows : new JoinedDrawRows(ranges)),
    single?.dispatch ?? combinedDispatch(queued, previous),
    single?.buckets ?? buckets,
    prepared,
    inputs.materials,
  );
  inputs.phases.scenePassWork = { queued, value };
  return value;
}

/** A captured pass range; no link to the preparation that preceded it. */
type AddressedPlan = ReturnType<typeof buildDispatchPlan>;

interface PreparedPassRange {
  readonly start: number;
  readonly end: number;
  readonly dispatch: DispatchList;
  readonly output: DirectDrawOutput;
}

/** Isolate closure storage from the caller's previous memo and full frame inputs. */
function createScenePassPreparation(
  dispatchOrdered: boolean,
  nativeStart: number,
  nativeEnd: number,
  materialRows: readonly MaterialRelationFrame[] | undefined,
  rows: DrawRows,
  dispatch: DispatchList,
  buckets: readonly FoldBucket[],
  prepared: ReadonlyMap<ScenePassRequest, PreparedPassRange>,
  materials: MaterialFrame,
): ScenePassPreparation {
  let finished:
    | {
        readonly rows: AddressedPlan['validatedOrdered'];
        readonly materialSlots: AddressedPlan['materialSlots'];
        readonly slotIndices: AddressedPlan['materialSlotIndices'];
        readonly work: ReadonlyMap<ScenePassRequest, ScenePassDraws>;
      }
    | undefined;
  return {
    dispatchOrdered,
    nativeStart,
    nativeEnd,
    materialRows,
    rows,
    dispatch,
    buckets,
    finish(
      plan: ReturnType<typeof buildDispatchPlan>,
    ): ReadonlyMap<ScenePassRequest, ScenePassDraws> {
      // Physical rows and material relations own their immutable publications.
      // Compare distinct accepted materials, without revisiting their draw users.
      const retain = materialRows !== undefined && plan.foldDispatchPlan === null;
      if (
        retain &&
        finished?.rows === plan.validatedOrdered &&
        finished.slotIndices === plan.materialSlotIndices &&
        finished.materialSlots.length === plan.materialSlots.length
      ) {
        const accepted = finished.materialSlots;
        if (plan.materialSlots.every((material, slot) => accepted[slot] === material))
          return finished.work;
      }
      finished = undefined;
      const work = new Map<ScenePassRequest, ScenePassDraws>();
      if (rows.length === 0) {
        let empty = true;
        for (const candidate of prepared.values()) empty &&= candidate.dispatch.length === 0;
        if (empty) {
          for (const request of prepared.keys()) work.set(request, emptyScenePassDraws);
          return work;
        }
      }
      const ranges: PassPositions[] = [];
      const submitted = plan.validatedOrdered;
      const phaseOrder = dispatchOrdered && plan.phaseOrderedRows === submitted;
      for (const candidate of prepared.values()) {
        const positions = new PassPositions(candidate.start, candidate.end);
        if (phaseOrder) {
          positions.first = candidate.start;
          positions.length = Math.max(
            0,
            Math.min(candidate.end, submitted.length) - candidate.start,
          );
        }
        ranges.push(positions);
      }
      if (!phaseOrder) indexSubmittedPositions(ranges, submitted, rows.length);
      let rangeIndex = 0;
      for (const [request, candidate] of prepared) {
        const positions = ranges[rangeIndex++] as PassPositions;
        work.set(
          request,
          finishScenePassRequest(request, candidate, plan, positions, phaseOrder, materials),
        );
      }
      if (retain)
        finished = {
          rows: plan.validatedOrdered,
          materialSlots: plan.materialSlots,
          slotIndices: plan.materialSlotIndices,
          work,
        };
      return work;
    },
  };
}

function projectPassFoldDispatch(
  fold: FoldDispatchPlan | null,
  positions: PassPositions,
): FoldDispatchPlan | null {
  let headBuckets: Map<number, FoldBucket> | undefined;
  let skipIndices: Set<number> | undefined;
  if (fold != null)
    for (let local = 0; local < positions.length; local++) {
      const global = positions.position(local);
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
  return headBuckets === undefined
    ? null
    : {
        headBuckets,
        skipIndices: skipIndices ?? new Set(),
        foldedBucketCount: headBuckets.size,
      };
}

function finishScenePassRequest(
  request: ScenePassRequest,
  candidate: PreparedPassRange,
  plan: AddressedPlan,
  positions: PassPositions,
  phaseOrder: boolean,
  materials: MaterialFrame,
): ScenePassDraws {
  const owned = completeOwnedPassRequest(
    request,
    materials,
    positions.length,
    candidate.end - candidate.start,
  );
  const slots = plan.materialSlotIndices;
  // Every submitted position was appended exactly once in plan order. A
  // request covering the entire plan already owns the required row/slot order.
  const entirePlan = positions.length === plan.validatedOrdered.length;
  const submitted = plan.validatedOrdered;
  const phaseRows =
    phaseOrder && submitted instanceof JoinedDrawRows
      ? submitted.exactRange(positions.first, positions.length)
      : undefined;
  const validatedOrdered = phaseRows ?? positions.select(submitted);
  const foldDispatchPlan = projectPassFoldDispatch(plan.foldDispatchPlan, positions);
  const roster = {
    validatedOrdered,
    dispatch: candidate.dispatch,
    materialSlots: plan.materialSlots,
    materialSlotIndices: entirePlan
      ? slots
      : Array.isArray(slots) && slots.length === plan.validatedOrdered.length
        ? positions.select<readonly number[]>(slots)
        : new FrameProjection(positions, (index) => slots.at(index) ?? emptySlotRow),
  };
  const geometry = preparedGeometryPasses(owned, candidate, validatedOrdered, positions.ordered);
  return {
    ...roster,
    start: candidate.start,
    end: candidate.end,
    geometryMaterialPasses: geometry,
    foldDispatchPlan,
    mainPassMaterialSelection: createMainPassMaterialSelectionOwner(
      roster,
      owned,
      geometry?.groups,
    ),
  };
}

/** Join this frame's sparse water addresses to its physical pass ranges in submission order. */
export function scenePassWaterDraws(
  work: ReadonlyMap<ScenePassRequest, ScenePassDraws> | undefined,
  water: WaterMaterialAdmissionDrawClosure | undefined,
): ReadonlyMap<ScenePassDraws, WaterMaterialAdmissionDrawClosure> | undefined {
  if (work === undefined || water === undefined || water.draws.length === 0) return undefined;
  const ranges = Array.from(work.values());
  return partitionWaterMaterialDraws(water, (address) => {
    const range = ranges[findSubmittedRange(ranges, address)];
    return range !== undefined && address >= range.start ? range : undefined;
  });
}

function issuedScenePassDraws(c: _InternalRenderPipelineContext, request: ScenePassRequest) {
  if (c.scenePassWork === undefined) return undefined;
  const work = c.scenePassWork.get(request);
  if (work === undefined)
    throw new RhiError({
      code: 'internal-error',
      expected: 'prepared draw work for the executing Scene Pass',
      hint: 'prepare requests from the actual compiled graph before recording',
    });
  return work;
}

/** Admission reads the same fixed rows and material slots that recording consumes.
 * No lighting, GPU bindings, or other frame context is needed for that selection. */
export function scenePassMaterialRows(
  c: _InternalRenderPipelineContext,
  request: ScenePassRequest,
) {
  return issuedScenePassDraws(c, request) ?? c;
}

export function scenePassContext(
  c: _InternalRenderPipelineContext,
  request: ScenePassRequest,
): _InternalRenderPipelineContext {
  const work = issuedScenePassDraws(c, request);
  if (work === undefined) return c;
  // Ownership was consumed while preparing this pass's CPU rows. Keep the
  // complete detached frame shape and clear selection instead of rebuilding
  // every property through object-rest exclusion.
  const waterOwner = c.waterMaterialRecordCache;
  const scopedWater =
    waterOwner !== undefined &&
    waterOwner.validatedOrdered === c.validatedOrdered &&
    waterOwner.passes === c.scenePassWork;
  return {
    ...c,
    ...work,
    materialSlots: c.materialSlots,
    scenePassDraws: scopedWater ? work : undefined,
    gpuDrivenSelection: undefined,
  };
}
