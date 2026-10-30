import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { conversationMessageSchema } from '../../src/app/bridge-protocol';
import { OPEN_TOOL } from '../../src/contract';
const frame = document.querySelector<HTMLIFrameElement>('#app')!;
const bridge = new AppBridge(
  null,
  { name: 'ForgeAX browser acceptance host', version: '1' },
  { serverTools: {}, experimental: { 'openai/message': {} } },
  { hostContext: { theme: 'light', displayMode: 'fullscreen' } },
);
bridge.oncalltool = async (params, extra) => {
  const response = await fetch('/tool', {
    method: 'POST',
    body: JSON.stringify(params),
    signal: extra.signal,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
const open = async () => {
  const response = await fetch('/tool', { method: 'POST', body: JSON.stringify({ name: OPEN_TOOL, arguments: {} }) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
bridge.oninitialized = async () => {
  await bridge.sendToolInput({ arguments: {} });
  await bridge.sendToolResult(await open());
};
for (const id of ['reopen', 'restart'])
  document.querySelector(`#${id}`)!.addEventListener('click', async () => {
    let result;
    if (id === 'restart') {
      const response = await fetch('/restart', { method: 'POST' });
      if (!response.ok) throw new Error(`Backend restart failed: HTTP ${response.status}`);
      result = await response.json();
    } else result = await open();
    await bridge.sendToolResult(result);
    document.querySelector('#opened')!.textContent = result.structuredContent.url;
  });
bridge.setRequestHandler(conversationMessageSchema, async ({ params }) => {
  if ((params._meta?.['openai/message'] as any)?.send !== false)
    throw new Error('Reference must remain a draft');
  document.querySelector('#draft')!.textContent = JSON.stringify(params);
  return {};
});
for (const theme of ['light', 'dark'] as const)
  document
    .querySelector(`#${theme}`)!
    .addEventListener('click', () => bridge.setHostContext({ theme }));
document.querySelector('#close')!.addEventListener('click', async () => {
  try {
    await bridge.teardownResource({});
    await bridge.close();
    frame.remove();
    document.querySelector('#closed')!.textContent = 'closed';
  } catch (error) {
    document.querySelector('#closed')!.textContent = String(error);
  }
});
await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
frame.src = '/carrier.html';
