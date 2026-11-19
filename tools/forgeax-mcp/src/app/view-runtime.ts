import { connectMcpHost } from './host-transport';
import { APP_VERSION, VIEW_TITLE, TRANSPORT_TOOL, SOURCE_OPEN_TOPIC, SOURCE_REPLY_SERVICE } from '../contract';
import type { HostTransportClient } from '@forgeax/engine-host/transport';
import { writeBrowserClipboard } from '@forgeax/engine-host/platform';
import { z } from 'zod/v4';
import { App } from '@modelcontextprotocol/ext-apps';
import { installNetworkRuntime } from './network-runtime';
import { retireViewResources } from './retire-view';
import { createMcpDocumentRuntime } from './document-runtime';
import { createServiceViewLauncher } from '@forgeax/view/viewer/launcher';
import { createViewFileOpener, type ViewFileResult, type ViewFile } from './file-open';
z.config({ jitless: true });

export async function startFullViewBridge() {
  const app = new App(
    { name: VIEW_TITLE, version: APP_VERSION },
    { availableDisplayModes: ['fullscreen'] },
    { autoResize: false },
  );
  const invoke = async (args: any, options: any = {}) => {
    const result = await app.callServerTool({ name: TRANSPORT_TOOL, arguments: args }, options);
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result.structuredContent;
  };
  let selectedSourcePath: string | undefined;
  const fileOpener = createViewFileOpener(signal => invoke(selectedSourcePath
    ? { action: 'source-context', sourcePath: selectedSourcePath } : { action: 'file-context' },
    { signal }) as Promise<ViewFileResult>, error => {
    document.getElementById('view-file-error')?.remove();
    if (!error) return;
    const status = document.createElement('div');
    status.id = 'view-file-error';
    status.setAttribute('role', 'alert');
    status.textContent = error instanceof Error ? error.message : String(error);
    Object.assign(status.style, { position: 'fixed', top: '8px', left: '8px', right: '8px', zIndex: '10000', padding: '12px', background: 'Canvas', color: 'CanvasText', border: '1px solid GrayText' });
    document.body.append(status);
  });
  app.ontoolinput = input => {
    const source = input.arguments?.assetSource as { path?: unknown } | undefined;
    if (typeof source?.path === 'string') {
      selectedSourcePath = source.path;
      fileOpener.activate();
      return;
    }
    const file = input.arguments?.file as { name?: unknown; resourceUri?: unknown } | undefined;
    if (typeof file?.name === 'string' && typeof file.resourceUri === 'string') {
      selectedSourcePath = undefined;
      fileOpener.activate();
    }
  };
  app.ontoolcancelled = () => fileOpener.cancel();
  app.ontoolresult = () => {};
  await app.connect();
  const config = JSON.parse(document.getElementById('fx-config')!.textContent!);
  const runtime = installNetworkRuntime(window, invoke, config.viewUrl);
  let logicalURL = new URL(config.viewUrl);
  const realm = new Proxy(window, {
    get(target, key) {
      if (key === 'location') return logicalURL;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const previewHostContext = () => ({
    ...app.getHostContext(),
    theme:
      document.documentElement.dataset.theme === 'dark' ? ('dark' as const) : ('light' as const),
  });
  const connections = new Set<HostTransportClient>();
  const sourceResponders = new Map<HostTransportClient, () => void>();
  const connectHost = async (url: string) => {
    const client = await connectMcpHost(invoke, runtime.bytes, url);
    connections.add(client);
    {
      // This platform connects the top-level View Shell. Project preview frames
      // use their separate document platform and never register this responder.
      const active = new Map<string, AbortController>();
      const stop = client.subscribe<{ requestId: string; file?: ViewFile; cancelled?: boolean }>(SOURCE_OPEN_TOPIC, request => {
        if (request.cancelled) { active.get(request.requestId)?.abort(); active.delete(request.requestId); return; }
        if (!request.file || active.has(request.requestId)) return;
        const controller = new AbortController();
        active.set(request.requestId, controller);
        void fileOpener.select(request.file, controller.signal).then(
          () => ({ ok: true }),
          error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        ).then(payload => {
          if (!controller.signal.aborted) return client.request(SOURCE_REPLY_SERVICE, { requestId: request.requestId, ...payload });
        }).catch(error => console.error('View source receipt failed', error)).finally(() => active.delete(request.requestId));
      });
      const dispose = () => { stop(); for (const controller of active.values()) controller.abort(); active.clear(); };
      sourceResponders.set(client, dispose);
    }
    client.onDisconnect(() => {
      sourceResponders.get(client)?.(); sourceResponders.delete(client);
      void Promise.resolve(client.close()).finally(() => connections.delete(client));
    });
    return client;
  };
  const documents = createMcpDocumentRuntime(app, invoke, runtime.bytes, previewHostContext);
  const createSurface = ({ target }: any) => {
    if (!target?.targetId || !target.url)
      throw new Error('Exact Engine target has no document URL');
    const handle = documents.createFrame(target.url);
    handle.element.title = 'ForgeAX Preview 3D viewport';
    handle.element.dataset.forgeaxMcpPreview = target.targetId;
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
    documents.setHostContext(previewHostContext());
  };
  const themeObserver = new MutationObserver(() => {
    documents.setHostContext(previewHostContext());
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  const dispose = async () => {
    for (const dispose of sourceResponders.values()) dispose();
    sourceResponders.clear();
    fileOpener.dispose();
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
    ...(config.launcher ? { launcher: createServiceViewLauncher(window.fetch.bind(window)) } : {}),
    startBackend: () => config.launcher ? invoke({ action: 'backend-start' }) : Promise.resolve(),
    app,
    fileOpener,
    dispose,
  };
}
