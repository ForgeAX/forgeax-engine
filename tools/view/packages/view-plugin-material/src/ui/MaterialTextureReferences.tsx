import { useEffect, useReducer, useState } from 'react';
import { AssetReferenceField, CollapsibleSection, Text, usePanelVisible } from '@forgeax/view-components';
import { Image } from 'lucide-react';
import { observeAssetThumbnails } from '@forgeax/view-workspace-core/asset-thumbnails';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceState, WorkspaceThumbnail } from '@forgeax/view-workspace-core/contract';
import type { ResourceAssetActionResolver } from '@forgeax/view-workspace-core/frontend-contract';
import type { WorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { materialReferenceScope, materialThumbnailScope, type MaterialTextureReferences as References } from '../texture-references.ts';
import { useTranslation } from '../i18n/useTranslation';

export function MaterialTextureReferences({ client, reader, workspace, references, loading, assetActions }: {
  client: ViewWorkspaceClient;
  reader: WorkspaceStateReader;
  workspace: WorkspaceState | null;
  references: References;
  loading: boolean;
  assetActions?: ResourceAssetActionResolver;
}) {
  const { t } = useTranslation();
  const visible = usePanelVisible();
  const [lease, restartLease] = useReducer((value: number) => value + 1, 0);
  const [thumbnails, setThumbnails] = useState<{ scope: string; rows: ReadonlyMap<string, WorkspaceThumbnail> }>();
  const guids = references.textures.map(asset => asset.guid);
  const scope = materialReferenceScope(workspace);
  const thumbnailScope = materialThumbnailScope(workspace, guids);
  useEffect(() => {
    if (!visible || !thumbnailScope || !guids.length) return;
    const observation = observeAssetThumbnails({ client, reader, guids, scope: thumbnailScope, getScope: materialThumbnailScope,
      publish: rows => setThumbnails({ scope: thumbnailScope, rows }), onInvalidate: restartLease });
    return () => observation.dispose();
  }, [client, reader, visible, thumbnailScope, lease]);

  return <div className="fx-inspector-form material-texture-references" data-testid="material-texture-references">
    <div className="fx-inspector-form__group material-texture-references__group">
      <CollapsibleSection defaultOpen title={<span className="fx-inspector-form__title">
        <span className="fx-inspector-form__icon"><Image size={13} strokeWidth={1.7} /></span>
        <span>{t('material.textureSlots')}</span>
      </span>}>
        <div className="material-texture-references__items">
          {references.textures.map(asset => {
            const value = { guid: asset.guid, kind: asset.kind, name: asset.name || asset.sourceKey || asset.guid, missing: asset.lifecycle === 'missing' };
            const actions = scope && !value.missing ? assetActions?.(value) : undefined;
            const current = () => materialReferenceScope(reader.getSnapshot()) === scope
              && materialThumbnailScope(reader.getSnapshot(), guids) === thumbnailScope;
            const thumbnail = visible && thumbnails?.scope === thumbnailScope ? thumbnails.rows.get(asset.guid) : undefined;
            return <div className="material-texture-reference" key={asset.guid} data-testid={`material-texture-${asset.guid}`}>
              <AssetReferenceField value={value}
                onOpen={actions?.onOpen ? () => { if (current()) actions.onOpen?.(); } : undefined}
                onBrowse={actions?.onBrowse ? () => { if (current()) actions.onBrowse?.(); } : undefined}
                labels={{ open: t('material.openTexture'), browse: t('material.browseTexture'), readOnly: t('material.readOnlyTexture'),
                  previewLoading: t('material.thumbnailLoading'), previewFailed: t('material.thumbnailFailed'), previewUnsupported: t('material.thumbnailUnsupported') }}
                thumbnail={{ state: !thumbnail || thumbnail.state === 'queued' || thumbnail.state === 'cooking' ? 'loading' : thumbnail.state,
                  src: thumbnail?.dataUrl, hint: thumbnail?.error?.hint }} />
            </div>;
          })}
          {loading ? <Text as="div" role="status" tone="muted">{t('material.referencesLoading')}</Text>
            : references.status === 'unavailable' ? <Text as="div" role="status" tone="muted">{t('material.referencesUnavailable')}</Text>
            : !references.textures.length && !references.unresolved.length ? <Text as="div" role="status" tone="muted">{t('material.noTextureReferences')}</Text> : null}
          {references.unresolved.length > 0 ? <Text as="div" role="status" tone="muted">{t('material.referencesIncomplete', { count: references.unresolved.length })}</Text> : null}
        </div>
      </CollapsibleSection>
    </div>
  </div>;
}
