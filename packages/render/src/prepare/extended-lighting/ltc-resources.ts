// @forgeax/engine-render - DeviceScope-owned RectArea LTC resources.

import type { DeviceScope } from '../../device/device-scope';
import { EXTENDED_LIGHTING_TOPOLOGY } from './resources';

export interface LtcResourcePlanInput {
  readonly scope: DeviceScope;
  readonly ltcAvailable: boolean;
  readonly residentGeneration?: number;
}

export interface LtcResourcePlan {
  readonly topology: typeof EXTENDED_LIGHTING_TOPOLOGY;
  readonly generation: number;
  readonly rectAdmission: 'admitted' | 'omitted';
  readonly tableCount: number;
  readonly uploadCount: number;
}

export function deriveLtcResourcePlan(input: LtcResourcePlanInput): LtcResourcePlan {
  const admitted = input.ltcAvailable;
  return {
    topology: EXTENDED_LIGHTING_TOPOLOGY,
    generation: input.scope.generation,
    rectAdmission: admitted ? 'admitted' : 'omitted',
    tableCount: admitted ? 2 : 0,
    uploadCount: admitted && input.residentGeneration !== input.scope.generation ? 2 : 0,
  };
}
