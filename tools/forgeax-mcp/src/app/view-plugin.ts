import type { Plugin } from '@forgeax/engine-plugin';
import type { FrontendPlatform } from '@forgeax/engine-host/platform';
import { mountViewApplication } from '@forgeax/view/viewer/application';
import { mcpPlatformPlugin, type McpViewPlatform } from './mcp-platform-plugin';

/** The same View mounts on a generic MCP platform or a host-specific decoration. */
export function createMcpViewPlugin(
  name = 'forgeax.view.mcp',
  decorate: (platform: McpViewPlatform) => FrontendPlatform = (platform) => platform,
): Plugin.Object {
  return {
    name,
    provide: ['frontendPlatform'],
    async apply(ctx) {
      const transport = ctx.plugin(mcpPlatformPlugin);
      await transport.await();
      const mcp = transport.ctx.mcpViewPlatform;
      ctx.provide('frontendPlatform', decorate(mcp));
      const dispose = mountViewApplication(ctx.frontendPlatform, {
        context: ctx,
        presentation: mcp.presentation,
        panels: import('@forgeax/view/viewer/panels'),
      });
      ctx.effect(() => dispose);
      const depart = () => {
        void ctx.fiber.dispose();
      };
      window.addEventListener('pagehide', depart, { once: true });
      ctx.effect(() => () => window.removeEventListener('pagehide', depart));
      mcp.app.onteardown = async () => {
        await ctx.fiber.dispose();
        return {};
      };
    },
  };
}
