import { defineComponent } from '@forgeax/engine-ecs';
/** Native GPU environment source attached to the same Skylight/Skybox entity.
 * Named outputs belong to a registered environment-stage RenderFeature; no
 * GPU object or second asset owner is stored in the simulation World. */
export const RenderFeatureEnvironment = defineComponent('RenderFeatureEnvironment', {
  feature: { type: 'string' },
  sky: { type: 'string' },
  irradiance: { type: 'string' },
  prefilter: { type: 'string' },
});
export interface RenderFeatureEnvironmentSource {
  readonly feature: string;
  readonly sky: string;
  readonly irradiance: string;
  readonly prefilter: string;
}
