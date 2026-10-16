import type { Plugin } from '@forgeax/engine-plugin';
import type { IntelligenceService } from './types';

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    intelligence?: IntelligenceService;
  }
}

/** Install one optional intelligence service and bind its lifetime to this Cordis Fiber. */
export function intelligencePlugin(service: IntelligenceService): Plugin {
  return {
    name: 'intelligence',
    provide: 'intelligence',
    apply(ctx) {
      ctx.provide('intelligence', service);
      ctx.effect(() => () => service.close(), 'intelligence/service');
    },
  };
}
