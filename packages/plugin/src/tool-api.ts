import type { Plugin } from '@deepseek-ai/cordis';
import { createToolApi } from '@forgeax/engine-tool-runtime';
export const TOOL_API_SERVICE = 'toolApi' as const;

export function createToolApiPlugin(): Plugin {
  return {
    name: 'forgeax:tool-api',
    provide: TOOL_API_SERVICE,
    apply(ctx) {
      const api = createToolApi();
      ctx.provide(TOOL_API_SERVICE, api);
      ctx.effect(() => async () => {
        await api.dispose();
      });
    },
  };
}
