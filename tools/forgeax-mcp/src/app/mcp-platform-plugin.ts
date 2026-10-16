import type { Plugin } from '@forgeax/engine-plugin';
import { startFullViewBridge } from './view-runtime';
export type McpViewPlatform = Awaited<ReturnType<typeof startFullViewBridge>>;
declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    mcpViewPlatform: McpViewPlatform;
  }
}

/** Protocol, bytes, theme, Workers and isolated surfaces are ordinary MCP Apps capabilities. */
export const mcpPlatformPlugin: Plugin.Object = {
  name: 'forgeax.view.platform.mcp',
  provide: ['mcpViewPlatform'],
  async apply(ctx) {
    const platform = await startFullViewBridge();
    ctx.provide('mcpViewPlatform', platform);
    ctx.effect(() => () => platform.dispose());
  },
};
