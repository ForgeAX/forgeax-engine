import type { FrontendFrame } from '@forgeax/engine-host/platform';
import { App, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { APP_VERSION, TRANSPORT_TOOL } from '../contract';
import { retireViewResources } from './retire-view';

/** URL identity owns one isolated document, its bridge, and its cancellation. */
export function createMcpDocumentRuntime(
  app: App,
  invoke: (args: any, options?: any) => Promise<any>,
  bytes: (ref: any, options?: any) => Promise<Uint8Array>,
  hostContext: () => McpUiHostContext = () => app.getHostContext() ?? {},
) {
  const documents = new Map<string, { handle: FrontendFrame; bridge: AppBridge }>();
  const createFrame = (url: string): FrontendFrame => {
    const existing = documents.get(url);
    if (existing) return existing.handle;
    const controller = new AbortController();
    const element = document.createElement('iframe');
    element.setAttribute('sandbox', 'allow-scripts allow-pointer-lock');
    element.setAttribute('allow', 'autoplay *; fullscreen *; clipboard-write *');
    Object.assign(element.style, { width: '1280px', height: '720px', border: '0',
      display: 'block', position: 'fixed', left: '0', top: '0', visibility: 'hidden' });
    document.body.append(element);
    const bridge = new AppBridge(null, { name: 'ForgeaX document bridge', version: APP_VERSION },
      { serverTools: {} }, { hostContext: hostContext() });
    bridge.oncalltool = (params, extra) => {
      if (params.name !== TRANSPORT_TOOL) throw new Error('Tool outside document transport');
      return app.callServerTool(params, { signal: extra.signal });
    };
    bridge.onupdatemodelcontext = async () => ({});
    let retiring: Promise<void> | undefined;
    const ready = (async () => {
      await bridge.connect(new PostMessageTransport(element.contentWindow!, element.contentWindow!));
      const options = { signal: controller.signal };
      const ref = await invoke({ action: 'document', url }, options);
      const data = await bytes(ref, options);
      controller.signal.throwIfAborted();
      element.srcdoc = new TextDecoder().decode(data);
    })().catch(async error => {
      await bridge.close();
      element.remove();
      if (documents.get(url)?.handle === handle) documents.delete(url);
      if (!controller.signal.aborted) throw error;
    });
    const handle: FrontendFrame = {
      element, ready,
      dispose() {
        return retiring ??= (async () => {
          controller.abort();
          await ready;
          try { await retireViewResources([{ bridge, frame: element }], [], () => {}); }
          finally { if (documents.get(url)?.handle === handle) documents.delete(url); }
        })();
      },
    };
    documents.set(url, { handle, bridge });
    return handle;
  };
  return {
    createFrame,
    setHostContext(context: McpUiHostContext) {
      for (const entry of documents.values()) entry.bridge.setHostContext(context);
    },
    async dispose() {
      const results = await Promise.allSettled([...documents.values()].map(entry => entry.handle.dispose()));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'MCP document retirement failed');
    },
  };
}
