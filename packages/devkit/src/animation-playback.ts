import type { AnimationPlaybackOptions } from '@forgeax/engine-animation';
import type { ToolJsonSchema } from '@forgeax/engine-tool-runtime';

/** Transport the existing Animation assembly choice; App owns its installation. */
export const animationPlaybackSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { cadence: { enum: ['update', 'fixed'] } },
} satisfies ToolJsonSchema;

export function animationPlayback(value: unknown): AnimationPlaybackOptions {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([key, cadence]) =>
        key !== 'cadence' || (cadence !== undefined && cadence !== 'update' && cadence !== 'fixed'),
    )
  )
    throw new Error('animation requires an object with cadence: update or fixed');
  const { cadence } = value as AnimationPlaybackOptions;
  return cadence === undefined ? {} : { cadence };
}

export function environmentAnimationPlayback(): AnimationPlaybackOptions {
  const value = process.env.FORGEAX_ANIMATION_PLAYBACK;
  return value === undefined ? {} : animationPlayback(JSON.parse(value));
}
