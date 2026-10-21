import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceEntityInspection, WorkspaceState } from '@forgeax/view-workspace-core/contract';
import { PRIMARY_ASSET_REFERENCE_FIELDS, sameAssetReferenceScope } from '@forgeax/view-workspace-core/asset-references';
import type { AssetReferenceScope, AssetReferenceServiceState, EntityAssetReferences } from '@forgeax/view-workspace-core/asset-references';

export function assetReferenceScope(state: WorkspaceState | null): AssetReferenceScope | undefined {
  const project = state?.project;
  const target = state?.scenePreview?.target ?? state?.projectTarget;
  if (!project || !target?.worldId || target.worldId.startsWith('pending:') || state.workspaceTargetLost) return;
  return { projectId: project.id, targetId: target.targetId, worldId: target.worldId,
    targetGeneration: target.generation, browserGeneration: state.browserGeneration ?? 0 };
}

type Binding = { scope: AssetReferenceScope; controller: AbortController };
type QueryClient = Pick<ViewWorkspaceClient, 'subscribe' | 'call'>;
const aborted = () => new DOMException('Asset reference scope changed', 'AbortError');

/** Owns frontend read cancellation and navigation scope; Engine owns all reference facts. */
export function createAssetReferenceSession({ client }: { client: QueryClient }) {
  let binding: Binding | undefined;
  let disposed = false;
  let state: AssetReferenceServiceState = { phase: 'idle' };
  const listeners = new Set<() => void>();
  const publish = (next: AssetReferenceServiceState) => { state = next; for (const listener of listeners) listener(); };
  const current = (entry: Binding) => !disposed && binding === entry && !entry.controller.signal.aborted;
  const stop = client.subscribe(next => {
    const scope = assetReferenceScope(next);
    if (sameAssetReferenceScope(binding?.scope, scope)) return;
    binding?.controller.abort();
    binding = scope ? { scope, controller: new AbortController() } : undefined;
    publish(scope ? { phase: 'ready', scope } : { phase: 'idle' });
  });
  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async query(entityId: string, { signal }: { signal?: AbortSignal } = {}): Promise<EntityAssetReferences> {
      const entry = binding;
      if (!entry || disposed) throw new Error('asset-reference-scene-unavailable');
      const requestSignal = signal ? AbortSignal.any([signal, entry.controller.signal]) : entry.controller.signal;
      requestSignal.throwIfAborted();
      try {
        const inspection = await client.call<WorkspaceEntityInspection>('entity.inspect', { ...entry.scope, entityId }, { signal: requestSignal, reportError: false });
        if (!current(entry) || requestSignal.aborted) throw aborted();
        if (inspection.entityId !== entityId || inspection.targetId !== entry.scope.targetId || inspection.worldId !== entry.scope.worldId)
          throw new Error('asset-reference-target-stale');
        if (!inspection.assetReferences) {
          publish({ phase: 'unavailable', scope: entry.scope, error: 'asset-reference-capability-unavailable' });
          throw new Error('asset-reference-capability-unavailable');
        }
        const references = inspection.assetReferences.references.map(reference => ({ ...reference,
          primary: PRIMARY_ASSET_REFERENCE_FIELDS.includes(`${reference.component}.${reference.field}`) }));
        const primary = references.filter(reference => reference.primary);
        if (state.phase !== 'ready') publish({ phase: 'ready', scope: entry.scope });
        return { ...entry.scope, entityId, references, truncated: inspection.assetReferences.truncated,
          ...(primary.length === 1 && primary[0]!.status === 'resolved' ? { primaryKey: primary[0]!.key } : {}) };
      } catch (error) {
        if (!current(entry) || requestSignal.aborted) throw aborted();
        if (state.phase !== 'unavailable') publish({ phase: 'failed', scope: entry.scope, error: String(error) });
        throw error;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop(); binding?.controller.abort(); binding = undefined;
      publish({ phase: 'unavailable', error: 'asset-reference-session-disposed' });
      listeners.clear();
    },
  };
}
