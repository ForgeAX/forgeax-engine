import type { Plugin } from '@forgeax/engine-plugin';
import type { FrontendPlatform } from '@forgeax/engine-host/platform';
import { mountViewApplication } from '@forgeax/view/viewer/application';
import { mcpPlatformPlugin, type McpViewPlatform } from './mcp-platform-plugin';
import type { ViewFileClient, ViewFileDocumentOwner } from './file-open';

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
      // The workspace service arrives after backend startup. Observe it without
      // making the offline Shell wait for a required startup descendant.
      let fileClient: ViewFileClient | undefined;
      let fileDocument: ViewFileDocumentOwner | undefined;
      let detachFileClient: (() => void) | undefined;
      const updateFileClient = () => {
        const next = ctx.get('viewOperationClient', false) as ViewFileClient | undefined;
        const owner = ctx.get('viewProjectDocumentFrameOwner', false) as ViewFileDocumentOwner | undefined;
        if (next === fileClient && owner === fileDocument) return;
        detachFileClient?.();
        fileClient = next;
        fileDocument = owner;
        detachFileClient = next && owner ? mcp.fileOpener.attach(next, owner) : undefined;
      };
      ctx.on('internal/service', (service) => {
        if (service === 'viewOperationClient' || service === 'viewProjectDocumentFrameOwner') updateFileClient();
      });
      updateFileClient();
      ctx.effect(() => () => {
        detachFileClient?.();
        detachFileClient = undefined;
        fileClient = undefined;
        fileDocument = undefined;
      });
      const dispose = mountViewApplication(ctx.frontendPlatform, {
        context: ctx,
        presentation: mcp.presentation,
        panels: import('@forgeax/view/viewer/panels'),
        launcher: mcp.launcher,
      });
      ctx.effect(() => dispose);
      // Mount the same Shell before requesting any backend work through MCP.
      void mcp.startBackend().catch(error => console.error('MCP backend startup failed', error));
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
