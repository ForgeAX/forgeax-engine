import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import { mountAssetPropertiesPanel } from '../../packages/view-plugin-asset/src/ui/mount';
import { setLocale } from '../../packages/view-plugin-asset/src/i18n/index.ts';

setLocale('en');
let revision = 1, generation = 1, selected = 'cloud-one';
let deferred = false;
const pending: (() => void)[] = [];
const listeners = new Set<(state: WorkspaceState) => void>();
const calls: { guid: string; targetId?: string; targetGeneration?: number; aborted: boolean }[] = [];
const actions: { action: string; guid: string }[] = [];
const asset = () => ({ guid: selected, kind: 'cloud-material', name: selected, path: 'assets/clouds/clouds.pack.ts' });
const state = (): WorkspaceState => ({
  revision, browserGeneration: generation, catalogEpoch: generation,
  project: { id: 'project', name: 'Cloud identity fixture', root: '/fixture' },
  projectTarget: { targetId: 'project-target', generation, worldId: `world-${generation}` },
  assets: [asset(), { guid: 'declared-noise', kind: 'texture', name: 'Declared noise' }],
  openRequest: { requestId: `open-${revision}`, sequence: revision, asset: asset(), detailsOnly: true },
} as WorkspaceState);
const changed = () => { revision++; for (const listener of listeners) listener(state()); };
const client = {
  transport: { connected: true, async request() { return {}; } },
  subscribe(listener: (state: WorkspaceState) => void) { listeners.add(listener); listener(state()); return () => listeners.delete(listener); },
  async getState() { return state(); },
  async inspectAsset(guid: string, options: { targetId?: string; targetGeneration?: number; signal?: AbortSignal }) {
    const call = { guid, targetId: options.targetId, targetGeneration: options.targetGeneration, aborted: false };
    calls.push(call);
    options.signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
    const meta = guid.startsWith('program-') ? {
      kind: 'cloud-material', model: guid === 'program-uniform' ? 'uniform' : 'program', parameters: [], truncated: false,
      ...(guid === 'program-missing' ? {} : {
        cookIdentity: `cook-${generation}`, densityKernelIdentity: 'density-kernel',
        variants: guid === 'program-uniform' ? [] : [{ programIdentity: 'authored-program', programDigest: 'program-digest',
          compilerIdentity: 'compiler-identity', staticValues: { detail: false }, selected: true,
          renderer: { programDigest: 'renderer-digest' } }],
        declaredDependencies: guid === 'program-uniform' ? [] : [
          { guid: 'declared-noise', kind: 'texture', declaredBy: 'material' },
          { guid: 'missing-noise', kind: 'texture', declaredBy: 'instance' },
        ], dependenciesTruncated: true,
      }),
    } : { owner: `generation-${generation}`, selected: guid };
    const result = { inspection: { guid, asset: asset(), source: { path: 'assets/clouds/clouds.pack.ts' }, meta } };
    if (deferred) await new Promise<void>(resolve => { pending.push(resolve); });
    return result;
  },
};
Object.assign(globalThis, { assetDetailsFixture: {
  calls, actions, setLocale,
  pending: () => pending.length,
  select(guid: string) { selected = guid; changed(); },
  replace() { generation++; changed(); },
  defer(value: boolean) { deferred = value; },
  finish() { const waiting = pending.splice(0); for (const resolve of waiting) resolve(); },
} });
await mountAssetPropertiesPanel({ client: client as unknown as ViewWorkspaceClient, mountElement: document.getElementById('app')!,
  assetActions: value => {
    const reference = value as { guid: string };
    return { onOpen: () => { actions.push({ action: 'open', guid: reference.guid }); },
      onBrowse: () => { actions.push({ action: 'browse', guid: reference.guid }); } };
  },
});
