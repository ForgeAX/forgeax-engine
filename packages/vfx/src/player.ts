import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import type { VfxValueMap } from './effect-contract.js';
import type { ParticleEffectInstance } from './instance.js';

/** ECS author intent for one shared particle effect. */
export const ParticleEffectPlayer = defineComponent('ParticleEffectPlayer', {
  // The VFX render owner re-resolves the compiled effect on the target world;
  // playback intent remains portable simulation state.
  effect: { type: 'asset<particle-effect>' },
  playing: { type: 'bool', default: true },
  // Keep effect GPU programs and storage ready while paused, without simulation or drawing.
  preparePipelines: { type: 'bool', default: false },
  seed: { type: 'u32', default: 0 },
  timeScale: { type: 'f32', default: 1 },
});

/** The serializable fields stored by {@link ParticleEffectPlayer}. */
export type ParticleEffectPlayerData = ShapeOf<SchemaOf<typeof ParticleEffectPlayer>>;

/** Runtime-owned typed values associated with a player without extending ECS storage. */
export interface ParticleEffectPlayerBinding<Values extends VfxValueMap = VfxValueMap> {
  readonly instance: ParticleEffectInstance<Values>;
}
