import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const config = JSON.parse(document.querySelector('#test-config')!.textContent!);
const frame = document.querySelector<HTMLIFrameElement>('#app')!;
const bridge = new AppBridge(null, { name: 'File entry browser verification', version: '1' },
  { serverTools: {} }, { hostContext: { theme: 'light', displayMode: 'fullscreen' } });
const call = async (params: unknown) => {
  const response = await fetch(`/tool?entry=${config.entry}`, { method: 'POST', body: JSON.stringify(params) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
bridge.oncalltool = (params) => call(params);
const input = (name = 'world.scene.pack.json') => ({ arguments: { file: { name, resourceUri: 'opaque://selected-file' } } });
bridge.oninitialized = async () => {
  if (config.file) {
    await bridge.sendToolInput(input());
    await bridge.sendToolResult(await call({ name: 'forgeax_view_file_open', arguments: input().arguments }));
  } else {
    await bridge.sendToolInput({ arguments: {} });
    await bridge.sendToolResult(await call({ name: 'forgeax_view_start', arguments: {} }));
  }
};
Object.assign(window, { fileTestHost: {
  activate: (name?: string) => bridge.sendToolInput(input(name)),
  cancel: () => bridge.sendToolCancelled({ reason: 'verification cancellation' }),
  reopen: async () => bridge.sendToolResult(await call({ name: 'forgeax_view_start', arguments: {} })),
  close: async () => { await bridge.teardownResource({}); await bridge.close(); frame.remove(); },
} });
await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
frame.src = `/carrier?entry=${config.entry}`;
