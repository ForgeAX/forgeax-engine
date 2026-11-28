import type { AssetHandle } from '@forgeax/engine-types';
import type { MeshGpuHandles } from './device/gpu-residency';
import type { GpuDrawSelection } from './gpu-driven/draw-selection';
import type { MaterialResource } from './material-resource';
import type { RenderResourceScope } from './publication/resource-scope';
import type { RenderSystemInternals } from './record/render-context';
import type {
  CameraSnapshot,
  FramePresentation,
  FramePresentationPendingReason,
} from './render-contract';
import { cameraAdmitsLayers } from './render-layers';
import type {
  DispatchList,
  ExtractedFrame,
  GpuOwnedFrame,
  RenderableSnapshot,
} from './render-system-extract';
import { createMaterialResidencyObserver } from './render-system-residency';
import {
  EMPTY_FRAME_ROWS,
  type FrameList,
  FrameListBase,
  RetainedFrameProjection,
  type SparseRowKind,
} from './scene/frame-list';
import { visitCapturedPassRanks } from './scene/material-dispatch';
import { hasRasterDemand } from './scene/raster-demand';
import {
  type DrawContentAdmission,
  sceneDrawContentOf,
  sceneSurfaceRowsOf,
} from './scene/render-scene-view';
import type { RowContent } from './scene/row-contents';
import { SelectedSceneDrawRows } from './scene/selected-draw-rows';
import { isResidualDrawRows } from './scene/view-cull';
import type { ViewLights } from './world/render-lights';

/** The existing boolean remains the readiness authority; record only its first owner. */
export function markPipelinePreparationPending(
  state: {
    pipelinePreparationPending?: boolean;
    pipelinePreparationPendingReason?: FramePresentationPendingReason;
  },
  reason: FramePresentationPendingReason,
): void {
  state.pipelinePreparationPending = true;
  state.pipelinePreparationPendingReason ??= Object.freeze(reason);
}

type DrawIndices = Map<number, number | Set<number> | undefined>;

function addDrawIndex(draws: DrawIndices, entity: number, index: number | undefined): void {
  const previous = draws.get(entity);
  if (previous === undefined) draws.set(entity, index);
  else if (index !== undefined) {
    if (typeof previous === 'number') {
      if (previous !== index) draws.set(entity, new Set([previous, index]));
    } else previous.add(index);
  }
}

function hasDrawIndex(draws: DrawIndices, entity: number, index: number): boolean {
  const previous = draws.get(entity);
  return typeof previous === 'number'
    ? previous === index || Object.is(previous, index)
    : previous?.has(index) === true;
}

/** Primary submesh evidence occupies one word per 32 stable entity keys. Extra
 * submeshes, unindexed draws and terrain have separate sparse evidence. All
 * storage belongs to the recording attempt, including when views overlap. */
export function createPresentationDraws() {
  let page: number | undefined;
  let mask = 0;
  let otherPages: Map<number, number> | undefined;
  let submeshes: DrawIndices | undefined;
  let terrain: DrawIndices | undefined;
  const hasPrimary = (entity: number): boolean => {
    if (!Number.isSafeInteger(entity)) return false;
    const key = Math.floor(entity / 32);
    const word = key === page ? mask : (otherPages?.get(key) ?? 0);
    return (word & (1 << (entity & 31))) !== 0;
  };
  return {
    record(entity: number, submesh: number | undefined, terrainSection?: number): void {
      if (submesh === 0 && Number.isSafeInteger(entity)) {
        const key = Math.floor(entity / 32);
        if (page !== key) {
          if (page !== undefined) {
            otherPages ??= new Map();
            otherPages.set(page, mask);
          }
          page = key;
          mask = otherPages?.get(key) ?? 0;
        }
        mask |= 1 << (entity & 31);
      } else {
        submeshes ??= new Map();
        addDrawIndex(submeshes, entity, submesh);
      }
      if (submesh !== undefined && terrainSection !== undefined) {
        terrain ??= new Map();
        addDrawIndex(terrain, entity, terrainSection);
      }
    },
    hasEntity: (entity: number): boolean => hasPrimary(entity) || submeshes?.has(entity) === true,
    hasSubmesh: (entity: number, submesh: number): boolean =>
      (submesh === 0 && hasPrimary(entity)) ||
      (submeshes !== undefined && hasDrawIndex(submeshes, entity, submesh)),
    hasTerrain: (entity: number, section: number): boolean =>
      terrain !== undefined && hasDrawIndex(terrain, entity, section),
    firstMissingSubmesh(entity: number, count: number): number | undefined {
      const start = hasPrimary(entity) ? 1 : 0;
      if (start >= count) return undefined;
      const extra = submeshes?.get(entity);
      for (let index = start; index < count; index++)
        if (typeof extra === 'number' ? extra !== index : extra?.has(index) !== true) return index;
      return undefined;
    },
  };
}

export type PresentationDrawEvidence = Omit<ReturnType<typeof createPresentationDraws>, 'record'>;

/** A mixed row keeps its actual CPU draw bits and borrows GPU evidence from
 * the submitted selection only when a consumer asks about an uncovered draw. */
export function submittedDrawEvidence(
  cpu: PresentationDrawEvidence,
  frame: Pick<GpuOwnedFrame, 'row'>,
  selection: GpuDrawSelection,
): PresentationDrawEvidence {
  const drawableRow = (entity: number) => {
    const row = frame.row(entity);
    return row !== undefined && hasRasterDemand(row) ? row : undefined;
  };
  const owns = (entity: number, submesh?: number, section?: number): boolean => {
    const row = drawableRow(entity);
    if (row === undefined) return false;
    if (section !== undefined && row.terrainSection?.index !== section) return false;
    return submesh === undefined
      ? selection.ownsAny(row)
      : selection.hasSubmittedSection(row, submesh);
  };
  return {
    hasEntity: (entity) => cpu.hasEntity(entity) || owns(entity),
    hasSubmesh: (entity, submesh) => cpu.hasSubmesh(entity, submesh) || owns(entity, submesh),
    hasTerrain: (entity, section) =>
      cpu.hasTerrain(entity, section) || owns(entity, undefined, section),
    firstMissingSubmesh: (entity, count) => {
      const first = cpu.firstMissingSubmesh(entity, count);
      if (first === undefined) return undefined;
      const row = drawableRow(entity);
      if (row === undefined || !selection.hasSubmittedSection(row, first)) return first;
      for (let index = first + 1; index < count; index++)
        if (!cpu.hasSubmesh(entity, index) && !selection.hasSubmittedSection(row, index))
          return index;
      return undefined;
    },
  };
}

function displayColumnsOf(rows: FrameList<RenderableSnapshot>) {
  return SelectedSceneDrawRows.native(rows) ? rows : sceneDrawContentOf(rows);
}

/** The frame's own row address space also serves the first GPU submission. */
export function submittedDrawRows(
  frame: Pick<ExtractedFrame, 'gpuOwned' | 'renderables'>,
): Pick<GpuOwnedFrame, 'row'> | undefined {
  return frame.gpuOwned ?? displayColumnsOf(frame.renderables);
}

type DisplayCamera = Pick<CameraSnapshot, 'cullMask'>;

/** Use only source ranks. Native presentation does not issue another Scene roster. */
class DisplayRanks {
  private prefix = 0;
  private later: Uint32Array | undefined;

  constructor(
    private readonly count: number,
    dispatch: DispatchList,
  ) {
    const visit = (index: number) => {
      if (index >= this.prefix && index < count) this.include(index);
    };
    if (visitCapturedPassRanks(dispatch, 'display', visit)) return;
    for (const entry of dispatch) {
      const index = entry.renderableIndex;
      if (
        index === undefined ||
        index < this.prefix ||
        index >= count ||
        entry.tags.LightMode === 'ShadowCaster'
      )
        continue;
      this.include(index);
    }
  }

  private include(index: number): void {
    if (index === this.prefix) {
      this.prefix++;
      while (this.prefix < this.count && this.has(this.prefix)) this.prefix++;
    } else if (Number.isInteger(index)) {
      this.later ??= new Uint32Array(Math.ceil(this.count / 32));
      const word = index >>> 5;
      this.later[word] = (this.later[word] ?? 0) | (1 << (index & 31));
    }
  }

  has(rank: number): boolean {
    return rank < this.prefix || ((this.later?.[rank >>> 5] ?? 0) & (1 << (rank & 31))) !== 0;
  }

  covers(renderables: FrameList<RenderableSnapshot>, camera: DisplayCamera | undefined): boolean {
    return (
      this.prefix === this.count &&
      renderables instanceof RetainedFrameProjection &&
      renderables.facts?.rasterRowCount === this.count &&
      (camera === undefined ||
        (renderables.facts.allDefaultRenderLayers === true &&
          ((camera.cullMask ?? 0xffffffff) & 1) !== 0))
    );
  }

  /** The geometry walk clears ineligible ranks. Material observation then reads the same admission. */
  prepare(camera: DisplayCamera | undefined) {
    const words = this.later ?? new Uint32Array(Math.ceil(this.count / 32));
    const full = this.prefix >>> 5;
    words.fill(0xffffffff, 0, full);
    if ((this.prefix & 31) !== 0) words[full] = (words[full] ?? 0) | (2 ** (this.prefix & 31) - 1);
    const view = camera === undefined ? undefined : { cullMask: camera.cullMask ?? 0xffffffff };
    const admits: DrawContentAdmission = (row, rank) => {
      const word = rank >>> 5;
      const bit = 1 << (rank & 31);
      const value = words[word] ?? 0;
      if ((value & bit) === 0) return false;
      if (displayDemand(row, view)) return true;
      words[word] = value & ~bit;
      return false;
    };
    const accepted: DrawContentAdmission = (_row, rank) =>
      ((words[rank >>> 5] ?? 0) & (1 << (rank & 31))) !== 0;
    return { admits, accepted };
  }
}

function displayDemand(row: RowContent, camera: DisplayCamera | undefined): boolean {
  return hasRasterDemand(row) && (camera === undefined || cameraAdmitsLayers(camera, row));
}

/** A retained subset for consumers that need it beyond this call, including terrain. */
export function projectDisplayRenderables(
  renderables: FrameList<RenderableSnapshot>,
  dispatch: DispatchList,
  camera?: DisplayCamera,
  kind?: SparseRowKind,
): FrameList<RenderableSnapshot> {
  const count = renderables.length;
  const ranks = new DisplayRanks(count, dispatch);
  if (kind === undefined && ranks.covers(renderables, camera)) return renderables;
  const selected = (row: RowContent, rank: number): boolean =>
    ranks.has(rank) && displayDemand(row, camera);
  const subset = SelectedSceneDrawRows.native(renderables) ? renderables : undefined;
  const columns = subset === undefined ? sceneDrawContentOf(renderables) : undefined;
  if (renderables.filter !== FrameListBase.prototype.filter) return renderables.filter(selected);
  if (subset !== undefined)
    return subset.selectDisplay(
      selected,
      kind === undefined ? undefined : subset.source.indexedSlots(kind),
    );
  if (columns === undefined || !columns.permitsSlotCull(undefined))
    return renderables.filter(selected);
  const indexed = kind === undefined ? undefined : columns.source.indexedSlots(kind);
  if (indexed?.size === 0) return EMPTY_FRAME_ROWS;
  const members = columns.source.selectContent(selected, undefined, indexed);
  if (members.size === count) return renderables;
  return members.size === 0 ? [] : new SelectedSceneDrawRows(columns, members);
}

/**
 * The display workset of a GPU-owned frame that needs CPU evidence: residual
 * rows of the submitted selection. Rows it draws are ready by construction.
 */
export function residualDisplayAdmission(
  frame: Pick<ExtractedFrame, 'cameraVisible'>,
  gpuOwned: Pick<GpuOwnedFrame, 'displays'>,
  camera?: Pick<CameraSnapshot, 'cullMask'>,
): (row: RenderableSnapshot) => boolean {
  return (row) =>
    gpuOwned.displays(row) &&
    hasRasterDemand(row) &&
    (camera === undefined || cameraAdmitsLayers(camera, row)) &&
    frame.cameraVisible?.(row) !== false;
}

/** First visible occurrence of each fixed binding, in submission order. The common
 * single-material view uses two fields. A second distinct material opens the index. */
class VisibleMaterialBindings {
  private first: MaterialResource | undefined;
  private entity = 0;
  private others: Map<MaterialResource, number> | undefined;

  include(entity: number, materials: readonly MaterialResource[]): void {
    for (let i = 0; i < materials.length; i++) {
      const material = materials[i] as MaterialResource;
      if (material === this.first) continue;
      if (this.first === undefined) {
        this.first = material;
        this.entity = entity;
      } else {
        this.others ??= new Map();
        if (!this.others.has(material)) this.others.set(material, entity);
      }
    }
  }

  allOwned(): boolean {
    if (this.first !== undefined && !this.first.ownsValues(this.first.snapshot)) return false;
    if (this.others !== undefined)
      for (const material of this.others.keys())
        if (!material.ownsValues(material.snapshot)) return false;
    return true;
  }

  firstPending(pending: (material: MaterialResource) => boolean): number | undefined {
    if (this.first !== undefined && pending(this.first)) return this.entity;
    const others = this.others;
    if (others !== undefined)
      for (const material of others.keys()) if (pending(material)) return others.get(material);
    return undefined;
  }
}

interface FramePresentationInput {
  readonly renderables: FrameList<RenderableSnapshot>;
  readonly admits?: MaterialAdmission | undefined;
  /** Additional eligibility of residual rows in the submitted view. */
  readonly rowAdmits?: ((row: RenderableSnapshot) => boolean) | undefined;
  /** Actual submitted geometry. Without a receipt this call only observes materials. */
  readonly draws?: PresentationDrawEvidence | undefined;
  /** Materials of GPU-executed bindings, standing for every row they draw. */
  readonly coveredBindings?: Iterable<{
    readonly material: MaterialResource;
  }>;
  readonly preparedSourceScope: RenderResourceScope;
  readonly internals: RenderSystemInternals;
  readonly onPending?: (reason: FramePresentationPendingReason) => void;
}

function presentationRows(
  input: FramePresentationInput,
  needsSelection: boolean,
  dispatch: DispatchList | undefined,
  camera: DisplayCamera | undefined,
) {
  const { renderables } = input;
  const columns = displayColumnsOf(renderables);
  if (dispatch === undefined)
    return { renderables, columns: needsSelection ? undefined : columns, display: undefined };
  if (
    columns === undefined ||
    renderables.filter !== FrameListBase.prototype.filter ||
    (!(columns instanceof SelectedSceneDrawRows) && !columns.permitsSlotCull(undefined)) ||
    (needsSelection &&
      (input.draws === undefined || sceneSurfaceRowsOf(renderables, renderables.at) === undefined))
  ) {
    const subset = projectDisplayRenderables(renderables, dispatch, camera);
    return {
      renderables: subset,
      columns: needsSelection ? undefined : displayColumnsOf(subset),
      display: undefined,
    };
  }
  const ranks = new DisplayRanks(renderables.length, dispatch);
  return {
    renderables,
    columns,
    display: ranks.covers(renderables, camera) ? undefined : ranks.prepare(camera),
  };
}

/** Check material readiness once, after the display work has actually submitted. */
export function projectFramePresentation(
  input: FramePresentationInput,
  dispatch?: DispatchList,
  camera?: DisplayCamera,
): FramePresentation {
  const needsSelection = input.rowAdmits !== undefined || input.admits !== undefined;
  const { renderables, columns, display } = presentationRows(
    input,
    needsSelection,
    dispatch,
    camera,
  );
  let materialRows: Iterable<RenderableSnapshot> = renderables;
  let bindings: VisibleMaterialBindings | undefined;
  if (input.draws !== undefined) {
    const draws = input.draws;
    const readMesh = presentationMeshReader(input.preparedSourceScope, input.internals);
    let gap: FramePresentationPendingReason | undefined;
    if (needsSelection) {
      const selected = collectSubmittedRows(
        renderables,
        input,
        draws,
        readMesh,
        columns,
        display?.admits,
      );
      if ('gap' in selected) gap = selected.gap;
      else materialRows = selected.rows;
    } else if (columns !== undefined) {
      // The receipt must prove every required draw before observing any resident
      // material. Gather the exact visible bindings during that same column walk.
      const visible = columns.fixedMaterialReads ? new VisibleMaterialBindings() : undefined;
      gap = columns.findDrawContent(
        visible !== undefined,
        (entity, content) => {
          const missing = renderableDrawGap(content, entity, draws, readMesh);
          if (missing === undefined) visible?.include(entity, content.materials);
          return missing;
        },
        display?.admits,
      );
      // A material can publish a borrowed value after the scene was captured.
      // Keep each of its live reads in the original entity order.
      if (gap === undefined && visible?.allOwned()) bindings = visible;
    } else {
      gap = firstDrawGap(renderables, draws, readMesh);
    }
    if (gap !== undefined) {
      input.onPending?.(gap);
      return 'pending';
    }
  }
  const observeResidency = createMaterialResidencyObserver(input.internals, false);
  const pending = (material: MaterialResource): boolean => {
    const snapshot = material.snapshot;
    const readiness = observeResidency(
      input.preparedSourceScope,
      snapshot,
      material.ownsValues(snapshot),
    ).readiness;
    return readiness === 'pending' || readiness === 'failed';
  };
  if (columns !== undefined && !needsSelection) {
    const entity =
      bindings === undefined
        ? columns.findDrawContent(
            true,
            (entity, draw) => {
              for (let i = 0; i < draw.materials.length; i++)
                if (pending(draw.materials[i] as MaterialResource)) return entity;
              return undefined;
            },
            input.draws === undefined ? display?.admits : display?.accepted,
          )
        : bindings.firstPending(pending);
    if (entity !== undefined) {
      input.onPending?.({ code: 'material-residency', entity });
      return 'pending';
    }
  } else {
    const entity = firstPendingMaterialRow(materialRows, input.admits, pending);
    if (entity !== undefined) {
      input.onPending?.({ code: 'material-residency', entity });
      return 'pending';
    }
  }
  for (const { material } of input.coveredBindings ?? []) {
    if (pending(material)) {
      input.onPending?.({ code: 'material-residency' });
      return 'pending';
    }
  }
  return 'ready';
}

function firstPendingMaterialRow(
  rows: Iterable<RenderableSnapshot>,
  admits: MaterialAdmission | undefined,
  pending: (material: MaterialResource) => boolean,
): number | undefined {
  for (const row of rows)
    for (const material of row.materials)
      if (admits?.(row, material) !== false && pending(material)) return row.entityKey;
  return undefined;
}

/** One frame's presentation candidate; only the first pending reason is reported. */
export interface FramePresentationCandidate {
  presentation: FramePresentation;
  reason: FramePresentationPendingReason | undefined;
}

export function initialFramePresentation(
  cameraCount: number,
  environmentAvailable: boolean,
): FramePresentationCandidate {
  return cameraCount > 0 && !environmentAvailable
    ? { presentation: 'pending', reason: { code: 'environment-not-ready' } }
    : { presentation: 'ready', reason: undefined };
}

export function markFramePending(
  candidate: FramePresentationCandidate,
  reason: FramePresentationPendingReason,
): void {
  candidate.presentation = 'pending';
  candidate.reason ??= reason;
}

/**
 * First submitted-draw gap among the display workset: every entity, terrain
 * section and submesh must have drawn against resident mesh handles.
 */
type MaterialAdmission = (row: RenderableSnapshot, material: MaterialResource) => boolean;

function captureAdmitsRow(row: RenderableSnapshot, admits: MaterialAdmission): boolean {
  const materials = row.materials;
  if (materials.length === 0) return admits(row, row.material);
  for (const material of materials) if (admits(row, material)) return true;
  return false;
}

/** Rank evidence borrows the source's fixed addresses until the live materials are read. */
class VerifiedRowRanks implements Iterable<RenderableSnapshot> {
  private readonly words: Uint32Array;

  constructor(private readonly source: FrameList<RenderableSnapshot>) {
    this.words = new Uint32Array(Math.ceil(source.length / 32));
  }

  add(rank: number): void {
    const word = rank >>> 5;
    this.words[word] = (this.words[word] ?? 0) | (1 << (rank & 31));
  }

  *[Symbol.iterator](): IterableIterator<RenderableSnapshot> {
    for (let word = 0; word < this.words.length; word++) {
      for (let bits = this.words[word] ?? 0; bits !== 0; bits &= bits - 1) {
        const rank = word * 32 + 31 - Math.clz32(bits & -bits);
        const row = this.source.at(rank);
        if (row === undefined)
          throw new Error('Verified presentation rank must remain addressable');
        yield row;
      }
    }
  }
}

/** Keep only rows whose geometry is proven for the later, ordered material reads. */
function collectSubmittedRows(
  renderables: FrameList<RenderableSnapshot>,
  { rowAdmits, admits }: FramePresentationInput,
  draws: PresentationDrawEvidence,
  readMesh: PresentationMeshReader,
  columns: ReturnType<typeof displayColumnsOf>,
  displayAdmits: DrawContentAdmission | undefined,
): { rows: Iterable<RenderableSnapshot> } | { gap: FramePresentationPendingReason } {
  const indexed =
    columns !== undefined ||
    isResidualDrawRows(renderables) ||
    (displayColumnsOf(renderables) !== undefined &&
      sceneSurfaceRowsOf(renderables, renderables.at) !== undefined);
  let verified: VerifiedRowRanks | undefined;
  let borrowed: RenderableSnapshot[] | undefined;
  const verify = (row: RenderableSnapshot, rank: number) => {
    if (rowAdmits?.(row) === false || (admits !== undefined && !captureAdmitsRow(row, admits)))
      return undefined;
    const gap = submittedRowGap(row, draws, readMesh, admits);
    if (gap !== undefined) return gap;
    if (indexed) {
      verified ??= new VerifiedRowRanks(renderables);
      verified.add(rank);
    } else {
      borrowed ??= [];
      borrowed.push(row);
    }
    return undefined;
  };
  if (columns !== undefined && displayAdmits !== undefined) {
    // Capture admission needs the authored draw row. Filter its raw columns
    // first so hidden members never materialize, then borrow only the chosen ranks.
    const members =
      columns instanceof SelectedSceneDrawRows ? columns.submittedSlots(columns.source) : undefined;
    let rank = 0;
    const gap = columns.source.findContent((content) => {
      const current = rank++;
      if (!displayAdmits(content, current)) return undefined;
      const row = renderables.at(current);
      if (row === undefined) throw new Error('Display rank must remain addressable');
      return verify(row, current);
    }, members);
    if (gap !== undefined) return { gap };
  } else {
    let rank = 0;
    for (const row of renderables) {
      const gap = verify(row, rank++);
      if (gap !== undefined) return { gap };
    }
  }
  return { rows: verified ?? borrowed ?? EMPTY_FRAME_ROWS };
}

function submittedRowGap(
  row: RenderableSnapshot,
  draws: PresentationDrawEvidence,
  readMesh: PresentationMeshReader,
  admits?: MaterialAdmission,
): FramePresentationPendingReason | undefined {
  return renderableDrawGap(
    row,
    row.entityKey,
    draws,
    readMesh,
    admits === undefined ? undefined : (material) => admits(row, material),
  );
}

export function missingDrawEvidence(
  renderables: FrameList<RenderableSnapshot>,
  draws: PresentationDrawEvidence,
  preparedSourceScope: RenderResourceScope,
  internals: RenderSystemInternals,
  admits?: MaterialAdmission,
): FramePresentationPendingReason | undefined {
  return firstDrawGap(
    renderables,
    draws,
    presentationMeshReader(preparedSourceScope, internals),
    admits,
  );
}

type PresentationMeshReader = (
  assetHandle: number | undefined,
  generatedMesh: RowContent['generatedMesh'],
) => MeshGpuHandles | undefined;

const missingMesh: PresentationMeshReader = () => undefined;

function presentationMeshReader(
  scope: RenderResourceScope | undefined,
  internals: RenderSystemInternals,
): PresentationMeshReader {
  return scope === undefined
    ? missingMesh
    : (internals.gpuStore?.meshResidencyReader(scope) ?? missingMesh);
}

function firstDrawGap(
  renderables: FrameList<RenderableSnapshot>,
  draws: PresentationDrawEvidence,
  readMesh: PresentationMeshReader,
  admits?: MaterialAdmission,
): FramePresentationPendingReason | undefined {
  const columns = admits === undefined ? displayColumnsOf(renderables) : undefined;
  if (columns !== undefined)
    return columns.findDrawContent(false, (entity, content) =>
      renderableDrawGap(content, entity, draws, readMesh),
    );
  for (const renderable of renderables) {
    const missing = submittedRowGap(renderable, draws, readMesh, admits);
    if (missing !== undefined) return missing;
  }
  return undefined;
}

function renderableDrawGap(
  renderable: RowContent,
  entity: number,
  draws: PresentationDrawEvidence,
  readMesh: PresentationMeshReader,
  admits?: (material: MaterialResource) => boolean,
): FramePresentationPendingReason | undefined {
  // Runs for every displayed row of every frame: the pending reason is
  // allocated only when a gap is actually found.
  if (!draws.hasEntity(entity)) return { code: 'draw-entity-missing', entity };
  const meshHandles = readMesh(renderable.assetHandle, renderable.generatedMesh);
  if (meshHandles === undefined) return { code: 'mesh-residency', entity };
  const terrain = renderable.terrainSection;
  if (terrain !== undefined && !draws.hasTerrain(entity, terrain.index))
    return { code: 'draw-terrain-missing', entity, section: terrain.index };
  if (renderable.pointsLines !== undefined) return undefined;
  const submeshCount = meshHandles.submeshes.length;
  if (admits === undefined) {
    const submesh = draws.firstMissingSubmesh(entity, submeshCount);
    return submesh === undefined ? undefined : { code: 'draw-submesh-missing', entity, submesh };
  }
  for (let submesh = 0; submesh < submeshCount; submesh++) {
    const slot = meshHandles.submeshes[submesh]?.materialSlot;
    const material =
      (slot === undefined ? undefined : renderable.materials[slot]) ?? renderable.material;
    if (admits(material) && !draws.hasSubmesh(entity, submesh))
      return { code: 'draw-submesh-missing', entity, submesh };
  }
  return undefined;
}

/** Recording starts lazy image projection; only resident cube/IBL publication qualifies. */
export function skyCubemapPending(
  handle: number | undefined,
  internals: RenderSystemInternals,
  resourceWorld: RenderResourceScope,
): boolean {
  return (
    handle !== undefined &&
    handle !== 0 &&
    (internals.gpuStore.getCubemapStatus(handle as AssetHandle<'equirect'>, resourceWorld) !==
      'ready' ||
      internals.gpuStore.getCubemapGpuView(handle as AssetHandle<'equirect'>, resourceWorld) ===
        undefined)
  );
}

/** Allocated point-shadow layers need complete finite matrices. */
function pointShadowPending(lights: ViewLights): boolean {
  return lights.pointShadow.some(
    (shadow) =>
      shadow.shadowAtlasLayer >= 0 &&
      (shadow.shadowMatrices.length < 96 || !shadow.shadowMatrices.every(Number.isFinite)),
  );
}

/**
 * Atlas overflow is admitted as direct lighting without a shadow. Only
 * allocated tiles participate in shadow readiness.
 */
function spotShadowPending(lights: ViewLights): boolean {
  return lights.spot.some(
    (spot) => spot.castShadow && spot.shadowAtlasTile >= 0 && spot.lightViewProj === undefined,
  );
}

/** Directional, point and spot shadow work requested by the frame must have produced results. */
export function verifySubmittedShadows(
  candidate: FramePresentationCandidate,
  lights: ViewLights,
  directionalShadowReady: boolean,
): void {
  if (candidate.presentation !== 'ready') return;
  if (!directionalShadowReady) markFramePending(candidate, { code: 'directional-shadow' });
  else if (pointShadowPending(lights)) markFramePending(candidate, { code: 'point-shadow' });
  else if (spotShadowPending(lights)) markFramePending(candidate, { code: 'spot-shadow' });
}
