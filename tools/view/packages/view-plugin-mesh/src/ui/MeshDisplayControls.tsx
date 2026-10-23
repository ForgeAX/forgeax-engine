import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Eye, Grid2X2, RotateCcw, ScanLine } from 'lucide-react';
import { IconButton, MenuDropdown, PreviewStatsOverlay, Toolbar, Tooltip, usePanelVisible } from '@forgeax/view-components';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspacePreview, WorkspacePreviewDisplay, WorkspacePreviewDisplayOptions } from '@forgeax/view-workspace-core/contract';
import { meshPreviewFactRows, previewFactValue } from '@forgeax/view-workspace-core/preview-facts';
import { selectWorkspaceResourcePreview, selectWorkspaceResourceSubject } from '@forgeax/view-workspace-core/resource-open';
import { createWorkspaceObservation, type WorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { useTranslation } from '../i18n/useTranslation';
import { MeshUvOverlay } from './MeshUvOverlay';
import type { UvViewport } from './uv-viewport';

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
  const [uvSelection, setUvSelection] = useState<{ binding: string; channel: number; viewport: UvViewport | null } | null>(null);
  const [uvLayout, setUvLayout] = useState<NonNullable<WorkspacePreviewDisplay['uv']>['layout']>();
  const [uvError, setUvError] = useState('');
  const [uvPending, setUvPending] = useState(false);
  const observationRef = useRef<ReturnType<typeof createWorkspaceObservation> | undefined>(undefined);
  const target = preview.target;
  const guid = preview.asset?.guid;
  const publication = preview.assetBinding?.publication;
  const bindingKey = JSON.stringify(publication ?? preview.assetBinding?.meta ?? null);
  const uvChannel = uvSelection?.binding === bindingKey ? uvSelection.channel : null;
  const changeUvViewport = useCallback((viewport: UvViewport | null) => {
    setUvSelection(current => current?.binding === bindingKey && current.channel === uvChannel ? { ...current, viewport } : current);
  }, [bindingKey, uvChannel]);
  useEffect(() => {
    setUvSelection(current => current && current.binding !== bindingKey ? null : current);
  }, [bindingKey]);
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
  }, [client, reader, target.targetId, target.generation, guid, visible, bindingKey]);
  useEffect(() => {
    setUvLayout(undefined);
    setUvError('');
    setUvPending(false);
    if (!visible || uvChannel === null) return;
    const observation = createWorkspaceObservation(reader, state => {
      const current = selectWorkspaceResourcePreview(state, guid);
      return selectWorkspaceResourceSubject(state, ['mesh'])?.guid === guid
        && current?.target.targetId === target.targetId && current.target.generation === target.generation
        && JSON.stringify(current.assetBinding?.publication ?? current.assetBinding?.meta ?? null) === bindingKey;
    });
    setUvPending(true);
    void client.getPreviewDisplay({ targetId: target.targetId, targetGeneration: target.generation, uvChannel, signal: observation.signal, reportError: false })
      .then(value => {
        if (observation.signal.aborted) return;
        const layout = value.uv?.layout;
        if (!layout || layout.channel !== uvChannel || JSON.stringify(layout.assetBinding.publication ?? layout.assetBinding.meta ?? null) !== bindingKey)
          throw new Error(t('mesh.uvBindingChanged'));
        setUvLayout(layout);
      })
      .catch(reason => { if (!observation.signal.aborted) setUvError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!observation.signal.aborted) setUvPending(false); });
    return () => observation.dispose();
  }, [client, reader, target.targetId, target.generation, guid, visible, bindingKey, uvChannel, t]);
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
    <div className="fx-mesh-preview-hud">
    {stats && <PreviewStatsOverlay label={t('mesh.statistics')} rows={meshPreviewFactRows(preview.assetBinding).map(row => ({
      id: row.key, label: t(`mesh.stats.${row.key}`), value: previewFactValue(row.value, unavailable, t('mesh.present'), t('mesh.none')),
    }))} />}
    {uvLayout && visible && uvLayout.channel === uvChannel && JSON.stringify(uvLayout.assetBinding.publication ?? uvLayout.assetBinding.meta ?? null) === bindingKey && <MeshUvOverlay layout={uvLayout} viewport={uvSelection?.viewport ?? null} onViewportChange={changeUvViewport} />}
    </div>
    <Toolbar className="fx-toolbar--viewport fx-mesh-preview-toolbar" aria-label={t('mesh.previewOptions')}>
      <Tooltip title={t('mesh.viewMode')} description={t('mesh.viewModeDescription')} placement="bottom" portaled>
        <MenuDropdown label={t('mesh.viewMode')} trigger={<IconButton label={t('mesh.viewMode')} title="" icon={<Box className="fx-icon" />} variant="secondary" size="compact" />} items={[
          { id: 'material', label: t('mesh.materialMode'), selection: 'radio', checked: display?.mode === 'material', disabled: !display || pending, onSelect: () => change({ mode: 'material' }) },
          { id: 'wireframe', label: t('mesh.wireframe'), selection: 'radio', checked: display?.mode === 'wireframe', disabled: !display?.capabilities.wireframe || pending, onSelect: () => change({ mode: 'wireframe' }) },
        ]} />
      </Tooltip>
      <Tooltip title={t('mesh.uv')} description={!display?.uv ? t('mesh.valueUnavailable') : !display.uv.channels.length ? t('mesh.noUv') : t('mesh.uvDescription')} placement="bottom" portaled>
        <MenuDropdown label={t('mesh.uv')} trigger={<IconButton label={t('mesh.uv')} title="" icon={<Grid2X2 className="fx-icon" />} variant="secondary" size="compact" data-testid="mesh-uv-menu" disabled={!display?.uv?.channels.length} aria-busy={uvPending} />} items={[
          { id: 'uv-none', label: t('mesh.none'), selection: 'radio', checked: uvChannel === null, onSelect: () => setUvSelection(null) },
          ...(display?.uv?.channels ?? []).map(channel => ({ id: `uv-${channel}`, label: t('mesh.uvChannel', { channel }), selection: 'radio' as const, checked: uvChannel === channel, onSelect: () => setUvSelection({ binding: bindingKey, channel, viewport: null }) })),
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
    {(uvError || error) && <p className="fx-mesh-display-error" role="alert"><ScanLine className="fx-icon" />{uvError || error}</p>}
  </>;
}
