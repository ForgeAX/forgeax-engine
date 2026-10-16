import { EmptyState, InspectorForm, PanelHeader } from '@forgeax/view-components';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from '../i18n/useTranslation';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { ResourceAssetActionResolver } from '@forgeax/view-workspace-core/frontend-contract';
import { VIEW_WORKSPACE_TAB_ID } from '@forgeax/view-workspace-core/contract';
import { unwrapWorkspaceInspection } from '@forgeax/view-workspace-core/inspection-presentation';
import { selectWorkspaceResourceSubject } from '@forgeax/view-workspace-core/resource-open';
import { createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { RESOURCE_KINDS } from '../identity.ts';
import './material.css';

export function MaterialPanel(props: { client?: ViewWorkspaceClient; assetActions?: ResourceAssetActionResolver }) {
  return <MaterialPropertiesPanel {...props} />;
}

export function MaterialPropertiesPanel({
  client,
  assetActions,
}: {
  client?: ViewWorkspaceClient;
  assetActions?: ResourceAssetActionResolver;
}) {
  const { t } = useTranslation();
  if (!client) {
    return (
      <div className="fx-asset-editor fx-ui" data-testid="panel-material-properties">
        <EmptyState title={t('material.unavailable')} description={t('material.empty')} />
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
  const subject = selectWorkspaceResourceSubject(workspace, RESOURCE_KINDS);
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
      <div className="fx-asset-editor fx-ui" data-testid="panel-material-properties">
        <EmptyState title={t('material.empty')} description={t('material.unavailable')} />
      </div>
    );
  }
  if (failed) {
    return (
      <div className="fx-asset-editor fx-ui" data-testid="panel-material-properties">
        <EmptyState title={t('material.unavailable')} description={t('material.inspectFailed')} />
      </div>
    );
  }
  return (
    <div className="fx-asset-editor fx-ui" data-testid="panel-material-properties" data-view-readonly="true">
      <PanelHeader start={<span><strong>{String(subject.name ?? subject.guid)}</strong></span>} />
      <InspectorForm assetActions={assetActions} inspection={inspection ?? { guid: subject.guid, asset: subject }} identityTitle={t('material.facts')} />
    </div>
  );
}
