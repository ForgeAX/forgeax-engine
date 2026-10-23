import type { AssetHandle } from '@forgeax/engine-types';
import type { RenderResourceScope } from './publication/resource-scope';
import { worldEntityKey } from './record/frame-snapshot';
import type { RenderSystemInternals } from './record/render-context';
import type { FramePresentation, FramePresentationPendingReason } from './render-contract';
import type { DispatchList, ExtractedLights, RenderableSnapshot } from './render-system-extract';
import { createMaterialResidencyObserver } from './render-system-residency';
import type { FrameList } from './scene/frame-list';

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

/** Frame-local submitted draw evidence; single-submesh entities need no string or Set. */
export function createPresentationDraws() {
  const submeshes: DrawIndices = new Map();
  const terrain: DrawIndices = new Map();
  return {
    record(entity: number, submesh: number | undefined, terrainSection?: number): void {
      addDrawIndex(submeshes, entity, submesh);
      if (submesh !== undefined && terrainSection !== undefined)
        addDrawIndex(terrain, entity, terrainSection);
    },
    hasEntity: (entity: number): boolean => submeshes.has(entity),
    hasSubmesh: (entity: number, submesh: number): boolean =>
      hasDrawIndex(submeshes, entity, submesh),
    hasTerrain: (entity: number, section: number): boolean =>
      hasDrawIndex(terrain, entity, section),
  };
}

const displayWorksets = new WeakMap<
  DispatchList,
  {
    readonly renderables: FrameList<RenderableSnapshot>;
    readonly value: FrameList<RenderableSnapshot>;
  }
>();

/**
 * Display workset used by recording and its later submitted-picture checks.
 * It reads only the fixed dispatch and immutable snapshots, so an unchanged
 * culled frame reuses the previous workset instead of rescanning every row.
 */
export function projectDisplayRenderables(
  renderables: FrameList<RenderableSnapshot>,
  dispatch: DispatchList,
): FrameList<RenderableSnapshot> {
  const cached = displayWorksets.get(dispatch);
  if (cached?.renderables === renderables) return cached.value;
  const displayRenderableIndices = new Set<number>();
  for (const entry of dispatch) {
    if (entry.renderableIndex === undefined) continue;
    if (entry.tags.LightMode !== 'ShadowCaster')
      displayRenderableIndices.add(entry.renderableIndex);
  }
  const value = renderables.filter(
    (renderable, index) =>
      displayRenderableIndices.has(index) &&
      renderable.authorVisible !== false &&
      renderable.instances?.instanceCount !== 0 &&
      renderable.spriteInstances?.instanceCount !== 0,
  );
  displayWorksets.set(dispatch, { renderables, value });
  return value;
}

/** Check material readiness once, after the display work has actually submitted. */
export function projectFramePresentation(input: {
  readonly renderables: FrameList<RenderableSnapshot>;
  readonly preparedWorlds: readonly RenderResourceScope[];
  readonly internals: RenderSystemInternals;
  readonly onPending?: (reason: FramePresentationPendingReason) => void;
}): FramePresentation {
  const observeResidency = createMaterialResidencyObserver(input.internals, false);
  for (const renderable of input.renderables) {
    const materialWorld = input.preparedWorlds[renderable.worldId];
    for (const material of renderable.materials) {
      const readiness = observeResidency(materialWorld, material.snapshot).readiness;
      if (readiness === 'pending' || readiness === 'failed') {
        input.onPending?.({
          code: 'material-residency',
          worldId: renderable.worldId,
          entity: renderable.entityKey,
        });
        return 'pending';
      }
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
export function missingDrawEvidence(
  renderables: FrameList<RenderableSnapshot>,
  worldKeys: readonly number[],
  draws: PresentationDraws,
  preparedWorlds: readonly RenderResourceScope[],
  internals: RenderSystemInternals,
): FramePresentationPendingReason | undefined {
  for (const renderable of renderables) {
    const entityKey = worldEntityKey(
      worldKeys[renderable.worldId] ?? renderable.worldId,
      renderable.entityKey,
    );
    const missing = renderableDrawGap(renderable, entityKey, draws, preparedWorlds, internals);
    if (missing !== undefined) return missing;
  }
  return undefined;
}

function renderableDrawGap(
  renderable: RenderableSnapshot,
  entityKey: number,
  draws: PresentationDraws,
  preparedWorlds: readonly RenderResourceScope[],
  internals: RenderSystemInternals,
): FramePresentationPendingReason | undefined {
  const source = { worldId: renderable.worldId, entity: renderable.entityKey };
  if (!draws.hasEntity(entityKey)) return { code: 'draw-entity-missing', ...source };
  const renderableWorld = preparedWorlds[renderable.worldId];
  const meshHandles =
    renderableWorld === undefined
      ? undefined
      : renderable.generatedMesh !== undefined
        ? internals.gpuStore.getGeneratedMesh(renderable.generatedMesh)
        : internals.gpuStore.getMeshGpuHandles(
            renderable.assetHandle as AssetHandle<'mesh'>,
            renderableWorld,
          );
  if (meshHandles === undefined) return { code: 'mesh-residency', ...source };
  const terrain = renderable.terrainSection;
  if (terrain !== undefined && !draws.hasTerrain(entityKey, terrain.index))
    return { code: 'draw-terrain-missing', ...source, section: terrain.index };
  if (renderable.pointsLines !== undefined) return undefined;
  for (const [submeshIndex] of meshHandles.submeshes.entries()) {
    if (!draws.hasSubmesh(entityKey, submeshIndex))
      return { code: 'draw-submesh-missing', ...source, submesh: submeshIndex };
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
function pointShadowPending(lights: ExtractedLights): boolean {
  return lights.pointShadow.some(
    (shadow) =>
      shadow.shadowAtlasLayer >= 0 &&
      (shadow.shadowMatrices.length < 96 ||
        [...shadow.shadowMatrices].some((value) => !Number.isFinite(value))),
  );
}

/**
 * Atlas overflow is admitted as direct lighting without a shadow. Only
 * allocated tiles participate in shadow readiness.
 */
function spotShadowPending(lights: ExtractedLights): boolean {
  return lights.spot.some(
    (spot) => spot.castShadow && spot.shadowAtlasTile >= 0 && spot.lightViewProj === undefined,
  );
}

/** Directional, point and spot shadow work requested by the frame must have produced results. */
export function verifySubmittedShadows(
  candidate: FramePresentationCandidate,
  lights: ExtractedLights,
  directionalShadowReady: boolean,
): void {
  if (candidate.presentation !== 'ready') return;
  if (!directionalShadowReady) markFramePending(candidate, { code: 'directional-shadow' });
  else if (pointShadowPending(lights)) markFramePending(candidate, { code: 'point-shadow' });
  else if (spotShadowPending(lights)) markFramePending(candidate, { code: 'spot-shadow' });
}
