import { AssetReferenceField, CollapsibleSection, PropertyRow, Text } from '@forgeax/view-components';
import type { InspectorResourceReference } from '../inspection.ts';
import { useTranslation } from '../i18n/useTranslation';
import { INSPECTOR_ACTIONS } from '../schema.ts';

export function InspectorAssetReference({ reference, openAsset, inline = false }: {
  reference: InspectorResourceReference;
  openAsset: (guid: string) => void;
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const rawName = reference.rawValue && typeof reference.rawValue === 'object' && 'name' in reference.rawValue
    && typeof reference.rawValue.name === 'string' ? reference.rawValue.name : undefined;
  const name = reference.asset?.name || reference.asset?.sourceKey || rawName || reference.guid
    || (reference.handle === 0 ? t(reference.inherited ? 'inspector.materialInherited' : 'inspector.unbound') : reference.handle !== undefined
      ? t('inspector.handleReference', { handle: reference.handle }) : t('inspector.bindingUnavailable'));
  const missing = reference.rawValue && typeof reference.rawValue === 'object' && 'missing' in reference.rawValue && reference.rawValue.missing === true;
  const canOpen = Boolean(reference.guid && !missing && reference.asset?.previewable !== false);
  const value = reference.rawValue === '' || reference.rawValue === null || reference.handle === 0 ? ''
    : reference.guid ? { guid: reference.guid, name, kind: reference.kind, missing }
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
        useSelection: t('inspector.assetRef.useSelection'), browse: t('inspector.assetRef.browse'),
        reveal: t('inspector.assetRef.reveal'), more: t('inspector.assetRef.more'),
        clear: t('inspector.assetRef.clear'), copyGuid: t('inspector.assetRef.copyGuid'),
      }} openAction={INSPECTOR_ACTIONS.openAsset}
        onOpen={canOpen && reference.guid ? () => openAsset(reference.guid!) : undefined} />
    </div>
    {!reference.guid && reference.handle !== 0 && reference.rawValue !== '' && reference.rawValue !== null
      ? <Text as="div" tone="muted" className="insp-resource-warning" role="status">{t('inspector.resourceIdentityUnavailable')}</Text> : null}
    {!inline && details.length > 0 ? <CollapsibleSection title={t('inspector.resourceDetails')} defaultOpen={false} className="insp-resource-details">
      {details.map(([label, value]) => <PropertyRow key={String(label)} label={String(label)}><span className="insp-resource-detail-value" title={String(value)}>{String(value)}</span></PropertyRow>)}
    </CollapsibleSection> : null}
  </div>;
}
