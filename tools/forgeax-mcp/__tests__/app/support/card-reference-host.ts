import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const config = JSON.parse(document.querySelector('#test-config')!.textContent!);
const frame = document.querySelector<HTMLIFrameElement>('#app')!;
const bridge = new AppBridge(null, { name: 'Resource card reference host', version: '1' },
  { serverTools: {} }, { hostContext: { theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } });
let acceptFullscreen = false;
const displayRequests: string[] = [];
bridge.oncalltool = async params => {
  const response = await fetch('/tool', { method: 'POST', body: JSON.stringify(params) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
bridge.onrequestdisplaymode = async ({ mode }) => {
  displayRequests.push(mode);
  const actual = mode === 'fullscreen' && acceptFullscreen ? 'fullscreen' : 'inline';
  bridge.setHostContext({ theme: 'light', displayMode: actual, availableDisplayModes: ['inline', 'fullscreen'] });
  return { mode: actual };
};
bridge.oninitialized = () => bridge.sendToolResult(config.result);
Object.assign(window, { cardTestHost: {
  allowFullscreen: () => { acceptFullscreen = true; },
  displayRequests: () => [...displayRequests],
  collapse: () => bridge.setHostContext({ theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] }),
  close: async () => { await bridge.teardownResource({}); await bridge.close(); frame.remove(); },
} });
await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
frame.src = '/carrier';
