import type { TaskRegistry } from '@forgeax/engine-types';

/** Texture derivation: encoded Basis/KTX2 bytes to one packed device format. */
export const TEXTURE_TRANSCODE_TASK = 'ktx2.transcode';

/**
 * Task kinds the Renderer submits to a task executor. Every executing realm
 * (pool Workers, or the Renderer's own realm when tasks run inline) resolves a
 * kind from this one registry.
 */
export const builtinTaskKinds: TaskRegistry = {
  [TEXTURE_TRANSCODE_TASK]: {
    load: async () => (await import('@forgeax/engine-codec')).textureTranscodeTask,
  },
};
