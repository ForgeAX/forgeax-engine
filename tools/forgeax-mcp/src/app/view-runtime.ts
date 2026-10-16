import { connectMcpHost } from './host-transport';
import { APP_VERSION, VIEW_TITLE, TRANSPORT_TOOL } from '../contract';
import type { HostTransportClient } from '@forgeax/engine-host/transport';
import { writeBrowserClipboard } from '@forgeax/engine-host/platform';
import { z } from 'zod/v4';
import { App } from '@modelcontextprotocol/ext-apps';
import { installNetworkRuntime } from './network-runtime';
import { retireViewResources } from './retire-view';
import { createMcpDocumentRuntime } from './document-runtime';
z.config({ jitless: true });

export async function startFullViewBridge() {
  const app = new App(
    { name: VIEW_TITLE, version: APP_VERSION },
    { availableDisplayModes: ['fullscreen'] },
    { autoResize: false },
  );
  app.ontoolresult = () => {};
  await app.connect();
  const config = JSON.parse(document.getElementById('fx-config')!.textContent!);
  const invoke = async (args: any, options: any = {}) => {
    const result = await app.callServerTool({ name: TRANSPORT_TOOL, arguments: args }, options);
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result.structuredContent;
  };
  const runtime = installNetworkRuntime(window, invoke, config.viewUrl);
  let logicalURL = new URL(config.viewUrl);
  const realm = new Proxy(window, {
    get(target, key) {
      if (key === 'location') return logicalURL;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const editorHostContext = () => ({
    ...app.getHostContext(),
    theme:
      document.documentElement.dataset.theme === 'dark' ? ('dark' as const) : ('light' as const),
  });
  const connections = new Set<HostTransportClient>();
  const connectHost = async (url: string) => {
    const client = await connectMcpHost(invoke, runtime.bytes, url);
    connections.add(client);
    client.onDisconnect(() => {
      void Promise.resolve(client.close()).finally(() => connections.delete(client));
    });
    return client;
  };
  const documents = createMcpDocumentRuntime(app, invoke, runtime.bytes, editorHostContext);
  const createSurface = ({ target }: any) => {
    if (!target?.targetId || !target.url)
      throw new Error('Exact Engine target has no document URL');
    const handle = documents.createFrame(target.url);
    handle.element.title = 'ForgeaX Editor 3D viewport';
    handle.element.dataset.forgeaxMcpEditor = target.targetId;
    void handle.ready.catch(error => console.error('MCP document failed', error));
    return handle.element;
  };
  const presentation = {
    surfacePlacement: 'owner' as const,
    createSurface,
    attach({ element }: any) {
      const frame = element as HTMLIFrameElement;
      const container = document.querySelector<HTMLElement>(
        '[data-forgeax-view-workspace="targets"]',
      );
      if (frame?.tagName !== 'IFRAME' || !container) throw new Error('Exact viewport owner is unavailable');
      const update = () => {
        const box = container.getBoundingClientRect();
        Object.assign(frame.style, {
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${box.width}px`,
          height: `${box.height}px`,
          visibility: box.width && box.height ? 'visible' : 'hidden',
        });
      };
      const resize = new ResizeObserver(update);
      resize.observe(container);
      const mutation = new MutationObserver(update);
      mutation.observe(document.getElementById('root')!, {
        attributes: true,
        subtree: true,
        attributeFilter: ['style', 'hidden', 'class'],
      });
      window.addEventListener('resize', update);
      update();
      return () => {
        resize.disconnect();
        mutation.disconnect();
        window.removeEventListener('resize', update);
        frame.style.visibility = 'hidden';
      };
    },
  };
  const navigate = async (value: string, { signal }: any = {}) => {
    signal?.throwIfAborted();
    const url = new URL(value, logicalURL);
    const targetId = url.searchParams.get('forgeaxWorkspaceTarget');
    if (!targetId) throw new Error('Embedded navigation requires an exact Engine target');
    createSurface({ target: { targetId, url: url.href } });
    await documents.createFrame(url.href).ready;
    signal?.throwIfAborted();
    logicalURL = url;
  };
  const themeListeners = new Set<() => void>();
  app.onhostcontextchanged = () => {
    for (const listener of themeListeners) listener();
    documents.setHostContext(editorHostContext());
  };
  const themeObserver = new MutationObserver(() => {
    documents.setHostContext(editorHostContext());
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  const dispose = async () => {
    themeObserver.disconnect();
    themeListeners.clear();
    try {
      await documents.dispose();
    } finally {
      try { await retireViewResources([], connections, () => runtime.dispose()); }
      finally { connections.clear(); }
    }
  };

  return {
    window: realm,
    document,
    fetch: window.fetch.bind(window),
    connectHost,
    createFrame: documents.createFrame,
    navigate,
    writeClipboard: (text: string) => writeBrowserClipboard(text),
    theme: {
      getSnapshot: () => app.getHostContext()?.theme ?? 'light',
      subscribe(listener: () => void) {
        themeListeners.add(listener);
        return () => themeListeners.delete(listener);
      },
    },
    presentation,
    app,
    dispose,
  };
}
