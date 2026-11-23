import { ok, type Result } from '@forgeax/engine-types';
import type { ClusterBinScratch } from '../../cluster-binner';
import type { RenderError } from '../../errors/render';
import { createStandardClusterLayout, type StandardClusterLayout } from './layout';
import type { StandardLightFrame } from './light-frame';
import { deriveStandardMembership, type StandardClusterMembership } from './membership';
import type { StandardClusterMembershipOwner } from './membership-owner';

export type { StandardLightFrame } from './light-frame';

export interface PreparedStandardLighting extends StandardClusterMembership {
  readonly directional: StandardLightFrame['directional'];
  readonly local: StandardLightFrame['local'];
  readonly layout: StandardClusterLayout;
  readonly renderPath: NonNullable<StandardLightFrame['renderPath']>;
  readonly maxLights: number;
  /** Point/spot/rect lights dropped over the limit; `local` holds the rest. */
  readonly droppedLocalLights: number;
  readonly deferredChannelProjection?: number;
  /** Camera terms the membership was derived with; read by on-demand inspection. */
  readonly camera?: Pick<StandardLightFrame, 'view' | 'projection' | 'near' | 'far'>;
}

export function prepareStandardLighting(
  frame: StandardLightFrame,
  directLightSlotCapacity: number = frame.lightCount,
  scratch?: ClusterBinScratch,
  owner?: StandardClusterMembershipOwner,
): Result<PreparedStandardLighting, RenderError> {
  const layout =
    owner === undefined
      ? createStandardClusterLayout(directLightSlotCapacity, frame.grid)
      : owner.graphLayout.layout(directLightSlotCapacity, frame.grid);
  const membership =
    owner === undefined
      ? deriveStandardMembership(frame, layout, scratch)
      : owner.derive(frame, layout, scratch);
  if (!membership.ok) return membership;
  const derived = membership.value;
  return ok({
    // Forward the list lazily: a spread would materialize it for GPU producers.
    publication: derived.publication,
    clusterGrid: derived.clusterGrid,
    get lightIndexList() {
      return derived.lightIndexList;
    },
    boundsColumn: derived.boundsColumn,
    get lightBounds() {
      return derived.lightBounds;
    },
    membershipLightCount: derived.membershipLightCount,
    membershipEntryCount: derived.membershipEntryCount,
    occupiedClusterCount: derived.occupiedClusterCount,
    clusterEntryCapK: derived.clusterEntryCapK,
    droppedClusterEntries: derived.droppedClusterEntries,
    scratch: derived.scratch,
    directional: frame.directional,
    local: frame.local,
    layout,
    renderPath: frame.renderPath,
    maxLights: frame.lightCount,
    droppedLocalLights: frame.droppedLocalLights ?? 0,
    ...(frame.deferredChannelProjection === undefined
      ? {}
      : { deferredChannelProjection: frame.deferredChannelProjection }),
    camera: { view: frame.view, projection: frame.projection, near: frame.near, far: frame.far },
  });
}
