import { useClipboardAction, usePanelVisible } from '@forgeax/view-components';
import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import {
  Box,
  Braces,
  Camera,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  Crosshair,
  Filter,
  Folder,
  Layers,
  Lightbulb,
  Maximize2,
  Minimize2,
  Settings,
  X,
} from 'lucide-react';
import {
  Checkbox,
  EmptyState,
  useOverlayRoot,
  FloatingMenu,
  IconButton,
  PanelHeader,
  SearchField,
  Toolbar,
  useWorkspaceClientConnected,
  type AnchorRect,
} from '@forgeax/view-components';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { useTranslation } from '../i18n/useTranslation';
import { SCENE_TREE_ACTIONS } from '../schema.ts';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { VIEW_WORKSPACE_TAB_ID, jsonUnchanged } from '@forgeax/view-workspace-core/contract';
import { createWorkspaceObservation, createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import {
  entityMatchesSceneTreeFilters,
  hierarchyTypeCategory,
} from '../hierarchy-filters.ts';
import {
  HIERARCHY_SCENE_FOLDER_ID,
  isSceneRootRow,
  sceneTreeComponentFilters,
  normalizeSceneTreeRows,
  type HierarchyRow,
} from '../hierarchy.ts';

type SceneTreeFilterOption = {
  id: string;
  label?: string;
  count?: number;
};

type SceneSelectionClient = Pick<
  ViewWorkspaceClient,
  'subscribe' | 'getState' | 'selectSceneEntity' | 'clearSceneSelection' | 'getSceneTree' | 'call' | 'onDisconnect' | 'transport'
>;

type WorkspacePreviewSnapshot = WorkspaceState;

type MenuItem =
  | { kind: 'title'; label: string; icon?: ReactNode }
  | { kind: 'separator' }
  | {
      kind: 'item';
      id: string;
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      forge?: boolean;
      children?: MenuItem[];
      action?: () => void;
    };
type MenuState = { x: number; y: number; items: MenuItem[] } | null;

function rowComponentNames(row: HierarchyRow) {
  if (Array.isArray(row.componentNames) && row.componentNames.length > 0) {
    return row.componentNames;
  }
  return row.typeKey ? [String(row.typeKey)] : [];
}

function rowType(row: HierarchyRow) {
  if (isSceneRootRow(row)) return 'scene';
  if (row.kind === 'folder') return 'group';
  const primary = rowComponentNames(row).find((name) => name !== 'Transform') ?? row.typeKey;
  if (!primary) return 'mesh';
  return hierarchyTypeCategory(String(primary));
}

function filterOptionIcon(id: string) {
  switch (hierarchyTypeCategory(id)) {
    case 'camera': return <Camera size={14} />;
    case 'light': return <Lightbulb size={14} />;
    case 'character': return <CircleUserRound size={14} />;
    case 'group': return <Layers size={14} />;
    default: return <Box size={14} />;
  }
}

function RowIcon({ row }: { row: HierarchyRow }) {
  if (isSceneRootRow(row)) return <Folder size={15} />;
  if (row.kind === 'folder') return <Layers size={15} />;
  if (['directionalLight', 'pointLight', 'spotLight', 'areaLight', 'skylight'].includes(row.typeKey ?? '')) return <Lightbulb size={15} />;
  if (row.typeKey === 'camera') return <Camera size={15} />;
  if (row.typeKey === 'sceneInstance' || row.typeKey === 'instancedMesh') return <Layers size={15} />;
  if (row.name === 'Player') return <CircleUserRound size={15} />;
  return <Box size={15} />;
}

function HierarchyContextMenu({ state, close }: { state: Exclude<MenuState, null>; close: () => void }) {
  const overlayRoot = useOverlayRoot();
  const [submenu, setSubmenu] = useState<string | null>(null);
  useEffect(() => {
    const dismiss = () => close();
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && close();
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', escape);
    };
  }, [close]);
  const renderItems = (items: MenuItem[], nested = false) => (
    <div className={nested ? 'hier-context-submenu' : 'hier-context-menu'}>
      {items.map((item, index) => {
        if (item.kind === 'separator') return <i className="hier-context-separator" key={`sep-${index}`} />;
        if (item.kind === 'title') return <div className="hier-context-title" key={`title-${index}`}>{item.icon}{item.label}</div>;
        return (
          <div className="hier-context-item-wrap" key={item.id} onPointerEnter={() => item.children && setSubmenu(item.id)}>
            <button
              type="button"
              role="menuitem"
              data-operation={item.id}
              data-danger={item.danger || undefined}
              data-forge={item.forge || undefined}
              disabled={item.disabled}
              onClick={() => {
                if (item.children) {
                  setSubmenu(submenu === item.id ? null : item.id);
                  return;
                }
                item.action?.();
                close();
              }}
            >
              <span className="hier-context-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
              {item.children ? <ChevronRight size={12} /> : null}
            </button>
            {item.children && submenu === item.id ? renderItems(item.children, true) : null}
          </div>
        );
      })}
    </div>
  );
  return createPortal(
    <div
      className="hier-context-position"
      data-action={SCENE_TREE_ACTIONS.showContextMenu}
      role="menu"
      style={{
        left: Math.max(8, Math.min(state.x, window.innerWidth - 260)),
        top: Math.max(8, Math.min(state.y, window.innerHeight - 420)),
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {renderItems(state.items)}
    </div>,
    overlayRoot ?? document.body,
  );
}

function highlighted(value: string, query: string) {
  const index = value.toLowerCase().indexOf(query.toLowerCase());
  if (!query || index < 0) return value;
  return <>{value.slice(0, index)}<mark className="hl">{value.slice(index, index + query.length)}</mark>{value.slice(index + query.length)}</>;
}

export function SceneTreePanel(props: { client?: SceneSelectionClient }) {
  if (!props.client) {
    return (
      <EmptyState
        title="Scene hierarchy unavailable"
        description="Connect to the View workspace API to load the Engine scene tree."
      />
    );
  }
  return <SceneTreeLivePanel client={props.client} />;
}

function useEngineSceneRows(
  client: SceneSelectionClient,
  workspace: WorkspacePreviewSnapshot | null,
  connected: boolean,
  reader: ReturnType<typeof createWorkspaceStateReader>,
) {
  const visible = usePanelVisible();
  const [projection, setProjection] = useState<{ key: string; rows: HierarchyRow[]; failed: boolean; hasMore: boolean } | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const target = workspace?.preview?.target;
  const projectId = workspace?.project?.id;
  const key = `${target?.targetId}:${target?.generation}`;
  const current = projection?.key === key ? projection : null;
  const rows = current?.rows ?? [];

  useEffect(() => { setPageCount(1); }, [target?.targetId, target?.generation]);

  useEffect(() => {
    if (!visible) return;
    if (!connected || !target?.targetId || !projectId) {
      if (!connected) return;
      setProjection(null);
      return;
    }
    const observation = createWorkspaceObservation(reader, (current: WorkspacePreviewSnapshot | null) =>
      current?.project?.id === projectId &&
      current?.preview?.target?.targetId === target.targetId &&
      current?.preview?.target?.generation === target.generation);
    const { signal } = observation;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (signal.aborted) return;
      let retryDelay = 500;
      try {
        const binding = {
          tabId: VIEW_WORKSPACE_TAB_ID, projectId, targetId: target.targetId,
          targetGeneration: target.generation, signal,
        };
        const result = await client.getSceneTree({ ...binding, limit: 1000 });
        if (signal.aborted) return;
        const nodes = [...(result.nodes ?? [])];
        let nextOffset = result.nextOffset;
        for (let page = 1; page < pageCount && nextOffset !== null && nextOffset !== undefined; page++) {
          const next = await client.getSceneTree({ ...binding, offset: nextOffset, revision: String(result.revision), limit: 1000 });
          if (signal.aborted) return;
          nodes.push(...next.nodes);
          nextOffset = next.nextOffset;
        }
        if (signal.aborted) return;
        setProjection((current) => {
          const next = { key, rows: normalizeSceneTreeRows({ ...result, nodes }), hasMore: nextOffset !== null && nextOffset !== undefined, failed: false };
          if (
            current?.key === next.key &&
            current.failed === next.failed &&
            current.hasMore === next.hasMore &&
            jsonUnchanged(current.rows, next.rows)
          ) return current;
          return next;
        });
      } catch {
        if (signal.aborted) return;
        setProjection((current) => {
          if (current?.key === key && current.failed && !current.hasMore && current.rows.length === 0) return current;
          return { key, rows: [], hasMore: false, failed: true };
        });
        retryDelay = 1500;
      }
      if (!signal.aborted) {
        timer = setTimeout(refresh, retryDelay);
      }
    };
    void refresh();
    return () => { observation.dispose(); clearTimeout(timer); };
    // Include the published snapshot: React may batch A -> B -> A into one
    // render after the observation for A has already been revoked.
  }, [client, connected, projectId, target?.targetId, target?.generation, pageCount, key, reader, visible]);

  return { rows, filterOptions: sceneTreeComponentFilters(rows), failed: current?.failed ?? false, hasMore: current?.hasMore ?? false, loadMore: () => setPageCount(value => value + 1) };
}

function SceneTreeLivePanel({ client }: { client: SceneSelectionClient }) {
  const { t } = useTranslation();
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  const workspace = useSyncExternalStore(
    reader.subscribe,
    () => reader.getSnapshot() as WorkspacePreviewSnapshot | null,
    () => reader.getSnapshot() as WorkspacePreviewSnapshot | null,
  );
  const connected = useWorkspaceClientConnected(client);
  const { rows, filterOptions, failed, hasMore, loadMore } = useEngineSceneRows(client, workspace, connected, reader);

  if (!workspace?.preview?.target?.targetId) {
    return (
      <EmptyState
        title={t('sceneTree.unavailable')}
        description="Open a scene preview from the Content Browser to load the Engine hierarchy."
      />
    );
  }
  if (failed) {
    return (
      <EmptyState
        title={t('sceneTree.unavailable')}
        description={t('sceneTree.loadErrorDescription')}
      />
    );
  }
  if (rows.length === 0) return <EmptyState title="Loading hierarchy" description="Reading the selected Engine target." />;
  return <>
    {hasMore && <button type="button" onClick={loadMore}>Showing {Math.max(0, rows.length - 1)} entities. Load more</button>}
    <SceneTreeRowsPanel key={`${workspace.preview?.target?.targetId}:${workspace.preview?.target?.generation}`}
      client={client} rows={rows} filterOptions={filterOptions} />
  </>;
}

function SceneTreeRowsPanel({
  client,
  rows,
  filterOptions,
}: {
  client: SceneSelectionClient;
  rows: HierarchyRow[];
  filterOptions: SceneTreeFilterOption[];
}) {
  const writeClipboard = useClipboardAction();
  const { t } = useTranslation();
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  const workspace = useSyncExternalStore(
    reader.subscribe,
    () => reader.getSnapshot() as (WorkspacePreviewSnapshot & { sceneSelection?: { primary?: { entityId: string } | null } | null }) | null,
    () => reader.getSnapshot() as (WorkspacePreviewSnapshot & { sceneSelection?: { primary?: { entityId: string } | null } | null }) | null,
  );
  const externalEntityId = workspace?.sceneSelection?.primary?.entityId ?? null;
  const externalSelectionKey = JSON.stringify(workspace?.sceneSelection?.entityIds ?? []);
  const sceneIdentity = workspace?.preview?.asset?.guid ?? workspace?.preview?.target?.targetId ?? null;
  const rowLabel = useCallback(
    (row: HierarchyRow) => (isSceneRootRow(row) ? t('sceneTree.sceneRoot') : row.name),
    [t],
  );
  const typeLabelFor = useCallback(
    (row: HierarchyRow) => {
      if (row.kind === 'folder') return t('sceneTree.types.folder');
      if (row.typeKey) {
        const key = `sceneTree.types.${row.typeKey}`;
        const label = t(key);
        return label === key ? t('sceneTree.types.entity') : label;
      }
      return '';
    },
    [t],
  );
  const componentTypeLabel = useCallback((id: string) => {
    const key = `sceneTree.types.${id}`;
    const label = t(key);
    return label === key ? id : label;
  }, [t]);
  const resolvedFilterOptions = useMemo(
    () => filterOptions.map((option) => ({
      ...option,
      label: option.label ?? componentTypeLabel(option.id),
    })),
    [componentTypeLabel, filterOptions],
  );
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(new Set<string>());
  const [expanded, setExpanded] = useState(() => new Set(
    rows.filter((row) => row.expanded || isSceneRootRow(row)).map((row) => row.id),
  ));
  const [columns, setColumns] = useState({ type: true, id: false });
  const [headerMenu, setHeaderMenu] = useState<'filter' | 'settings' | null>(null);
  const [headerMenuAnchor, setHeaderMenuAnchor] = useState<AnchorRect | null>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const [contextMenu, setContextMenu] = useState<MenuState>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [anchor, setAnchor] = useState<string | null>(null);

  useEffect(() => {
    setExpanded((current) => {
      if (current.has(HIERARCHY_SCENE_FOLDER_ID)) return current;
      const next = new Set(current);
      next.add(HIERARCHY_SCENE_FOLDER_ID);
      return next;
    });
  }, [sceneIdentity]);

  useEffect(() => {
    if (externalEntityId && rows.some((row) => row.id === externalEntityId)) {
      const entityIds: string[] = JSON.parse(externalSelectionKey);
      setSelected(new Set(entityIds.length > 0 ? entityIds.filter(id => rows.some(row => row.id === id)) : [externalEntityId]));
      setAnchor(externalEntityId);
    } else if (!externalEntityId) {
      setSelected(new Set());
      setAnchor(null);
    }
  }, [externalEntityId, externalSelectionKey, rows]);

  useEffect(() => {
    const allowed = new Set(resolvedFilterOptions.map((option) => option.id));
    setFilters((current) => {
      if (current.size === 0) return current;
      const next = new Set([...current].filter((id) => allowed.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [resolvedFilterOptions]);

  const publishSceneSelection = (row: HierarchyRow, entityIds?: readonly string[]) => {
    if (row.kind !== 'entity') return;
    const target = workspace?.preview?.target;
    if (!target?.targetId) return;
    void client.selectSceneEntity(row.id, {
      label: row.name,
      entityIds,
      tabId: VIEW_WORKSPACE_TAB_ID,
      targetId: target.targetId,
      targetGeneration: target.generation,
    }).catch(() => {});
  };

  const clearSceneSelection = () => {
    setSelected(new Set());
    setAnchor(null);
    const target = workspace?.preview?.target;
    if (!target?.targetId) return;
    void client.clearSceneSelection({
      tabId: VIEW_WORKSPACE_TAB_ID,
      targetId: target.targetId,
      targetGeneration: target.generation,
    }).catch(() => {});
  };

  const visibleRows = useMemo(() => {
    const text = query.trim().toLowerCase();
    const filtering = text.length > 0 || filters.size > 0;
    if (filtering) {
      return rows.filter((row) => {
        const names = rowComponentNames(row);
        const typeText = typeLabelFor(row).toLowerCase();
        const componentText = names.join(' ').toLowerCase();
        const textMatch = !text
          || rowLabel(row).toLowerCase().includes(text)
          || typeText.includes(text)
          || componentText.includes(text);
        const typeMatch = entityMatchesSceneTreeFilters(names, filters);
        return !isSceneRootRow(row) && textMatch && typeMatch;
      }).map((row) => ({ ...row, depth: 0 }));
    }
    const collapsedDepths: number[] = [];
    return rows.filter((row) => {
      while (collapsedDepths.length && collapsedDepths.at(-1)! >= row.depth) collapsedDepths.pop();
      const hiddenByParent = collapsedDepths.length > 0;
      if (row.hasChildren && !expanded.has(row.id)) collapsedDepths.push(row.depth);
      return !hiddenByParent;
    });
  }, [expanded, filters, query, rowLabel, rows, typeLabelFor]);

  const selectRow = (row: HierarchyRow, event: MouseEvent) => {
    if (row.kind === 'folder') {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
        return next;
      });
      return;
    }
    const ordered = visibleRows.filter((entry) => entry.kind === 'entity').map((entry) => entry.id);
    let next: Set<string>;
    if (event.shiftKey && anchor) {
      const from = ordered.indexOf(anchor);
      const to = ordered.indexOf(row.id);
      next = from < 0 || to < 0
        ? new Set([row.id])
        : new Set(ordered.slice(Math.min(from, to), Math.max(from, to) + 1));
    } else if (event.ctrlKey || event.metaKey) {
      next = new Set(selected);
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
    } else {
      next = new Set([row.id]);
    }
    if (next.size === 0) {
      clearSceneSelection();
      return;
    }
    const primary = next.has(row.id)
      ? row
      : rows.find((entry) => entry.kind === 'entity' && next.has(entry.id));
    if (!primary) {
      clearSceneSelection();
      return;
    }
    setSelected(next);
    setAnchor(primary.id);
    publishSceneSelection(primary, [...next]);
  };
  const showContext = (event: MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setHeaderMenu(null);
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  };
  const blankMenu = useCallback((): MenuItem[] => [
    { kind: 'title', label: t('sceneTree.readOnlyTitle') },
    { kind: 'item', id: 'clear-filter', label: t('sceneTree.menu.clearSearchAndFilters'), icon: <X size={14} />, disabled: !query && filters.size === 0, action: () => { setQuery(''); setFilters(new Set()); } },
    { kind: 'item', id: 'focus', label: t('sceneTree.menu.focusSelection'), icon: <Crosshair size={14} />, shortcut: 'F', disabled: selected.size === 0, action: () => {} },
  ], [filters.size, query, selected.size, t]);
  const rowMenu = useCallback((row: HierarchyRow): MenuItem[] => [
    { kind: 'title', label: rowLabel(row), icon: <RowIcon row={row} /> },
    { kind: 'item', id: 'copy-json', label: t('sceneTree.menu.copyJson'), icon: <Braces size={14} />, action: () => void writeClipboard(JSON.stringify(row, null, 2)) },
    { kind: 'item', id: 'focus', label: t('sceneTree.menu.focusInViewport'), icon: <Crosshair size={14} />, shortcut: 'F', disabled: !workspace?.preview || isSceneRootRow(row), action: () => { const target = workspace?.preview?.target; if (target) void client?.call('entity.focus', { entityId: row.id, targetId: target.targetId, targetGeneration: target.generation }); } },
  ], [rowLabel, t, client, workspace?.preview]);
  useEffect(() => {
    if (!headerMenu) setHeaderMenuAnchor(null);
  }, [headerMenu]);

  const openHeaderMenu = (kind: 'filter' | 'settings') => {
    if (headerMenu === kind) {
      setHeaderMenu(null);
      return;
    }
    const ref = kind === 'filter' ? filterButtonRef : settingsButtonRef;
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setHeaderMenuAnchor(rect);
    setHeaderMenu(kind);
  };

  const toggleTypeFilter = (filterId: string) => {
    setFilters((current) => {
      const next = new Set(current);
      if (next.has(filterId)) next.delete(filterId);
      else next.add(filterId);
      return next;
    });
  };

  return (
    <div
      className="panel outliner-panel"
      data-testid="panel-hierarchy"
      data-view-readonly="true"
      role="tree"
      tabIndex={0}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault();
          setSelected(new Set(rows.filter((row) => row.kind === 'entity').map((row) => row.id)));
        }
      }}
    >
      <PanelHeader
        className="fx-hier-toolbar"
        data-testid="hier-toolbar"
        start={(
          <Toolbar>
            <IconButton
              ref={filterButtonRef}
              className={filters.size ? 'active' : undefined}
              label={t('sceneTree.filterByType')}
              icon={<Filter size={14} />}
              size="compact"
              onClick={() => openHeaderMenu('filter')}
            />
          </Toolbar>
        )}
        center={(
          <SearchField
            className="fx-hier-search"
            data-testid="hier-search"
            data-action={SCENE_TREE_ACTIONS.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClear={() => setQuery('')}
            placeholder={t('sceneTree.searchPlaceholder')}
            label={t('sceneTree.searchLabel')}
          />
        )}
        end={(
          <Toolbar>
            <IconButton
              ref={settingsButtonRef}
              label={t('sceneTree.displaySettings')}
              icon={<Settings size={14} />}
              size="compact"
              onClick={() => openHeaderMenu('settings')}
            />
          </Toolbar>
        )}
      />
      <div className="ol-colhead" data-testid="hier-colhead">
        <span className="ch-caret" aria-hidden />
        <span className="ch-name sortable">{t('sceneTree.columnName')}</span>
        {columns.type ? <span className="ch-type sortable col-type">{t('sceneTree.columnType')}</span> : null}
        {columns.id ? <span className="ch-id sortable col-id">{t('sceneTree.columnId')}</span> : null}
      </div>
      <div
        className="ol-body"
        data-testid="hier-root-dropzone"
        onClick={(event) => {
          if (event.target === event.currentTarget) clearSceneSelection();
        }}
        onContextMenu={(event) => {
          if (!(event.target as HTMLElement).closest('.tn')) showContext(event, blankMenu());
        }}
      >
        {visibleRows.length === 0 ? (
          <EmptyState
            className="hier-no-match"
            title={t('sceneTree.noMatchTitle')}
            description={t('sceneTree.noMatchDescription')}
          />
        ) : visibleRows.map((row) => {
          const isSelected = selected.has(row.id);
          const isHidden = row.hidden === true;
          const isExpanded = expanded.has(row.id);
          return (
            <div
              key={row.id}
              className={`tn k-${rowType(row)}${isSelected ? ' sel' : ''}${isHidden ? ' dim' : ''}`}
              data-testid={isSceneRootRow(row) ? 'hier-row-scene-folder' : `hier-row-${row.id}`}
              data-action={SCENE_TREE_ACTIONS.select}
              style={{ paddingLeft: `calc(var(--fx-ref-space-8) + ${row.depth} * var(--hier-indent-step, calc(var(--fx-ref-space-12) + var(--fx-ref-space-2))))` }}
              role="treeitem"
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              onClick={(event) => selectRow(row, event)}
              onContextMenu={(event) => {
                if (!selected.has(row.id)) {
                  setSelected(new Set([row.id]));
                  if (row.kind === 'entity') publishSceneSelection(row);
                }
                showContext(event, isSceneRootRow(row) ? blankMenu() : rowMenu(row));
              }}
            >
              <button
                type="button"
                className="caret"
                data-action={SCENE_TREE_ACTIONS.toggleExpanded}
                disabled={!row.hasChildren}
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!row.hasChildren) return;
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(row.id)) next.delete(row.id);
                    else next.add(row.id);
                    return next;
                  });
                }}
              >
                {row.hasChildren ? (isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
              </button>
              <span className="ico"><RowIcon row={row} /></span>
              <span className="name-cell">
                <span className="nm">{highlighted(rowLabel(row), query)}</span>
              </span>
              {columns.type ? <span className="cell type col-type"><span className="kind">{typeLabelFor(row)}</span></span> : null}
              {columns.id ? <span className="cell id col-id">{isSceneRootRow(row) ? '' : `#${row.id}`}</span> : null}
            </div>
          );
        })}
      </div>
      <FloatingMenu
        open={Boolean(headerMenuAnchor && headerMenu === 'filter')}
        anchorRect={headerMenuAnchor}
        onClose={() => setHeaderMenu(null)}
        ignorePointerWithin={[filterButtonRef]}
        className="hier-filter-menu"
        containerProps={{ onPointerDown: (event) => event.stopPropagation() }}
      >
        <div className="hier-filter-menu-body">
          <div className="hier-filter-section">{t('sceneTree.filterByType')}</div>
          {resolvedFilterOptions.map((filter) => {
            const active = filters.has(filter.id);
            return (
              <button
                type="button"
                className="hier-filter-option"
                data-active={active ? 'true' : 'false'}
                key={filter.id}
                onClick={() => toggleTypeFilter(filter.id)}
              >
                <Checkbox
                  checked={active}
                  onChange={() => toggleTypeFilter(filter.id)}
                  tabIndex={-1}
                  hideLabel
                  label={filter.label}
                  className="hier-filter-check"
                />
                <span className="hier-filter-option-icon" aria-hidden>{filterOptionIcon(filter.id)}</span>
                {filter.label}
              </button>
            );
          })}
          <div className="hier-filter-separator" />
          <button
            type="button"
            className="hier-filter-option hier-filter-clear"
            disabled={filters.size === 0}
            onClick={() => setFilters(new Set())}
          >
            {t('sceneTree.clearFilters')}
          </button>
        </div>
      </FloatingMenu>
      <FloatingMenu
        open={Boolean(headerMenuAnchor && headerMenu === 'settings')}
        anchorRect={headerMenuAnchor}
        onClose={() => setHeaderMenu(null)}
        ignorePointerWithin={[settingsButtonRef]}
        className="hier-filter-menu"
        containerProps={{ onPointerDown: (event) => event.stopPropagation() }}
      >
        <div className="hier-filter-menu-body hierarchy-header-menu-settings">
          <div className="hier-filter-section">{t('sceneTree.columns')}</div>
          {(['type', 'id'] as const).map((column) => {
            const label = column === 'type'
              ? t('sceneTree.columnType')
              : t('sceneTree.columnId');
            const checked = columns[column];
            const toggle = () => setColumns((current) => ({ ...current, [column]: !current[column] }));
            return (
              <button
                type="button"
                className="hier-filter-option"
                data-action={SCENE_TREE_ACTIONS.toggleColumn}
                data-active={checked ? 'true' : 'false'}
                key={column}
                onClick={toggle}
              >
                <Checkbox
                  checked={checked}
                  onChange={toggle}
                  tabIndex={-1}
                  hideLabel
                  label={label}
                  className="hier-filter-check"
                />
                {label}
              </button>
            );
          })}
          <div className="hier-filter-separator" />
          <button
            type="button"
            className="hier-filter-option hier-filter-action"
            data-action={SCENE_TREE_ACTIONS.expandAll}
            onClick={() => setExpanded(new Set(rows.filter((row) => row.hasChildren).map((row) => row.id)))}
          >
            <Maximize2 size={14} className="hier-filter-option-icon" />
            {t('sceneTree.expandAll')}
          </button>
          <button
            type="button"
            className="hier-filter-option hier-filter-action"
            data-action={SCENE_TREE_ACTIONS.collapseAll}
            onClick={() => setExpanded(new Set(rows.filter(isSceneRootRow).map((row) => row.id)))}
          >
            <Minimize2 size={14} className="hier-filter-option-icon" />
            {t('sceneTree.collapseAll')}
          </button>
        </div>
      </FloatingMenu>
      {contextMenu ? <HierarchyContextMenu state={contextMenu} close={() => setContextMenu(null)} /> : null}
    </div>
  );
}
