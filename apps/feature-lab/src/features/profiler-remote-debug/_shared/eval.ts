import type { App } from '@forgeax/engine/app';
import { executeScript } from '@forgeax/engine/remote/execute';
import * as scene from '@forgeax/engine/scene';

const MODULES: Readonly<Record<string, unknown>> = { '@forgeax/engine/scene': scene };

export function evalInApp(app: App, script: string): ReturnType<typeof executeScript> {
  return executeScript(script, {
    world: app.world,
    renderer: app.renderer,
    assets: app.assets,
    importModule: async (specifier) => {
      const module = MODULES[specifier];
      if (module === undefined) throw new Error(`module ${specifier} is not injected`);
      return module;
    },
  });
}
