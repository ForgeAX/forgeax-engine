import type { AssetHandle } from '@forgeax/engine-types';
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
import { type FrameList, FrameListBase, RetainedFrameProjection } from './scene/frame-list';
import { FrameSet } from './scene/frame-set';
import { visitCapturedPassRanks } from './scene/material-dispatch';
import { hasRasterDemand } from './scene/raster-demand';
import { sceneDrawContentOf } from './scene/render-scene-view';
import type { RowContent } from './scene/row-contents';
import { SelectedSceneDrawRows } from './scene/selected-draw-rows';
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
  };
}

function displayColumns(rows: FrameList<RenderableSnapshot>) {
  return SelectedSceneDrawRows.native(rows) ? rows : sceneDrawContentOf(rows);
}

/** Select current display rows in source order, including rows with multiple passes. */
export function projectDisplayRenderables(
  renderables: FrameList<RenderableSnapshot>,
  dispatch: DispatchList,
  camera?: Pick<CameraSnapshot, 'cullMask'>,
): FrameList<RenderableSnapshot> {
  const count = renderables.length;
  let prefix = 0;
  let later: Uint32Array | undefined;
  const include = (index: number): void => {
    if (index === prefix) {
      prefix++;
      while (
        later !== undefined &&
        prefix < count &&
        ((later[prefix >>> 5] ?? 0) & (1 << (prefix & 31))) !== 0
      )
        prefix++;
    } else if (Number.isInteger(index)) {
      later ??= new Uint32Array(Math.ceil(count / 32));
      const word = index >>> 5;
      later[word] = (later[word] ?? 0) | (1 << (index & 31));
    }
  };
  if (
    !visitCapturedPassRanks(dispatch, 'display', (index) => {
      if (index >= prefix && index < count) include(index);
    })
  ) {
    for (const entry of dispatch) {
      const index = entry.renderableIndex;
      if (
        index === undefined ||
        index < prefix ||
        index >= count ||
        entry.tags.LightMode === 'ShadowCaster'
      )
        continue;
      include(index);
    }
  }
  if (
    prefix === count &&
    renderables instanceof RetainedFrameProjection &&
    renderables.facts?.rasterRowCount === count &&
    (camera === undefined ||
      (renderables.facts.allDefaultRenderLayers === true &&
        ((camera.cullMask ?? 0xffffffff) & 1) !== 0))
  )
    return renderables;
  const selected = (row: RowContent, i: number): boolean =>
    (i < prefix || (later !== undefined && ((later[i >>> 5] ?? 0) & (1 << (i & 31))) !== 0)) &&
    hasRasterDemand(row) &&
    (camera === undefined || cameraAdmitsLayers(camera, row));
  if (
    SelectedSceneDrawRows.native(renderables) &&
    renderables.filter === FrameListBase.prototype.filter
  )
    return renderables.selectDisplay(selected);
  const columns = sceneDrawContentOf(renderables);
  if (
    columns === undefined ||
    !columns.permitsSlotCull(undefined) ||
    renderables.filter !== FrameListBase.prototype.filter
  )
    return renderables.filter(selected);
  let rank = 0;
  const members = FrameSet.collect((add) => {
    columns.source.findContent((content, _entity, slot) => {
      if (selected(content, rank++)) add(slot);
      return undefined;
    });
  });
  if (members.size === count) return renderables;
  return members.size === 0 ? [] : new SelectedSceneDrawRows(columns, members);
}

/**
 * The display workset of a GPU-owned frame that needs CPU evidence: residual
 * rows of the submitted selection. Rows it draws are ready by construction.
 */
export function projectResidualDisplayRows(
  frame: Pick<ExtractedFrame, 'cameraVisible'>,
  gpuOwned: GpuOwnedFrame,
  selection: GpuDrawSelection,
  camera?: Pick<CameraSnapshot, 'cullMask'>,
): readonly RenderableSnapshot[] {
  return gpuOwned
    .residual(selection)
    .filter(
      (row) =>
        gpuOwned.displays(row) &&
        hasRasterDemand(row) &&
        (camera === undefined || cameraAdmitsLayers(camera, row)) &&
        frame.cameraVisible?.(row) !== false,
    );
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
    if (this.others !== undefined)
      for (const [material, entity] of this.others) if (pending(material)) return entity;
    return undefined;
  }
}

/** Check material readiness once, after the display work has actually submitted. */
export function projectFramePresentation(input: {
  readonly renderables: FrameList<RenderableSnapshot>;
  readonly admits?: MaterialAdmission | undefined;
  /** Actual submitted geometry. Without a receipt this call only observes materials. */
  readonly draws?: PresentationDraws | undefined;
  /** Materials of GPU-executed bindings, standing for every row they draw. */
  readonly coveredBindings?: Iterable<{
    readonly material: MaterialResource;
  }>;
  readonly preparedSourceScope: RenderResourceScope;
  readonly internals: RenderSystemInternals;
  readonly onPending?: (reason: FramePresentationPendingReason) => void;
}): FramePresentation {
  const columns = input.admits === undefined ? displayColumns(input.renderables) : undefined;
  let bindings: VisibleMaterialBindings | undefined;
  if (input.draws !== undefined) {
    const draws = input.draws;
    let gap: FramePresentationPendingReason | undefined;
    if (columns?.fixedMaterialReads === true) {
      // The receipt must prove every required draw before observing any resident
      // material. Gather the exact visible bindings during that same column walk.
      const visible = new VisibleMaterialBindings();
      gap = columns.findDrawContent(true, (entity, content) => {
        const missing = renderableDrawGap(
          content,
          entity,
          entity,
          draws,
          input.preparedSourceScope,
          input.internals,
        );
        if (missing === undefined) visible.include(entity, content.materials);
        return missing;
      });
      // A material can publish a borrowed value after the scene was captured.
      // Keep each of its live reads in the original entity order.
      if (gap === undefined && visible.allOwned()) bindings = visible;
    } else {
      gap = missingDrawEvidence(
        input.renderables,
        draws,
        input.preparedSourceScope,
        input.internals,
        input.admits,
      );
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
  if (columns !== undefined) {
    const entity =
      bindings === undefined
        ? columns.findDrawContent(true, (entity, draw) => {
            for (let i = 0; i < draw.materials.length; i++)
              if (pending(draw.materials[i] as MaterialResource)) return entity;
            return undefined;
          })
        : bindings.firstPending(pending);
    if (entity !== undefined) {
      input.onPending?.({ code: 'material-residency', entity });
      return 'pending';
    }
  } else {
    for (const renderable of input.renderables) {
      for (const material of renderable.materials) {
        if (input.admits?.(renderable, material) !== false && pending(material)) {
          input.onPending?.({
            code: 'material-residency',
            entity: renderable.entityKey,
          });
          return 'pending';
        }
      }
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

type PresentationDraws = ReturnType<typeof createPresentationDraws>;

/**
 * First submitted-draw gap among the display workset: every entity, terrain
 * section and submesh must have drawn against resident mesh handles.
 */
type MaterialAdmission = (row: RenderableSnapshot, material: MaterialResource) => boolean;

export function missingDrawEvidence(
  renderables: FrameList<RenderableSnapshot>,
  draws: PresentationDraws,
  preparedSourceScope: RenderResourceScope,
  internals: RenderSystemInternals,
  admits?: MaterialAdmission,
): FramePresentationPendingReason | undefined {
  const columns = admits === undefined ? displayColumns(renderables) : undefined;
  if (columns !== undefined)
    return columns.findDrawContent(false, (entity, content) =>
      renderableDrawGap(content, entity, entity, draws, preparedSourceScope, internals),
    );
  for (const renderable of renderables) {
    const entityKey = renderable.entityKey;
    const missing = renderableDrawGap(
      renderable,
      entityKey,
      renderable.entityKey,
      draws,
      preparedSourceScope,
      internals,
      admits === undefined ? undefined : (material) => admits(renderable, material),
    );
    if (missing !== undefined) return missing;
  }
  return undefined;
}

function renderableDrawGap(
  renderable: RowContent,
  entityKey: number,
  entity: number,
  draws: PresentationDraws,
  preparedSourceScope: RenderResourceScope,
  internals: RenderSystemInternals,
  admits?: (material: MaterialResource) => boolean,
): FramePresentationPendingReason | undefined {
  // Runs for every displayed row of every frame: the pending reason is
  // allocated only when a gap is actually found.
  if (!draws.hasEntity(entityKey)) return { code: 'draw-entity-missing', entity };
  const renderableWorld = preparedSourceScope;
  const meshHandles =
    renderableWorld === undefined
      ? undefined
      : renderable.generatedMesh !== undefined
        ? internals.gpuStore.getGeneratedMesh(renderable.generatedMesh)
        : internals.gpuStore.getMeshGpuHandles(
            renderable.assetHandle as AssetHandle<'mesh'>,
            renderableWorld,
          );
  if (meshHandles === undefined) return { code: 'mesh-residency', entity };
  const terrain = renderable.terrainSection;
  if (terrain !== undefined && !draws.hasTerrain(entityKey, terrain.index))
    return { code: 'draw-terrain-missing', entity, section: terrain.index };
  if (renderable.pointsLines !== undefined) return undefined;
  const submeshCount = meshHandles.submeshes.length;
  for (let submesh = 0; submesh < submeshCount; submesh++) {
    if (admits) {
      const slot = meshHandles.submeshes[submesh]?.materialSlot;
      if (
        !admits(
          (slot === undefined ? undefined : renderable.materials[slot]) ?? renderable.material,
        )
      )
        continue;
    }
    if (!draws.hasSubmesh(entityKey, submesh))
      return { code: 'draw-submesh-missing', entity, submesh };
  }
  return undefined;
}

/** Recording starts lazy image projection; only resident cube/IBL publication qualifies. */
export function skyCubemapPending(
  handles: readonly (number | undefined)[],
  internals: RenderSystemInternals,
  resourceWorld: RenderResourceScope,
): boolean {
  return handles.some(
    (handle) =>
      handle !== undefined &&
      handle !== 0 &&
      (internals.gpuStore.getCubemapStatus(handle as AssetHandle<'equirect'>, resourceWorld) !==
        'ready' ||
        internals.gpuStore.getCubemapGpuView(handle as AssetHandle<'equirect'>, resourceWorld) ===
          undefined),
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
