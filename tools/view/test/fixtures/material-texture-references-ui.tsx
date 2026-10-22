import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import { mountMaterialPropertiesPanel } from '../../packages/view-plugin-material/src/ui/mount';
import { setLocale } from '../../packages/view-plugin-material/src/i18n/index.ts';

setLocale('en');
let revision = 1, epoch = 1, generation = 1, selected = 'ground';
let missingPublication = false, missingReference = false, empty = false, bound = true, many = false, failed = false, queued = false, unsupported = false;
let defer = false, pending = false;
let finish: (() => void) | undefined;
const calls: { operation: string; args: Record<string, unknown>; aborted: boolean }[] = [];
const listeners = new Set<(state: WorkspaceState) => void>();
const texture = (guid: string) => ({ guid, kind: 'texture', name: `texture/brick-floor-${guid}`, publicationId: `v${generation}`, lifecycle: 'current' });
const textures = [texture('base-color'), texture('normal'), { ...texture('roughness'), kind: 'equirect' }];
const asset = () => ({ guid: selected, kind: 'material', name: `material/${selected}`, path: 'assets/materials.pack.ts' });
const refs = () => empty ? [] : selected === 'ground' ? many ? Array.from({ length: 65 }, (_, index) => `extra-${index}`)
  : ['base-color', 'sampler', 'normal', 'base-color', 'roughness', ...(missingReference ? ['missing'] : [])] : ['other-texture'];
const publication = () => ({ generation, digest: `publication-${generation}`, outputs: [
  { guid: 'sibling', kind: 'material', refs: ['sibling-texture'] }, { guid: selected, kind: 'material', refs: refs() },
] });
const state = (): WorkspaceState => {
  const preview = { asset: asset(), target: { targetId: `preview-${selected}`, generation, worldId: 'world' },
    assetBinding: bound ? { publication: missingPublication ? undefined : publication(), meta: { kind: 'material', passCount: 1, parameterCount: 3,
      textureParameterCount: 3, passes: [{ name: 'Forward', program: 'standard', renderState: { depthWriteEnabled: true } }] } } : undefined };
  return { revision, thumbnailEpoch: epoch, catalogEpoch: generation, browserGeneration: 1,
    project: { id: 'project', root: '/fixture', name: 'Material textures fixture' }, projectTarget: { targetId: 'project-target', generation: 1 },
    previews: [preview], resourceOpens: { material: { asset: asset(), preview } }, assets: [asset(), ...textures,
      ...['other-texture', 'sibling-texture', ...Array.from({ length: 65 }, (_, index) => `extra-${index}`)].map(texture), { guid: 'sampler', kind: 'sampler' }],
  } as unknown as WorkspaceState;
};
const changed = () => { revision++; for (const listener of listeners) listener(state()); };
const image = (guid: string) => {
  const canvas = document.createElement('canvas');
  canvas.width = guid === 'normal' ? 64 : 256; canvas.height = guid === 'normal' ? 256 : 128;
  const context = canvas.getContext('2d')!;
  context.fillStyle = guid === 'normal' ? '#8080ff' : guid === 'roughness' ? '#b8b8b8' : '#a85d46';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#d3cdc4'; context.lineWidth = 3;
  for (let y = 0; y < canvas.height; y += 16) { context.beginPath(); context.moveTo(0, y); context.lineTo(canvas.width, y); context.stroke();
    for (let x = (y / 16 % 2) * 16; x < canvas.width; x += 32) { context.beginPath(); context.moveTo(x, y); context.lineTo(x, y + 16); context.stroke(); } }
  return canvas.toDataURL('image/png');
};
const client = {
  subscribe(listener: (state: WorkspaceState) => void) { listeners.add(listener); listener(state()); return () => listeners.delete(listener); },
  async getState() { return state(); },
  async inspectAsset(guid: string, options: { signal?: AbortSignal }) { return this.call('asset.inspect', { guid }, options); },
  async call(operation: string, args: Record<string, unknown>, options: { signal?: AbortSignal } = {}) {
    const call = { operation, args, aborted: false }; calls.push(call);
    options.signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
    const result = operation === 'assets.thumbnails' ? { thumbnails: (args.guids as string[]).map(guid => ({ guid,
      publicationId: textures.find(asset => asset.guid === guid)?.publicationId ?? `v${generation}`,
      state: unsupported ? 'unsupported' : failed ? 'failed' : queued ? 'queued' : 'ready', dataUrl: image(guid) })) }
      : operation === 'asset.inspect' ? { guid: selected, asset: asset(), publication: publication(), meta: { passCount: 1 } } : {};
    if (defer && ['assets.thumbnails', 'asset.inspect'].includes(operation)) {
      defer = false; pending = true; await new Promise<void>(resolve => { finish = resolve; }); pending = false;
    }
    return result;
  },
};
Object.assign(globalThis, { materialTexturesFixture: {
  calls, pending: () => pending, listeners: () => listeners.size,
  select(guid: string) { selected = guid; generation++; changed(); },
  replace() { generation++; for (const asset of textures) asset.publicationId = `v${generation}`; changed(); },
  set(options: Record<string, boolean>) {
    missingPublication = options.missingPublication ?? missingPublication; missingReference = options.missingReference ?? missingReference;
    empty = options.empty ?? empty; bound = options.bound ?? bound; many = options.many ?? many; failed = options.failed ?? failed; queued = options.queued ?? queued;
    unsupported = options.unsupported ?? unsupported; generation++; changed();
  },
  ready() { queued = false; epoch++; changed(); },
  defer() { defer = true; }, finish() { finish?.(); },
  longName() { textures[0]!.name = 'texture/' + 'VeryLongTextureName'.repeat(12); changed(); },
} });
await mountMaterialPropertiesPanel({ client: client as unknown as ViewWorkspaceClient, mountElement: document.getElementById('app')!,
  assetActions: value => {
    const guid = (value as { guid: string }).guid;
    return { onOpen: () => { void client.call('asset.open', { guid }); }, onBrowse: () => { void client.call('asset.browse', { guid }); } };
  },
});
