import { Button, EmptyState, PropertyRow, Toolbar } from '@forgeax/view-components';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { AssetReferenceService } from '@forgeax/view-workspace-core/asset-references';
import { createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { type RuntimeParameter as Parameter, parameterDrafts, parameterValues, runtimePackTarget, runtimeToolingOwnership, userRuntimePacks } from './runtime-packs.ts';
import './runtime-packs.css';
import { useTranslation } from '../i18n/useTranslation';

type Instance = { schemaVersion: '3.0.0'; packageId: string; parent: string; values?: Record<string, unknown> };
type Execution = { instance: Instance; status: string; lastKnownGood?: { generation: number }; error?: unknown };
type Pack = { source: { packageId: string; source?: string; kind?: string; parameters?: Parameter[] } };
type Inspection = { packs: Pack[]; executions: Execution[] };
type Installation = { uid: number; state: string };
type Asset = { guid: string; kind: string; name?: string; sourceKey?: string; packageId?: string };

export function RuntimePacksPanel({ client, assetReferences }: { client: ViewWorkspaceClient; assetReferences?: AssetReferenceService }) {
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  const workspace = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  const target = runtimePackTarget(workspace);
  const key = target ? `${target.projectId}/${target.targetId}/${target.worldId}` : '';
  // A replacement project gets fresh drafts and cancels all old requests.
  return target ? <BoundRuntimePacks key={key} client={client} target={target} assetReferences={assetReferences} /> :
    <EmptyState title="Runtime content unavailable" description="Wait for the project target to be ready." />;
}

function BoundRuntimePacks({ client, target, assetReferences }: { client: ViewWorkspaceClient; target: { projectId: string; targetId: string; worldId: string }; assetReferences?: AssetReferenceService }) {
  const toolingState = useSyncExternalStore(assetReferences?.subscribe ?? (() => () => {}), assetReferences?.getState ?? (() => undefined), () => undefined);
  const tooling = runtimeToolingOwnership(toolingState, target);
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
  const upload = useRef<HTMLInputElement>(null);
  const packs = userRuntimePacks(inspection.packs, tooling?.packageId);
  const visiblePlugins = plugins.filter(plugin => plugin.uid !== tooling?.pluginUid);
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
    return () => controller.abort();
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
    const owner = runtimeToolingOwnership(assetReferences?.getState(), target);
    const saved = { ...snapshot, packs: userRuntimePacks(snapshot.packs, owner?.packageId) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(saved)], { type: 'application/json' }));
    try {
      const link = document.createElement('a');
      link.href = url; link.download = `${target.projectId}-runtime-content.json`; link.click();
    } finally { URL.revokeObjectURL(url); }
  }
  return <section className="cb-runtime" aria-label="Runtime content" data-testid="runtime-content">
    <Toolbar>
      <strong>{t('contentBrowser.runtimeTools')}</strong>
      <Button size="compact" disabled={busy} onClick={() => void act(async () => {})}>Refresh</Button>
      <Button size="compact" disabled={busy} onClick={() => upload.current?.click()}>Import content</Button>
      <Button size="compact" disabled={busy} onClick={() => void act(save)}>Save content</Button>
      <input ref={upload} type="file" accept=".json,application/json" hidden onChange={event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (file) void act(async () => {
          const value = JSON.parse(await file.text());
          return value.schemaVersion === 'runtime-pack-source/2' ? call('restore', { snapshot: value }) : call('admit', { content: value });
        });
      }} />
    </Toolbar>
    {error ? <p role="alert">{error}</p> : null}
    {busy ? <p role="status">Waiting for Engine...</p> : null}
    <details><summary>Admitted packs ({packs.length})</summary>
      {packs.map(pack => <PropertyRow key={pack.source.packageId} label={pack.source.source ?? pack.source.packageId}>
        <Button size="compact" disabled={busy} onClick={() => void act(() => call('withdraw', { packageId: pack.source.packageId }))}>Withdraw pack</Button>
      </PropertyRow>)}
    </details>
    <div className="cb-runtime-columns">
      <fieldset disabled={busy}>
        <legend>Generate assets</legend>
        <PropertyRow label="Generator"><select aria-label="Generator" value={selected} onChange={event => choose(event.target.value)}>
          <option value="">Choose a generator</option>
          {generators.map(pack => <option key={pack.source.packageId} value={pack.source.packageId}>{pack.source.source ?? pack.source.packageId}</option>)}
        </select></PropertyRow>
        {generator ? <>
          <PropertyRow label="Instance"><select aria-label="Instance" value={instanceId} onChange={event => choose(selected, event.target.value)}>
            <option value="">New instance</option>
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
          })}>Generate</Button>
          {execution ? <p role="status">{execution.status}{execution.lastKnownGood ? ` · Published generation ${execution.lastKnownGood.generation}` : ''}{execution.status !== 'current' && execution.lastKnownGood ? ' · Previous successful result' : ''}</p> : null}
          {execution?.error ? <pre>{JSON.stringify(execution.error, null, 2)}</pre> : null}
          {instanceId ? <Button size="compact" onClick={() => void act(async () => { await call('withdraw', { packageId: instanceId }); choose(selected); })}>Withdraw instance</Button> : null}
        </> : <p>{generators.length ? 'Select an admitted definition to edit parameters.' : 'No runtime generators have been admitted.'}</p>}
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Plugin assets</legend>
        {assets.filter(asset => asset.kind === 'plugin' && (!tooling?.packageId || asset.packageId !== tooling.packageId)).map(asset => <PropertyRow key={asset.guid} label={asset.name ?? asset.sourceKey ?? asset.guid}>
          <Button size="compact" onClick={() => void act(() => call('plugin-install', { guid: asset.guid }))}>Install</Button>
        </PropertyRow>)}
        <p>Installations owned by this View connection</p>
        {visiblePlugins.length ? visiblePlugins.map(plugin => <PropertyRow key={plugin.uid} label={`#${plugin.uid} · ${plugin.state}`}>
          <Button size="compact" onClick={() => void act(() => call('plugin-dispose', { uid: plugin.uid }))}>Dispose</Button>
        </PropertyRow>) : <p>No installations.</p>}
        <p>Generated outputs appear in the asset browser below. Open an output for its dedicated preview.</p>
      </fieldset>
    </div>
  </section>;
}
