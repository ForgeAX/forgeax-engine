import { box3, frustum } from '@forgeax/engine-math';
import { type ShadowViewIdentity, shadowViewIdentityKey } from '../gpu-driven/shadow-views';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import type { RecordingScenePose } from '../scene/captured-transform';
import type { PersistentShadowCasterProjection } from '../scene/render-scene';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import type { ShadowViewProjection } from '../world/render-lights';
import type { InstalledFrameGraph } from './frame-snapshot';

const NO_WINDINGS: readonly boolean[] = Object.freeze([]);
const POINT_FIRST = Object.freeze([true, false]);
const REGULAR_FIRST = Object.freeze([false, true]);
const POINT_ONLY = Object.freeze([true]);
const REGULAR_ONLY = Object.freeze([false]);

/** A point face reverses raster winding. Keep first-demand order, including mixed views. */
export function shadowWindings(
  point: boolean,
  regular: boolean,
  pointFirst = true,
): readonly boolean[] {
  if (point && regular) return pointFirst ? POINT_FIRST : REGULAR_FIRST;
  if (point) return POINT_ONLY;
  return regular ? REGULAR_ONLY : NO_WINDINGS;
}

/** Production owns these rows together. External plane maps retain their declared key order. */
export function admittedShadowWindings(
  planes: ReadonlyMap<string, Float32Array> | undefined,
  views: readonly ShadowViewIdentity[],
): readonly boolean[] {
  if (planes instanceof ShadowPlaneTable) return planes.windings;
  let first: boolean | undefined;
  if (planes !== undefined) {
    for (const key of planes.keys()) {
      const point = key.startsWith('point:');
      if (first === undefined) first = point;
      else if (first !== point) return shadowWindings(true, true, first);
    }
  } else {
    for (const view of views) {
      const point = view.kind === 'point';
      if (first === undefined) first = point;
      else if (first !== point) return shadowWindings(true, true, first);
    }
  }
  return shadowWindings(first === true, first === false);
}

class ShadowPlaneTable extends Map<string, Float32Array> {
  windings: readonly boolean[] = NO_WINDINGS;

  constructor(
    readonly projections: readonly ShadowViewProjection[],
    readonly directionalLimit?: number,
  ) {
    super();
    for (const view of projections) {
      if (this.includesCascade(view.identity)) this.admit(view);
    }
  }

  private includesCascade(identity: ShadowViewIdentity): boolean {
    return (
      identity.kind !== 'directional' ||
      this.directionalLimit === undefined ||
      identity.index < this.directionalLimit
    );
  }

  rasterWindings(
    frame: RenderPipelineFrame,
    demand: NonNullable<InstalledFrameGraph['requiresShadowPipelinePreparation']>,
  ): readonly boolean[] {
    let first: boolean | undefined;
    for (const { identity } of this.projections) {
      const point = identity.kind === 'point';
      if (point === first || !this.includesCascade(identity) || !demand(frame, identity, true))
        continue;
      if (first !== undefined) return shadowWindings(true, true, first);
      if (this.windings.length === 1) return this.windings;
      first = point;
    }
    return shadowWindings(first === true, first === false);
  }

  private admit(view: ShadowViewProjection): void {
    this.set(shadowViewIdentityKey(view.identity), view.planes);
    const point = view.identity.kind === 'point';
    if (this.windings.length === 0) this.windings = point ? POINT_ONLY : REGULAR_ONLY;
    else if (this.windings.length === 1 && this.windings[0] !== point)
      this.windings = point ? REGULAR_FIRST : POINT_FIRST;
  }
}

const worldBoundsScratch = box3.create();

export function shadowViewContains(
  source: RenderableSnapshot,
  planes: Float32Array | undefined,
  boundsOf: PersistentShadowCasterProjection['recordingWorldBoundsOf'],
  slot?: RenderSceneSlot,
  pose?: RecordingScenePose,
): boolean {
  if (planes === undefined || planes.length === 0) return true;
  const bounds = shadowCasterBounds(source, worldBoundsScratch, boundsOf, slot, pose);
  return (
    bounds === 'unbounded' ||
    (bounds !== 'empty' && frustum.intersectsBox(planes as frustum.Frustum, bounds))
  );
}

/** Resolve one caster for all frusta testing the same source row. Unknown bounds stay conservative. */
export function shadowCasterBounds(
  source: RenderableSnapshot,
  into: box3.Box3,
  boundsOf: PersistentShadowCasterProjection['recordingWorldBoundsOf'],
  slot?: RenderSceneSlot,
  pose?: RecordingScenePose,
): box3.Box3 | 'unbounded' | 'empty' {
  if (source.spriteInstances !== undefined) return 'unbounded';
  if (source.instances?.instanceCount === 0) return 'empty';
  if (source.frustumCulled === false || boundsOf?.(source, into, slot, pose) !== true)
    return 'unbounded';
  return into;
}

/**
 * Culling planes of every shadow view a frame may raster: this view's
 * directional cascades, then the Render World point-face and spot views. Each
 * view's planes were derived once, when its fit or light changed.
 */
export function shadowViewPlanesByView(
  shadowViews: readonly ShadowViewProjection[],
  directionalLimit?: number,
): ReadonlyMap<string, Float32Array> {
  return new ShadowPlaneTable(shadowViews, directionalLimit);
}

/** Direct casters serve physical rasters. External plane maps do not own typed light identities. */
export function rasterShadowWindings(
  planes: ReadonlyMap<string, Float32Array> | undefined,
  admitted: readonly boolean[],
  frame: RenderPipelineFrame,
  demand: InstalledFrameGraph['requiresShadowPipelinePreparation'],
): readonly boolean[] {
  return demand !== undefined && planes instanceof ShadowPlaneTable
    ? planes.rasterWindings(frame, demand)
    : admitted;
}
