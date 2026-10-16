import type { FrontendAssemblyState } from '@forgeax/engine-host';
import type { InspectorSources, InspectorSource } from '../runtime.ts';
import { workspaceDiagnosticRecord } from '@forgeax/view-workspace-core/command-error';
export type PluginEntry = { sourceId: string; entryId: string; module: string; label: string; kind: string; assetGuid?: string; program?: string; realm?: string; version: string; state: string; tags: string[]; operations: string[]; commands: string[] };
type PluginRecord = { entryId?: string; id?: string; module?: string; name?: string; realm?: string; fiberId?: string | number; assetGuid?: string; program?: string; requiredServices?: readonly string[]; fiberState?: string; disabled?: boolean; desiredState?: string; commandContract?: unknown };
export type PluginSnapshotSource = { sourceId: string; kind: string; generation?: number; state?: string; plugins?: PluginRecord[]; actual?: { entries?: readonly PluginRecord[] }; assembly?: { root?: { program: string; codeRevision: string } | null } | null; api?: InspectorSource['api']; connection?: InspectorSource['connection']; local?: boolean; unavailable?: boolean };
export type PluginsInspectorClient = { sources?: (options?: { signal?: AbortSignal }) => Promise<unknown>; inspect?: (options: { sourceId: string; generation?: number; signal?: AbortSignal }) => Promise<unknown>; inspectPlugins?: PluginsInspectorClient['inspect'] };
export type PluginSnapshotOptions = { client?: PluginsInspectorClient; hostAssembly?: FrontendAssemblyState; connectionId?: string };
export const PLUGIN_TAGS = Object.freeze(['backend', 'frontend', 'game', 'asset', 'api', 'cli']);

function entriesFor(source: PluginSnapshotSource): PluginEntry[] {
  const { sourceId, kind, assembly, actual, plugins = [], api } = source;
  const installed = new Map((actual?.entries ?? []).map(entry => [entry.entryId ?? entry.id, entry]));
  // Backend assembly.current is the FRONTEND projection, not backend installations.
  const records = plugins;
  const declared = new Map<string | undefined, PluginRecord>();
  for (const entry of records) {
    const id = entry.entryId ?? entry.id;
    declared.set(id, { ...declared.get(id), ...entry });
  }
  const entries = new Map<string, PluginEntry>();
  for (const entry of declared.values()) {
    const entryId = entry.entryId ?? entry.id;
    if (!entryId) continue;
    const module = entry.module ?? entry.name ?? '';
    const observed = installed.get(entryId);
    const realm = observed?.realm ?? entry.realm;
    const operations = (api?.operations ?? []).filter(({ owner }) => owner && (
      entryId === `provider:${owner.sourceId}:${owner.providerId}` ||
      entryId === owner.fiberId || (entry.fiberId !== undefined && String(entry.fiberId) === String(owner.fiberId))
    ));
    const tags = new Set<string>();
    if (kind === 'backend' || kind === 'frontend') tags.add(kind);
    // A View frontend may use Engine's engine realm. Realm alone is not gameplay evidence.
    const required = observed?.requiredServices ?? entry.requiredServices ?? [];
    if (kind === 'game' || kind === 'engine' ||
        (realm === 'engine' && required.some(service => service === 'world' || service === 'gameHost'))) tags.add('game');
    if (entry.assetGuid) tags.add('asset');
    if (operations.length) tags.add('api');
    const commands = operations.map(({ descriptor }) => descriptor?.path ?? descriptor?.id?.split('.'))
      .filter((path): path is string[] => Array.isArray(path) && path.length > 0).map(path => path.join(' '));
    if (commands.length || entry.commandContract) tags.add('cli');
    entries.set(entryId, {
      sourceId, entryId, module,
      label: module && module !== 'unknown' ? module : entry.program || entry.assetGuid || '', kind,
      ...(entry.assetGuid ? { assetGuid: entry.assetGuid } : {}),
      ...(entry.program ? { program: entry.program } : {}),
      realm,
      version: entry.program && entry.program === assembly?.root?.program ? assembly!.root!.codeRevision : '',
      state: observed?.fiberState ?? entry.fiberState ?? (entry.disabled || entry.desiredState === 'disabled' ? 'disabled' : 'unknown'),
      tags: [...tags],
      operations: operations.map(operation => operation.descriptor?.id ?? 'unknown'),
      commands,
    });
  }
  return [...entries.values()];
}

/** Both public clients are supported; methods must keep their transport-bound receiver. */
export function pluginInspector(client: PluginsInspectorClient | undefined) {
  const inspect = typeof client?.inspect === 'function' ? client.inspect : client?.inspectPlugins;
  if (typeof client?.sources !== 'function' || typeof inspect !== 'function') return undefined;
  return { sources: client.sources.bind(client) as () => Promise<InspectorSources>, inspect: inspect.bind(client) as (input: { sourceId: string; generation?: number }) => Promise<InspectorSource> };
}

/** One failed or unavailable source must not masquerade as a complete frontend-only inventory. */
export async function loadPluginSnapshot({ client, hostAssembly, connectionId }: PluginSnapshotOptions = {}) {
  const sources: PluginSnapshotSource[] = [];
  const issues: { sourceId: string; message: string }[] = [];
  const local: PluginSnapshotSource | undefined = hostAssembly ? {
    sourceId: connectionId ? `view-frontend:${connectionId}` : 'view-frontend',
    kind: 'frontend', assembly: hostAssembly.current, actual: hostAssembly.status,
    plugins: (hostAssembly.inspection ?? []).map(item => ({
      entryId: `fiber:${item.uid}`,
      ...(item.uid == null ? {} : { fiberId: String(item.uid) }),
      module: item.name,
      fiberState: item.state,
      ...(item.origin?.guid ? { assetGuid: item.origin.guid } : {}),
      ...(item.origin?.program ? { program: item.origin.program } : {}),
      missingServices: item.missingServices,
    })), local: true,
  } : undefined;
  const inspector = pluginInspector(client);
  if (!inspector) issues.push({ sourceId: 'remote-hosts', message: 'Remote Host inspection unavailable. Only locally observed entries are shown.' });
  else {
    try {
      const listed = await inspector.sources();
      const ownConnection = listed.caller?.connectionId ?? connectionId;
      if (local && ownConnection) local.sourceId = `view-frontend:${ownConnection}`;
      const remote = (listed.sources ?? []).filter(source => !local || !ownConnection ||
        (source.sourceId !== local.sourceId && source.connection?.connectionId !== ownConnection));
      const results = await Promise.allSettled(remote.map(source => inspector.inspect({
        sourceId: source.sourceId, generation: source.generation,
      })));
      const stale = results.flatMap((result, index) =>
        result.status === 'rejected' && workspaceDiagnosticRecord(result.reason).code === 'view-inspector-stale-generation' ? [index] : []);
      if (stale.length) {
        try {
          const refreshed = await inspector.sources();
          const current = new Map((refreshed.sources ?? []).map(source => [source.sourceId, source]));
          await Promise.all(stale.map(async index => {
            try {
              const source = current.get(remote[index].sourceId);
              if (!source) throw new Error('Inspection source disconnected during refresh.');
              remote[index] = source;
              results[index] = { status: 'fulfilled', value: await inspector.inspect({
                sourceId: source.sourceId, generation: source.generation,
              }) };
            } catch (reason) { results[index] = { status: 'rejected', reason }; }
          }));
        } catch (reason) {
          for (const index of stale) results[index] = { status: 'rejected', reason };
        }
      }
      results.forEach((result, index) => {
        const source = remote[index];
        if (result.status === 'fulfilled') sources.push({ ...source, ...result.value });
        else {
          sources.push({ ...source, unavailable: true });
          issues.push({ sourceId: source.sourceId, message: typeof workspaceDiagnosticRecord(result.reason).message === 'string' ? String(workspaceDiagnosticRecord(result.reason).message) : String(result.reason) });
        }
      });
    } catch (cause) {
      issues.push({ sourceId: 'remote-hosts', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  if (local) sources.push(local);
  sources.sort((a, b) => (a.kind === 'backend' ? 0 : 1) - (b.kind === 'backend' ? 0 : 1) || a.sourceId.localeCompare(b.sourceId));
  return { sources, entries: sources.flatMap(entriesFor), issues };
}

/** Entry-only callers require complete inspection; the UI can display partial snapshots. */
export async function loadPluginEntries(options: PluginSnapshotOptions) {
  const snapshot = await loadPluginSnapshot(options);
  if (snapshot.issues.length) throw new Error(snapshot.issues.map(issue => issue.message).join('; '));
  return snapshot.entries;
}

/** Search and Host selection intersect; selected capability tags use AND semantics.
 * Search, source, and capability tags are View presentation filters.
 * @param {{ query?: string, sourceId?: string, tags?: string[] }} options
 */
export function filterPluginEntries(entries: readonly PluginEntry[], { query = '', sourceId = '', tags = [] }: { query?: string; sourceId?: string; tags?: readonly string[] } = {}) {
  const search = query.trim().toLowerCase();
  return entries.filter(entry => (!sourceId || entry.sourceId === sourceId) &&
    tags.every(tag => entry.tags.includes(tag)) &&
    [entry.entryId, entry.module, entry.assetGuid, entry.program, entry.sourceId, entry.kind, entry.realm, entry.state,
      ...entry.tags, ...entry.operations, ...entry.commands].join(' ').toLowerCase().includes(search));
}
