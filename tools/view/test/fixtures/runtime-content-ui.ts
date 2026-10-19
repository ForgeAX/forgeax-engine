// UI-only evidence. These deterministic responses do not simulate Engine acceptance.
import { mountContentBrowserPanel } from '../../packages/view-plugin-content-browser/src/ui/mount';
import { setLocale } from '../../packages/view-plugin-content-browser/src/i18n/index.ts';
setLocale('en');

const parent = '01900000-0000-7000-8000-000000000101';
let revision = 1;
const thumbnailRevision = new URLSearchParams(location.search).has('thumbnail-revision');
let catalogEpoch = 0;
let thumbnailEpoch = 0;
let holdThumbnails = false;
let thumbnailColor = 'red';
const pendingThumbnails: (() => void)[] = [];
const thumbnailAssets = thumbnailRevision ? ['image-guid', 'other-image'].map(guid => ({ guid, kind: 'texture', name: guid, sourcePath: 'content/images.pack.ts', lifecycle: 'current' })) : [];
function thumbnailPng() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4;
  const context = canvas.getContext('2d')!; context.fillStyle = thumbnailColor; context.fillRect(0, 0, 4, 4);
  return canvas.toDataURL();
}
let revealCount = 0;
let target = { targetId: 'project-target', worldId: 'project-world' };
let executions: any[] = [];
let plugins: any[] = [];
let outputs: any[] = [];
let deferGeneration = false;
let completeGeneration: (() => void) | undefined;
let failSave = false;
let deferInspection = new URLSearchParams(location.search).has('defer-inspection');
let completeInspection: (() => void) | undefined;
const calls: any[] = [];
const listeners = new Set<(state: unknown) => void>();
const pack = { source: { packageId: parent, source: 'Box generator', kind: 'scriptable-pack-source', parameters: [
  { name: 'width', type: 'f32', default: 1, minimum: 1, maximum: 5 },
  { name: 'enabled', type: 'bool', default: true },
] } };
const asset = { guid: 'plugin-guid', kind: 'plugin', name: 'Counter behavior', sourcePath: 'content/behavior.pack.ts' };
const state = () => ({ revision, project: { id: 'project', root: '/fixture', assetRoots: ['content'], name: 'Runtime content fixture' }, projectTarget: target, catalogEpoch, thumbnailEpoch, assets: [asset, ...outputs, ...thumbnailAssets] });
const changed = () => { revision++; for (const listener of listeners) listener(state()); };
const client = {
  transport: { connected: true, async request() { return null; } },
  subscribe(listener: (state: unknown) => void) { listeners.add(listener); listener(state()); return () => listeners.delete(listener); },
  onDisconnect() { return () => {}; },
  async getState() { return state(); },
  async listAssets() { changed(); return { catalogEpoch, thumbnailEpoch, assets: [asset, ...outputs, ...thumbnailAssets] }; },
  async thumbnails(_projectId: string, guids: string[]) {
    if (holdThumbnails) await new Promise<void>(done => { pendingThumbnails.push(done); });
    return { thumbnails: guids.map(guid => ({ guid, state: 'ready', dataUrl: thumbnailPng() })) };
  },
  async call(operation: string, args: any, options: any = {}) {
    const call = { operation, args, aborted: false, completed: false }; calls.push(call);
    options.signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
    if (operation === 'runtime-pack.inspect') {
      if (deferInspection) await new Promise<void>(resolve => { completeInspection = resolve; });
      if (failSave) throw new Error('Inspection unavailable');
      return { packs: [pack], executions: structuredClone(executions) };
    }
    if (operation === 'runtime-pack.plugin-inspect') return { plugins: structuredClone(plugins) };
    if (operation === 'runtime-pack.generate') {
      if (deferGeneration) {
        await new Promise<void>(resolve => { completeGeneration = resolve; });
        call.completed = true;
        return { status: 'admitted' };
      }
      const old = executions.find(item => item.instance.packageId === args.instance.packageId);
      const execution = { instance: args.instance, status: args.instance.values.width > 5 ? 'failed' : 'current', lastKnownGood: old?.lastKnownGood };
      executions = executions.filter(item => item.instance.packageId !== args.instance.packageId).concat(execution);
      if (execution.status === 'failed') throw new Error('Width must be at most 5');
      execution.lastKnownGood = { generation: (old?.lastKnownGood?.generation ?? 0) + 1 };
      outputs = [{ guid: 'mesh-guid', kind: 'mesh', name: `Box ${args.instance.values.width}`, sourcePath: 'content/generated.pack.ts' }];
      changed(); return { status: 'admitted' };
    }
    if (operation === 'runtime-pack.plugin-install') { plugins.push({ uid: 21, state: 'active' }); return { uid: 21, state: 'active' }; }
    if (operation === 'runtime-pack.plugin-dispose') { plugins = []; return { cleanup: 'completed' }; }
    if (operation === 'runtime-pack.snapshot') {
      if (failSave) throw new Error('Snapshot storage unavailable');
      return { schemaVersion: 'runtime-pack-source/2', packs: [pack], instances: executions.map(item => item.instance) };
    }
    if (operation === 'runtime-pack.restore' || operation === 'runtime-pack.admit') return { status: 'admitted' };
    if (operation === 'runtime-pack.withdraw') { executions = []; outputs = []; changed(); return { status: 'withdrawn' }; }
    throw new Error(`Unexpected fixture operation ${operation}`);
  },
};
Object.assign(globalThis, { runtimeContentFixture: { calls,
  reviseThumbnail() { thumbnailColor = 'blue'; holdThumbnails = true; catalogEpoch++; changed(); },
  notifyThumbnail() { thumbnailEpoch++; changed(); },
  completeThumbnails() { holdThumbnails = false; for (const done of pendingThumbnails.splice(0)) done(); }, revealed() { return revealCount; }, completeInspection() { deferInspection = false; completeInspection?.(); }, completeGeneration() { completeGeneration?.(); }, failSave() { failSave = true; }, deferGeneration() { deferGeneration = true; }, replaceTarget() { target = { targetId: 'replacement', worldId: 'replacement-world' }; executions = []; outputs = []; changed(); } } });
await mountContentBrowserPanel({ client, mountElement: document.getElementById('app')!, revealPanel: async () => { revealCount++; return true; } });
