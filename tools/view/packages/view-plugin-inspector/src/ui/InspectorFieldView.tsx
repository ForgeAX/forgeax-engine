import { InspectorFieldControl } from '@forgeax/view-components';
import { useState } from 'react';
import { inspectorCollection, type InspectorField } from '../inspection.ts';
import { useTranslation } from '../i18n/useTranslation';
import { InspectorAssetReference } from './InspectorAssetReference';

export function InspectorFieldView({ field, openAsset }: { field: InspectorField; openAsset: (guid: string) => void }) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  if (field.presentation === 'handle') return <span className="insp-handle-value" title={JSON.stringify(field.rawValue)}>{t('inspector.handleReference', { handle: String(field.rawValue) })}</span>;
  if (field.presentation === 'resource' && field.resource) return <InspectorAssetReference reference={field.resource} openAsset={openAsset} inline />;
  if (field.presentation === 'color' && field.colorChannels) {
    return <InspectorFieldControl field={{ ...field, kind: 'color', value: field.colorChannels }} />;
  }
  if (field.presentation === 'collection') {
    const collection = inspectorCollection(field.rawValue);
    if (collection.unavailable) return <span className="insp-collection-status" role="status">{t('inspector.valueUnavailable', { reason: collection.unavailable })}</span>;
    return <details className="insp-collection" data-testid="insp-collection">
      <summary>{t('inspector.collectionCount', { count: collection.length })}{collection.truncated ? <span className="insp-collection-status">{t('inspector.collectionTruncated', { count: collection.entries.length })}</span> : null}</summary>
      <dl>{collection.entries.slice(0, showAll ? undefined : 16).map(([key, value]) => {
        const text = JSON.stringify(value) ?? t('inspector.bindingUnavailable');
        return <div key={key}><dt title={key}>{key}</dt><dd title={text}>{text.length > 160 ? `${text.slice(0, 160)}...` : text}</dd></div>;
      })}</dl>
      {collection.entries.length > 16 ? <button type="button" className="insp-collection-more" onClick={() => setShowAll(current => !current)}>{t(showAll ? 'inspector.collectionLess' : 'inspector.collectionMore', { count: collection.entries.length })}</button> : null}
    </details>;
  }
  const wideVector = ['vector3', 'vector4'].includes(field.kind) && field.value && typeof field.value === 'object'
    && Object.values(field.value).some(value => String(value).length > 5);
  const assetLabels = {
    none: t('inspector.assetRef.none'), missing: t('inspector.assetRef.missing'), open: t('inspector.openResource'),
    useSelection: t('inspector.assetRef.useSelection'), browse: t('inspector.assetRef.browse'), reveal: t('inspector.assetRef.reveal'),
    more: t('inspector.assetRef.more'), clear: t('inspector.assetRef.clear'), copyGuid: t('inspector.assetRef.copyGuid'),
  };
  return <span className="insp-scalar-value" data-wide-vector={wideVector ? 'true' : undefined} title={JSON.stringify(field.rawValue)}><InspectorFieldControl field={field} assetLabels={assetLabels} /></span>;
}
