import { err, ok, type Result } from '@forgeax/engine-types';
import { type RenderError, StandardLightBudgetExceededError } from '../../errors/render';
import { MAX_LIGHTS } from '../standard-profile';
import { createStandardClusterLayout, type StandardClusterLayout } from './layout';
import type { StandardLightFrame } from './light-frame';
import { deriveStandardMembership, type StandardClusterMembership } from './membership';

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
): Result<PreparedStandardLighting, RenderError> {
  if (frame.local.length > frame.lightCount || frame.local.length > MAX_LIGHTS) {
    return err(new StandardLightBudgetExceededError(frame.local.length, frame.lightCount));
  }
  const layout = createStandardClusterLayout(frame.grid);
  const membership = deriveStandardMembership(frame, layout);
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
