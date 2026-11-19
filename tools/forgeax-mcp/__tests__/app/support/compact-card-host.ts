import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const config = JSON.parse(document.querySelector('#test-config')!.textContent!);
const frame = document.querySelector<HTMLIFrameElement>('#card')!;
const sizes: { height?: number; width?: number }[] = [];
const bridge = new AppBridge(null, { name: 'Compact card reference', version: '1' }, { serverTools: {} },
  { hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } });
let fail = false;
let opening = false;
let releaseAction: (() => void) | undefined;
let actionGate: Promise<void> | undefined;
const calls: unknown[] = [], displayRequests: string[] = [];
bridge.onsizechange = params => { sizes.push(params); };
bridge.oncalltool = async params => {
  calls.push(params);
  if (params.name === config.actionTool && params.arguments?.cancel) return { content: [], structuredContent: { ok: true } };
  if (params.name === config.actionTool) {
    await actionGate;
    return fail
    ? { isError: true, content: [{ type: 'text', text: 'This source was removed. Select another resource or retry after restoring the original file.' }] }
    : { content: [], structuredContent: { ok: true, disposition: opening ? 'open' : 'reused', value: { projectRoot: '/consumer', sourcePath: 'archway.scene.pack.json' } } };
  }
  if (params.arguments?.action === 'context-probe') return { content: [], structuredContent: {} };
  throw new Error('Compact reused card must not acquire another View');
};
bridge.onrequestdisplaymode = async ({ mode }) => {
  displayRequests.push(mode);
  return { mode: 'inline' };
};
bridge.oninitialized = () => bridge.sendToolResult({ content: [], structuredContent: {
  resources: [{ path: '/consumer/archway.scene.pack.json', label: 'archway.scene.pack.json' }],
} });
Object.assign(window, { compactCardHost: {
  sizes: () => [...sizes], fail: () => { fail = true; }, recover: () => { fail = false; },
  pause: () => { actionGate = new Promise<void>(resolve => { releaseAction = resolve; }); },
  release: () => { releaseAction?.(); actionGate = undefined; releaseAction = undefined; },
  open: () => { opening = true; },
  calls: () => calls, displayRequests: () => displayRequests,
  mode: (displayMode: 'inline' | 'fullscreen') => bridge.setHostContext({ displayMode }),
  resources: (resources: { path: string; label: string }[]) => bridge.sendToolResult({ content: [], structuredContent: { resources } }),
} });
await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
frame.src = '/carrier';
