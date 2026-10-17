import { EmptyState, InspectorForm, PanelHeader } from '@forgeax/view-components';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { ResourceAssetActionResolver } from '@forgeax/view-workspace-core/frontend-contract';
import { VIEW_WORKSPACE_TAB_ID } from '@forgeax/view-workspace-core/contract';
import { unwrapWorkspaceInspection } from '@forgeax/view-workspace-core/inspection-presentation';
import { createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { selectWorkspaceFallbackSubject } from '@forgeax/view-workspace-core/resource-open';
import { useTranslation } from '../i18n/useTranslation';
import './asset.css';

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
  const { t } = useTranslation();
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  const workspace = useSyncExternalStore(
    reader.subscribe,
    () => reader.getSnapshot(),
    () => reader.getSnapshot(),
  );
  const subject = selectWorkspaceFallbackSubject(workspace) ?? workspace?.openRequest?.asset;
  const projectId = workspace?.project?.id;
  const [inspection, setInspection] = useState<Record<string, unknown> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!subject?.guid || !projectId) {
      setInspection(null);
      setFailed(false);
      return undefined;
    }
    const controller = new AbortController();
    void client.inspectAsset(subject.guid, {
      projectId,
      tabId: VIEW_WORKSPACE_TAB_ID,
      signal: controller.signal,
    }).then((result: unknown) => {
      if (controller.signal.aborted) return;
      setInspection(unwrapWorkspaceInspection(result));
      setFailed(false);
    }).catch(() => {
      if (!controller.signal.aborted) {
        setInspection(null);
        setFailed(true);
      }
    });
    return () => controller.abort();
  }, [client, subject?.guid, projectId]);

  if (!subject) {
    return (
      <div className="fx-asset-viewer fx-ui" data-testid="panel-asset-properties">
        <EmptyState title={t('asset.empty')} description={t('asset.unavailable')} />
      </div>
    );
  }
  if (failed) {
    return (
      <div className="fx-asset-viewer fx-ui" data-testid="panel-asset-properties">
        <EmptyState title={t('asset.unavailable')} description={t('asset.inspectFailed')} />
      </div>
    );
  }
  const inspectionRecord = inspection ?? { guid: subject.guid, asset: subject };
  return (
    <div className="fx-asset-viewer fx-ui" data-testid="panel-asset-properties" data-view-readonly="true">
      <PanelHeader start={<span><strong>{String(subject.name ?? subject.guid)}</strong></span>} />
      <InspectorForm assetActions={assetActions} inspection={inspectionRecord} identityTitle={t('asset.facts')} />
    </div>
  );
}
