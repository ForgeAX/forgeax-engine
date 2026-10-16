import type { Plugin } from '@forgeax/engine-plugin';

import { registerStatesPlugin } from './register-plugin';

/**
 * statePlugin -- registers the state-machine systems + per-token Resources.
 *
 * Installs the transition system and projects both current and later
 * module-defined StateTokens into the injected World.
 */
export function statePlugin(): Plugin {
  return {
    name: 'state',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => registerStatesPlugin(ctx.world), 'state/systems');
    },
  };
}
