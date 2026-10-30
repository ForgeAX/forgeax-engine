import { navigateBrowserDocument } from '@forgeax/view/workspace/document-navigation';
import { APP_VERSION, TRANSPORT_TOOL } from '../contract';
import { z } from 'zod/v4';
import { App } from '@modelcontextprotocol/ext-apps';
import { createFrontendPlatformPlugin } from '@forgeax/engine-host/platform';
import { connectMcpHost } from './host-transport';
import { viewportInputPlugin } from '@forgeax/view/plugins/viewport/input';
import type { HostTransportClient } from '@forgeax/engine-host/transport';
import type { Context } from '@forgeax/engine-plugin';
import core from '@forgeax/view/workspace/frontend-plugin';
import { writeBrowserClipboard } from '@forgeax/engine-host/platform';
import { installNetworkRuntime } from './network-runtime';
import { createMcpDocumentRuntime } from './document-runtime';
import { createMcpProgramHosts } from './program-host';
z.config({ jitless: true });

/** Activated by DevKit's declared frontendModule.prepare before its Host connection. */
export const preparePlatform = {
  name: 'forgeax.mcp.preview.platform',
  async apply(ctx: Context) {
    const app = new App(
      { name: 'ForgeAX Engine Preview runtime', version: APP_VERSION },
      { availableDisplayModes: ['fullscreen'] },
      { autoResize: false },
    );
    app.ontoolresult = () => {};
    await app.connect();
    const config = JSON.parse(document.getElementById('fx-config')!.textContent!);
    const report = (value: unknown) => {
      console.debug('ForgeAX Preview', value);
    };
    const invoke = async (args: any, options: any = {}) => {
      const result = await app.callServerTool({ name: TRANSPORT_TOOL, arguments: args }, options);
      if (result.isError) throw new Error(JSON.stringify(result.content));
      return result.structuredContent;
    };
    const runtime = installNetworkRuntime(window, invoke, config.documentUrl);
    const programHosts = createMcpProgramHosts(window, invoke, runtime.bytes);
    const logicalURL = new URL(config.documentUrl);
    const realm = new Proxy(window, {
      get(target, key) {
        if (key === 'location') return logicalURL;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const themeListeners = new Set<() => void>();
    const documents = createMcpDocumentRuntime(app, invoke, runtime.bytes);
    const theme = {
      getSnapshot: () => app.getHostContext()?.theme ?? ('light' as const),
      subscribe(listener: () => void) {
        themeListeners.add(listener);
        return () => themeListeners.delete(listener);
      },
    };
    const updateTheme = () => {
      document.documentElement.dataset.theme = theme.getSnapshot();
      documents.setHostContext(app.getHostContext() ?? {});
      for (const listener of themeListeners) listener();
    };
    app.onhostcontextchanged = updateTheme;
    updateTheme();
    const connections = new Set<HostTransportClient>();
    const connectHost = async (url: string) => {
      const client = await connectMcpHost(invoke, runtime.bytes, url);
      connections.add(client);
      client.onDisconnect(() => {
        void Promise.resolve(client.close()).finally(() => connections.delete(client));
      });
      return client;
    };
    const platform = ctx.plugin(
      createFrontendPlatformPlugin({
        createPackProgramHost: programHosts.create,
        window: realm,
        document,
        fetch: window.fetch.bind(window),
        connectHost,
        createFrame: documents.createFrame,
        navigate: (url, options) => navigateBrowserDocument(window, url, options),
        writeClipboard: (text) => writeBrowserClipboard(text),
        theme,
      }),
    );
    await platform.await();
    const onError = (event: ErrorEvent) =>
      report({ stage: 'runtime-error', message: event.message });
    const onReject = (event: PromiseRejectionEvent) =>
      report({ stage: 'runtime-rejection', message: String(event.reason?.stack ?? event.reason) });
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onReject);
    ctx.effect(() => async () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onReject);
      themeListeners.clear();
      try { await documents.dispose(); }
      finally {
        await Promise.all([...connections].map((client) => client.close('MCP Preview retired')));
        connections.clear();
        programHosts.dispose();
        runtime.dispose();
      }
    });
    app.onteardown = async () => {
      await ctx.fiber.dispose();
      return {};
    };
    report({
      stage: 'runtime-starting',
      targetId: logicalURL.searchParams.get('forgeaxWorkspaceTarget'),
      parentDocumentAccessible: (() => {
        try {
          return Boolean(parent.document);
        } catch {
          return false;
        }
      })(),
    });
  },
};

/** This realm installs the ordinary View workspace client, with no duplicate Shell. */
export default {
  name: 'forgeax.mcp.preview',
  inject: ['frontendPlatform'],
  async apply(ctx: Context, config: any = {}) {
    const fiber = ctx.plugin(core, {
      ...(config.frontendConfig ?? {}),
      window: ctx.frontendPlatform.window,
    });
    await fiber.await();
    let inputStarted = false;
    const startInput = () => {
      if (inputStarted || !ctx.get('engineWorkspacePresentation', false)) return;
      inputStarted = true;
      ctx.plugin(viewportInputPlugin);
    };
    ctx.on('internal/service', (name) => {
      if (name === 'engineWorkspacePresentation') startInput();
    });
    startInput();
  },
};
