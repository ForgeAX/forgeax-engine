import { type CSSProperties, type MouseEvent } from 'react';
import { Spinner } from '@forgeax/view-components';
import { useTranslation } from '../i18n/useTranslation';
import { CONTENT_BROWSER_ACTIONS } from '../schema.ts';
import { formatBytes, formatDate, viewItemKey } from './format';
import { itemIcon } from './icons';
import { assetKindLabel, fileKindLabel } from './derived-view';
import type { CBSortKey, CBSortState, CBViewItem } from './types';

const COLUMNS: readonly { key: CBSortKey; labelKey: string; track: string }[] = [
  { key: 'name', labelKey: 'contentBrowser.details.colName', track: 'minmax(160px, 1fr)' },
  { key: 'kind', labelKey: 'contentBrowser.details.colType', track: '160px' },
  { key: 'estimatedSize', labelKey: 'contentBrowser.details.colSize', track: '90px' },
  { key: 'packModifiedAt', labelKey: 'contentBrowser.details.colModified', track: '130px' },
];

export function CBDetailsList({
  items,
  selectedIds,
  openingKeys,
  sortState,
  onSort,
  onSelect,
  onActivate,
  onContextMenu,
  onBlankClick,
}: {
  items: CBViewItem[];
  selectedIds: ReadonlySet<string>;
  openingKeys?: ReadonlySet<string>;
  sortState: CBSortState;
  onSort: (key: CBSortKey) => void;
  onSelect: (item: CBViewItem, event: MouseEvent) => void;
  onActivate: (item: CBViewItem) => void;
  onContextMenu: (event: MouseEvent, item: CBViewItem) => void;
  onBlankClick: () => void;
}) {
  const { t } = useTranslation();
  const gridStyle = { '--cb-details-cols': COLUMNS.map((column) => column.track).join(' ') } as CSSProperties;

  return (
    <div
      className="cb-details-view cb-details-column"
      role="grid"
      style={gridStyle}
      onClick={(event) => { if (event.target === event.currentTarget) onBlankClick(); }}
    >
      <div className="cb-details-header" role="row">
        {COLUMNS.map((column) => {
          const active = sortState.key === column.key;
          return (
            <button
              key={column.key}
              type="button"
              role="columnheader"
              className={`cb-details-cell cb-details-th${active ? ' active' : ''}`}
              data-active={active ? 'true' : 'false'}
              aria-sort={active ? (sortState.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              onClick={() => onSort(column.key)}
            >
              <span>{t(column.labelKey)}</span>
              {active ? <span className="cb-details-sort-arrow" aria-hidden="true">{sortState.dir === 'asc' ? '\u25b2' : '\u25bc'}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="cb-details-body">
        {items.map((item) => {
          const key = viewItemKey(item);
          const selected = selectedIds.has(key);
          const opening = openingKeys?.has(key) ?? false;
          const Icon = itemIcon(item);
          const typeLabel = item.type === 'folder'
            ? t('contentBrowser.details.typeFolder')
            : item.type === 'file'
              ? item.kindLabel || fileKindLabel(item, t)
              : assetKindLabel(item.kind, t);
          const sizeLabel = item.type === 'folder'
            ? t('contentBrowser.details.itemCount', { count: item.childCount })
            : formatBytes(item.type === 'file' ? item.estimatedSize : item.estimatedSize);
          const modifiedLabel = item.type === 'folder' ? '' : formatDate(item.packModifiedAt);
          return (
            <div
              role="row"
              tabIndex={0}
              className={`cb-details-row${selected ? ' sel' : ''}${opening ? ' is-busy' : ''}`}
              key={key}
              data-action={CONTENT_BROWSER_ACTIONS.select}
              data-cb-path={item.type === 'file' ? item.path : undefined}
              aria-selected={selected}
              aria-busy={opening || undefined}
              onClick={(event) => onSelect(item, event)}
              onDoubleClick={() => onActivate(item)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onActivate(item);
                } else if (event.key === ' ') {
                  event.preventDefault();
                  onSelect(item, event as unknown as MouseEvent);
                }
              }}
              onContextMenu={(event) => onContextMenu(event, item)}
            >
              <div className="cb-details-cell cb-details-name" role="gridcell">
                <span className={`cb-details-icon${item.type === 'folder' ? ' cb-folder-icon' : ''}`}><Icon size={16} /></span>
                <span className="cb-details-label">{item.name}</span>
                {opening ? <Spinner className="cb-item-busy-inline" label={t('contentBrowser.opening')} /> : null}
              </div>
              <div className="cb-details-cell cb-details-type" role="gridcell">{typeLabel}</div>
              <div className="cb-details-cell cb-details-size" role="gridcell">{sizeLabel}</div>
              <div className="cb-details-cell cb-details-modified" role="gridcell">{modifiedLabel}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
