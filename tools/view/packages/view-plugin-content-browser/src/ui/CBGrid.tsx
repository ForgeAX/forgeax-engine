import { ChevronDown } from 'lucide-react';
import { Spinner } from '@forgeax/view-components';
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from '../i18n/useTranslation';
import { CONTENT_BROWSER_ACTIONS } from '../schema.ts';
import { viewItemKey } from './format';
import { itemIcon } from './icons';
import { assetKindLabel } from './derived-view';
import type { CBFile, CBViewItem, CBViewMode } from './types';
import type { WorkspaceThumbnail } from '@forgeax/view-workspace-core/contract';

export function CBGrid({
  items,
  thumbnailSize,
  layout,
  searchActive,
  expandedPacks,
  selectedIds,
  openingKeys,
  thumbnails,
  onVisibleAssets,
  onSelect,
  onActivate,
  onContextMenu,
  onTogglePackExpansion,
  onBlankClick,
}: {
  items: CBViewItem[];
  thumbnailSize: number;
  layout: Exclude<CBViewMode, 'column'>;
  searchActive: boolean;
  expandedPacks: ReadonlySet<string>;
  selectedIds: ReadonlySet<string>;
  openingKeys?: ReadonlySet<string>;
  thumbnails: ReadonlyMap<string, WorkspaceThumbnail>;
  onVisibleAssets: (guids: string[]) => void;
  onSelect: (item: CBViewItem, event: MouseEvent) => void;
  onActivate: (item: CBViewItem) => void;
  onContextMenu: (event: MouseEvent, item: CBViewItem) => void;
  onTogglePackExpansion: (path: string) => void;
  onBlankClick: () => void;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [backdrops, setBackdrops] = useState<{ key: string; left: number; top: number; width: number; height: number; radius: string }[]>([]);
  const grouping = !searchActive;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const guid = (entry.target as HTMLElement).dataset.cbAssetGuid;
        if (!guid) continue;
        if (entry.isIntersecting) visible.add(guid);
        else visible.delete(guid);
      }
      onVisibleAssets([...visible].sort());
    }, { root });
    const cards = root.querySelectorAll<HTMLElement>('[data-cb-asset-guid]');
    if (cards.length === 0) onVisibleAssets([]);
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [items, expandedPacks, searchActive, onVisibleAssets]);

  const measureGroups = useCallback(() => {
    const container = rootRef.current;
    if (!container) { setBackdrops((prev) => (prev.length ? [] : prev)); return; }
    const members = container.querySelectorAll<HTMLElement>('[data-cb-group]');
    if (members.length === 0) { setBackdrops((prev) => (prev.length ? [] : prev)); return; }
    const byGroup = new Map<string, HTMLElement[]>();
    members.forEach((el) => {
      const key = el.dataset.cbGroup;
      if (!key) return;
      const list = byGroup.get(key);
      if (list) list.push(el);
      else byGroup.set(key, [el]);
    });
    const pad = layout === 'list' ? 2 : 4;
    const radius = 8;
    // Padding-box right edge (inside any scrollbar). Do not clamp card bounds to
    // this — clamping cuts the backdrop short of the last card once a scrollbar
    // appears. Only the wrapped-row continuation uses it as a full-width edge.
    const containerRight = container.clientWidth;
    const next: typeof backdrops = [];
    for (const [key, els] of byGroup) {
      const rows: { top: number; els: HTMLElement[] }[] = [];
      for (const el of els) {
        const top = el.offsetTop;
        const row = rows.find((entry) => Math.abs(entry.top - top) <= 4);
        if (row) row.els.push(el);
        else rows.push({ top, els: [el] });
      }
      const multiRow = rows.length > 1;
      rows.forEach((row, idx) => {
        let left = Infinity;
        let right = -Infinity;
        let top = Infinity;
        let bottom = -Infinity;
        for (const el of row.els) {
          left = Math.min(left, el.offsetLeft);
          right = Math.max(right, el.offsetLeft + el.offsetWidth);
          top = Math.min(top, el.offsetTop);
          bottom = Math.max(bottom, el.offsetTop + el.offsetHeight);
        }
        const extendLeft = multiRow && idx > 0;
        const extendRight = multiRow && idx < rows.length - 1;
        const x0 = extendLeft ? 0 : left - pad;
        const x1 = extendRight ? containerRight : right + pad;
        next.push({
          key: `${key}#${idx}`,
          left: x0,
          top: top - pad,
          width: x1 - x0,
          height: bottom - top + pad * 2,
          radius: `${extendLeft ? 0 : radius}px ${extendRight ? 0 : radius}px ${extendRight ? 0 : radius}px ${extendLeft ? 0 : radius}px`,
        });
      });
    }
    setBackdrops(next);
  }, [layout]);

  useLayoutEffect(() => {
    measureGroups();
    const container = rootRef.current;
    if (!container) return;
    let raf = 0;
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measureGroups); };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    container.querySelectorAll<HTMLElement>('[data-cb-group]').forEach((el) => observer.observe(el));
    return () => { cancelAnimationFrame(raf); observer.disconnect(); };
  }, [measureGroups, items, expandedPacks, thumbnailSize, searchActive]);

  const renderCard = (item: CBViewItem, expanded = false, groupKey?: string): ReactNode => {
    const key = viewItemKey(item);
    const selected = selectedIds.has(key);
    const opening = openingKeys?.has(key) ?? false;
    const Icon = itemIcon(item);
    const thumbnail = item.type === 'asset' ? thumbnails.get(item.guid) : undefined;
    const isFolder = item.type === 'folder';
    const isFile = item.type === 'file';
    const groupCount = grouping && isFile && (item.isAssetPackage || item.assets.length > 1) ? item.assets.length : 0;
    const stacked = groupCount >= 2;
    const meta = isFolder
      ? null
      : isFile
        ? item.kindLabel
        : assetKindLabel(item.kind, t);
    return (
      <div
        role="button"
        tabIndex={0}
        className={`cb-grid-item cb-fe-card${isFolder ? ' cb-grid-folder' : ''}${isFile ? ' cb-file-card' : ''}${selected ? ' sel' : ''}${expanded ? ' cb-pack-expanded' : ''}${stacked ? ' cb-group-card' : ''}${groupKey ? ' cb-group-member' : ''}${opening ? ' is-busy' : ''}`}
        key={key}
        data-action={CONTENT_BROWSER_ACTIONS.select}
        data-cb-path={item.type === 'file' ? item.path : undefined}
        data-cb-guid={item.type === 'asset' ? item.guid : undefined}
        data-cb-group={groupKey}
        data-cb-asset-guid={item.type === 'asset' ? item.guid : undefined}
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
        <span className={`cb-grid-thumb cb-fe-thumb${isFile ? ' cb-file-thumb' : ''}${isFolder ? ' cb-folder-thumb' : ''}`}>
          {thumbnail?.state === 'ready' && thumbnail.dataUrl ? (
            <img className="cb-asset-thumbnail" src={thumbnail.dataUrl} alt="" />
          ) : (
            <span className={isFolder ? 'cb-folder-icon' : 'cb-grid-icon'}><Icon /></span>
          )}
          {groupCount >= 1 ? (
            <button
              type="button"
              className={`cb-group-badge${expanded ? ' open' : ''}`}
              data-action={CONTENT_BROWSER_ACTIONS.togglePackExpansion}
              title={t('contentBrowser.menu.expandSubAssets')}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(item, event);
                onTogglePackExpansion((item as CBFile).path);
              }}
            >
              <span className="cb-group-badge-num">{groupCount}</span>
              <ChevronDown size={11} />
            </button>
          ) : null}
        </span>
        <span className={`cb-grid-label cb-fe-label${meta ? ' has-kind' : ''}`}>
          <span className="cb-fe-name">{item.name}</span>
          {meta ? <span className="cb-card-meta">{meta}</span> : null}
        </span>
        {opening ? (
          layout === 'list' ? (
            <Spinner className="cb-item-busy-inline" label={t('contentBrowser.opening')} />
          ) : (
            <span className="cb-item-busy-veil">
              <Spinner label={t('contentBrowser.opening')} />
            </span>
          )
        ) : null}
      </div>
    );
  };

  const nodes: ReactNode[] = [];
  for (let index = 0; index < items.length; ) {
    const item = items[index];
    if (!item) { index += 1; continue; }
    if (grouping && item.type === 'file' && item.assets.length > 0
      && (item.isAssetPackage || item.assets.length > 1) && expandedPacks.has(item.path)) {
      const guids = new Set(item.assets.map((asset) => asset.guid));
      nodes.push(renderCard(item, true, item.path));
      let nextIndex = index + 1;
      for (; nextIndex < items.length; nextIndex += 1) {
        const next = items[nextIndex];
        if (!next || next.type !== 'asset' || !guids.has(next.guid)) break;
        nodes.push(renderCard(next, false, item.path));
      }
      index = nextIndex;
      continue;
    }
    nodes.push(renderCard(item));
    index += 1;
  }

  return (
    <div
      ref={rootRef}
      className={`cb-grid-view cb-fe-grid cb-layout-${layout}`}
      style={{ '--cb-thumb': `${thumbnailSize}px` } as CSSProperties}
      onClick={(event) => { if (event.target === event.currentTarget) onBlankClick(); }}
    >
      {backdrops.length > 0 ? (
        <div className="cb-group-backdrops" aria-hidden="true">
          {backdrops.map((backdrop) => (
            <div key={backdrop.key} className="cb-group-backdrop" style={{ left: backdrop.left, top: backdrop.top, width: backdrop.width, height: backdrop.height, borderRadius: backdrop.radius }} />
          ))}
        </div>
      ) : null}
      {nodes}
    </div>
  );
}
