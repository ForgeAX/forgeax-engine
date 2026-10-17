import type { ToolApi } from '@forgeax/engine-tool-runtime';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import { reportWorkspaceCommandError } from '@forgeax/view-workspace-core/command-error';
import {
  ASSET_REFERENCE_QUERY, ASSET_REFERENCE_SOURCE, sameAssetReferenceScope,
} from '@forgeax/view-workspace-core/asset-references';
import type {
  AssetReferenceScope, AssetReferenceServiceState, EntityAssetReferences,
} from '@forgeax/view-workspace-core/asset-references';

export function assetReferenceScope(state: WorkspaceState | null): AssetReferenceScope | undefined {
  const project = state?.project;
  const target = state?.projectTarget;
  if (!project || !target?.worldId || target.worldId.startsWith('pending:') || state.workspaceTargetLost) return;
  const scene = state.scenePreview?.target ?? state.preview?.target;
  return { projectId: project.id, targetId: target.targetId, worldId: target.worldId,
    targetGeneration: scene?.targetId === target.targetId ? scene.generation : target.generation,
    browserGeneration: state.browserGeneration ?? 0 };
}

type Binding = {
  scope: AssetReferenceScope; packageId: string; providerId: string; controller: AbortController;
  installed?: number; admissionAttempted: boolean; ready: Promise<void>;
};
type QueryClient = Pick<ViewWorkspaceClient, 'subscribe' | 'call'>;
const aborted = () => new DOMException('Asset reference scope changed', 'AbortError');

export function createAssetReferenceSession({ client, api, program }: { client: QueryClient; api: ToolApi; program: string | (() => string) }) {
  let snapshot: WorkspaceState | null = null;
  let binding: Binding | undefined;
  let disposed = false;
  let state: AssetReferenceServiceState = { phase: 'idle' };
  const listeners = new Set<() => void>();
  const publish = (next: AssetReferenceServiceState) => { state = next; for (const listener of listeners) listener(); };
  const current = (entry: Binding) => !disposed && binding === entry && !entry.controller.signal.aborted
    && sameAssetReferenceScope(entry.scope, assetReferenceScope(snapshot));
  const runtime = <T>(entry: Binding, operation: string, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
    client.call<T>(`runtime-pack.${operation}`, { ...entry.scope, ...args }, { signal, reportError: false });
  const clean = async (entry: Binding) => {
    // Never send cleanup to a replacement World or release another plugin on this connection.
    const target = snapshot?.projectTarget;
    if (snapshot?.project?.id !== entry.scope.projectId || target?.targetId !== entry.scope.targetId || target.worldId !== entry.scope.worldId) return;
    if (entry.installed !== undefined) {
      const actual = await runtime<{ plugins: { uid: number }[] }>(entry, 'plugin-inspect');
      if (actual.plugins.some(plugin => plugin.uid === entry.installed)) await runtime(entry, 'plugin-dispose', { uid: entry.installed });
    }
    if (entry.admissionAttempted) await runtime(entry, 'withdraw', { packageId: entry.packageId });
  };
  const install = async (entry: Binding) => {
    const signal = entry.controller.signal;
    const imports = await runtime<{ imports: Record<string, string> }>(entry, 'inspect', {}, signal);
    const source = { entry: 'query.js', export: 'default', imports: imports.imports, modules: { 'query.js': typeof program === 'function' ? program() : program } };
    const prepared = await client.call('runtime-pack.prepare', { projectId: entry.scope.projectId, source }, { signal, reportError: false });
    if (!current(entry)) throw aborted();
    const content = { source: { schemaVersion: '3.0.0', packageId: entry.packageId, assets: {
      query: { kind: 'plugin', payload: { module: { specifier: './query.js' }, config: { ...entry.scope, providerId: entry.providerId } } },
    } }, programs: { 'project:query.js#default': prepared } };
    entry.admissionAttempted = true;
    await runtime(entry, 'admit', { content }, signal);
    if (!current(entry)) throw aborted();
    // The admitted definition is authoritative for the generated plugin GUID.
    const inspection = await runtime<{ packs: { source: { packageId: string }; }[] }>(entry, 'inspect', {}, signal);
    if (!inspection.packs.some(pack => pack.source.packageId === entry.packageId)) throw new Error('asset-reference-publication-unavailable');
    const assets = await client.call<{ assets: { packageId?: string; guid: string; kind: string }[] }>('assets.list', { projectId: entry.scope.projectId }, { signal, reportError: false });
    const asset = assets.assets.find(asset => asset.packageId === entry.packageId && asset.kind === 'plugin');
    if (!asset) throw new Error('asset-reference-plugin-identity-unavailable');
    const installed = await runtime<{ uid: number }>(entry, 'plugin-install', { guid: asset.guid }, signal);
    entry.installed = installed.uid;
    if (!current(entry)) throw aborted();
    const owner = api.describe(ASSET_REFERENCE_QUERY, ASSET_REFERENCE_SOURCE).find(record => record.callable && record.owner.providerId === entry.providerId);
    if (!owner) throw new Error('asset-reference-local-tool-channel-unavailable');
  };
  const activate = (next: WorkspaceState, force = false) => {
    snapshot = next;
    const scope = assetReferenceScope(next);
    if (!binding && !scope && state.phase === 'idle') return;
    if (!force && sameAssetReferenceScope(binding?.scope, scope)) return;
    const old = binding;
    binding = undefined;
    old?.controller.abort();
    if (old) void old.ready.catch(() => {}).then(() => clean(old)).catch(error => {
      const target = snapshot?.projectTarget;
      if (!disposed && snapshot?.project?.id === old.scope.projectId && target?.targetId === old.scope.targetId && target.worldId === old.scope.worldId) {
        if (!binding) publish({ phase: 'failed', error: String(error) });
        reportWorkspaceCommandError(error);
      }
    });
    if (!scope || disposed) { publish({ phase: 'idle' }); return; }
    const entry: Binding = { scope, packageId: crypto.randomUUID(), providerId: `view-asset-references:${crypto.randomUUID()}`,
      controller: new AbortController(), admissionAttempted: false, ready: Promise.resolve() };
    binding = entry;
    publish({ phase: 'installing', scope, packageId: entry.packageId });
    entry.ready = install(entry).then(() => {
      if (current(entry)) publish({ phase: 'ready', scope, packageId: entry.packageId, pluginUid: entry.installed });
    }).catch(async error => {
      if (current(entry)) {
        publish({ phase: 'failed', scope, error: String(error), packageId: entry.packageId });
        await clean(entry).catch(cleanup => {
          if (current(entry)) publish({ phase: 'failed', scope, error: `${String(error)}; cleanup: ${String(cleanup)}`, packageId: entry.packageId });
          reportWorkspaceCommandError(cleanup);
        });
      }
      throw error;
    });
    void entry.ready.catch(() => {});
  };
  const stopClient = client.subscribe(next => activate(next));
  const stopApi = api.subscribe(() => {
    if (binding && state.phase === 'ready' && !api.describe(ASSET_REFERENCE_QUERY, ASSET_REFERENCE_SOURCE)
      .some(record => record.callable && record.owner.providerId === binding!.providerId))
      publish({ ...state, phase: 'unavailable', error: 'asset-reference-provider-removed' });
  });
  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async query(entityId: string, { signal }: { signal?: AbortSignal } = {}): Promise<EntityAssetReferences> {
      if (snapshot && ['failed', 'unavailable'].includes(state.phase)) activate(snapshot, true);
      const entry = binding;
      if (!entry) throw new Error('asset-reference-scene-unavailable');
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const release = () => { signal?.removeEventListener('abort', cancel); entry.controller.signal.removeEventListener('abort', cancel); };
        const cancel = () => { release(); reject(aborted()); };
        signal?.addEventListener('abort', cancel, { once: true });
        entry.controller.signal.addEventListener('abort', cancel, { once: true });
        void entry.ready.then(() => { release(); resolve(); }, error => { release(); reject(error); });
      });
      signal?.throwIfAborted();
      if (!current(entry)) throw aborted();
      const owner = api.describe(ASSET_REFERENCE_QUERY, ASSET_REFERENCE_SOURCE).find(record => record.callable && record.owner.providerId === entry.providerId)?.owner;
      if (!owner) throw new Error('asset-reference-provider-unavailable');
      const controller = new AbortController();
      const revoke = () => controller.abort();
      signal?.addEventListener('abort', revoke, { once: true });
      entry.controller.signal.addEventListener('abort', revoke, { once: true });
      try {
        const terminal = await api.run<EntityAssetReferences>(ASSET_REFERENCE_QUERY, { ...entry.scope, entityId }, { ...owner, signal: controller.signal }).terminal;
        if (!current(entry) || signal?.aborted) throw aborted();
        if (terminal.outcome !== 'succeeded') throw new Error(JSON.stringify(terminal));
        return terminal.result;
      } finally {
        signal?.removeEventListener('abort', revoke);
        entry.controller.signal.removeEventListener('abort', revoke);
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true; stopClient(); stopApi();
      const old = binding; binding = undefined; old?.controller.abort();
      publish({ phase: 'unavailable', error: 'asset-reference-session-disposed' });
      if (old) { await old.ready.catch(() => {}); await clean(old); }
      listeners.clear();
    },
  };
}
