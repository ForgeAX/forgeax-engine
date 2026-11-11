import { err, ok, type Result } from '@forgeax/engine-types';
import type { ClusterBinScratch } from '../../cluster-binner';
import { type RenderError, StandardLightBudgetExceededError } from '../../errors/render';
import { createStandardClusterLayout, type StandardClusterLayout } from './layout';
import type { StandardLightFrame } from './light-frame';
import { deriveStandardMembership, type StandardClusterMembership } from './membership';
import type { StandardClusterMembershipOwner } from './membership-owner';

export type { StandardLightFrame } from './light-frame';

export interface PreparedStandardLighting extends StandardClusterMembership {
  readonly directional: StandardLightFrame['directional'];
  readonly local: StandardLightFrame['local'];
  readonly layout: StandardClusterLayout;
  readonly membershipLightCount: number;
  readonly renderPath: NonNullable<StandardLightFrame['renderPath']>;
  readonly maxLights: number;
  /** Camera terms the membership was derived with; read by on-demand inspection. */
  readonly camera?: Pick<StandardLightFrame, 'view' | 'projection' | 'near' | 'far'>;
}

export function prepareStandardLighting(
  frame: StandardLightFrame,
  directLightSlotCapacity: number = frame.lightCount,
  scratch?: ClusterBinScratch,
  owner?: StandardClusterMembershipOwner,
): Result<PreparedStandardLighting, RenderError> {
  const admittedBudget = Math.min(frame.lightCount, directLightSlotCapacity);
  if (frame.local.length > admittedBudget) {
    return err(new StandardLightBudgetExceededError(frame.local.length, admittedBudget));
  }
  const layout = createStandardClusterLayout(directLightSlotCapacity, frame.grid);
  const membership =
    owner === undefined
      ? deriveStandardMembership(frame, layout, scratch)
      : owner.derive(frame, layout, scratch);
  if (!membership.ok) return membership;
  const derived = membership.value;
  return ok({
    // Forward the list lazily: a spread would materialize it for GPU producers.
    clusterGrid: derived.clusterGrid,
    get lightIndexList() {
      return derived.lightIndexList;
    },
    lightBounds: derived.lightBounds,
    membershipEntryCount: derived.membershipEntryCount,
    scratch: derived.scratch,
    directional: frame.directional,
    local: frame.local,
    layout,
    membershipLightCount: frame.local.length,
    renderPath: frame.renderPath,
    maxLights: frame.lightCount,
    camera: { view: frame.view, projection: frame.projection, near: frame.near, far: frame.far },
  });
}
