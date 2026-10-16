import type { Plugin } from '@forgeax/engine-plugin';

import type { InputBackend } from './input-snapshot';

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    input?: InputBackend;
  }
}

export function inputBackendPlugin(backend: InputBackend): Plugin {
  return {
    name: 'input-backend',
    provide: 'input',
    apply(ctx) {
      ctx.provide('input', backend);
    },
  };
}

/** Provide an App-acquired input backend and release its Host listeners with the Fiber. */
export function ownedInputBackendPlugin(backend: InputBackend, dispose: () => void): Plugin {
  return {
    name: 'input-backend',
    provide: 'input',
    apply(ctx) {
      ctx.provide('input', backend);
      ctx.effect(() => dispose, 'input/backend');
    },
  };
}
