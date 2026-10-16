import type { Plugin } from '@forgeax/engine-plugin';

import type { AudioBackend } from './audio-backend';

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    audio?: AudioBackend;
  }
}

export function audioBackendPlugin(backend: AudioBackend): Plugin {
  return {
    name: 'audio-backend',
    provide: 'audio',
    apply(ctx) {
      ctx.provide('audio', backend);
    },
  };
}
