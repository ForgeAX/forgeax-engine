import { Button, EmptyState, PropertyRow, Toolbar } from '@forgeax/view-components';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { type RuntimeParameter as Parameter, parameterDrafts, parameterValues, runtimePackTarget } from './runtime-packs.ts';
import './runtime-packs.css';
import { useTranslation } from '../i18n/useTranslation';

type Instance = { schemaVersion: '3.0.0'; packageId: string; parent: string; values?: Record<string, unknown> };
type Execution = { instance: Instance; status: string; lastKnownGood?: { generation: number }; error?: unknown };
type Pack = { source: { packageId: string; source?: string; kind?: string; parameters?: Parameter[] } };
type Inspection = { packs: Pack[]; executions: Execution[] };
type Installation = { uid: number; state: string };
type Asset = { guid: string; kind: string; name?: string; sourceKey?: string; packageId?: string };

export function RuntimePacksPanel({ client }: { client: ViewWorkspaceClient }) {
  const { t } = useTranslation();
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  const workspace = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  const target = runtimePackTarget(workspace);
  const key = target ? `${target.projectId}/${target.targetId}/${target.worldId}` : '';
  // A replacement project gets fresh drafts and cancels all old requests.
  return target ? <BoundRuntimePacks key={key} client={client} target={target} /> :
    <EmptyState title={t('contentBrowser.runtime.unavailable')} description={t('contentBrowser.runtime.waitForTarget')} />;
}

function BoundRuntimePacks({ client, target }: { client: ViewWorkspaceClient; target: { projectId: string; targetId: string; worldId: string } }) {
  const { t } = useTranslation();
  const [inspection, setInspection] = useState<Inspection>({ packs: [], executions: [] });
  const [plugins, setPlugins] = useState<Installation[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  const downloadUrl = useRef<string | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const packs = inspection.packs;
  const generators = packs.filter(pack => pack.source.kind === 'scriptable-pack-source');
  const generator = generators.find(pack => pack.source.packageId === selected);
  const parameters = generator?.source.parameters ?? [];
  const executions = inspection.executions.filter(item => item.instance.parent === selected && item.status !== 'withdrawn');
  const execution = executions.find(item => item.instance.packageId === instanceId);
  const call = useCallback(<T,>(operation: string, args = {}) => client.call<T>(`runtime-pack.${operation}`, { ...args, ...target }, { signal: lifetime.current?.signal }), [client, target.projectId, target.targetId, target.worldId]);
  const refresh = useCallback(async (signal = lifetime.current?.signal) => {
    const [contents, installed, listed] = await Promise.all([
      client.call('runtime-pack.inspect', target, { signal }),
      client.call('runtime-pack.plugin-inspect', target, { signal }),
      client.listAssets(target.projectId, { signal }),
    ]);
    if (signal?.aborted) return;
    setInspection(contents as Inspection);
    setPlugins((installed as { plugins: Installation[] }).plugins);
    setAssets((listed as { assets: Asset[] }).assets);
  }, [client, target.projectId, target.targetId, target.worldId]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setBusy(true);
    void refresh(controller.signal).catch(cause => { if (!controller.signal.aborted) setError(String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => {
      controller.abort();
      if (downloadUrl.current !== null) URL.revokeObjectURL(downloadUrl.current);
      downloadUrl.current = null;
    };
  }, [refresh]);
  async function act(operation: () => Promise<unknown>) {
    if (busy || lifetime.current?.signal.aborted) return;
    setBusy(true);
    setError('');
    const signal = lifetime.current?.signal;
    let operationFailed = false;
    try { await operation(); }
    catch (cause) { operationFailed = true; if (!signal?.aborted) setError(String(cause)); }
    finally {
      if (!signal?.aborted) {
        try { await refresh(signal); } catch (cause) { if (!signal?.aborted && !operationFailed) setError(String(cause)); }
        if (!signal?.aborted) setBusy(false);
      }
    }
  }
  function choose(parent: string, id = '') {
    const pack = generators.find(item => item.source.packageId === parent);
    const item = inspection.executions.find(item => item.instance.packageId === id);
    setSelected(parent); setInstanceId(id);
    setDrafts(parameterDrafts(pack?.source.parameters ?? [], item?.instance.values));
  }
  async function save() {
    const snapshot = await call<{ packs: Pack[] }>('snapshot');
    if (lifetime.current?.signal.aborted) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot)], { type: 'application/json' }));
    if (downloadUrl.current !== null) URL.revokeObjectURL(downloadUrl.current);
    downloadUrl.current = url;
    try {
      const link = document.createElement('a');
      link.href = url; link.download = `${target.projectId}-runtime-content.json`; link.click();
    } catch (error) {
      URL.revokeObjectURL(url);
      downloadUrl.current = null;
      throw error;
    }
  }
  return <section className="cb-runtime" aria-label={t('contentBrowser.runtime.title')} data-testid="runtime-content">
    <Toolbar>
      <strong>{t('contentBrowser.runtimeTools')}</strong>
      <Button size="compact" disabled={busy} onClick={() => void act(async () => {})}>{t('contentBrowser.refresh')}</Button>
      <Button size="compact" disabled={busy} onClick={() => upload.current?.click()}>{t('contentBrowser.runtime.import')}</Button>
      <Button size="compact" disabled={busy} onClick={() => void act(save)}>{t('contentBrowser.runtime.save')}</Button>
      <input ref={upload} type="file" accept=".json,application/json" hidden onChange={event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (file) void act(async () => {
          const value = JSON.parse(await file.text());
          if (value?.schemaVersion === 'runtime-pack-source/2' || value?.schemaVersion === 'runtime-pack-source/3') {
            return call('restore', { snapshot: value });
          }
          return call('admit', { content: value });
        });
      }} />
    </Toolbar>
    {error ? <p role="alert">{error}</p> : null}
    {busy ? <p role="status">{t('contentBrowser.runtime.waiting')}</p> : null}
    <details><summary>{t('contentBrowser.runtime.admitted', { count: packs.length })}</summary>
      {packs.map(pack => <PropertyRow key={pack.source.packageId} label={pack.source.source ?? pack.source.packageId}>
        <Button size="compact" disabled={busy} onClick={() => void act(() => call('withdraw', { packageId: pack.source.packageId }))}>{t('contentBrowser.runtime.withdrawPack')}</Button>
      </PropertyRow>)}
    </details>
    <div className="cb-runtime-columns">
      <fieldset disabled={busy}>
        <legend>{t('contentBrowser.runtime.generateAssets')}</legend>
        <PropertyRow label={t('contentBrowser.runtime.generator')}><select aria-label={t('contentBrowser.runtime.generator')} value={selected} onChange={event => choose(event.target.value)}>
          <option value="">{t('contentBrowser.runtime.chooseGenerator')}</option>
          {generators.map(pack => <option key={pack.source.packageId} value={pack.source.packageId}>{pack.source.source ?? pack.source.packageId}</option>)}
        </select></PropertyRow>
        {generator ? <>
          <PropertyRow label={t('contentBrowser.runtime.instance')}><select aria-label={t('contentBrowser.runtime.instance')} value={instanceId} onChange={event => choose(selected, event.target.value)}>
            <option value="">{t('contentBrowser.runtime.newInstance')}</option>
            {executions.map(item => <option key={item.instance.packageId} value={item.instance.packageId}>{item.instance.packageId}</option>)}
          </select></PropertyRow>
          {parameters.map(parameter => <PropertyRow key={parameter.name} label={parameter.name}>
            {parameter.type === 'bool' || parameter.type === 'enum' ?
              <select aria-label={parameter.name} value={drafts[parameter.name] ?? ''} onChange={event => setDrafts({ ...drafts, [parameter.name]: event.target.value })}>
                {(parameter.type === 'bool' ? [true, false] : parameter.values ?? []).map(value => <option key={String(value)} value={String(value)}>{String(value)}</option>)}
              </select> : <input aria-label={parameter.name} value={drafts[parameter.name] ?? ''} onChange={event => setDrafts({ ...drafts, [parameter.name]: event.target.value })} />}
          </PropertyRow>)}
          <Button size="compact" onClick={() => void act(async () => {
            const id = instanceId || crypto.randomUUID();
            const instance: Instance = { schemaVersion: '3.0.0', packageId: id, parent: selected, values: parameterValues(parameters, drafts) };
            setInstanceId(id);
            await call('generate', { instance });
          })}>{t('contentBrowser.runtime.generate')}</Button>
          {execution ? <p role="status">{execution.status}{execution.lastKnownGood ? ` · ${t('contentBrowser.runtime.publishedGeneration', { generation: execution.lastKnownGood.generation })}` : ''}{execution.status !== 'current' && execution.lastKnownGood ? ` · ${t('contentBrowser.runtime.previousResult')}` : ''}</p> : null}
          {execution?.error ? <pre>{JSON.stringify(execution.error, null, 2)}</pre> : null}
          {instanceId ? <Button size="compact" onClick={() => void act(async () => { await call('withdraw', { packageId: instanceId }); choose(selected); })}>{t('contentBrowser.runtime.withdrawInstance')}</Button> : null}
        </> : <p>{t(generators.length ? 'contentBrowser.runtime.selectDefinition' : 'contentBrowser.runtime.noGenerators')}</p>}
      </fieldset>
      <fieldset disabled={busy}>
        <legend>{t('contentBrowser.runtime.pluginAssets')}</legend>
        {assets.filter(asset => asset.kind === 'plugin').map(asset => <PropertyRow key={asset.guid} label={asset.name ?? asset.sourceKey ?? asset.guid}>
          <Button size="compact" onClick={() => void act(() => call('plugin-install', { guid: asset.guid }))}>{t('contentBrowser.runtime.install')}</Button>
        </PropertyRow>)}
        <p>{t('contentBrowser.runtime.installations')}</p>
        {plugins.length ? plugins.map(plugin => <PropertyRow key={plugin.uid} label={`#${plugin.uid} · ${plugin.state}`}>
          <Button size="compact" onClick={() => void act(() => call('plugin-dispose', { uid: plugin.uid }))}>{t('contentBrowser.runtime.dispose')}</Button>
        </PropertyRow>) : <p>{t('contentBrowser.runtime.noInstallations')}</p>}
      </fieldset>
    </div>
  </section>;
}
