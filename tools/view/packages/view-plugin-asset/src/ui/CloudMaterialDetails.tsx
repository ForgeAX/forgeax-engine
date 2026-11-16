import { useEffect, useReducer, useState } from 'react';
import { AssetReferenceField, Checkbox, CollapsibleSection, InspectorFieldControl, PropertyRow, Text, TextInput, usePanelVisible } from '@forgeax/view-components';
import type { InspectorFormField } from '@forgeax/view-components';
import { observeAssetThumbnails } from '@forgeax/view-workspace-core/asset-thumbnails';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceCloudMaterialInspection, WorkspaceState, WorkspaceThumbnail } from '@forgeax/view-workspace-core/contract';
import type { ResourceAssetActionResolver } from '@forgeax/view-workspace-core/frontend-contract';
import type { WorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { cloudDeclaredDependencyReference, cloudParameterGroups, cloudProgramDetails, cloudThumbnailScope } from '../cloud-material';
import { useTranslation } from '../i18n/useTranslation';

export function CloudMaterialDetails({ details, client, reader, workspace, assetActions }: {
  details: WorkspaceCloudMaterialInspection['meta']; client: ViewWorkspaceClient; reader: WorkspaceStateReader;
  workspace: WorkspaceState | null; assetActions?: ResourceAssetActionResolver;
}) {
  const { t } = useTranslation();
  const visible = usePanelVisible();
  const [query, setQuery] = useState('');
  const [lease, restart] = useReducer((value: number) => value + 1, 0);
  const [thumbnails, setThumbnails] = useState<{ scope: string; rows: ReadonlyMap<string, WorkspaceThumbnail> }>();
  const guids = details.parameters.filter(row => row.definition.kind === 'texture').map(row => String(row.value));
  const scope = cloudThumbnailScope(workspace, guids);
  const program = cloudProgramDetails(details);
  const dependencyGuids = program?.declaredDependencies.map(dependency => dependency.guid) ?? [];
  const dependencyScope = cloudThumbnailScope(workspace, dependencyGuids);
  const fact = (key: string, value: unknown) => <PropertyRow key={key} label={t(`asset.${key}`)}>
    <InspectorFieldControl field={{key, label: t(`asset.${key}`), kind: 'text', value: value === undefined ? t('asset.factUnavailable') : String(value)}} />
  </PropertyRow>;
  useEffect(() => {
    if (!visible || !scope || !guids.length) return;
    return observeAssetThumbnails({ client, reader, guids, scope, getScope: cloudThumbnailScope,
      publish: rows => setThumbnails({ scope, rows }), onInvalidate: restart }).dispose;
  }, [client, reader, visible, scope, lease]);
  return <div className="fx-cloud-details fx-inspector-form" data-testid="cloud-material-details">
    <CollapsibleSection title={t('asset.programFacts')} defaultOpen={false}>
      <Text as="div" tone="muted">{t('asset.programFactsScope')}</Text>
      {program ? <>
        {fact('cookIdentity', program.cookIdentity)}
        {program.densityKernelIdentity !== undefined && fact('densityKernelIdentity', program.densityKernelIdentity)}
        {program.variants.map((variant, index) => <CollapsibleSection key={variant.programIdentity} title={`${t('asset.variant')} ${index + 1}`} defaultOpen={variant.selected}>
          {fact('programIdentity', variant.programIdentity)}
          {fact('programDigest', variant.programDigest)}
          {fact('compilerIdentity', variant.compilerIdentity)}
          {fact('staticValues', JSON.stringify(variant.staticValues))}
          {fact('resolvedVariant', variant.selected ? t('asset.selected') : t('asset.notSelected'))}
          {variant.renderer && fact('rendererProgramDigest', variant.renderer.programDigest)}
        </CollapsibleSection>)}
        {!program.variants.length && <Text as="div" tone="muted">{t('asset.noProgramVariants')}</Text>}
      </> : <Text as="div" role="status">{t('asset.programFactsUnavailable')}</Text>}
    </CollapsibleSection>
    <CollapsibleSection title={t('asset.declaredDependencies')} defaultOpen={false}>
      <Text as="div" tone="muted">{t('asset.declaredDependenciesScope')}</Text>
      {program ? <>
        {program.declaredDependencies.map(dependency => {
          const value = cloudDeclaredDependencyReference(dependency, workspace?.assets);
          const actions = value.missing ? undefined : assetActions?.(value);
          const current = () => dependencyScope !== null && cloudThumbnailScope(reader.getSnapshot(), dependencyGuids) === dependencyScope;
          return <PropertyRow key={`${dependency.declaredBy}:${dependency.kind}:${dependency.guid}`}
            label={t(dependency.declaredBy === 'material' ? 'asset.materialDeclaration' : 'asset.instanceDeclaration')}>
            <AssetReferenceField readOnly value={value}
              onOpen={actions?.onOpen ? () => { if (current()) actions.onOpen?.(); } : undefined}
              onReveal={actions?.onBrowse ? () => { if (current()) actions.onBrowse?.(); } : undefined} />
          </PropertyRow>;
        })}
        {!program.declaredDependencies.length && <Text as="div" tone="muted">{t('asset.noDeclaredDependencies')}</Text>}
        {program.dependenciesTruncated && <Text as="div" role="status">{t('asset.dependenciesTruncated')}</Text>}
      </> : <Text as="div" role="status">{t('asset.programFactsUnavailable')}</Text>}
    </CollapsibleSection>
    <TextInput aria-label={t('asset.searchParameters')} placeholder={t('asset.searchParameters')} value={query} onChange={event => setQuery(event.target.value)} />
    {cloudParameterGroups(details, query).map(([group, rows]) => <CollapsibleSection key={group} defaultOpen title={group}>
      {rows.map(row => {
        const definition = row.definition;
        const label = definition.label ?? row.name;
        const guid = String(row.value);
        const asset = workspace?.assets?.find(asset => asset.guid === guid);
        const value = { guid, kind: 'texture', name: asset?.name || asset?.sourceKey || guid, missing: !asset || asset.lifecycle === 'missing' };
        const thumbnail = visible && thumbnails?.scope === scope ? thumbnails.rows.get(guid) : undefined;
        const actions = assetActions?.(value);
        const field: InspectorFormField = { key: row.name, label, value: typeof row.value === 'number' ? Number(row.value.toPrecision(7)) : row.value,
          kind: definition.kind === 'scalar' ? 'number' : definition.kind === 'static' ? 'bool' : 'vector3' };
        if (definition.kind === 'vector') {
          field.kind = definition.default.length === 4 ? 'vector4' : 'vector3';
          field.value = Object.fromEntries(['x', 'y', 'z', 'w'].slice(0, definition.default.length).map((axis, i) => [axis, Number((row.value as readonly number[])[i]!.toPrecision(7))]));
        }
        const current = () => scope !== null && cloudThumbnailScope(reader.getSnapshot(), guids) === scope;
        return <PropertyRow key={row.name} className="fx-cloud-parameter" label={<span title={row.name}>{label}</span>}>
          <div className="fx-cloud-parameter__value" title={definition.kind === 'scalar' ? `${definition.unit}${definition.range ? ` [${definition.range.join(', ')}]` : ''}` : row.name}>
            <Checkbox checked={row.overridden} disabled hideLabel label={t('asset.overridden')} />
            {definition.kind === 'texture' ? <AssetReferenceField readOnly value={value}
              onOpen={actions?.onOpen ? () => { if (current()) actions.onOpen?.(); } : undefined}
              onReveal={actions?.onBrowse ? () => { if (current()) actions.onBrowse?.(); } : undefined}
              thumbnail={{ state: !thumbnail || thumbnail.state === 'queued' || thumbnail.state === 'cooking' ? 'loading' : thumbnail.state, src: thumbnail?.dataUrl, hint: thumbnail?.error?.hint }} />
              : <InspectorFieldControl field={field} />}
          </div>
        </PropertyRow>;
      })}
    </CollapsibleSection>)}
    {details.truncated && <div role="status">{t('asset.parametersTruncated')}</div>}
  </div>;
}
