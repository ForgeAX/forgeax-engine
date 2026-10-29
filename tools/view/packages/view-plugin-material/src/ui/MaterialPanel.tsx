import { EmptyState, InspectorForm, PanelHeader, inspectorFormGroupsFromInspection, usePanelVisible } from '@forgeax/view-components';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from '../i18n/useTranslation';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { ResourceAssetActionResolver } from '@forgeax/view-workspace-core/frontend-contract';
import { VIEW_WORKSPACE_TAB_ID, type WorkspaceInspection } from '@forgeax/view-workspace-core/contract';
import { unwrapWorkspaceInspection } from '@forgeax/view-workspace-core/inspection-presentation';
import { selectWorkspaceResourcePreview, selectWorkspaceResourceSubject } from '@forgeax/view-workspace-core/resource-open';
import { createWorkspaceObservation, createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { RESOURCE_KINDS } from '../identity.ts';
import './material.css';
import { boundPreviewInspection } from '@forgeax/view-workspace-core/preview-facts';
import { resourceAssetName } from '@forgeax/view-workspace-core/page-title';
import { materialReferenceScope, materialTextureReferences } from '../texture-references.ts';
import { MaterialTextureReferences } from './MaterialTextureReferences';

const inactive = () => () => {};

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
      <div className="fx-asset-viewer fx-ui" data-testid="panel-material-properties">
        <EmptyState title={t('material.unavailable')} description={t('material.empty')} />
      </div>
    );
  }
  return <LiveProperties client={client} assetActions={assetActions} />;
}

function LiveProperties({ client, assetActions }: { client: ViewWorkspaceClient; assetActions?: ResourceAssetActionResolver }) {
  const { t } = useTranslation();
  const visible = usePanelVisible();
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  useEffect(() => () => reader.dispose(), [reader]);
  const workspace = useSyncExternalStore(
    visible ? reader.subscribe : inactive,
    () => reader.getSnapshot(),
    () => reader.getSnapshot(),
  );
  const subject = selectWorkspaceResourceSubject(workspace, RESOURCE_KINDS);
  const projectId = workspace?.project?.id;
  const preview = selectWorkspaceResourcePreview(workspace, subject?.guid);
  const binding = preview?.assetBinding;
  const scope = materialReferenceScope(workspace);
  const [inspection, setInspection] = useState<{ scope: string; value: WorkspaceInspection | null } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !scope || !subject?.guid || !projectId || binding) return;
    const controller = createWorkspaceObservation(reader, state => materialReferenceScope(state) === scope);
    void client.inspectAsset(subject.guid, {
      projectId,
      tabId: VIEW_WORKSPACE_TAB_ID,
      signal: controller.signal,
    }).then((result: unknown) => {
      if (controller.signal.aborted) return;
      setInspection({ scope, value: unwrapWorkspaceInspection(result) as WorkspaceInspection | null });
      setFailed(null);
    }).catch(() => {
      if (!controller.signal.aborted) {
        setInspection(null);
        setFailed(scope);
      }
    });
    return () => controller.dispose();
  }, [client, reader, scope, visible]);

  if (!subject) {
    return (
      <div className="fx-asset-viewer fx-ui" data-testid="panel-material-properties">
        <EmptyState title={t('material.empty')} description={t('material.unavailable')} />
      </div>
    );
  }
  if (failed === scope && !binding) {
    return (
      <div className="fx-asset-viewer fx-ui" data-testid="panel-material-properties">
        <EmptyState title={t('material.unavailable')} description={t('material.inspectFailed')} />
      </div>
    );
  }
  const inspected = inspection?.scope === scope ? inspection.value : null;
  const displayed = binding ? boundPreviewInspection(subject, binding) : inspected;
  const groups = inspectorFormGroupsFromInspection(displayed ?? { guid: subject.guid, asset: subject }, { identityTitle: t('material.facts') });
  const passesIndex = groups.findIndex(group => group.key === 'meta.passes');
  const splitAt = passesIndex < 0 ? Math.min(1, groups.length) : passesIndex;
  const name = resourceAssetName(subject) ?? subject.guid;
  return (
    <div className="fx-asset-viewer fx-ui" data-testid="panel-material-properties" data-view-readonly="true">
      <PanelHeader start={<span className="material-properties-name" title={name}><strong>{name}</strong></span>} />
      <div className="material-properties-body">
        <InspectorForm assetActions={assetActions} groups={groups.slice(0, splitAt)} />
        <MaterialTextureReferences client={client} reader={reader} workspace={workspace}
          references={materialTextureReferences(workspace, inspected)} loading={!binding && !inspected}
          assetActions={assetActions} />
        <InspectorForm assetActions={assetActions} groups={groups.slice(splitAt)} />
      </div>
    </div>
  );
}
