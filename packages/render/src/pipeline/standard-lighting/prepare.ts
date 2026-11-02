import { err, ok, type Result } from '@forgeax/engine-types';
import type { ClusterBinScratch } from '../../cluster-binner';
import { type RenderError, StandardLightBudgetExceededError } from '../../errors/render';
import { MAX_LIGHTS } from '../standard-profile';
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
  readonly maxLights: StandardLightFrame['lightCount'];
}

export function prepareStandardLighting(
  frame: StandardLightFrame,
  scratch?: ClusterBinScratch,
  owner?: StandardClusterMembershipOwner,
): Result<PreparedStandardLighting, RenderError> {
  if (frame.local.length > frame.lightCount || frame.local.length > MAX_LIGHTS) {
    return err(new StandardLightBudgetExceededError(frame.local.length, frame.lightCount));
  }
  const layout = createStandardClusterLayout(frame.grid);
  const membership =
    owner === undefined
      ? deriveStandardMembership(frame, layout, scratch)
      : owner.derive(frame, layout, scratch);
  if (!membership.ok) return membership;
  return ok({
    ...membership.value,
    directional: frame.directional,
    local: frame.local,
    layout,
    membershipLightCount: frame.local.length,
    renderPath: frame.renderPath,
    maxLights: frame.lightCount,
  });
}
