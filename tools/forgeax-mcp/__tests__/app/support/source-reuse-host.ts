import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const config = JSON.parse(document.querySelector('#test-config')!.textContent!);
const calls: unknown[] = [], displayRequests: string[] = [];
const frame = document.querySelector<HTMLIFrameElement>('#card')!;
const bridge = new AppBridge(null, { name: 'Existing presenter reference', version: '1' }, { serverTools: {} },
  { hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } });
bridge.oncalltool = async params => {
  calls.push(params);
  if (params.name === config.actionTool) return { content: [], structuredContent: {
    ok: true, value: { projectRoot: '/consumer', sourcePath: 'assets/archway.scene.pack.json' }, disposition: 'reused',
  } };
  if (params.arguments?.action === 'context-probe') return { content: [], structuredContent: {} };
  throw new Error('Reused selection must not acquire another View document');
};
bridge.onrequestdisplaymode = async ({ mode }) => {
  displayRequests.push(mode);
  return { mode: 'inline' };
};
bridge.oninitialized = () => bridge.sendToolResult({ content: [], structuredContent: {
  resources: [{ path: '/consumer/assets/archway.scene.pack.json', label: 'archway.scene.pack.json' }],
} });
Object.assign(window, { sourceReuseHost: { calls: () => calls, displayRequests: () => displayRequests } });
await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
frame.src = '/carrier';
