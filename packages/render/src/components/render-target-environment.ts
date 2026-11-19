import { defineComponent } from '@forgeax/engine-ecs';

/** Renderer-local, already-filtered radiance; no portable GPU handles. */
export interface RenderTargetEnvironmentSource {
  readonly kind: 'render-target-environment';
}

/** Attach a retained native environment source to the Skylight entity. */
export const RenderTargetEnvironment = defineComponent('RenderTargetEnvironment', {
  source: { type: 'shared<RenderTargetEnvironmentSource>', simulationTransient: true },
});
