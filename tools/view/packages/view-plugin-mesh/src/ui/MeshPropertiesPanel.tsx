import { EmptyState, InspectorForm, PanelHeader, usePanelVisible } from '@forgeax/view-components';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { ResourceAssetActionResolver } from '@forgeax/view-workspace-core/frontend-contract';
import { VIEW_WORKSPACE_TAB_ID } from '@forgeax/view-workspace-core/contract';
import { unwrapWorkspaceInspection } from '@forgeax/view-workspace-core/inspection-presentation';
import { selectWorkspaceResourcePreview, selectWorkspaceResourceSubject } from '@forgeax/view-workspace-core/resource-open';
import { createWorkspaceObservation, createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { resourceAssetName } from '@forgeax/view-workspace-core/page-title';
import { RESOURCE_KINDS } from '../identity.ts';
import { useTranslation } from '../i18n/useTranslation';
import './mesh.css';
import { boundPreviewInspection } from '@forgeax/view-workspace-core/preview-facts';
import { inspectorFormGroupsFromInspection } from '@forgeax/view-components/inspector-form-model';
import { MeshMaterialSlots } from './MeshMaterialSlots';
import type { MeshMaterialSlot } from '../material-slots.ts';

export function MeshPropertiesPanel({
  client,
  assetActions,
}: {
  client?: ViewWorkspaceClient;
  assetActions?: ResourceAssetActionResolver;
}) {
  const { t } = useTranslation();
  if (!client) {
    return (
      <div className="fx-asset-viewer fx-ui" data-testid="panel-mesh-properties">
        <EmptyState title={t('mesh.unavailable')} description={t('mesh.empty')} />
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
    reader.subscribe,
    () => reader.getSnapshot(),
    () => reader.getSnapshot(),
  );
  const subject = selectWorkspaceResourceSubject(workspace, RESOURCE_KINDS);
  const projectId = workspace?.project?.id;
  const selectedPreview = selectWorkspaceResourcePreview(workspace, subject?.guid);
  const previewTarget = selectedPreview?.target;
  const binding = selectedPreview?.assetBinding;
  const inspectionKey = JSON.stringify([projectId, subject?.guid, workspace?.browserGeneration, previewTarget?.targetId, previewTarget?.generation]);
  const [inspection, setInspection] = useState<{ key: string; value: Record<string, unknown> | null } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !subject?.guid || !projectId || binding) {
      setInspection(null);
      setFailed(null);
      return undefined;
    }
    const controller = createWorkspaceObservation(reader, state => state?.project?.id === projectId && state?.browserGeneration === workspace?.browserGeneration
      && selectWorkspaceResourceSubject(state, RESOURCE_KINDS)?.guid === subject.guid && !selectWorkspaceResourcePreview(state, subject.guid)?.assetBinding);
    void client.inspectAsset(subject.guid, {
      projectId,
      tabId: VIEW_WORKSPACE_TAB_ID,
      signal: controller.signal,
    }).then((result: unknown) => {
      if (controller.signal.aborted) return;
      setInspection({ key: inspectionKey, value: unwrapWorkspaceInspection(result) });
      setFailed(null);
    }).catch(() => {
      if (!controller.signal.aborted) {
        setInspection(null);
        setFailed(inspectionKey);
      }
    });
    return () => controller.dispose();
  }, [client, reader, inspectionKey, Boolean(binding), visible]);

  if (!subject) {
    return (
      <div className="fx-asset-viewer fx-ui" data-testid="panel-mesh-properties">
        <EmptyState title={t('mesh.empty')} description={t('mesh.unavailable')} />
      </div>
    );
  }
  if (failed === inspectionKey && !binding) {
    return (
      <div className="fx-asset-viewer fx-ui" data-testid="panel-mesh-properties">
        <EmptyState title={t('mesh.unavailable')} description={t('mesh.inspectFailed')} />
      </div>
    );
  }
  const displayed = binding ? boundPreviewInspection(subject, binding) : inspection?.key === inspectionKey ? inspection.value : null;
  const meta = displayed?.meta && typeof displayed.meta === 'object' ? displayed.meta as Record<string, unknown> : {};
  const slots = Array.isArray(meta.materialSlots) && meta.materialSlots.every(slot => slot && typeof slot === 'object' && typeof slot.slotName === 'string')
    ? meta.materialSlots as MeshMaterialSlot[] : undefined;
  const formInspection = slots ? { ...displayed, meta: { ...meta, materialSlots: undefined } } : displayed;
  const groups = inspectorFormGroupsFromInspection(formInspection ?? { guid: subject.guid, asset: subject }, { identityTitle: t('mesh.facts') });
  const submeshesIndex = groups.findIndex(group => group.key === 'meta.submeshes');
  const splitAt = submeshesIndex < 0 ? Math.min(1, groups.length) : submeshesIndex;
  const name = resourceAssetName(subject) ?? resourceAssetName(workspace?.assets?.find(asset => asset.guid === subject.guid)) ?? subject.guid;
  return (
    <div className="fx-asset-viewer fx-ui" data-testid="panel-mesh-properties" data-view-readonly="true">
      <PanelHeader start={<span className="mesh-properties-name" title={name}><strong>{name}</strong></span>} />
      <div className="mesh-properties-body">
      {binding?.publication && <dl className="mesh-bound-identity">
        <div><dt>Bound generation</dt><dd>{binding.publication.generation}</dd></div>
        <div><dt>Bound digest</dt><dd title={binding.publication.digest}>{binding.publication.digest}</dd></div>
      </dl>}
      <InspectorForm assetActions={assetActions} groups={groups.slice(0, splitAt)} />
      {slots && <MeshMaterialSlots client={client} reader={reader} workspace={workspace} slots={slots} assetActions={assetActions} />}
      <InspectorForm assetActions={assetActions} groups={groups.slice(splitAt)} />
      </div>
    </div>
  );
}
