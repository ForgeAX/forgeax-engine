import type { RenderResourceScope } from './publication/resource-scope';
import type { RenderSystemInternals } from './record/render-context';
import type { FramePresentation, FramePresentationPendingReason } from './render-contract';
import type { DispatchList, RenderableSnapshot } from './render-system-extract';
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

/** Display workset used by recording and its later submitted-picture checks. */
export function projectDisplayRenderables(
  renderables: FrameList<RenderableSnapshot>,
  dispatch: DispatchList,
): FrameList<RenderableSnapshot> {
  const displayRenderableIndices = new Set<number>();
  for (const entry of dispatch) {
    if (entry.renderableIndex === undefined) continue;
    if (entry.tags.LightMode !== 'ShadowCaster')
      displayRenderableIndices.add(entry.renderableIndex);
  }
  return renderables.filter(
    (renderable, index) =>
      displayRenderableIndices.has(index) &&
      renderable.authorVisible !== false &&
      renderable.instances?.instanceCount !== 0 &&
      renderable.spriteInstances?.instanceCount !== 0,
  );
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
