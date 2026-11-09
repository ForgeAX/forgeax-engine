import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';

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
  // JSON object overriding the effect's declared `parameters` for this Player, e.g.
  // '{"origin":[1,2,3],"worldScale":9.5}'. Build it with `vfxPlayerParameters`.
  parameters: { type: 'string', default: '' },
});

/** The serializable fields stored by {@link ParticleEffectPlayer}. */
export type ParticleEffectPlayerData = ShapeOf<SchemaOf<typeof ParticleEffectPlayer>>;

/**
 * Serialize per-Player parameter overrides for `ParticleEffectPlayer.parameters`.
 * Names and types are validated against the effect at runtime (diagnostic
 * `vfx-parameters-invalid`) and offline by {@link validateVfxPlayerParameters}.
 */
export function vfxPlayerParameters(
  values: Readonly<Record<string, number | readonly number[]>>,
): string {
  return Object.keys(values).length === 0 ? '' : JSON.stringify(values);
}
