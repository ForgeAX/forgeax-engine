import { EmptyState, Spinner, Text, usePanelVisible, useWorkspaceClientConnected } from '@forgeax/view-components';
import { MousePointer2 } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { AssetReferenceService } from '@forgeax/view-workspace-core/asset-references';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { AssetBrowserReveal } from '@forgeax/view-workspace-core/frontend-contract';
import { createWorkspaceObservation, createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { VIEW_WORKSPACE_TAB_ID, jsonUnchanged, type WorkspaceState } from '@forgeax/view-workspace-core/contract';
import { useTranslation } from '../i18n/useTranslation';
import { inspectorEntityFromInspection, inspectorWorkspaceTarget, type EntityInspection, type InspectorEntity } from '../inspection.ts';
import { useInspectorAuthoring } from './InspectorAuthoring';
import { EntityInspectorBody } from './EntityInspectorBody';
import { InspectorThumbnailContext, useInspectorThumbnails } from './InspectorThumbnails';

type InspectionRecord = { key: string; source: InspectorEntity | null };

export function InspectorPanel({ client, assetReferences, browseAsset, addConversationReference }: { addConversationReference?: (reference: { title: string; text: string }) => Promise<void>; client?: ViewWorkspaceClient; assetReferences?: AssetReferenceService; browseAsset?: (guid: string, scope: Omit<AssetBrowserReveal, 'guid'>) => Promise<boolean> }) {
  const visible = usePanelVisible();
  const { t } = useTranslation();
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  const workspace = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  const primary = workspace?.sceneSelection?.primary;
  const target = inspectorWorkspaceTarget(workspace);
  const connected = useWorkspaceClientConnected(client);
  const [inspection, setInspection] = useState<InspectionRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const referenceState = useSyncExternalStore(assetReferences?.subscribe ?? (() => () => {}), assetReferences?.getState ?? (() => undefined), () => undefined);
  const projectId = workspace?.project?.id;
  const selectionKey = primary?.entityId && target?.targetId
    ? `${projectId ?? ''}:${primary.entityId}:${target.targetId}:${target.generation ?? ''}` : null;
  const matches = (current: WorkspaceState | null) => current?.project?.id === projectId
    && current?.sceneSelection?.primary?.entityId === primary?.entityId
    && inspectorWorkspaceTarget(current)?.targetId === target?.targetId
    && inspectorWorkspaceTarget(current)?.generation === target?.generation;
  useEffect(() => { setActionFailure(null); }, [selectionKey]);
  useEffect(() => {
    if (!visible) return;
    if (!client || !connected || !primary?.entityId || !target?.targetId || !selectionKey) {
      setLoading(false);
      return;
    }
    const observation = createWorkspaceObservation(reader, matches);
    const { signal } = observation;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    setFailure(null);
    const refresh = async () => {
      if (signal.aborted) return;
      try {
        const result = await client.call<EntityInspection>('entity.inspect', { projectId, entityId: primary.entityId, targetId: target.targetId, targetGeneration: target.generation }, { signal });
        if (signal.aborted) return;
        const source = inspectorEntityFromInspection(result, reader.getSnapshot()?.assets ?? [], {
          rotation: t('inspector.rotation'), unavailable: t('inspector.unavailable'),
        });
        setInspection(current => current?.key === selectionKey
          && jsonUnchanged({ ...current.source?.raw, sampledAt: undefined }, { ...source?.raw, sampledAt: undefined })
          && jsonUnchanged(current.source?.components, source?.components)
          && jsonUnchanged(current.source?.meshReference, source?.meshReference)
          && jsonUnchanged(current.source?.materialOverrides, source?.materialOverrides)
          ? current : { key: selectionKey, source });
        setFailure(null);
        setLoading(false);
      } catch (error) {
        if (signal.aborted) return;
        setInspection(null);
        setFailure(String(error));
        setLoading(false);
      }
      if (!signal.aborted) timer = setTimeout(refresh, 500);
    };
    void refresh();
    return () => { observation.dispose(); clearTimeout(timer); };
    // A batched return to the same selection still needs a fresh observation.
  }, [client, connected, selectionKey, reader, workspace, t, visible]);
  const source = connected && inspection?.key === selectionKey ? inspection.source : null;
  const thumbnails = useInspectorThumbnails({ client, reader, workspace, source, active: connected && visible });
  const cloudReadOnly = source?.components.some(component => component.name === 'VolumetricCloudLayer') === true;
  const authoring = useInspectorAuthoring({ client, inspection: cloudReadOnly ? undefined : source?.raw, project: workspace?.project, target, projectId, sessionId: workspace?.projectTarget?.sessionId, targetId: target?.targetId, addConversationReference });
  const submit = (operation: string, args: Record<string, unknown>) => {
    if (!client || !connected || !target || !primary?.entityId) return;
    const observation = createWorkspaceObservation(reader, matches);
    if (observation.signal.aborted) { observation.dispose(); return; }
    setActionFailure(null);
    void client.call(operation, { projectId, tabId: VIEW_WORKSPACE_TAB_ID, targetId: target.targetId, targetGeneration: target.generation, ...args }, { signal: observation.signal })
      .catch(error => { if (!observation.signal.aborted) setActionFailure(String(error)); })
      .finally(() => observation.dispose());
  };
  return <div className="fx-inspector fx-ui" data-testid="panel-inspector" data-view-readonly={source?.raw.source && !cloudReadOnly ? undefined : "true"} data-entity-id={primary?.entityId} data-inspector-loading={primary && !source && loading ? 'true' : undefined}>
    {!primary || (!source && !loading) ? <EmptyState className="dp-empty" data-testid="insp-empty"
      title={primary ? t('inspector.inspectionUnavailable') : t('inspector.emptyTitle')}
      description={!connected ? t('inspector.connectionUnavailable') : failure ?? t('inspector.emptyDescription')} icon={<MousePointer2 />} />
      : !source ? <div className="fx-inspector__loading-pane" data-testid="insp-loading"><Spinner label={t('inspector.loading')} /></div>
        : <>
          {!cloudReadOnly && authoring.toolbar}
          <InspectorThumbnailContext.Provider value={thumbnails}><EntityInspectorBody renderAuthorField={cloudReadOnly ? undefined : authoring.renderField} key={selectionKey} source={source} selectionCount={workspace?.sceneSelection?.entityIds?.length ?? 1}
            focus={() => submit('entity.focus', { entityId: primary.entityId })}
            openAsset={guid => {
              if (!matches(reader.getSnapshot())) return;
              if (assetReferences?.getState().scope) void assetReferences.open(guid).catch(error => setActionFailure(String(error)));
              else submit('asset.open', { guid });
            }} browseAsset={browseAsset ? guid => { if (!matches(reader.getSnapshot()) || !projectId || !target) return; void browseAsset(guid, { projectId, targetId: target.targetId, targetGeneration: target.generation }).then(ok => {
              if (!ok) throw new Error(t('inspector.resourceIdentityUnavailable'));
            }).catch(error => setActionFailure(String(error))); } : undefined} /></InspectorThumbnailContext.Provider>
          {actionFailure ? <Text as="div" role="alert" className="insp-action-error">{actionFailure}</Text> : null}
          {source.assetReferencesTruncated ? <Text as="div" role="status" className="insp-section-status">{t('inspector.assetReferencesTruncated')}</Text> : null}
          {assetReferences && !source.raw.assetReferences && ['failed', 'unavailable'].includes(referenceState?.phase ?? '') ? <Text as="div" role="status" className="insp-section-status" title={referenceState?.error}>{t('inspector.assetReferencesUnavailable')}</Text> : null}
        </>}
  </div>;
}
