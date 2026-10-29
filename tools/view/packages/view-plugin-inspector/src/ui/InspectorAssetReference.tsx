import { AssetReferenceField, CollapsibleSection, PropertyRow, Text } from '@forgeax/view-components';
import type { InspectorResourceReference } from '../inspection.ts';
import { useTranslation } from '../i18n/useTranslation';
import { INSPECTOR_ACTIONS } from '../schema.ts';
import { useInspectorThumbnail } from './InspectorThumbnails';

export function InspectorAssetReference({ reference, openAsset, browseAsset, inline = false }: {
  reference: InspectorResourceReference;
  openAsset: (guid: string) => void;
  browseAsset?: (guid: string) => void;
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const thumbnail = useInspectorThumbnail(reference.guid);
  const rawName = reference.rawValue && typeof reference.rawValue === 'object' && 'name' in reference.rawValue
    && typeof reference.rawValue.name === 'string' ? reference.rawValue.name : undefined;
  const name = reference.asset?.name || reference.asset?.sourceKey || rawName || reference.guid
    || (reference.handle === 0 ? t(reference.inherited ? 'inspector.materialInherited' : 'inspector.unbound') : reference.handle !== undefined
      ? t('inspector.handleReference', { handle: reference.handle }) : t('inspector.bindingUnavailable'));
  const missing = reference.status === 'missing' || Boolean(reference.guid && !reference.asset)
    || (reference.rawValue && typeof reference.rawValue === 'object' && 'missing' in reference.rawValue && reference.rawValue.missing === true);
  const canOpen = Boolean(reference.guid && !missing && reference.asset);
  const value = reference.guid ? { guid: reference.guid, name, kind: reference.kind, missing }
    : reference.rawValue === '' || reference.rawValue === null || reference.handle === 0 ? ''
      : { name, kind: reference.kind };
  const details = [
    ['GUID', reference.guid],
    [t('inspector.source'), reference.asset?.sourcePath ?? reference.asset?.path],
    [t('inspector.sourceKey'), reference.asset?.sourceKey],
    [t('inspector.handle'), reference.handle],
  ].filter(([, value]) => value !== undefined && value !== '');
  return <div className={`insp-resource${inline ? ' insp-resource--inline' : ''}`}>
    <div data-testid="insp-resource-reference">
      <AssetReferenceField value={value} labels={{
        none: t('inspector.assetRef.none'), missing: t('inspector.assetRef.missing'), open: t('inspector.openResource'),
        openUnavailable: t('inspector.assetRef.openUnavailable'), readOnly: t('inspector.assetRef.readOnly'),
        identityUnavailable: t('inspector.resourceIdentityUnavailable'),
        useSelection: t('inspector.assetRef.useSelection'), browse: t('inspector.assetRef.browse'),
        reveal: t('inspector.assetRef.reveal'), more: t('inspector.assetRef.more'),
        clear: t('inspector.assetRef.clear'), copyGuid: t('inspector.assetRef.copyGuid'),
        previewLoading: t('inspector.assetRef.previewLoading'), previewFailed: t('inspector.assetRef.previewFailed'),
        previewUnsupported: t('inspector.assetRef.previewUnsupported'),
      }} openAction={INSPECTOR_ACTIONS.openAsset}
        thumbnail={canOpen ? { state: !thumbnail || thumbnail.state === 'queued' || thumbnail.state === 'cooking'
          ? 'loading' : thumbnail.state, src: thumbnail?.dataUrl, hint: thumbnail?.error?.hint } : undefined}
        onOpen={canOpen && reference.guid ? () => openAsset(reference.guid!) : undefined}
        onBrowse={canOpen && reference.guid && browseAsset ? () => browseAsset(reference.guid!) : undefined} />
    </div>
    {!reference.guid && reference.handle !== 0 && reference.rawValue !== '' && reference.rawValue !== null
      ? <Text as="div" tone="muted" className="insp-resource-warning" role="status">{t('inspector.resourceIdentityUnavailable')}</Text> : null}
    {!inline && details.length > 0 ? <CollapsibleSection title={t('inspector.resourceDetails')} defaultOpen={false} className="insp-resource-details">
      {details.map(([label, value]) => <PropertyRow key={String(label)} label={String(label)}><span className="insp-resource-detail-value" title={String(value)}>{String(value)}</span></PropertyRow>)}
    </CollapsibleSection> : null}
  </div>;
}
