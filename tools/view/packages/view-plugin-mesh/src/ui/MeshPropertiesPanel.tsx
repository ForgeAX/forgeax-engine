import { EmptyState, InspectorForm, PanelHeader, PropertyRow } from '@forgeax/view-components';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { VIEW_WORKSPACE_TAB_ID } from '@forgeax/view-workspace-core/contract';
import { unwrapWorkspaceInspection } from '@forgeax/view-workspace-core/inspection-presentation';
import { selectWorkspaceResourcePreview, selectWorkspaceResourceSubject } from '@forgeax/view-workspace-core/resource-open';
import { createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { RESOURCE_KINDS } from '../identity.ts';
import { useTranslation } from '../i18n/useTranslation';
import './mesh.css';

export function MeshPropertiesPanel({
  client,
}: {
  client?: ViewWorkspaceClient;
}) {
  const { t } = useTranslation();
  if (!client) {
    return (
      <div className="fx-asset-editor fx-ui" data-testid="panel-mesh-properties">
        <EmptyState title={t('mesh.unavailable')} description={t('mesh.empty')} />
      </div>
    );
  }
  return <LiveProperties client={client} />;
}

function LiveProperties({ client }: { client: ViewWorkspaceClient }) {
  const { t } = useTranslation();
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  const workspace = useSyncExternalStore(
    reader.subscribe,
    () => reader.getSnapshot(),
    () => reader.getSnapshot(),
  );
  const subject = selectWorkspaceResourceSubject(workspace, RESOURCE_KINDS);
  const projectId = workspace?.project?.id;
  const selectedPreview = selectWorkspaceResourcePreview(workspace, subject?.guid);
  const previewTarget = selectedPreview?.target;
  const binding = selectedPreview?.assetBinding;
  const [inspection, setInspection] = useState<Record<string, unknown> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!subject?.guid || !projectId || binding) {
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
  }, [client, subject?.guid, projectId, previewTarget?.targetId, previewTarget?.generation, Boolean(binding)]);

  if (!subject) {
    return (
      <div className="fx-asset-editor fx-ui" data-testid="panel-mesh-properties">
        <EmptyState title={t('mesh.empty')} description={t('mesh.unavailable')} />
      </div>
    );
  }
  if (failed && !binding) {
    return (
      <div className="fx-asset-editor fx-ui" data-testid="panel-mesh-properties">
        <EmptyState title={t('mesh.unavailable')} description={t('mesh.inspectFailed')} />
      </div>
    );
  }
  const displayed = binding ? { guid: subject.guid, asset: subject, ...binding } : inspection;
  return (
    <div className="fx-asset-editor fx-ui" data-testid="panel-mesh-properties" data-view-readonly="true">
      <PanelHeader start={<span><strong>{String(subject.name ?? subject.guid)}</strong></span>} />
      {binding?.publication && <>
        <PropertyRow label="Bound generation">{binding.publication.generation}</PropertyRow>
        <PropertyRow label="Bound digest"><span style={{ overflowWrap: 'anywhere' }}>{binding.publication.digest}</span></PropertyRow>
      </>}
      <InspectorForm inspection={displayed ?? { guid: subject.guid, asset: subject }} identityTitle={t('mesh.facts')} />
    </div>
  );
}
