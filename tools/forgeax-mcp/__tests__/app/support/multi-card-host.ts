import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const config = JSON.parse(document.querySelector('#test-config')!.textContent!);
const requests: { owner: string; mode: string }[] = [];
const bridges = new Map<string, AppBridge>();
const contexts = new Map<string, { theme: 'light'; displayMode: 'inline' | 'fullscreen'; availableDisplayModes: ('inline' | 'fullscreen')[] }>();
const setMode = (owner: string, displayMode: 'inline' | 'fullscreen') => {
  const context = { theme: 'light' as const, displayMode, availableDisplayModes: ['inline', 'fullscreen'] as ('inline' | 'fullscreen')[] };
  contexts.set(owner, context); bridges.get(owner)!.setHostContext(context);
};
Object.assign(window, { multiCardHost: {
  requests: () => [...requests],
  snapshot: () => [...bridges].map(([owner, bridge]) => {
    const frame = document.getElementById(owner) as HTMLIFrameElement;
    const rect = frame.getBoundingClientRect();
    return { owner, context: contexts.get(owner), displayMode: frame.dataset.displayMode,
      className: frame.className, visibility: getComputedStyle(frame).visibility,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }),
  inline: async (owner: string) => {
    const frame = document.getElementById(owner) as HTMLIFrameElement;
    frame.classList.remove('fullscreen');
    frame.dataset.displayMode = 'inline';
    setMode(owner, 'inline');
    // Native input can still hit the old fullscreen iframe until its resize
    // reaches the compositor. Wait for the reference host to paint inline.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  },
  fullscreen: (owner: string) => {
    const frame = document.getElementById(owner) as HTMLIFrameElement;
    frame.classList.add('fullscreen');
    frame.style.visibility = '';
    frame.dataset.displayMode = 'fullscreen';
    setMode(owner, 'fullscreen');
  },
  add: async (entry: { id: string; initialMode?: string; result: unknown }) => addEntry(entry),
  remove: (owner: string) => {
    void bridges.get(owner)?.close(); bridges.delete(owner); contexts.delete(owner);
    document.getElementById(owner)?.remove();
  },
} });
async function addEntry(entry: { id: string; initialMode?: string; result: unknown }) {
  const owner = entry.id as string;
  let frame = document.getElementById(owner) as HTMLIFrameElement | null;
  if (!frame) {
    frame = document.createElement('iframe'); frame.id = owner; frame.dataset.card = owner;
    frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('allow', 'clipboard-write *'); document.body.append(frame);
  }
  const mode = entry.initialMode ?? 'inline';
  frame.classList.toggle('fullscreen', mode === 'fullscreen');
  const bridge = new AppBridge(null, { name: `Per-card reference host: ${owner}`, version: '1' },
    { serverTools: {} }, { hostContext: { theme: 'light', displayMode: mode, availableDisplayModes: ['inline', 'fullscreen'] } });
  bridges.set(owner, bridge);
  contexts.set(owner, { theme: 'light', displayMode: mode, availableDisplayModes: ['inline', 'fullscreen'] });
  bridge.oncalltool = async params => {
    const response = await fetch('/tool', { method: 'POST', body: JSON.stringify({ owner, params }) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
  bridge.onrequestdisplaymode = async ({ mode: requested }) => {
    requests.push({ owner, mode: requested });
    const actual = config.declineFullscreen ? 'inline' : requested;
    // Reference positioning preserves this iframe; native placement is unverified.
    for (const other of document.querySelectorAll<HTMLIFrameElement>('iframe[data-card]')) other.style.visibility = other === frame || !other.classList.contains('fullscreen') ? '' : 'hidden';
    frame.classList.toggle('fullscreen', actual === 'fullscreen');
    frame.dataset.displayMode = actual;
    setMode(owner, actual);
    return { mode: actual };
  };
  bridge.oninitialized = () => bridge.sendToolResult(entry.result);
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  frame.src = `/carrier?id=${encodeURIComponent(owner)}`;
}
for (const entry of config.entries) await addEntry(entry);
