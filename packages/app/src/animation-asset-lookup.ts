import type { AnimationPayloadLookup } from '@forgeax/engine-animation';
import type { AnimationClip } from '@forgeax/engine-types';

export interface AnimationPayloadSource {
  lookup<T = unknown>(guid: string): T | undefined;
}

/** Bridge the renderer-owned GUID catalogue into the animation plugin. */
export function createAnimationPayloadLookup(
  source: AnimationPayloadSource | undefined,
): AnimationPayloadLookup {
  return (guid) => source?.lookup<AnimationClip>(guid);
}
