import type { Plugin } from '@forgeax/engine-plugin';

import { createWebAudioBackend } from './host-audio-consumer';
import { WebAudioEngine } from './web-audio-engine';

export function webAudioPlugin(engine = new WebAudioEngine()): Plugin {
  return {
    name: 'web-audio',
    provide: 'audio',
    apply(ctx) {
      const backend = createWebAudioBackend(engine);
      ctx.effect(() => () => backend.destroy(), 'audio/destroy-webaudio');
      ctx.provide('audio', backend);
    },
  };
}
