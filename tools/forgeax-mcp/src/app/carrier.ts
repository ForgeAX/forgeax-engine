import { createToolQueue } from './tool-queue';
import { createHostPoll } from './host-poll';
import { relayConversation } from './bridge-protocol';
import { retireViewResources } from './retire-view';
import { readResourceBytes } from './resource-bytes';
import { createResourceCard, type CardResource } from './resource-card';
import { APP_VERSION, VIEW_TITLE, TRANSPORT_TOOL, RESOURCE_ACTION_TOOL } from '../contract';
import { z } from 'zod/v4';
z.config({ jitless: true });
import { App } from '@modelcontextprotocol/ext-apps';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const entryScope = JSON.parse(document.querySelector('#fx-entry-scope')?.textContent ?? '"workspace"');
const entryKind = JSON.parse(document.querySelector('#fx-entry-kind')?.textContent ?? '"view"');
const fileEntry = entryKind === 'file';
const directEntry = entryKind === 'resource-view';
const cardEntry = entryKind === 'card' || directEntry;
let expanded = !cardEntry;
document.documentElement.dataset.forgeaxInline = String(!expanded);
let activating = false;
let reservedSource: string | undefined;
let directResource: CardResource | undefined;
let directSource: string | undefined;
const app = new App(
  { name: VIEW_TITLE, version: APP_VERSION },
  { availableDisplayModes: cardEntry ? ['inline', 'fullscreen'] : ['fullscreen'] },
  { autoResize: false },
);
let appDocumentId = crypto.randomUUID();
let fileInput: Parameters<NonNullable<App['ontoolinput']>>[0] | undefined;
let bridgeReady = false;
let frame = document.querySelector<HTMLIFrameElement>('#view')!;
frame.hidden = cardEntry;
const show = (value: unknown) => {
  console.debug('ForgeAX carrier', value);
};
const makeQueue = () => createToolQueue((params: Parameters<App['callServerTool']>[0], signal) =>
  app.callServerTool({ ...params, arguments: { ...params.arguments, appDocumentId, entryScope, displayMode: app.getHostContext()?.displayMode ?? (expanded ? 'fullscreen' : 'inline') } }, { signal }),
);
let queue = makeQueue();
let poll = createHostPoll((params) => queue.call(params, { background: true }), TRANSPORT_TOOL);
const call = (params: any, options: any = {}) =>
  params.arguments?.action === 'host-read'
    ? poll.read(params.arguments.connectionId)
    : queue.call(params, options);
let bridge: AppBridge | undefined;
app.ontoolinput = (input) => {
  if (cardEntry || retired || (!fileEntry && !input.arguments?.assetSource)) return;
  fileInput = input;
  if (bridgeReady) void bridge?.sendToolInput(input).catch(reportFailure);
};
app.ontoolcancelled = (input) => {
  fileInput = undefined;
  if (bridgeReady) void bridge?.sendToolCancelled(input).catch(reportFailure);
};
let documentId: string | undefined;
let connected = false;
let retired = false;
let loading = Promise.resolve();
let sizeFrame: number | undefined;
let lastHeight: number | undefined;
const resizeInline = () => {
  if (sizeFrame !== undefined || retired || !connected || expanded) return;
  sizeFrame = requestAnimationFrame(() => {
    sizeFrame = undefined;
    if (retired || !connected || expanded) return;
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height === lastHeight) return;
    lastHeight = height;
    void app.sendSizeChanged({ height }).catch(reportFailure);
  });
};
const sizeObserver = new ResizeObserver(resizeInline);
sizeObserver.observe(document.body);
const reportFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  show({ stage: 'carrier-error', error: message });
  const status = document.querySelector('#carrier-error') ?? document.body.appendChild(document.createElement('p'));
  status.id = 'carrier-error';
  status.setAttribute('role', 'alert');
  status.textContent = message;
};
const presentCard = () => {
  document.documentElement.dataset.forgeaxInline = String(!expanded);
  frame.hidden = !expanded;
  if (resourceCard) resourceCard.element.hidden = expanded;
  if (expanded) lastHeight = undefined;
  else resizeInline();
};
const activateResource = async (resource: CardResource) => {
  if (retired) throw new Error('This resource card has closed.');
  activating = true;
  let opening = false;
  try {
    document.querySelector('#carrier-error')?.remove();
    const checked = await app.callServerTool({ name: RESOURCE_ACTION_TOOL, arguments: { path: resource.path, appDocumentId, entryScope, displayMode: app.getHostContext()?.displayMode ?? 'inline', reuse: !directEntry } });
    if (checked.isError) throw new Error(checked.content.filter(value => value.type === 'text').map(value => value.text).join('\n'));
    const selected = checked.structuredContent as { ok: boolean; value?: { projectRoot: string; sourcePath: string }; disposition?: 'open' | 'reused' } | undefined;
    if (!selected?.ok || typeof selected.value?.projectRoot !== 'string' || typeof selected.value.sourcePath !== 'string')
      throw new Error('The resource action did not return an asset source.');
    if (retired) throw new Error('This resource card has closed.');
    if (selected.disposition === 'reused') return;
    if (selected.disposition !== 'open') throw new Error('The resource action did not select a View destination.');
    opening = true;
    reservedSource = resource.path;
    fileInput = { arguments: { assetSource: { path: `${selected.value.projectRoot}/${selected.value.sourcePath}` } } };
    if (app.getHostContext()?.displayMode !== 'fullscreen') {
      const result = await app.requestDisplayMode({ mode: 'fullscreen' });
      if (result.mode !== 'fullscreen') throw new Error('Asset source validated, but the host did not expand ForgeAX View.');
    }
    if (retired) throw new Error('This resource card has closed.');
    expanded = true;
    presentCard();
    const priorBridge = bridge;
    const attempt = loading.then(loadView);
    loading = attempt.catch(() => {});
    await attempt;
    // A newly mounted child receives retained input from oninitialized. A
    // reused child needs this selection forwarded through its existing bridge.
    if (bridgeReady && bridge === priorBridge) await bridge!.sendToolInput(fileInput);
  } catch (error) {
    if (opening) { reservedSource = undefined; await app.callServerTool({ name: RESOURCE_ACTION_TOOL, arguments: { path: resource.path,
      appDocumentId, entryScope, displayMode: app.getHostContext()?.displayMode ?? 'inline', cancel: true } }).catch(() => {}); }
    throw error;
  } finally { activating = false; }
};
const resourceCard = cardEntry ? createResourceCard(activateResource, error => show({ stage: 'resource-action-error', error: String(error) })) : undefined;
const openDirectResource = () => {
  if (!connected || !directResource || directSource === directResource.path) return;
  directSource = directResource.path;
  void activateResource(directResource).catch(error => { directSource = undefined; reportFailure(error); });
};
const loadView = async () => {
  if (retired || !expanded) return;
  const result = await call({ name: TRANSPORT_TOOL, arguments: { action: 'view-document' } });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const ref: any = result.structuredContent;
  if (bridge && ref.resourceId === documentId) return;
  if (bridge) {
    const replacement = frame.cloneNode(false) as HTMLIFrameElement;
    replacement.removeAttribute('srcdoc');
    replacement.removeAttribute('src');
    // Teardown can report disconnected old Host leases after a backend restart.
    // Still retire every child and bridge before admitting the replacement.
    await retireViewResources([{ bridge, frame }], [], () => {}).catch(reportFailure);
    bridge = undefined;
    bridgeReady = false;
    frame = replacement;
    presentCard();
    document.body.append(frame);
  }
  const started = performance.now();
  const data = await readResourceBytes(ref, async (args: any) => {
    const result = await call({ name: TRANSPORT_TOOL, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result.structuredContent;
  });
  if (retired) return;
  bridge = new AppBridge(
    null,
    { name: 'ForgeAX MCP carrier', version: APP_VERSION },
    { ...app.getHostCapabilities(), serverTools: {} },
    { hostContext: app.getHostContext() ?? {} },
  );
  bridge.oncalltool = (params, extra) => {
    if (params.name !== TRANSPORT_TOOL) throw new Error('Tool outside View');
    return call(params, { signal: extra.signal });
  };
  bridge.onupdatemodelcontext = (params, extra) =>
    app.updateModelContext(params, { signal: extra.signal });
  relayConversation(bridge, app);
  const mountedBridge = bridge;
  bridge.oninitialized = () => {
    if (retired || bridge !== mountedBridge) return;
    bridgeReady = true;
    if (fileInput) void mountedBridge.sendToolInput(fileInput).catch(reportFailure);
  };
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  documentId = ref.resourceId;
  document.querySelector('#carrier-error')?.remove();
  frame.srcdoc = new TextDecoder().decode(data);
  show({
    stage: 'full-view-loaded',
    bytes: data.length,
    wireBytes: ref.bytes,
    downloadMs: Math.round(performance.now() - started),
    host: app.getHostVersion(),
  });
};
const reload = () => {
  loading = loading.then(loadView).catch(reportFailure);
};
let bindingTimer: ReturnType<typeof setTimeout> | undefined;
const readBinding = async () => {
  const result = await app.callServerTool({ name: TRANSPORT_TOOL, arguments: {
    action: 'binding-read', appDocumentId, entryScope,
  } });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent as { phase: string; revision: number };
};
const watchBinding = async () => {
  if (retired || entryScope !== 'workspace') return;
  try {
    if (!expanded && !documentId) return;
    const state = await readBinding();
    frame.style.pointerEvents = state.phase === 'ready' ? '' : 'none';
    frame.inert = state.phase !== 'ready';
    if (state.phase === 'retiring') {
      loading = loading.then(async () => {
        if (retired) return;
        // Keep old transport alive until children acknowledge disposal.
        if (bridge) await retireViewResources([{ bridge, frame }], [], () => {});
        bridge = undefined;
        bridgeReady = false;
        await app.callServerTool({ name: TRANSPORT_TOOL, arguments: { action: 'app-close', appDocumentId, entryScope } });
        poll.close(); queue.close();
        appDocumentId = crypto.randomUUID();
        queue = makeQueue();
        poll = createHostPoll(params => queue.call(params, { background: true }), TRANSPORT_TOOL);
        documentId = undefined;
        frame = frame.cloneNode(false) as HTMLIFrameElement;
        frame.removeAttribute('srcdoc'); frame.removeAttribute('src');
        presentCard();
        document.body.append(frame);
        while (!retired && (await readBinding()).phase !== 'ready') await new Promise(done => setTimeout(done, 150));
        await loadView();
      });
      await loading;
    }
  } catch (error) { if (!retired) reportFailure(error); }
  finally { if (!retired) bindingTimer = setTimeout(watchBinding, 750); }
};
app.ontoolresult = (result) => {
  if (cardEntry) {
    if (result.isError) reportFailure(result.content);
    else if (Array.isArray(result.structuredContent?.resources)) {
      try { resourceCard!.update(result.structuredContent?.resources); }
      catch (error) { reportFailure(error); return; }
      if (directEntry) {
        directResource = result.structuredContent.resources[0] as CardResource;
        openDirectResource();
      }
      resizeInline();
    }
    return;
  }
  if (!result.isError && typeof result.structuredContent?.url === 'string' && connected)
    reload();
};
app.onhostcontextchanged = () => {
  const context = app.getHostContext() ?? {};
  bridge?.setHostContext(context);
  if (documentId && !retired) void call({ name: TRANSPORT_TOOL, arguments: { action: 'app-context' } }).catch(reportFailure);
  if (cardEntry) {
    const wasExpanded = expanded;
    expanded = context.displayMode === 'fullscreen';
    presentCard();
    if (expanded && !wasExpanded && !activating && fileInput) {
      loading = loading.then(loadView).catch(reportFailure);
    }
    resizeInline();
  }
};
app.onteardown = async () => {
  retired = true;
  sizeObserver.disconnect();
  if (sizeFrame !== undefined) cancelAnimationFrame(sizeFrame);
  clearTimeout(bindingTimer);
  if (reservedSource) await app.callServerTool({ name: RESOURCE_ACTION_TOOL, arguments: { path: reservedSource,
    appDocumentId, entryScope, displayMode: app.getHostContext()?.displayMode ?? 'inline', cancel: true } }).catch(() => {});
  await loading;
  try {
    if (bridge) await retireViewResources([{ bridge, frame }], [], () => {});
    else frame.remove();
  } finally {
    await app.callServerTool({ name: TRANSPORT_TOOL, arguments: { action: 'app-close', appDocumentId, entryScope } }).catch(reportFailure);
    poll.close();
    queue.close();
  }
  return {};
};
window.addEventListener('pagehide', () => {
  retired = true;
  sizeObserver.disconnect();
  if (sizeFrame !== undefined) cancelAnimationFrame(sizeFrame);
  clearTimeout(bindingTimer);
  if (reservedSource) void app.callServerTool({ name: RESOURCE_ACTION_TOOL, arguments: { path: reservedSource,
    appDocumentId, entryScope, displayMode: app.getHostContext()?.displayMode ?? 'inline', cancel: true } }).catch(() => {});
  void app.callServerTool({ name: TRANSPORT_TOOL, arguments: { action: 'app-close', appDocumentId, entryScope } }).catch(() => {});
});
app.connect().then(() => {
  connected = true;
  resizeInline();
  // This operation only records sanitized host context when explicitly enabled in Node.
  void call({ name: TRANSPORT_TOOL, arguments: { action: 'context-probe', hostContext: app.getHostContext() } }).catch(reportFailure);
  if (!cardEntry) reload();
  else {
    expanded = app.getHostContext()?.displayMode === 'fullscreen';
    presentCard();
    if (directEntry) openDirectResource();
  }
  void watchBinding();
}).catch(reportFailure);
window.addEventListener('securitypolicyviolation', (event) =>
  show({ stage: 'carrier-csp', directive: event.violatedDirective, blockedURI: event.blockedURI }),
);
