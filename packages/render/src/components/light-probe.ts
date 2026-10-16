// @forgeax/engine-render - local diffuse LightProbe authoring facts.

import { defineComponent } from '@forgeax/engine-ecs';
import { R_MIN } from '@forgeax/engine-types';

/**
 * Local diffuse irradiance probe. Transform supplies position; the 27 SH
 * values are nine RGB groups in the fixed real-SH order.
 */
export const LightProbe = defineComponent('LightProbe', {
  irradiance: { type: 'array<f32, 27>' },
  radius: { type: 'f32', default: R_MIN },
});
