import type {} from '@forgeax/engine/devkit/plugin-build';
import type { Plugin } from '@forgeax/engine/plugin';

/** Project policy is declared before the generated Host creates engine services. */
export const projectConfiguration: Plugin = {
  name: 'game-3d/configuration',
  provide: ['devkitAppOptions'],
  apply(ctx) {
    ctx.provide('devkitAppOptions', {
      configuration: { quality: { base: { kind: 'device-default' } } },
    });
  },
};
