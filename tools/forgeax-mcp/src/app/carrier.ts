import { createToolQueue } from './tool-queue';
import { createHostPoll } from './host-poll';
import { relayConversation } from './bridge-protocol';
import { retireViewResources } from './retire-view';
import { readResourceBytes } from './resource-bytes';
import { APP_VERSION, VIEW_TITLE, TRANSPORT_TOOL } from '../contract';
import { z } from 'zod/v4';
z.config({ jitless: true });
import { App } from '@modelcontextprotocol/ext-apps';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const app = new App(
  { name: VIEW_TITLE, version: APP_VERSION },
  { availableDisplayModes: ['fullscreen'] },
  { autoResize: false },
);
let frame = document.querySelector<HTMLIFrameElement>('#view')!;
const show = (value: unknown) => {
  console.debug('ForgeAX carrier', value);
};
const queue = createToolQueue((params: Parameters<App['callServerTool']>[0], signal) =>
  app.callServerTool(params, { signal }),
);
const poll = createHostPoll((params) => queue.call(params, { background: true }), TRANSPORT_TOOL);
const call = (params: any, options: any = {}) =>
  params.arguments?.action === 'host-read'
    ? poll.read(params.arguments.connectionId)
    : queue.call(params, options);
let bridge: AppBridge | undefined;
let documentId: string | undefined;
let connected = false;
let retired = false;
let loading = Promise.resolve();
const reportFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  show({ stage: 'carrier-error', error: message });
  const status = document.querySelector('#carrier-error') ?? document.body.appendChild(document.createElement('p'));
  status.id = 'carrier-error';
  status.setAttribute('role', 'alert');
  status.textContent = message;
};
const loadView = async () => {
  if (retired) return;
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
    frame = replacement;
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
app.ontoolresult = (result) => {
  if (!result.isError && typeof result.structuredContent?.url === 'string' && connected)
    reload();
};
app.onhostcontextchanged = () => bridge?.setHostContext(app.getHostContext() ?? {});
app.onteardown = async () => {
  retired = true;
  await loading;
  try {
    if (bridge) await retireViewResources([{ bridge, frame }], [], () => {});
    else frame.remove();
  } finally {
    poll.close();
    queue.close();
  }
  return {};
};
app.connect().then(() => {
  connected = true;
  reload();
}).catch(reportFailure);
window.addEventListener('securitypolicyviolation', (event) =>
  show({ stage: 'carrier-csp', directive: event.violatedDirective, blockedURI: event.blockedURI }),
);
