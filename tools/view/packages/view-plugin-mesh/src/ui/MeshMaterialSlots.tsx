import { useEffect, useReducer, useState } from 'react';
import { AssetReferenceField, CollapsibleSection, IconButton, MaterialSlot, PropertyRow, Text, usePanelVisible } from '@forgeax/view-components';
import { Layers, RefreshCw } from 'lucide-react';
import { observeAssetThumbnails } from '@forgeax/view-workspace-core/asset-thumbnails';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceState, WorkspaceThumbnail } from '@forgeax/view-workspace-core/contract';
import type { ResourceAssetActionResolver } from '@forgeax/view-workspace-core/frontend-contract';
import { createWorkspaceObservation, type WorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { meshMaterialScope, meshThumbnailScope, readMeshMaterialReferences, type MeshMaterialReferences, type MeshMaterialSlot } from '../material-slots.ts';
import { useTranslation } from '../i18n/useTranslation';

export function MeshMaterialSlots({ client, reader, workspace, slots, assetActions }: {
  client: ViewWorkspaceClient;
  reader: WorkspaceStateReader;
  workspace: WorkspaceState | null;
  slots: readonly MeshMaterialSlot[];
  assetActions?: ResourceAssetActionResolver;
}) {
  const { t } = useTranslation();
  const visible = usePanelVisible();
  const scope = meshMaterialScope(workspace);
  const [leaseRevision, restartLease] = useReducer((value: number) => value + 1, 0);
  const [referenceRevision, retryReferences] = useReducer((value: number) => value + 1, 0);
  const [result, setResult] = useState<{ scope: string; value: MeshMaterialReferences }>();
  const [failure, setFailure] = useState<{ scope: string; message: string }>();
  const [thumbnails, setThumbnails] = useState<{ scope: string; rows: ReadonlyMap<string, WorkspaceThumbnail> }>();
  const references = result?.scope === scope ? result.value.references : [];
  const guids = [...new Set(references.flatMap(reference => reference.status === 'resolved' && reference.guid
    && workspace?.assets?.some(asset => asset.guid === reference.guid) ? [reference.guid] : []))].sort();
  const thumbnailScope = meshThumbnailScope(workspace, guids);

  useEffect(() => {
    if (!visible || !scope || !workspace || !slots.length) return;
    const observation = createWorkspaceObservation(reader, state => meshMaterialScope(state) === scope);
    setFailure(undefined);
    void readMeshMaterialReferences(client, workspace, observation.signal).then(value => {
      if (!observation.signal.aborted) setResult({ scope, value });
    }).catch(error => { if (!observation.signal.aborted) setFailure({ scope, message: error instanceof Error ? error.message : String(error) }); });
    return () => observation.dispose();
  }, [client, reader, scope, visible, slots.length, referenceRevision]);

  useEffect(() => {
    if (!visible || !thumbnailScope || !guids.length) return;
    const observation = observeAssetThumbnails({ client, reader, guids, scope: thumbnailScope, getScope: meshThumbnailScope,
      publish: rows => setThumbnails({ scope: thumbnailScope, rows }), onInvalidate: restartLease });
    return () => observation.dispose();
  }, [client, reader, visible, thumbnailScope, leaseRevision]);

  return <div className="fx-inspector-form mesh-material-slots">
    <div className="fx-inspector-form__group mesh-material-slots__group">
    <CollapsibleSection title={<span className="fx-inspector-form__title">
      <span className="fx-inspector-form__icon"><Layers size={13} strokeWidth={1.7} /></span>
      <span>{t('mesh.slots')}</span>
    </span>} defaultOpen>
    <div className="mesh-material-slots__items">
    {slots.length === 0 ? <Text tone="muted">{t('mesh.noMaterials')}</Text> : slots.map((slot, index) => {
      const candidates = references.filter(reference => reference.index === index);
      const reference = candidates.length === 1 ? candidates[0] : undefined;
      const asset = reference?.guid ? workspace?.assets?.find(asset => asset.guid === reference.guid && asset.kind === 'material') : undefined;
      const resolved = reference?.status === 'resolved' && Boolean(asset);
      const value = { ...(resolved ? { guid: reference!.guid } : {}),
        name: asset?.name || asset?.sourceKey || reference?.guid || (reference?.status === 'builtin' ? t('mesh.engineDefault') : t('mesh.materialUnavailable')),
        kind: 'material', missing: Boolean(reference?.guid && !asset) };
      const actions = resolved ? assetActions?.(value) : undefined;
      const current = () => meshMaterialScope(reader.getSnapshot()) === scope;
      const thumbnail = visible && thumbnails?.scope === thumbnailScope ? thumbnails.rows.get(reference?.guid ?? '') : undefined;
      return <div key={index} className="mesh-material-entry" data-testid={`mesh-material-slot-${index}`}>
        <MaterialSlot index={index} name={slot.slotName} source={t(reference?.status === 'builtin' ? 'mesh.engineDefault' : 'mesh.meshDefault')}>
          <AssetReferenceField value={value}
            onOpen={actions?.onOpen ? () => { if (current()) actions.onOpen?.(); } : undefined}
            onBrowse={actions?.onBrowse ? () => { if (current()) actions.onBrowse?.(); } : undefined} labels={{
            none: t('mesh.none'), identityUnavailable: t('mesh.materialUnavailable'), readOnly: t('mesh.readOnlyMaterial'),
            open: t('mesh.openMaterial'), browse: t('mesh.browseMaterial'),
            previewLoading: t('mesh.previewLoading'), previewFailed: t('mesh.previewFailed'), previewUnsupported: t('mesh.previewUnsupported'),
          }} thumbnail={resolved ? { state: !thumbnail || thumbnail.state === 'queued' || thumbnail.state === 'cooking'
            ? 'loading' : thumbnail.state, src: thumbnail?.dataUrl, hint: thumbnail?.error?.hint } : undefined} />
        </MaterialSlot>
        {!resolved && reference?.status !== 'builtin' ? <Text as="div" variant="caption" tone="muted" role="status">{t('mesh.materialUnavailable')}</Text> : null}
        <CollapsibleSection title={t('mesh.slotDetails')} defaultOpen={false}>
          {Object.entries(slot).map(([key, value]) => <PropertyRow key={key} label={key === 'slotName' ? 'Slot Name' : key === 'sourceKey' ? 'Source Key' : key === 'defaultMaterial' ? 'Default Material' : key}>
            <span className="mesh-material-detail">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
          </PropertyRow>)}
        </CollapsibleSection>
      </div>;
    })}
    {failure?.scope === scope ? <div role="status" title={failure.message}><Text tone="muted">{t('mesh.referencesUnavailable')}</Text>
      <IconButton icon={<RefreshCw size={13} />} label={t('mesh.retryReferences')} onClick={retryReferences} />
    </div> : null}
    {result?.scope === scope && result.value.truncated ? <Text as="div" tone="muted" role="status">{t('mesh.referencesTruncated')}</Text> : null}
    </div>
    </CollapsibleSection>
    </div>
  </div>;
}
