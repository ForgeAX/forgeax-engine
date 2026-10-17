import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { mountContentBrowserPanel } from '../../packages/view-plugin-content-browser/src/ui/mount';
import { setLocale as setContentLocale } from '../../packages/view-plugin-content-browser/src/i18n/index.ts';
import { mountSceneTreePanel } from '../../packages/view-plugin-scene-tree/src/ui/mount';
import { setLocale as setSceneLocale } from '../../packages/view-plugin-scene-tree/src/i18n/index.ts';
import { mountInspectorPanel } from '../../packages/view-plugin-inspector/src/ui/mount';
import { setLocale as setInspectorLocale } from '../../packages/view-plugin-inspector/src/i18n/index.ts';
import type { AssetReferenceService } from '@forgeax/view-workspace-core/asset-references';
import { AssetReferenceField } from '@forgeax/view-components';
import { createRoot } from 'react-dom/client';

setContentLocale('zh');
setSceneLocale('zh');
setInspectorLocale('zh');
document.documentElement.dataset.forgeaxViewActivePage = 'scene';

const assets = [
  { guid: 'cube-guid', kind: 'mesh', sourceKey: 'mesh/cube', path: 'assets/geometry.pack.ts', previewable: true },
  { guid: 'other-guid', kind: 'mesh', sourceKey: 'mesh/other', path: 'assets/geometry.pack.ts', previewable: true },
  { guid: 'material-guid', kind: 'material', sourceKey: 'material/surface', path: 'assets/materials.pack.ts', previewable: true },
  { guid: 'audio-guid', kind: 'audio', sourceKey: 'audio/ambient', path: 'assets/audio.pack.ts', previewable: false },
];
let revision = 1;
let generation = 1;
let handle: string | number = 'cube-guid';
let deferInspection = false;
let finishInspection: (() => void) | undefined;
let nativeMapping = false;
let manyReferences = false;
let snapshot = {
  revision,
  project: { id: 'project', name: 'Game 3D', root: '/fixture', assetRoots: ['assets'] },
  preview: { target: { targetId: 'scene', generation }, asset: { guid: 'scene-guid', kind: 'scene', name: 'Showcase' } },
  sceneSelection: null as { primary: { entityId: string; label?: string }; entityIds: string[] } | null,
  assets,
};
const listeners = new Set<(state: typeof snapshot) => void>();
const calls: { operation: string; args: Record<string, unknown>; aborted: boolean }[] = [];
const publish = () => {
  snapshot = { ...snapshot, revision: ++revision };
  for (const listener of listeners) listener(snapshot);
};
const client = {
  transport: {
    connected: true,
    async request() { return { sources: [] }; },
    subscribe() { return () => {}; },
  },
  subscribe(listener: (state: typeof snapshot) => void) { listeners.add(listener); listener(snapshot); return () => listeners.delete(listener); },
  onDisconnect() { return () => {}; },
  async getState() { return snapshot; },
  async getSceneTree() {
    return { targetId: 'scene', revision: 1, nextOffset: null, nodes: [
      { entityId: 'scene:world:2', name: 'Lacquer Collision Cube', parentId: null, componentNames: ['Name', 'Transform', 'MeshFilter', 'MeshRenderer'] },
      { entityId: 'scene:world:3', name: 'Other Cube', parentId: null, componentNames: ['MeshFilter', 'MeshRenderer'] },
      { entityId: 'scene:world:4', name: 'Ambient track', parentId: null, componentNames: ['AudioSource'] },
      { entityId: 'scene:world:5', name: 'Combined object', parentId: null, componentNames: ['AudioSource', 'MeshFilter'] },
      { entityId: 'scene:world:6', name: 'Material-only object', parentId: null, componentNames: ['ProjectedDecal'] },
    ] };
  },
  async selectSceneEntity(entityId: string) {
    snapshot.sceneSelection = { primary: { entityId }, entityIds: [entityId] };
    publish();
    return snapshot;
  },
  async clearSceneSelection() { snapshot.sceneSelection = null; publish(); return snapshot; },
  async selectTab() { return snapshot; },
  async listAssets() { return { assets }; },
  async inspectAsset(guid: string, options: Record<string, unknown>) {
    calls.push({ operation: 'asset.inspect', args: { guid, ...options }, aborted: false });
    return { inspection: { guid } };
  },
  async call(operation: string, args: Record<string, unknown>, options: { signal?: AbortSignal } = {}) {
    const call = { operation, args, aborted: false };
    calls.push(call);
    options.signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
    if (operation === 'entity.inspect') {
      if (deferInspection) {
        deferInspection = false;
        await new Promise<void>(resolve => { finishInspection = resolve; });
      }
      return { entityId: args.entityId, targetId: args.targetId, components: args.entityId === 'scene:world:4' ? [
        { name: 'AudioSource', fields: { clip: { type: 'shared<AudioClipAsset>' } }, values: { clip: 1088 } },
      ] : args.entityId === 'scene:world:6' ? [
        { name: 'ProjectedDecal', fields: { material: { type: 'shared<MaterialAsset>' } }, values: { material: 1089 } },
      ] : [
        { name: 'MeshFilter', fields: { assetHandle: { type: 'shared<MeshAsset>' } }, values: { assetHandle: handle } },
        { name: 'MeshRenderer', fields: { materials: { type: 'array<shared<MaterialAsset>>' } }, values: { materials: [0] } },
      ] };
    }
    if (operation === 'assets.list') return { assets };
    if (operation === 'asset.open') return { asset: assets.find(asset => asset.guid === args.guid) };
    throw new Error(`Unexpected operation: ${operation}`);
  },
};

const browserElement = document.getElementById('browser')!;
const browserMount = document.getElementById('browser-mount')!;
let revealAsset: ((input: { projectId: string; guid: string; targetId: string; targetGeneration?: number }) => Promise<boolean>) | undefined;
const mountBrowser = () => mountContentBrowserPanel({
  client: client as unknown as ViewWorkspaceClient,
  mountElement: browserMount,
  revealPanel: async () => { browserElement.hidden = false; return true; },
  registerAssetReveal: handler => {
    revealAsset = handler;
    return () => { if (revealAsset === handler) revealAsset = undefined; };
  },
});
let disposeBrowser = await mountBrowser();
const referenceState = { phase: 'ready' as const, scope: { projectId: 'project', targetId: 'scene', targetGeneration: generation, worldId: 'world', browserGeneration: 1 } };
const assetReferences: AssetReferenceService = {
  getState: () => referenceState,
  subscribe: () => () => {},
  async query(entityId) {
    const mesh = { key: 'MeshFilter.assetHandle', component: 'MeshFilter', field: 'assetHandle', origin: 'component' as const, primary: true,
      status: typeof handle === 'string' || nativeMapping ? 'resolved' as const : 'unregistered' as const,
      ...(typeof handle === 'string' || nativeMapping ? { guid: 'cube-guid', kind: 'mesh' } : {}), };
    const audio = { key: 'AudioSource.clip', component: 'AudioSource', field: 'clip', origin: 'component' as const, primary: true, status: 'resolved' as const, guid: 'audio-guid', kind: 'audio' };
    return { ...referenceState.scope, targetGeneration: generation, entityId,
      references: entityId === 'scene:world:4' ? [audio] : entityId === 'scene:world:5' ? [mesh, audio]
        : entityId === 'scene:world:6' ? [{ key: 'ProjectedDecal.material', component: 'ProjectedDecal', field: 'material', origin: 'component', status: 'resolved', guid: 'material-guid', kind: 'material' }] : [mesh,
        ...(nativeMapping ? Array.from({ length: manyReferences ? 50 : 1 }, (_, index) => ({ key: `MeshRenderer.materials[${index}]`, component: 'MeshRenderer', field: 'materials', index, slotName: `Surface ${index}`, origin: 'mesh-default' as const, status: 'resolved' as const, guid: 'material-guid', kind: 'material' })) : [])] };
  },
  open: guid => client.call('asset.open', { projectId: 'project', tabId: 'forgeax-user-workspace', targetId: 'scene', targetGeneration: generation, guid }),
};
await mountSceneTreePanel({
  client: client as unknown as ViewWorkspaceClient,
  mountElement: document.getElementById('scene')!,
  browseAsset: input => revealAsset?.(input) ?? Promise.resolve(false),
  canBrowseAsset: () => Boolean(revealAsset),
  assetReferences,
});
const inspector = document.createElement('div');
inspector.dataset.testid = 'fixture-inspector';
inspector.style.height = '620px';
document.body.append(inspector);
await mountInspectorPanel({ client: client as unknown as ViewWorkspaceClient, mountElement: inspector, assetReferences,
  browseAsset: guid => revealAsset?.({ projectId: 'project', guid, targetId: 'scene', targetGeneration: generation }) ?? Promise.resolve(false) });
const unavailableCards = document.createElement('div');
document.body.append(unavailableCards);
createRoot(unavailableCards).render(<div style={{ width: 320 }}>
  <div data-testid="missing-asset"><AssetReferenceField value={{ guid: 'removed', name: 'Removed', missing: true }} onOpen={() => { throw new Error('Missing asset opened'); }} /></div>
  <div data-testid="unregistered-asset"><AssetReferenceField value={{ name: 'Handle 1088' }} onOpen={() => { throw new Error('Unregistered asset opened'); }} /></div>
  <div data-testid="unavailable-viewer"><AssetReferenceField value={{ guid: 'cube-guid', name: 'Cube' }} /></div>
</div>);

Object.assign(globalThis, { sceneMeshAssetFixture: {
  calls,
  selected: () => snapshot.sceneSelection?.primary.entityId,
  browserReady: () => Boolean(revealAsset),
  setHandle(value: string | number) { handle = value; },
  enableNativeMapping() { nativeMapping = true; publish(); },
  useLongAssetName() { Object.assign(assets[3]!, { name: 'Ambient forest soundtrack with a deliberately long asset name' }); publish(); },
  useManyReferences(value: boolean) { manyReferences = value; },
  deferInspection() { deferInspection = true; },
  inspectionPending: () => Boolean(finishInspection),
  finishInspection() { finishInspection?.(); finishInspection = undefined; },
  replaceTarget() { snapshot.preview.target = { targetId: 'scene', generation: ++generation }; publish(); },
  async removeBrowser() { await disposeBrowser(); },
  async restoreBrowser() { disposeBrowser = await mountBrowser(); },
} });
