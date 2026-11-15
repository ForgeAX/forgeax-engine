import {
  type StandardClusterLocalLights,
  standardClusterLocalLights,
  standardLocalLightLimit,
} from '../pipeline/standard-lighting/local-light-cap';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import type { LightRoster } from '../render-system-extract';
import type { RenderFrameState } from './frame-snapshot';
import type { RenderSystemInternals } from './render-context';

type ClusterRoster = Pick<LightRoster, 'point' | 'spot' | 'rect' | 'additionalDirectional'>;

/**
 * Point/spot/rect lights one view's Cluster may hold: `lightCount`, bounded by
 * the slots the additional DirectionalLights leave free. Directional lights
 * do not count toward `lightCount`; they stay out of the light grid and are
 * shaded in their own loop.
 */
export function clusterLocalLightLimit(
  internals: Pick<RenderSystemInternals, 'standardProfile' | 'standardClusterAbi'>,
  lights: Pick<ClusterRoster, 'additionalDirectional'>,
  slotCapacity: number | undefined = internals.standardClusterAbi?.directLightSlot.capacity,
): number {
  const lightCount = internals.standardProfile?.lightCount ?? DEFAULT_STANDARD_PROFILE.lightCount;
  // Additional DirectionalLights occupy the slots after the local lights.
  const directional = lights.additionalDirectional?.length ?? 0;
  return standardLocalLightLimit(
    lightCount,
    (slotCapacity ?? Number.POSITIVE_INFINITY) - directional,
  );
}

/**
 * The point/spot/rect lights this view's Cluster slots hold. Every consumer
 * that addresses a Cluster slot (light table, volume, projector) reads this
 * one admission so slot indices agree; shadow producers keep the full roster.
 */
export function clusterLocalLights(
  internals: Pick<RenderSystemInternals, 'standardProfile' | 'standardClusterAbi'>,
  lights: ClusterRoster,
  slotCapacity: number | undefined = internals.standardClusterAbi?.directLightSlot.capacity,
): StandardClusterLocalLights {
  return standardClusterLocalLights(
    lights,
    clusterLocalLightLimit(internals, lights, slotCapacity),
  );
}

/**
 * Warn once per renderer when the Cluster drops local lights; the frame keeps
 * rendering.
 */
export function warnStandardLocalLightCap(
  frameState: Pick<RenderFrameState, 'warnedStandardLocalLightCap'>,
  admitted: StandardClusterLocalLights,
  limit: number,
): void {
  if (admitted.dropped === 0 || frameState.warnedStandardLocalLightCap) return;
  frameState.warnedStandardLocalLightCap = true;
  console.warn(
    `[forgeax] Standard Cluster: ${admitted.requested} local lights exceed the ${limit}-light ` +
      `limit; the first ${limit} by (kind, world, entity) are shaded and ${admitted.dropped} ` +
      'are dropped from the Cluster (their shadow maps still render). Raise ' +
      'RenderProfile lightCount or reduce the active Point/Spot/RectArea lights.',
  );
}

/**
 * Warn once per renderer when the light index list overflowed and every
 * cluster kept only its first K entries.
 */
export function warnStandardClusterEntryCap(
  frameState: Pick<RenderFrameState, 'warnedStandardClusterEntryCap'>,
  membership: {
    readonly clusterEntryCapK: number | undefined;
    readonly droppedClusterEntries: number;
  },
  capacity: number,
): void {
  if (membership.clusterEntryCapK === undefined || frameState.warnedStandardClusterEntryCap) return;
  frameState.warnedStandardClusterEntryCap = true;
  console.warn(
    `[forgeax] Standard Cluster: the light index list (${capacity} entries) overflowed; each ` +
      `cluster keeps its first ${membership.clusterEntryCapK} lights and ` +
      `${membership.droppedClusterEntries} entries are dropped. Shrink light ranges, reduce ` +
      'overlapping Point/Spot/RectArea lights or lower the Cluster grid.',
  );
}
