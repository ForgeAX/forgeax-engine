import { Button, Text } from '@forgeax/view-components';
import { useTranslation } from '../i18n/useTranslation';
import { PLUGIN_TAGS } from './plugin-entries.ts';

export type PluginSource = { sourceId: string; kind: string; local?: boolean; unavailable?: boolean };

export function PluginFilters({ sources, sourceId, tags, counts, total, onSource, onTag, onReset }: {
  sources: PluginSource[];
  sourceId: string;
  tags: string[];
  counts: Record<string, number>;
  total: number;
  onSource: (sourceId: string) => void;
  onTag: (tag: string) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  return <div className="fx-plugins-filters">
    <div className="fx-plugins-filter-row" role="group" aria-label={t('plugins.hosts')}>
      <Text variant="caption" className="fx-plugins-filter-label">{t('plugins.hosts')}</Text>
      <Button size="compact" variant="quiet" className="fx-plugin-filter" aria-pressed={!sourceId}
        data-plugin-host="all" onClick={() => onSource('')}>{t('plugins.allHosts')} <span>{total}</span></Button>
      {sources.map(source => <Button key={source.sourceId} size="compact" variant="quiet"
        className="fx-plugin-filter" aria-pressed={sourceId === source.sourceId} title={source.sourceId}
        data-plugin-host={source.sourceId} onClick={() => onSource(source.sourceId)}>
        {source.local ? t('plugins.thisFrontend') : source.sourceId}
        <span>{counts[`host:${source.sourceId}`] ?? 0}{source.unavailable ? ' !' : ''}</span>
      </Button>)}
    </div>
    <div className="fx-plugins-filter-row" role="group" aria-label={t('plugins.tags')}>
      <Text variant="caption" className="fx-plugins-filter-label">{t('plugins.tags')}</Text>
      {PLUGIN_TAGS.map((tag: string) => <Button key={tag} size="compact" variant="quiet"
        className="fx-plugin-filter" aria-pressed={tags.includes(tag)} title={t(`plugins.tagHelp.${tag}`)}
        data-plugin-tag={tag} onClick={() => onTag(tag)}>{t(`plugins.tag.${tag}`)} <span>{counts[tag] ?? 0}</span></Button>)}
      <Button size="compact" variant="quiet" data-action="plugins.reset" onClick={onReset}>{t('plugins.reset')}</Button>
    </div>
    <Text variant="caption" className="fx-plugins-filter-help">{t('plugins.filterHelp')}</Text>
  </div>;
}
