import { useEffect, useRef, useState } from 'react';
import { Box, Eye, RotateCcw, ScanLine } from 'lucide-react';
import { IconButton, MenuDropdown, PreviewStatsOverlay, Toolbar, Tooltip, usePanelVisible } from '@forgeax/view-components';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspacePreview, WorkspacePreviewDisplay, WorkspacePreviewDisplayOptions } from '@forgeax/view-workspace-core/contract';
import { meshPreviewFactRows, previewFactValue } from '@forgeax/view-workspace-core/preview-facts';
import { selectWorkspaceResourcePreview, selectWorkspaceResourceSubject } from '@forgeax/view-workspace-core/resource-open';
import { createWorkspaceObservation, type WorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { useTranslation } from '../i18n/useTranslation';

export function MeshDisplayControls({ client, preview, reader, resetDisabled, onReset }: {
  client: ViewWorkspaceClient; preview: WorkspacePreview; reader: WorkspaceStateReader;
  resetDisabled: boolean; onReset: () => void;
}) {
  const { t } = useTranslation();
  const visible = usePanelVisible();
  const [display, setDisplay] = useState<WorkspacePreviewDisplay>();
  const [stats, setStats] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const observationRef = useRef<ReturnType<typeof createWorkspaceObservation> | undefined>(undefined);
  const target = preview.target;
  const guid = preview.asset?.guid;
  useEffect(() => {
    if (!visible) return;
    const observation = createWorkspaceObservation(reader, state => {
      const current = selectWorkspaceResourcePreview(state, guid)?.target;
      return selectWorkspaceResourceSubject(state, ['mesh'])?.guid === guid && current?.targetId === target.targetId && current?.generation === target.generation;
    });
    observationRef.current = observation;
    setPending(false);
    void client.capabilities().then(capabilities => {
      if (!capabilities || typeof capabilities !== 'object' || !('operations' in capabilities) || !Array.isArray(capabilities.operations) || !capabilities.operations.includes('preview.display.get')) return undefined;
      return client.getPreviewDisplay({ targetId: target.targetId, targetGeneration: target.generation, signal: observation.signal, reportError: false });
    })
      .then(value => { if (!observation.signal.aborted) { setDisplay(value); setError(''); } })
      .catch(reason => { if (!observation.signal.aborted) { setDisplay(undefined); setError(String(reason instanceof Error ? reason.message : reason)); } });
    return () => { observation.dispose(); observationRef.current = undefined; };
  }, [client, reader, target.targetId, target.generation, guid, visible]);
  const change = (options: WorkspacePreviewDisplayOptions) => {
    const signal = observationRef.current?.signal;
    if (!signal || signal.aborted || pending || !display) return;
    setPending(true);
    void client.setPreviewDisplay(options, { targetId: target.targetId, targetGeneration: target.generation, signal, reportError: false })
      .then(value => { if (!signal.aborted) { setDisplay(value); setError(''); } })
      .catch(reason => { if (!signal.aborted) setError(String(reason instanceof Error ? reason.message : reason)); })
      .finally(() => { if (!signal.aborted) setPending(false); });
  };
  const unavailable = t('mesh.valueUnavailable');
  return <>
    {stats && <PreviewStatsOverlay label={t('mesh.statistics')} rows={meshPreviewFactRows(preview.assetBinding).map(row => ({
      id: row.key, label: t(`mesh.stats.${row.key}`), value: previewFactValue(row.value, unavailable, t('mesh.present'), t('mesh.none')),
    }))} />}
    <Toolbar className="fx-toolbar--viewport fx-mesh-preview-toolbar" aria-label={t('mesh.previewOptions')}>
      <Tooltip title={t('mesh.viewMode')} description={t('mesh.viewModeDescription')} placement="bottom" portaled>
        <MenuDropdown label={t('mesh.viewMode')} trigger={<IconButton label={t('mesh.viewMode')} title="" icon={<Box className="fx-icon" />} variant="secondary" size="compact" />} items={[
          { id: 'material', label: t('mesh.materialMode'), selection: 'radio', checked: display?.mode === 'material', disabled: !display || pending, onSelect: () => change({ mode: 'material' }) },
          { id: 'wireframe', label: t('mesh.wireframe'), selection: 'radio', checked: display?.mode === 'wireframe', disabled: !display?.capabilities.wireframe || pending, onSelect: () => change({ mode: 'wireframe' }) },
        ]} />
      </Tooltip>
      <Tooltip title={t('mesh.show')} description={t('mesh.showDescription')} placement="bottom" portaled>
        <MenuDropdown label={t('mesh.show')} trigger={<IconButton label={t('mesh.show')} title="" icon={<Eye className="fx-icon" />} variant="secondary" size="compact" />} items={[
          { id: 'collision', label: t('mesh.collision'), selection: 'checkbox', checked: display?.collision, disabled: !display?.capabilities.collision || pending, buttonProps: { title: meshPreviewFactRows(preview.assetBinding).some(row => row.key === 'collisionData' && row.value === false) ? t('mesh.noCollision') : !display ? unavailable : undefined }, onSelect: () => change({ collision: !display?.collision }) },
          { id: 'bounds', label: t('mesh.bounds'), selection: 'checkbox', checked: display?.bounds, disabled: !display?.capabilities.bounds || pending, onSelect: () => change({ bounds: !display?.bounds }) },
          { type: 'separator' },
          { id: 'statistics', label: t('mesh.statistics'), selection: 'checkbox', checked: stats, onSelect: () => setStats(value => !value) },
        ]} />
      </Tooltip>
      <Tooltip title={t('mesh.resetView')} description={t('mesh.resetViewDescription')} placement="bottom" portaled>
        <IconButton label={t('mesh.resetView')} title="" icon={<RotateCcw className="fx-icon" />} size="compact" variant="secondary" data-testid="mesh-reset-view" disabled={resetDisabled} onClick={onReset} />
      </Tooltip>
    </Toolbar>
    {error && <p className="fx-mesh-display-error" role="alert"><ScanLine className="fx-icon" />{error}</p>}
  </>;
}
