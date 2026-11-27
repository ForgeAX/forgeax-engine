import { EmptyState, IconButton, InspectorForm, PanelHeader, Spinner, Text, useClipboardAction, usePanelVisible, useWorkspaceClientConnected } from '@forgeax/view-components';
import { Copy } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { ResourceAssetActionResolver } from '@forgeax/view-workspace-core/frontend-contract';
import { VIEW_WORKSPACE_TAB_ID, type WorkspaceInspection, type WorkspaceState } from '@forgeax/view-workspace-core/contract';
import { unwrapWorkspaceInspection } from '@forgeax/view-workspace-core/inspection-presentation';
import { createWorkspaceObservation, createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { selectWorkspaceFallbackSubject } from '@forgeax/view-workspace-core/resource-open';
import { useTranslation } from '../i18n/useTranslation';
import './asset.css';
import { cloudMaterialDetails } from '../cloud-material';
import { CloudMaterialDetails } from './CloudMaterialDetails';

function inspectionKey(workspace: WorkspaceState | null) {
  const subject = selectWorkspaceFallbackSubject(workspace) ?? workspace?.openRequest?.asset;
  const target = workspace?.projectTarget;
  if (!subject?.guid || !workspace?.project?.id || !target?.targetId || workspace.workspaceTargetLost) return null;
  return JSON.stringify([workspace.project.id, target.targetId, target.generation, target.worldId,
    workspace.browserGeneration, workspace.catalogEpoch, subject.guid, subject.kind]);
}

export function AssetPropertiesPanel({
  client,
  assetActions,
}: {
  client?: ViewWorkspaceClient;
  assetActions?: ResourceAssetActionResolver;
}) {
  const { t } = useTranslation();
  if (!client) {
    return (
      <div className="fx-asset-viewer fx-ui" data-testid="panel-asset-properties">
        <EmptyState title={t('asset.unavailable')} description={t('asset.empty')} />
      </div>
    );
  }
  return <LiveProperties client={client} assetActions={assetActions} />;
}

function LiveProperties({ client, assetActions }: { client: ViewWorkspaceClient; assetActions?: ResourceAssetActionResolver }) {
  const { t, locale } = useTranslation();
  const visible = usePanelVisible();
  const connected = useWorkspaceClientConnected(client);
  const writeClipboard = useClipboardAction();
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  const workspace = useSyncExternalStore(
    reader.subscribe,
    () => reader.getSnapshot(),
    () => reader.getSnapshot(),
  );
  const subject = selectWorkspaceFallbackSubject(workspace) ?? workspace?.openRequest?.asset;
  const projectId = workspace?.project?.id;
  const target = workspace?.projectTarget;
  const key = inspectionKey(workspace);
  const [result, setResult] = useState<{ key: string; inspection?: WorkspaceInspection; failed?: boolean } | null>(null);

  useEffect(() => {
    if (!visible || !connected || !key || !subject || !projectId || !target) return;
    const observation = createWorkspaceObservation(reader, state => inspectionKey(state) === key);
    void client.inspectAsset(subject.guid, {
      projectId,
      tabId: VIEW_WORKSPACE_TAB_ID,
      targetId: target.targetId,
      targetGeneration: target.generation,
      signal: observation.signal,
    }).then((value: unknown) => {
      if (observation.signal.aborted) return;
      const inspection = unwrapWorkspaceInspection(value);
      if (!inspection || (inspection.guid ?? inspection.asset?.guid) !== subject.guid) {
        setResult({ key, failed: true });
        return;
      }
      setResult({ key, inspection });
    }).catch(() => {
      if (!observation.signal.aborted) setResult({ key, failed: true });
    });
    return () => observation.dispose();
  }, [client, reader, key, visible, connected]);

  if (!subject) {
    return (
      <div className="fx-asset-viewer fx-ui" data-testid="panel-asset-properties">
        <EmptyState title={t('asset.empty')} description={t('asset.unavailable')} />
      </div>
    );
  }
  const current = connected && result?.key === key ? result : null;
  if (!key || !connected || current?.failed) {
    return (
      <div className="fx-asset-viewer fx-ui" data-testid="panel-asset-properties">
        <EmptyState title={t('asset.unavailable')} description={t('asset.inspectFailed')} />
      </div>
    );
  }
  if (!current?.inspection) return <div className="fx-asset-viewer fx-ui" data-testid="panel-asset-properties">
    <Spinner label={t('asset.loading')} />
  </div>;
  const cloud = cloudMaterialDetails(current.inspection);
  return (
    <div className="fx-asset-viewer fx-ui" data-testid="panel-asset-properties" data-view-readonly="true"
      data-asset-guid={subject.guid} data-target-id={target?.targetId} data-target-generation={target?.generation}>
      <PanelHeader start={<span><strong>{String(subject.name ?? subject.sourceKey ?? subject.guid)}</strong></span>}
        end={<IconButton variant="quiet" size="compact" icon={<Copy size={15} />} label={t('asset.copyGuid')} onClick={() => { void writeClipboard(subject.guid); }} />} />
      {cloud ? <CloudMaterialDetails key={key} details={cloud} client={client} reader={reader} workspace={workspace} assetActions={assetActions} /> : ['cloud-material', 'cloud-material-instance'].includes(subject.kind)
        ? <Text as="div" tone="muted" role="status">{t('asset.cloudParametersUnavailable')}</Text> : null}
      <InspectorForm locale={locale} assetActions={assetActions} inspection={cloud ? { ...current.inspection, meta: { kind: cloud.kind, model: cloud.model, ...(cloud.material ? { material: cloud.material } : {}), ...(cloud.sample ? { sample: cloud.sample } : {}) } } : current.inspection} identityTitle={t('asset.facts')} />
    </div>
  );
}
