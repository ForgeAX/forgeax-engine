import { useCallback, useEffect, useRef, useState } from 'react';
import { jsonUnchanged } from '@forgeax/view-workspace-core/contract';
import {
  EmptyState,
  IconButton,
  PanelHeader,
  SearchField,
  Status,
  Surface,
  Text,
  Toolbar,
  type StatusTone,
} from '@forgeax/view-components';
import { Box, Package, RefreshCw, SearchX, ShieldCheck } from 'lucide-react';
import { useTranslation } from '../i18n/useTranslation';
import { PLUGINS_ACTIONS } from '../schema.ts';

import { type PluginEntry, type PluginsInspectorClient, type PluginSnapshotOptions, filterPluginEntries, loadPluginSnapshot, PLUGIN_TAGS } from './plugin-entries.ts';
import { PluginFilters, type PluginSource } from './PluginFilters';


function pluginType(entry: PluginEntry) {
  return entry.kind ?? 'unknown';
}

function stateTone(state: string): StatusTone {
  if (state === 'active') return 'success';
  if (state === 'failed' || state === 'error') return 'error';
  if (state === 'pending' || state === 'loading' || state === 'unloading') return 'warning';
  return 'info';
}

export function PluginsPanel(props: PluginSnapshotOptions & { workspaceClient?: PluginsInspectorClient }) {
  const { t } = useTranslation();
  const inspector = props.client ?? props.workspaceClient;
  const [entries, setEntries] = useState<PluginEntry[]>([]);
  const [sources, setSources] = useState<PluginSource[]>([]);
  const [issues, setIssues] = useState<{ sourceId: string; message: string }[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

  const request = useRef(0);
  const refresh = useCallback(async () => {
    const revision = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const snapshot = await loadPluginSnapshot({ client: inspector, hostAssembly: props.hostAssembly, connectionId: props.connectionId });
      if (revision !== request.current) return;
      setEntries((current) => jsonUnchanged(current, snapshot.entries) ? current : snapshot.entries);
      setSources((current) => jsonUnchanged(current, snapshot.sources) ? current : snapshot.sources);
      setIssues((current) => jsonUnchanged(current, snapshot.issues) ? current : snapshot.issues);
    } catch (cause) {
      if (revision !== request.current) return;
      setEntries([]);
      setSources([]);
      setIssues([]);
      setError(cause instanceof Error ? cause.message : t('plugins.loadErrorTitle'));
    } finally {
      if (revision === request.current) setLoading(false);
    }
  }, [inspector, props.hostAssembly, props.connectionId, t]);

  useEffect(() => {
    void refresh();
    return () => { request.current += 1; };
  }, [refresh]);

  const filtered: PluginEntry[] = filterPluginEntries(entries, { query, sourceId, tags });
  const candidates: PluginEntry[] = filterPluginEntries(entries, { query, sourceId });
  const counts: Record<string, number> = Object.fromEntries(PLUGIN_TAGS.map((tag: string) => [tag, candidates.filter(entry => entry.tags.includes(tag)).length]));
  for (const source of sources) counts[`host:${source.sourceId}`] = entries.filter(entry => entry.sourceId === source.sourceId).length;
  const reset = () => { setQuery(''); setSourceId(''); setTags([]); };

  const hostTone: StatusTone = error ? 'error' : loading || issues.length ? 'warning' : 'info';
  const hostLabel = error
    ? t('plugins.loadErrorTitle')
    : loading
      ? t('plugins.loading')
      : issues.length ? t('plugins.partial') : t('plugins.observed');

  return (
    <Surface className="fx-plugins fx-ui" tone="sidebar" data-testid="panel-plugins">
      <PanelHeader
        className="fx-plugins-header"
        start={<Text as="h2" variant="heading">{t('plugins.title')}</Text>}
        center={(
          <Toolbar className="fx-plugins-toolbar" aria-label={t('plugins.toolbar')}>
            <SearchField
              data-action={PLUGINS_ACTIONS.search}
              label={t('plugins.filterLabel')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onClear={() => setQuery('')}
              placeholder={t('plugins.filterPlaceholder')}
            />
          </Toolbar>
        )}
        end={(
          <IconButton
            data-action={PLUGINS_ACTIONS.refresh}
            label={t('plugins.refresh')}
            icon={<RefreshCw className="fx-icon" />}
            variant="quiet"
            size="compact"
            disabled={loading}
            onClick={() => void refresh()}
          />
        )}
      />
      <PluginFilters sources={sources} sourceId={sourceId} tags={tags} counts={counts} total={entries.length}
        onSource={setSourceId} onTag={tag => setTags(current => current.includes(tag) ? current.filter(value => value !== tag) : [...current, tag])}
        onReset={reset} />
      <div className="fx-plugins-summary">
        <Text as="span" variant="caption">
          <ShieldCheck className="fx-icon" /> {t('plugins.resultCount', { count: filtered.length, total: entries.length })}
        </Text>
        <Status tone={hostTone}>{hostLabel}</Status>
      </div>
      {issues.length > 0 ? <div className="fx-plugins-notice" role="status" data-testid="plugins-partial">
        {issues.map(issue => <p key={issue.sourceId}>{issue.sourceId}: {issue.message}</p>)}
      </div> : null}
      <div className="fx-plugins-list">
        {!error && sources.filter(source => filtered.some(entry => entry.sourceId === source.sourceId)).map(source => <section
          key={source.sourceId} className="fx-plugin-source" aria-label={source.sourceId}>
          <div className="fx-plugin-source-header"><Text variant="caption">{source.sourceId}</Text>
            <Text variant="caption">{filtered.filter(entry => entry.sourceId === source.sourceId).length}</Text></div>
          {filtered.filter(entry => entry.sourceId === source.sourceId).map((entry) => {
          const entryId = `${entry.sourceId}:${entry.entryId}`;
          const sourceId = entry.sourceId;
          const label = entry.label || t('plugins.unnamed');
          const version = entry.version || '—';
          const selected = selectedEntryId === entryId;
          const type = pluginType(entry);
          return (
            <button
              type="button"
              key={entryId}
              data-action={PLUGINS_ACTIONS.select}
              className={`fx-plugin-row${selected ? ' selected' : ''}`}
              data-plugin-kind={type}
              data-plugin-tags={entry.tags.join(' ')}
              data-source-id={sourceId}
              data-entry-id={entry.entryId}
              data-asset-guid={entry.assetGuid}
              aria-pressed={selected}
              onClick={() => setSelectedEntryId(entryId)}
            >
              <span className="fx-plugin-icon">{sourceId.includes('view-plugin') || sourceId.includes('viewport') ? <Package size={15} /> : <Box size={15} />}</span>
              <span className="fx-plugin-copy">
                <strong title={label}>{label}</strong>
                {entry.program && entry.program !== label ? <small title={entry.program}>{entry.program}</small> : null}
                {entry.assetGuid ? <small title={t('plugins.sourceAssetGuidHelp')}>{t('plugins.sourceAssetGuid')}: {entry.assetGuid}</small> : null}
                {selected && entry.operations.length > 0 ? <small className="fx-plugin-operations">{entry.commands.join(' · ')}</small> : null}
              </span>
              <span className="fx-plugin-tags">{entry.tags.map(tag => <Status key={tag} className="fx-plugin-type" tone="info" pill icon={null}>{t(`plugins.tag.${tag}`)}</Status>)}</span>
              <span className="fx-plugin-version">{version}</span>
              <Status className="fx-plugin-state" tone={stateTone(entry.state)} pill>
                {entry.state}
              </Status>
            </button>
          );
        })}</section>)}
        {!error && !loading && filtered.length === 0 ? (
          <EmptyState
            icon={<SearchX className="fx-plugins-empty-icon" />}
            title={entries.length === 0 ? t('plugins.empty') : t('plugins.emptyTitle')}
            description={tags.includes('game') && !entries.some(entry => entry.tags.includes('game'))
              ? t('plugins.gameUnavailable') : entries.length === 0 ? t('plugins.unavailable') : t('plugins.emptyDescription')}
          />
        ) : null}
        {error ? (
          <EmptyState
            title={t('plugins.loadErrorTitle')}
            description={error}
            action={<IconButton label={t('plugins.retry')} icon={<RefreshCw className="fx-icon" />} onClick={() => void refresh()} />}
          />
        ) : null}
      </div>
    </Surface>
  );
}
