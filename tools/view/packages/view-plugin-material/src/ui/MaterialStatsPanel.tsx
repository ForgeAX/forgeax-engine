import { useMemo, useSyncExternalStore } from 'react';
import { BarChart3 } from 'lucide-react';
import { EmptyState, PanelHeader, PropertyRow, usePanelVisible } from '@forgeax/view-components';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { materialPassStateRows, materialPreviewFacts, previewFactValue } from '@forgeax/view-workspace-core/preview-facts';
import { selectWorkspaceResourcePreview, selectWorkspaceResourceSubject } from '@forgeax/view-workspace-core/resource-open';
import { createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { RESOURCE_KINDS } from '../identity.ts';
import { useTranslation } from '../i18n/useTranslation';
import './material.css';

const inactive = () => () => {};
export function MaterialStatsPanel({ client }: { client?: ViewWorkspaceClient }) {
  const { t } = useTranslation();
  const visible = usePanelVisible();
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  const workspace = useSyncExternalStore(visible ? reader.subscribe : inactive, reader.getSnapshot, reader.getSnapshot);
  const subject = selectWorkspaceResourceSubject(workspace, RESOURCE_KINDS);
  const preview = selectWorkspaceResourcePreview(workspace, subject?.guid);
  const facts = materialPreviewFacts(preview?.assetBinding);
  const unavailable = t('material.valueUnavailable');
  const value = (input: string | number | boolean | null | undefined) => previewFactValue(input ?? null, unavailable, t('material.yes'), t('material.no'));
  return <div className="fx-asset-viewer fx-material-stats fx-ui" data-testid="panel-material-stats">
    {!subject ? <EmptyState icon={<BarChart3 />} title={t('material.empty')} description={t('material.statsEmptyDescription')} /> : <>
      <PanelHeader start={<strong>{String(subject.name ?? subject.guid)}</strong>} />
      <PropertyRow label={t('material.stats.passCount')}>{value(facts?.passCount)}</PropertyRow>
      <PropertyRow label={t('material.stats.parameterCount')}>{value(facts?.parameterCount)}</PropertyRow>
      <PropertyRow label={t('material.stats.textureParameterCount')}>{value(facts?.textureParameterCount)}</PropertyRow>
      <p className="fx-material-compiler-status">{t('material.compilerUnavailable')}</p>
      {(facts?.passes ?? []).map((pass, index) => <section className="fx-material-pass-stats" key={`${index}:${pass.name}`}>
        <h3>{pass.name}</h3>
        {materialPassStateRows(pass).map(row => <PropertyRow key={row.key} label={t(`material.stats.${row.key}`)}>{value(row.value)}</PropertyRow>)}
      </section>)}
    </>}
  </div>;
}
