import { useClipboardAction } from '@forgeax/view-components';
import type { WorkspaceState, WorkspaceThumbnail } from '@forgeax/view-workspace-core/contract';
import type { AssetReferenceService } from '@forgeax/view-workspace-core/asset-references';
import {
  ArrowDownWideNarrow,
  ArrowUpDown,
  ArrowUpNarrowWide,
  CaseSensitive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Filter,
  Folder,
  FolderOpen,
  Grid2X2,
  HardDrive,
  List,
  Settings2,
  Shapes,
  Star,
  StarOff,
  Table2,
} from 'lucide-react';
import {
  Button,
  Checkbox,
  ContextMenu,
  EmptyState,
  FloatingMenu,
  IconButton,
  PanelHeader,
  RangeInput,
  SearchField,
  Switch,
  Toolbar,
  anchorRectFromPoint,
  type AnchorRect,
  type MenuItem as FxMenuItem,
  useWorkspaceClientConnected,
} from '@forgeax/view-components';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { AssetBrowserReveal, ContentBrowserDetailTabs, PageHost } from '@forgeax/view-workspace-core/frontend-contract';
import { VIEW_FILE_GET_SERVICE, VIEW_HTML_FILES_SERVICE, VIEW_PACK_SOURCES_SERVICE, VIEW_PACK_REVEAL_TOPIC, VIEW_PACK_REVEAL_ACK_SERVICE, VIEW_WORKSPACE_TAB_ID, workspaceUiFingerprint } from '@forgeax/view-workspace-core/contract';
import { useTranslation } from '../i18n/useTranslation';
import { CONTENT_BROWSER_ACTIONS } from '../schema.ts';
import { CBDetailsList } from './CBDetailsList';
import { CBGrid } from './CBGrid';
import { CBNavigationBar } from './CBNavigationBar';
import { CBPreviewPanel } from './CBPreviewPanel';
import { RuntimePacksPanel } from './RuntimePacksPanel';
import {
  buildFamilyFilters,
  buildKindFilters,
  deriveViewItems,
  fileKindLabel,
  nextSortState,
  setSortDir,
  toggleFilterId,
} from './derived-view';
import { dirOfPath, normalizePathInput, viewItemKey } from './format';
import { familyIcon, itemIcon, kindIcon } from './icons';
import { assetSourcePath, projectCatalog, visibleCatalogFolders, type CatalogAsset, type PackSourceRow } from './workspace-catalog';
import { ResizeHandle, useLocalSize } from './resize-handle';
import type {
  CBFilterFamily,
  CBSortDir,
  CBSortKey,
  CBSortState,
  CBViewItem,
  CBViewMode,
  PreviewFileInfo,
} from './types';

const EMPTY_HTML_FILES: readonly string[] = [];
const EMPTY_DETAIL_TABS = Object.freeze([]);

type BrowserMenuItem =
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
      action: () => void;
    };
type ContextMenuState = { anchor: AnchorRect; items: BrowserMenuItem[] } | null;

const LAYOUT_OPTIONS: readonly { mode: CBViewMode; icon: ReactNode; labelKey: string }[] = [
  { mode: 'grid', icon: <Grid2X2 size={14} />, labelKey: 'contentBrowser.layoutGrid' },
  { mode: 'list', icon: <List size={14} />, labelKey: 'contentBrowser.layoutList' },
  { mode: 'column', icon: <Table2 size={14} />, labelKey: 'contentBrowser.layoutColumn' },
];
const SORT_KEYS: readonly CBSortKey[] = ['name', 'kind', 'packModifiedAt', 'estimatedSize'];
const SORT_KEY_ICONS: Record<CBSortKey, typeof CaseSensitive> = {
  name: CaseSensitive,
  kind: Shapes,
  packModifiedAt: Clock,
  estimatedSize: HardDrive,
};

function isContextMenuAnchor(element: HTMLElement) {
  return element.classList.contains('cb-grid-item')
    || element.classList.contains('cb-fe-card')
    || element.classList.contains('cb-details-row')
    || element.classList.contains('cb-source-row');
}

function toFxMenuItems(items: BrowserMenuItem[], close?: () => void): FxMenuItem[] {
  return items.map((item) => {
    if (item.kind === 'separator') return { type: 'separator' };
    if (item.kind === 'title') {
      return { type: 'title', label: <span className="cb-menu-title">{item.icon}{item.label}</span> };
    }
    return {
      id: item.id,
      label: item.label,
      icon: item.icon,
      shortcut: item.shortcut,
      disabled: item.disabled,
      danger: item.danger,
      buttonProps: { 'data-operation': item.id },
      onSelect: () => {
        item.action();
        close?.();
      },
    };
  });
}

export function ContentBrowserPanel({
  client,
  pageHost,
  revealPanel,
  dismissUnpinnedEdge,
  addConversationReference,
  registerAssetReveal,
  assetReferences,
  detailTabs,
}: {
  client?: ViewWorkspaceClient;
  pageHost?: PageHost;
  revealPanel?: () => Promise<boolean>;
  dismissUnpinnedEdge?: () => boolean | undefined;
  addConversationReference?: (reference: { title: string; text: string }) => Promise<void>;
  registerAssetReveal?: (handler: (input: AssetBrowserReveal) => Promise<boolean>) => () => void;
  assetReferences?: AssetReferenceService;
  detailTabs?: ContentBrowserDetailTabs;
}) {
  const writeClipboard = useClipboardAction();
  const { t } = useTranslation();
  const detailContributions = useSyncExternalStore(detailTabs?.subscribe ?? (() => () => {}), detailTabs?.getSnapshot ?? (() => EMPTY_DETAIL_TABS), () => EMPTY_DETAIL_TABS);
  const [snapshot, setSnapshot] = useState<WorkspaceState>({});
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionError, setActionError] = useState('');
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [openingKeys, setOpeningKeys] = useState(new Set<string>());
  const [visibleAssetGuids, setVisibleAssetGuids] = useState<string[]>([]);
  const [thumbnailRows, setThumbnailRows] = useState<{ projectId: string; targetKey: string; rows: Map<string, WorkspaceThumbnail> } | null>(null);
  const lastThumbnailRequest = useRef<string | null>(null);
  const [packSources, setPackSources] = useState<readonly PackSourceRow[]>([]);
  const [htmlListing, setHtmlListing] = useState<{ projectId: string; files: readonly string[]; issue: string } | null>(null);
  const project = snapshot.project;
  const projectLabel = project?.name ?? project?.root ?? 'No project';
  const htmlFiles = htmlListing && htmlListing.projectId === project?.id ? htmlListing.files : EMPTY_HTML_FILES;
  const htmlListingIssue = htmlListing && htmlListing.projectId === project?.id ? htmlListing.issue : '';
  const catalog = useMemo(() => projectCatalog({ root: project?.root ?? '', assetRoots: project?.assetRoots ?? EMPTY_HTML_FILES, assets: snapshot.assets ?? [], sources: packSources, htmlFiles }), [project?.root, project?.assetRoots, snapshot.assets, packSources, htmlFiles]);
  const files = catalog.files;
  const folders = catalog.folders;
  const clientRef = useRef(client);
  clientRef.current = client;
  const connected = useWorkspaceClientConnected(client);
  const readPreview = useCallback((path: string, options?: { signal?: AbortSignal }) => {
    const transport = clientRef.current?.transport;
    if (typeof transport?.request !== 'function') return Promise.resolve(null);
    return transport.request(VIEW_FILE_GET_SERVICE, { path }, options) as Promise<PreviewFileInfo | null>;
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!connected || !project || !client) return;
    setLoading(true);
    const [assetsResult, sourceResult, htmlResult] = await Promise.allSettled([
      client.listAssets(project.id, { tabId: VIEW_WORKSPACE_TAB_ID, signal }),
      client.transport?.request?.(VIEW_PACK_SOURCES_SERVICE, { projectId: project.id }, { signal }) as Promise<{ sources?: PackSourceRow[] }> | undefined,
      client.transport?.request?.(VIEW_HTML_FILES_SERVICE, {}, { signal }) as Promise<{ files?: string[]; hasMore?: boolean }> | undefined,
    ]);
    if (signal?.aborted) return;
    if (sourceResult.status === 'fulfilled') setPackSources(sourceResult.value?.sources ?? []);
    setHtmlListing(htmlResult.status === 'fulfilled'
      ? { projectId: project.id, files: htmlResult.value?.files ?? [], issue: htmlResult.value?.hasMore ? t('contentBrowser.htmlListingTruncated') : '' }
      : { projectId: project.id, files: [], issue: t('contentBrowser.htmlListingFailed') });
    setLoadFailed(assetsResult.status === 'rejected' && sourceResult.status === 'rejected');
    setLoading(false);
  }, [client, connected, project?.id, t]);
  useEffect(() => {
    if (!client || !connected) {
      if (!client) setLoadFailed(true);
      return;
    }
    const controller = new AbortController();
    setSnapshot({});
    const accept = (next: typeof snapshot) => {
      if (controller.signal.aborted) return;
      setSnapshot((current) => {
        if ((next.revision ?? 0) < (current.revision ?? 0)) return current;
        if (workspaceUiFingerprint(next) === workspaceUiFingerprint(current)) return current;
        return next;
      });
      setLoadFailed(false);
    };
    const unsubscribe = client.subscribe(accept);
    void client.getState({ signal: controller.signal }).then(accept).catch(() => {
      if (!controller.signal.aborted) setLoadFailed(true);
    });
    return () => { controller.abort(); unsubscribe?.(); };
  }, [client, connected]);
  useEffect(() => {
    // The initial project identity can precede its accepted Engine catalog.
    // Read once for the ready realm rather than retaining that partial listing.
    if (!connected || snapshot.projectPhase === 'starting') return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [connected, refresh, snapshot.projectPhase, snapshot.browserGeneration]);
  const [layout, setLayout] = useState<CBViewMode>('grid');
  const [thumbnailSize, setThumbnailSize] = useState(80);
  const [detailPanelOpen, setDetailPanelOpen] = useState(true);
  const [detailPanelExpanded, setDetailPanelExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [revealFocus, setRevealFocus] = useState<string | null>(null);
  const revealEpoch = useRef(0);
  const cancelReveal = useCallback(() => {
    revealEpoch.current++;
    setRevealFocus(null);
  }, []);
  const [activeFamilies, setActiveFamilies] = useState<Set<CBFilterFamily>>(new Set());
  const [activeKinds, setActiveKinds] = useState<Set<string>>(new Set());
  const [sortState, setSortState] = useState<CBSortState>({ key: 'name', dir: 'asc' });
  const [history, setHistory] = useState(['']);
  const [historyIndex, setHistoryIndex] = useState(0);
  const historyRef = useRef({ history, historyIndex });
  historyRef.current = { history, historyIndex };
  const openEpoch = useRef(0);
  const landedForEpoch = useRef(-1);
  const userMovedEpoch = useRef(-1);
  const [menu, setMenu] = useState<'settings' | 'filter' | 'sort' | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [toolbarMenuAnchor, setToolbarMenuAnchor] = useState<AnchorRect | null>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const sortButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const [groups, setGroups] = useState({ favorites: true, project: true });
  const [favorites, setFavorites] = useState(new Set<string>());
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [expandedPacks, setExpandedPacks] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState(new Set<string>());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const previewItem = [...folders, ...files.flatMap((file) => [file, ...file.assets])]
    .find((item) => viewItemKey(item) === previewKey) ?? null;
  const [srcWidth, setSrcWidth] = useLocalSize('view.cb.sourceWidth', 200, 140, 420);
  const [previewWidth, setPreviewWidth] = useLocalSize('view.cb.previewWidth', 380, 180, 560, 280);
  useEffect(() => {
    openEpoch.current += 1;
    setPackSources([]);
    setHtmlListing(null);
    setHistory(['']);
    setHistoryIndex(0);
    setSelectedIds(new Set());
    setSelectionAnchor(null);
    setPreviewKey(null);
    setExpandedPacks(new Set());
    setFavorites(new Set());
    setQuery('');
    cancelReveal();
  }, [project?.id]);
  useEffect(() => {
    const epoch = openEpoch.current;
    if (landedForEpoch.current === epoch) return;
    if (!project?.id) return;
    if (userMovedEpoch.current === epoch) {
      landedForEpoch.current = epoch;
      return;
    }
    const catalogReady = Array.isArray(snapshot.assets);
    if (!catalogReady) return;
    landedForEpoch.current = epoch;
    const firstRoot = project.assetRoots?.[0];
    if (!firstRoot) return;
    setHistory(['', firstRoot]);
    setHistoryIndex(1);
  }, [project, snapshot.assets]);
  const folder = history[historyIndex] ?? '';
  const familyFilters = useMemo(() => buildFamilyFilters(activeFamilies, t), [activeFamilies, t]);
  const kindFilters = useMemo(() => buildKindFilters(activeKinds, t), [activeKinds, t]);
  const activeFilterCount = activeFamilies.size + activeKinds.size;
  const labeledFiles = useMemo(
    () => files.map((file) => ({ ...file, kindLabel: fileKindLabel(file, t) })),
    [files, t],
  );
  const derived = useMemo(
    () => deriveViewItems({
      folders,
      files: labeledFiles,
      currentPath: folder,
      searchQuery: query,
      activeFamilies,
      activeKinds,
      revealPath: revealFocus,
      sortState,
      expandedPacks,
      withKindLabel: (file) => file,
    }),
    [activeFamilies, activeKinds, expandedPacks, folder, folders, labeledFiles, query, revealFocus, sortState],
  );
  const { viewItems, foldersInPath, searchActive } = derived;
  const assetFacts = useMemo(() => new Map(files.flatMap(file => file.assets.map(asset =>
    [asset.guid, { publicationId: asset.publicationId, lifecycle: asset.lifecycle }] as const))), [files]);
  const onVisibleAssets = useCallback((guids: string[]) => {
    setVisibleAssetGuids(current => current.length === guids.length && current.every((guid, index) => guid === guids[index]) ? current : guids);
  }, []);
  const gridGuids = layout === 'column' ? [] : visibleAssetGuids;
  const detailGuid = detailPanelOpen && detailPanelExpanded && previewItem?.type === 'asset' ? previewItem.guid : null;
  const visibleGuids = [...new Set([...gridGuids, ...(detailGuid ? [detailGuid] : [])])];
  const targetKey = JSON.stringify([snapshot.projectTarget?.targetId, snapshot.projectTarget?.generation, snapshot.browserGeneration, snapshot.catalogEpoch]);
  const requestKey = JSON.stringify([project?.id, targetKey, visibleGuids.map(guid => [guid, assetFacts.get(guid)])]);
  const thumbnailEpoch = snapshot.thumbnailEpoch ?? -1;
  useEffect(() => {
    if (!client || !connected || !project?.id || visibleGuids.length === 0) {
      setThumbnailRows(null);
      lastThumbnailRequest.current = null;
      return;
    }
    const controller = new AbortController();
    const projectId = project.id;
    const requested = new Set(visibleGuids);
    const previous = lastThumbnailRequest.current;
    const visibleChanged = previous !== requestKey;
    const existing = thumbnailRows?.projectId === projectId && thumbnailRows.targetKey === targetKey ? thumbnailRows.rows : new Map<string, WorkspaceThumbnail>();
    const queryGuids = visibleChanged ? visibleGuids : visibleGuids.filter(guid => existing.get(guid)?.state !== 'ready');
    if (!visibleChanged && queryGuids.length === 0) return;
    lastThumbnailRequest.current = requestKey;
    setThumbnailRows(current => ({ projectId, targetKey, rows: new Map(current?.projectId === projectId && current.targetKey === targetKey
      ? [...current.rows].filter(([guid]) => requested.has(guid)) : []) }));
    const batches: string[][] = [];
    for (let index = 0; index < queryGuids.length; index += 32) batches.push(queryGuids.slice(index, index + 32));
    void (async () => {
      for (const guids of batches) {
        try {
          const result = await client.thumbnails(projectId, guids, { signal: controller.signal });
          if (controller.signal.aborted) return;
          const rows = result.thumbnails.filter(row => guids.includes(row.guid) &&
            (assetFacts.get(row.guid)?.publicationId === undefined || row.publicationId === assetFacts.get(row.guid)?.publicationId));
          setThumbnailRows(current => {
            const next = new Map<string, WorkspaceThumbnail>(current?.projectId === projectId && current.targetKey === targetKey
              ? [...current.rows].filter(([guid]) => requested.has(guid)) : []);
            for (const row of rows) next.set(row.guid, row);
            return { projectId, targetKey, rows: next };
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          setThumbnailRows(current => {
            const next = new Map<string, WorkspaceThumbnail>(current?.projectId === projectId && current.targetKey === targetKey
              ? [...current.rows].filter(([guid]) => requested.has(guid)) : []);
            for (const guid of guids) next.set(guid, { guid, state: 'failed', publicationId: assetFacts.get(guid)?.publicationId, error: { code: 'thumbnail-query-failed', expected: 'Thumbnail response', hint: error instanceof Error ? error.message : String(error) } });
            return { projectId, targetKey, rows: next };
          });
        }
      }
    })();
    return () => controller.abort();
  }, [client, connected, requestKey, thumbnailEpoch]);
  const thumbnails = useMemo(() => {
    if (!thumbnailRows || thumbnailRows.projectId !== project?.id || thumbnailRows.targetKey !== targetKey) return new Map<string, WorkspaceThumbnail>();
    return new Map([...thumbnailRows.rows].filter(([guid, row]) =>
      (assetFacts.get(guid)?.publicationId === undefined || row.publicationId === assetFacts.get(guid)?.publicationId)
      && (row.state !== 'ready' || assetFacts.get(guid)?.lifecycle === 'current')));
  }, [thumbnailRows, project?.id, targetKey, assetFacts]);
  const selectedThumbnail = detailGuid ? thumbnails.get(detailGuid) : undefined;

  const revealAsset = useCallback(async ({ projectId, guid, targetId, targetGeneration }: AssetBrowserReveal) => {
    const matchingTarget = (state: WorkspaceState) => state.project?.id === projectId
      && state.preview?.target?.targetId === targetId
      && state.preview?.target?.generation === targetGeneration;
    if (!client || !revealPanel || !matchingTarget(snapshotRef.current) || !guid) return false;
    const file = files.find(entry => entry.assets.some(asset => asset.guid === guid));
    if (!file) return false;
    const epoch = ++revealEpoch.current;
    const current = () => epoch === revealEpoch.current && matchingTarget(snapshotRef.current);
    try {
      await client.selectTab(VIEW_WORKSPACE_TAB_ID);
      if (!current() || !await revealPanel() || !current()) return false;
      const history = historyRef.current;
      const directory = dirOfPath(file.path);
      if (history.history[history.historyIndex] !== directory) {
        const nextHistory = [...history.history.slice(0, history.historyIndex + 1), directory];
        setHistory(nextHistory);
        setHistoryIndex(nextHistory.length - 1);
      }
      setQuery('');
      setActiveFamilies(new Set());
      setActiveKinds(new Set());
      setExpandedPacks(previous => new Set(previous).add(file.path));
      setRevealFocus(file.path);
      setSelectedIds(new Set([guid]));
      setSelectionAnchor(guid);
      setPreviewKey(guid);
      void client.inspectAsset(guid, { projectId, tabId: VIEW_WORKSPACE_TAB_ID, targetId, targetGeneration }).catch(() => {});
      for (let attempt = 0; attempt < 40 && current(); attempt++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const panel = document.querySelector<HTMLElement>('[data-testid="panel-content-browser"]');
        const card = [...(panel?.querySelectorAll<HTMLElement>('[data-cb-guid]') ?? [])]
          .find(element => element.dataset.cbGuid === guid);
        if (card) card.scrollIntoView({ block: 'nearest' });
        await new Promise(resolve => requestAnimationFrame(resolve));
        const panelRect = panel?.getBoundingClientRect();
        const cardRect = card?.getBoundingClientRect();
        if (current() && card?.getAttribute('aria-selected') === 'true'
          && document.documentElement.dataset.forgeaxViewActivePage === 'scene'
          && panelRect && cardRect && panelRect.width > 0 && panelRect.height > 0
          && cardRect.bottom > panelRect.top && cardRect.top < panelRect.bottom
          && cardRect.right > panelRect.left && cardRect.left < panelRect.right) return true;
      }
    } catch { /* A missing page or project is a failed reveal, not a selection change. */ }
    return false;
  }, [client, files, project?.id, revealPanel]);
  useEffect(() => registerAssetReveal?.(revealAsset), [registerAssetReveal, revealAsset]);

  useEffect(() => {
    const transport = client?.transport;
    if (!client || !transport?.subscribe || !transport.request || !project?.id) return;
    const workspaceClient = client;
    let retired = false;
    let activeRequestId: string | undefined;
    const unsubscribe = transport.subscribe<{ requestId: string; projectId: string; sourcePath: string; revision: string; cancelled?: boolean }>(VIEW_PACK_REVEAL_TOPIC, async intent => {
      if (intent.cancelled) {
        if (activeRequestId === intent.requestId) {
          activeRequestId = undefined;
          ++revealEpoch.current;
          setRevealFocus(null);
        }
        return;
      }
      activeRequestId = intent.requestId;
      const epoch = ++revealEpoch.current;
      const current = () => !retired && epoch === revealEpoch.current;
      const acknowledge = async (shown: boolean, reason?: string) => {
        if (retired) return;
        await transport.request(VIEW_PACK_REVEAL_ACK_SERVICE, { requestId: intent.requestId, projectId: intent.projectId,
          sourcePath: intent.sourcePath, revision: intent.revision, shown, reason }).catch(() => {});
      };
      if (intent.projectId !== project.id) { await acknowledge(false, 'project-mismatch'); return; }
      if (!revealPanel) { await acknowledge(false, 'panel-reveal-unavailable'); return; }
      try {
        const inventory = await transport.request<{ projectId: string }, { sources: PackSourceRow[] }>(VIEW_PACK_SOURCES_SERVICE, { projectId: project.id });
        const source = inventory.sources.find(row => row.sourcePath === intent.sourcePath);
        if (!source || !assetSourcePath(project.root, project.assetRoots ?? EMPTY_HTML_FILES, source.sourcePath) || source.revision !== intent.revision) { await acknowledge(false, 'source-revision-changed'); return; }
        if (!current()) { await acknowledge(false, 'user-navigation-cancelled'); return; }
        setPackSources(inventory.sources);
        await workspaceClient.selectTab(VIEW_WORKSPACE_TAB_ID);
        if (!current()) { await acknowledge(false, 'user-navigation-cancelled'); return; }
        if (!await revealPanel() || !current()) { await acknowledge(false, 'panel-reveal-unavailable'); return; }
        const path = source.sourcePath;
        const directory = path.slice(0, path.lastIndexOf('/'));
        setRevealFocus(path);
        const currentHistory = historyRef.current;
        const nextHistory = [...currentHistory.history.slice(0, currentHistory.historyIndex + 1), directory];
        setHistory(nextHistory);
        setHistoryIndex(nextHistory.length - 1);
        setExpandedPacks(current => new Set(current).add(path));
        setSelectedIds(new Set([path]));
        setPreviewKey(path);
        for (let attempt = 0; attempt < 40 && current(); attempt++) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const panel = document.querySelector<HTMLElement>('[data-testid="panel-content-browser"]');
          const card = [...(panel?.querySelectorAll<HTMLElement>('[data-cb-path]') ?? [])].find(element => element.dataset.cbPath === path);
          if (card) card.scrollIntoView({ block: 'nearest' });
          await new Promise(resolve => requestAnimationFrame(resolve));
          const panelRect = panel?.getBoundingClientRect();
          const cardRect = card?.getBoundingClientRect();
          const shown = current() && card?.getAttribute('aria-selected') === 'true' && document.documentElement.dataset.forgeaxViewActivePage === 'scene'
            && !!panelRect && !!cardRect && panelRect.width > 0 && panelRect.height > 0
            && cardRect.width > 0 && cardRect.height > 0
            && cardRect.bottom > panelRect.top && cardRect.top < panelRect.bottom
            && cardRect.right > panelRect.left && cardRect.left < panelRect.right;
          if (shown) { await acknowledge(true); return; }
        }
        await acknowledge(false, current() ? 'pack-card-not-visible' : 'user-navigation-cancelled');
      } catch (error) { await acknowledge(false, `reveal-error:${error instanceof Error ? error.message : String(error)}`.slice(0, 160)); }
    });
    return () => { retired = true; unsubscribe(); };
  }, [client, project?.id, revealPanel]);

  const navigate = (path: string) => {
    cancelReveal();
    userMovedEpoch.current = openEpoch.current;
    const normalized = normalizePathInput(path);
    if (normalized === folder || (normalized !== '' && !folders.some(entry => entry.path === normalized))) return;
    const next = history.slice(0, historyIndex + 1);
    next.push(normalized);
    setHistory(next);
    setHistoryIndex(next.length - 1);
  };

  const selectItem = (item: CBViewItem, event?: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>) => {
    cancelReveal();
    setActionError('');
    const key = viewItemKey(item);
    const toggleOff = Boolean((event?.ctrlKey || event?.metaKey) && selectedIds.has(key));
    setSelectedIds((current) => {
      if (event?.shiftKey && selectionAnchor) {
        const start = viewItems.findIndex((entry) => viewItemKey(entry) === selectionAnchor);
        const end = viewItems.findIndex((entry) => viewItemKey(entry) === key);
        if (start >= 0 && end >= 0) {
          const range = viewItems.slice(Math.min(start, end), Math.max(start, end) + 1).map((entry) => viewItemKey(entry));
          return new Set(event.ctrlKey || event.metaKey ? [...current, ...range] : range);
        }
      }
      if (event?.ctrlKey || event?.metaKey) {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }
      return new Set([key]);
    });
    setSelectionAnchor(key);
    setPreviewKey(viewItemKey(item));
    if (!toggleOff && item.type === 'asset' && client && project) {
      void client.inspectAsset(item.guid, { projectId: project.id, tabId: VIEW_WORKSPACE_TAB_ID }).catch(() => {});
    }
  };

  const assetToOpen = (item: CBViewItem) => item.type === 'asset'
    ? item
    : item.type === 'file' ? item.assets.find(asset => asset.kind === 'scene') ?? item.assets[0] : undefined;
  const canActivate = (item: CBViewItem) => item.type === 'folder'
    || (item.type === 'file' && item.isAssetPackage && !!project)
    || (item.type === 'file' && item.name.toLowerCase().endsWith('.html') && !!project && !!pageHost)
    || (!!client && !!project && !!assetToOpen(item));
  const activateItem = (item: CBViewItem, dismissOnOpen = false) => {
    setActionError('');
    if (item.type === 'folder') {
      navigate(item.path);
      return;
    }
    if (item.type === 'file' && item.name.toLowerCase().endsWith('.html') && project && pageHost) {
      pageHost.openResource({ requestId: crypto.randomUUID(), sequence: Date.now(), file: { path: item.diskPath, extension: '.html', projectId: project.id } });
      if (dismissOnOpen) dismissUnpinnedEdge?.();
      return;
    }
    if (item.type === 'file' && item.isAssetPackage) {
      setPreviewKey(viewItemKey(item));
      if (item.assets.length > 0) setExpandedPacks((current) => new Set(current).add(item.path));
      return;
    }
    if (!client || !project) return;
    const guid = assetToOpen(item)?.guid;
    if (!guid) return;
    const key = viewItemKey(item);
    if (openingKeys.has(key)) return;
    setOpeningKeys((current) => new Set(current).add(key));
    void (assetReferences?.getState().scope ? assetReferences.open(guid) : client.openAsset(guid, { projectId: project.id, tabId: VIEW_WORKSPACE_TAB_ID }))
      .then(() => { if (dismissOnOpen) dismissUnpinnedEdge?.(); })
      .catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        setOpeningKeys((current) => {
          if (!current.has(key)) return current;
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      });
  };

  const toggleFavorite = (path: string) => setFavorites((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  const togglePackExpansion = (path: string) => setExpandedPacks((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  const toggleCollapsed = (path: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  useEffect(() => {
    if (menu !== 'filter' && menu !== 'sort' && menu !== 'settings') setToolbarMenuAnchor(null);
  }, [menu]);

  const showMenu = (event: MouseEvent, items: BrowserMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu(null);
    setToolbarMenuAnchor(null);
    const target = event.currentTarget as HTMLElement;
    const anchor = isContextMenuAnchor(target)
      ? target.getBoundingClientRect()
      : anchorRectFromPoint(event.clientX, event.clientY);
    setContextMenu({ anchor, items });
  };

  const openToolbarMenu = (kind: 'filter' | 'sort' | 'settings') => {
    if (menu === kind) {
      setMenu(null);
      return;
    }
    const ref = kind === 'filter' ? filterButtonRef : kind === 'sort' ? sortButtonRef : settingsButtonRef;
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setToolbarMenuAnchor(rect);
    setMenu(kind);
  };

  const folderMenu = (path: string, name: string): BrowserMenuItem[] => [
    { kind: 'title', label: name, icon: <Folder className="cb-folder-icon" size={14} /> },
    { kind: 'item', id: 'open', label: t('contentBrowser.menu.open'), icon: <FolderOpen size={14} />, action: () => navigate(path) },
    {
      kind: 'item',
      id: 'copy-path',
      label: t('contentBrowser.menu.copyPath'),
      icon: <Copy size={14} />,
      action: () => void writeClipboard(path || projectLabel),
    },
    {
      kind: 'item',
      id: 'favorite',
      label: favorites.has(path) ? t('contentBrowser.menu.removeFromFavorites') : t('contentBrowser.menu.addToFavorites'),
      icon: favorites.has(path) ? <StarOff size={14} /> : <Star size={14} />,
      action: () => toggleFavorite(path),
    },
  ];
  const itemMenu = (item: CBViewItem): BrowserMenuItem[] => {
    const Icon = itemIcon(item);
    if (item.type === 'folder') return folderMenu(item.path, item.name);
    return [
      { kind: 'title', label: item.name, icon: <Icon size={14} /> },
      ...(canActivate(item) ? [{ kind: 'item' as const, id: 'open', label: t('contentBrowser.menu.open'), shortcut: 'Enter', action: () => activateItem(item) }] : []),
      ...(item.type === 'asset' && addConversationReference && project
        ? [{
          kind: 'item' as const,
          id: 'reference-to-conversation',
          label: t('contentBrowser.menu.referenceToConversation'),
          action: () => {
            void addConversationReference({
              title: item.name,
              text: JSON.stringify({ asset: { name: item.name, guid: item.guid, kind: item.kind, packPath: item.packPath }, project: { id: project.id, root: project.root } }, null, 2),
            }).catch(error => setActionError(error instanceof Error ? error.message : String(error)));
          },
        }] : []),
      ...(item.type === 'asset'
        ? [{
          kind: 'item' as const,
          id: 'copy-guid',
          label: t('contentBrowser.menu.copyGuid'),
          icon: <Copy size={14} />,
          action: () => void writeClipboard(item.guid),
        }]
        : []),
      {
        kind: 'item',
        id: 'copy-path',
        label: t('contentBrowser.menu.copyAssetPath'),
        icon: <Copy size={14} />,
        shortcut: 'Ctrl+Shift+C',
        action: () => void writeClipboard(item.type === 'asset' ? item.packPath : item.path),
      },
    ];
  };
  const blankMenu: BrowserMenuItem[] = [
    { kind: 'title', label: t('contentBrowser.readOnlyTitle') },
    {
      kind: 'item',
      id: 'copy-path',
      label: t('contentBrowser.menu.copyCurrentPath'),
      icon: <Copy size={14} />,
      action: () => void writeClipboard(folder || projectLabel),
    },
  ];

  const applyFilter = (filterId: string) => {
    cancelReveal();
    const next = toggleFilterId(filterId, activeFamilies, activeKinds);
    setActiveFamilies(next.families);
    setActiveKinds(next.kinds);
  };

  const renderTreeRow = (path: string, name: string, depth: number, favorite = false) => {
    const hasChildren = folders.some((entry) => entry.path.startsWith(`${path}/`));
    const open = !collapsed.has(path);
    const folderItem = folders.find((entry) => entry.path === path);
    const selected = folder === path;
    const inPath = folder.startsWith(`${path}/`);
    const row = (
      <button
        type="button"
        className={`cb-source-row${selected ? ' is-sel' : inPath ? ' is-path' : ''}${hasChildren && !open ? ' collapsed' : ''}`}
        style={{ paddingLeft: `calc(var(--fx-ref-space-16) + ${depth} * (var(--fx-ref-space-12) + var(--fx-ref-space-2)))` } as CSSProperties}
        onClick={() => {
          navigate(path);
          if (folderItem) {
            setPreviewKey(viewItemKey(folderItem));
            setSelectedIds(new Set([path]));
            setSelectionAnchor(path);
          }
        }}
        onDoubleClick={() => hasChildren && toggleCollapsed(path)}
        onContextMenu={(event) => showMenu(event, folderMenu(path, name))}
      >
        <span
          className={`cb-source-chev${hasChildren ? '' : ' hidden'}${open ? '' : ' collapsed'}`}
          onClick={(event) => {
            if (!hasChildren) return;
            event.stopPropagation();
            toggleCollapsed(path);
          }}
        >
          <ChevronDown size={12} />
        </span>
        <span className="cb-source-icon">{open ? <FolderOpen size={15} /> : <Folder size={15} />}</span>
        <span className="cb-source-name">{name}</span>
      </button>
    );
    if (!favorite) return <div key={`tree-${path}`}>{row}</div>;
    return (
      <div
        className={`cb-source-fav-row${selected ? ' is-sel' : inPath ? ' is-path' : ''}`}
        key={`fav-${path}`}
      >
        {row}
        <button
          type="button"
          className="cb-source-unfav"
          data-action={CONTENT_BROWSER_ACTIONS.toggleFavorite}
          title={t('contentBrowser.unfavorite')}
          aria-label={t('contentBrowser.unfavorite')}
          onClick={(event) => {
            event.stopPropagation();
            toggleFavorite(path);
          }}
        >
          <Star size={11} fill="currentColor" />
        </button>
      </div>
    );
  };

  const filterLabel = activeFilterCount === 0
    ? t('contentBrowser.filterAll')
    : activeFilterCount === 1
      ? (familyFilters.find((item) => item.active) ?? kindFilters.find((item) => item.active))!.label
      : t('contentBrowser.filterByType');
  const sortLabels: Record<CBSortKey, string> = {
    name: t('contentBrowser.sort.name'),
    kind: t('contentBrowser.sort.kind'),
    packModifiedAt: t('contentBrowser.sort.modified'),
    estimatedSize: t('contentBrowser.sort.size'),
  };

  return (
    <div className="cb-root" data-testid="panel-content-browser">
      {client && project && runtimeOpen ? <RuntimePacksPanel client={client} /> : null}
      <div
        className="cb-split"
        ref={splitRef}
        style={{ '--cb-src-w': `${srcWidth}px`, '--cb-preview-w': `${previewWidth}px` } as CSSProperties}
      >
        <aside className="cb-source-panel">
          <div className="cb-source-tree">
            <section className="cb-source-group">
              <button type="button" data-action={CONTENT_BROWSER_ACTIONS.toggleSourceGroup} className={`cb-source-group-head${groups.favorites ? '' : ' collapsed'}`} onClick={() => setGroups((current) => ({ ...current, favorites: !current.favorites }))}>
                <span className="cb-source-chev"><ChevronDown size={12} /></span><Star className="cb-source-group-icon" size={15} /><span className="cb-source-group-name">{t('contentBrowser.favorites')}</span>
              </button>
              {groups.favorites ? (
                <div className="cb-source-group-body">
                  {favorites.size ? [...favorites].map((path) => renderTreeRow(path, path.split('/').at(-1) ?? path, 0, true)) : <div className="cb-source-empty">{t('contentBrowser.noFavorites')}</div>}
                </div>
              ) : null}
            </section>
            <section className="cb-source-group">
              <button type="button" data-action={CONTENT_BROWSER_ACTIONS.toggleSourceGroup} className={`cb-source-group-head${folder === '' ? ' is-sel' : ''}${groups.project ? '' : ' collapsed'}`} aria-expanded={groups.project} onClick={() => navigate('')} onDoubleClick={() => setGroups((current) => ({ ...current, project: !current.project }))} onContextMenu={(event) => showMenu(event, folderMenu('', projectLabel))}>
                <span className="cb-source-chev" onClick={(event) => { event.stopPropagation(); setGroups((current) => ({ ...current, project: !current.project })); }}><ChevronDown size={12} /></span><FolderOpen className="cb-source-group-icon cb-folder-icon" size={15} /><span className="cb-source-group-name">{projectLabel}</span>
              </button>
              {groups.project ? (
                <div className="cb-source-group-body">
                  {visibleCatalogFolders(folders, collapsed).map((entry) => renderTreeRow(entry.path, entry.name, entry.path.split('/').length - 1))}
                </div>
              ) : null}
            </section>
          </div>
        </aside>
        <ResizeHandle
          title={t('contentBrowser.actions.resizeFolderTree')}
          onDrag={(delta) => {
            const next = srcWidth + delta;
            setSrcWidth(next);
            splitRef.current?.style.setProperty('--cb-src-w', `${Math.min(420, Math.max(140, next))}px`);
          }}
        />
        <section className="cb-asset-view">
          <PanelHeader
            className="cb-toolbar"
            center={
              <CBNavigationBar
                currentPath={folder}
                projectLabel={projectLabel}
                allDirs={folders.map((entry) => entry.path)}
                canGoBack={historyIndex > 0}
                canGoForward={historyIndex < history.length - 1}
                refreshDisabled={!project || loading}
                onBack={() => { cancelReveal(); setHistoryIndex((index) => Math.max(0, index - 1)); }}
                onForward={() => { cancelReveal(); setHistoryIndex((index) => Math.min(history.length - 1, index + 1)); }}
                onRefresh={() => void refresh()}
                onNavigate={navigate}
              />
            }
            end={<IconButton ref={settingsButtonRef} size="compact" variant="quiet" label={t('contentBrowser.settings')} icon={<Settings2 size={14} />} onClick={() => openToolbarMenu('settings')} />}
          />

          <div className="cb-content-body">
            <div className="cb-grid-column">
              <Toolbar className="cb-filter-bar">
                <Button size="compact" variant="quiet" data-action={CONTENT_BROWSER_ACTIONS.activate}
                  disabled={selectedIds.size !== 1 || !previewItem || !canActivate(previewItem)}
                  loading={Boolean(previewItem && openingKeys.has(viewItemKey(previewItem)))}
                  title={t('contentBrowser.openHint')}
                  onClick={() => { if (previewItem) activateItem(previewItem); }}>{t('contentBrowser.menu.open')}</Button>
                <Button ref={filterButtonRef} size="compact" variant="quiet" data-action={CONTENT_BROWSER_ACTIONS.setFilter} className={activeFilterCount ? 'is-active' : undefined} leadingIcon={<Filter size={14} />} title={t('contentBrowser.filterByType')} aria-label={filterLabel} onClick={() => openToolbarMenu('filter')}>{filterLabel}</Button>
                <SearchField className="cb-search-box" data-action={CONTENT_BROWSER_ACTIONS.search} value={query} onChange={(event) => { cancelReveal(); setQuery(event.target.value); }} onClear={() => { cancelReveal(); setQuery(''); }} placeholder={t('contentBrowser.searchPlaceholder')} label={t('contentBrowser.search')} />
                <Button ref={sortButtonRef} size="compact" variant="quiet" data-action={CONTENT_BROWSER_ACTIONS.setSort} leadingIcon={<ArrowUpDown size={14} />} title={t('contentBrowser.sortBy')} aria-label={`${t('contentBrowser.sortBy')}: ${sortLabels[sortState.key]}`} onClick={() => openToolbarMenu('sort')}>{sortLabels[sortState.key]}</Button>
              </Toolbar>

              {loading ? <div role="status">Loading assets...</div> : null}
              {actionError ? <div role="alert">{actionError}</div> : null}
              {htmlListingIssue ? <div role="status">{htmlListingIssue}</div> : null}
              {loadFailed ? (
                <EmptyState
                  className="cb-empty"
                  title={t('contentBrowser.unavailable')}
                  description={client ? t('contentBrowser.loadErrorDescription') : t('contentBrowser.unavailableDescription')}
                  icon={<FolderOpen size={28} />}
                />
              ) : !project ? (
                <EmptyState className="cb-empty" title={t('contentBrowser.noProject')} description={t('contentBrowser.openProjectHint')} icon={<FolderOpen size={28} />} />
              ) : viewItems.length === 0 ? (
                <EmptyState className="cb-empty" title={t('contentBrowser.emptyTitle')} description={t('contentBrowser.emptyDescription')} icon={<FolderOpen size={28} />} />
              ) : layout === 'column' ? (
                <CBDetailsList
                  items={viewItems}
                  selectedIds={selectedIds}
                  openingKeys={openingKeys}
                  sortState={sortState}
                  onSort={(key) => setSortState((current) => nextSortState(current, key))}
                  onSelect={selectItem}
                  onActivate={(item) => activateItem(item, true)}
                  onContextMenu={(event, item) => showMenu(event, itemMenu(item))}
                  onBlankClick={() => { cancelReveal(); setSelectedIds(new Set()); }}
                />
              ) : (
                <CBGrid
                  items={viewItems}
                  thumbnailSize={thumbnailSize}
                  layout={layout}
                  searchActive={searchActive}
                  expandedPacks={expandedPacks}
                  selectedIds={selectedIds}
                  openingKeys={openingKeys}
                  thumbnails={thumbnails}
                  onVisibleAssets={onVisibleAssets}
                  onSelect={selectItem}
                  onActivate={(item) => activateItem(item, true)}
                  onContextMenu={(event, item) => showMenu(event, itemMenu(item))}
                  onTogglePackExpansion={togglePackExpansion}
                  onBlankClick={() => { cancelReveal(); setSelectedIds(new Set()); }}
                />
              )}
              <footer className="cb-status">
                <span>
                  {selectedIds.size
                    ? t('contentBrowser.statusSelected', { count: viewItems.length, selected: selectedIds.size })
                    : t('contentBrowser.statusCount', { count: viewItems.length })}
                </span>
                <span>{folder || projectLabel}</span>
              </footer>
            </div>
            {detailPanelOpen ? (
              <div className={`cb-preview-dock${detailPanelExpanded ? ' is-expanded' : ''}`}>
                <button
                  type="button"
                  className="cb-preview-rail"
                  data-action={CONTENT_BROWSER_ACTIONS.toggleDetailPanel}
                  aria-expanded={detailPanelExpanded}
                  aria-label={t(detailPanelExpanded ? 'contentBrowser.preview.collapse' : 'contentBrowser.preview.expand')}
                  onClick={() => setDetailPanelExpanded((expanded) => !expanded)}
                >
                  {detailPanelExpanded ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
                </button>
                {detailPanelExpanded ? (
                  <div className="cb-preview-dock-content">
                    <CBPreviewPanel
                      previewItem={previewItem}
                      detailTabs={client && detailTabs ? detailContributions.filter(contribution => {
                        if (!previewItem || previewItem.type === 'folder') return false;
                        const isFile = previewItem.type === 'file';
                        const sourcePath = isFile ? previewItem.diskPath : previewItem.packPath;
                        return contribution.matches({ kind: isFile ? 'file' : 'asset', path: sourcePath, ...(isFile ? {} : { assetKind: previewItem.kind }) });
                      }).map(contribution => ({ contribution, sourcePath: previewItem!.type === 'file' ? previewItem!.diskPath : (previewItem as Extract<CBViewItem, { type: 'asset' }>).packPath })) : []}
                      client={client}
                      addConversationReference={addConversationReference}
                      thumbnail={selectedThumbnail}
                      foldersInPath={folders}
                      diskFiles={labeledFiles}
                      projectLabel={projectLabel}
                      readPreview={readPreview}
                      onOpenAsset={activateItem}
                      onClose={() => setDetailPanelExpanded(false)}
                      onDrag={(delta) => {
                        const next = previewWidth - delta;
                        setPreviewWidth(next);
                        splitRef.current?.style.setProperty('--cb-preview-w', `${Math.min(560, Math.max(180, next))}px`);
                      }}
                      onDragEnd={() => undefined}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <FloatingMenu
        open={Boolean(toolbarMenuAnchor && menu === 'filter')}
        anchorRect={toolbarMenuAnchor}
        onClose={() => setMenu(null)}
        ignorePointerWithin={[filterButtonRef]}
        className="cb-filter-menu"
        containerProps={{ onPointerDown: (event) => event.stopPropagation() }}
      >
        <div className="cb-filter-menu-body" data-action={CONTENT_BROWSER_ACTIONS.setFilter}>
          <div className="cb-filter-section">{t('contentBrowser.fileTypeSection')}</div>
          {familyFilters.map((item) => {
            const Icon = familyIcon(item.family);
            return (
              <button type="button" className="cb-filter-option" data-active={item.active ? 'true' : 'false'} key={item.id} onClick={() => applyFilter(item.id)}>
                <Checkbox checked={item.active} onChange={() => applyFilter(item.id)} tabIndex={-1} hideLabel label={item.label} className="cb-filter-check" />
                <Icon size={14} className={`cb-filter-option-icon${item.family === 'dir' ? ' cb-folder-icon' : ''}`} />
                {item.label}
              </button>
            );
          })}
          <div className="cb-filter-separator" />
          <div className="cb-filter-section">{t('contentBrowser.assetTypeSection')}</div>
          {kindFilters.map((item) => {
            const Icon = kindIcon(item.kind);
            return (
              <button type="button" className="cb-filter-option" data-active={item.active ? 'true' : 'false'} key={item.id} onClick={() => applyFilter(item.id)}>
                <Checkbox checked={item.active} onChange={() => applyFilter(item.id)} tabIndex={-1} hideLabel label={item.label} className="cb-filter-check" />
                <Icon size={14} className="cb-filter-option-icon" />
                {item.label}
              </button>
            );
          })}
          <div className="cb-filter-separator" />
          <button type="button" className="cb-filter-option cb-filter-clear" disabled={activeFilterCount === 0} onClick={() => { cancelReveal(); setActiveFamilies(new Set()); setActiveKinds(new Set()); }}>
            {t('contentBrowser.clearFilters')}
          </button>
        </div>
      </FloatingMenu>

      <FloatingMenu
        open={Boolean(toolbarMenuAnchor && menu === 'sort')}
        anchorRect={toolbarMenuAnchor}
        onClose={() => setMenu(null)}
        ignorePointerWithin={[sortButtonRef]}
        containerProps={{ onPointerDown: (event) => event.stopPropagation() }}
      >
        <div className="cb-filter-menu-body">
          <div className="cb-filter-section">{t('contentBrowser.sort.by')}</div>
          {SORT_KEYS.map((key) => {
            const Icon = SORT_KEY_ICONS[key];
            const active = sortState.key === key;
            return (
              <button type="button" className="cb-filter-option" data-active={active ? 'true' : 'false'} key={key} onClick={() => setSortState((current) => nextSortState(current, key))}>
                <span className="cb-radio-menu" data-checked={active ? 'true' : 'false'} />
                <Icon size={14} className="cb-filter-option-icon" />
                {sortLabels[key]}
              </button>
            );
          })}
          <div className="cb-filter-separator" />
          <div className="cb-filter-section">{t('contentBrowser.sort.order')}</div>
          {([['asc', ArrowUpNarrowWide], ['desc', ArrowDownWideNarrow]] as const).map(([dir, Icon]) => {
            const active = sortState.dir === dir;
            return (
              <button type="button" className="cb-filter-option" data-active={active ? 'true' : 'false'} key={dir} onClick={() => setSortState((current) => setSortDir(current, dir as CBSortDir))}>
                <span className="cb-radio-menu" data-checked={active ? 'true' : 'false'} />
                <Icon size={14} className="cb-filter-option-icon" />
                {t(dir === 'asc' ? 'contentBrowser.sort.asc' : 'contentBrowser.sort.desc')}
              </button>
            );
          })}
        </div>
      </FloatingMenu>

      <FloatingMenu
        open={Boolean(toolbarMenuAnchor && menu === 'settings')}
        anchorRect={toolbarMenuAnchor}
        onClose={() => setMenu(null)}
        ignorePointerWithin={[settingsButtonRef]}
        containerProps={{ onPointerDown: (event) => event.stopPropagation() }}
      >
        <div className="cb-settings-menu">
          <strong>{t('contentBrowser.layout')}</strong>
          <div className="fx-segmented cb-layout-switch">
            {LAYOUT_OPTIONS.map(({ mode, icon, labelKey }) => (
              <button
                type="button"
                data-action={CONTENT_BROWSER_ACTIONS.setView}
                className="fx-segmented__item fx-segmented__item--stacked"
                data-checked={layout === mode ? 'true' : 'false'}
                key={mode}
                onClick={() => setLayout(mode)}
              >
                {icon}<span>{t(labelKey)}</span>
              </button>
            ))}
          </div>
          <label className="cb-settings-row">
            <span className="cb-settings-label">{t('contentBrowser.thumbnailSize')}</span>
            <RangeInput
              data-action={CONTENT_BROWSER_ACTIONS.setThumbnailSize}
              className="cb-settings-range"
              min={48}
              max={200}
              step={4}
              value={thumbnailSize}
              onChange={(event) => setThumbnailSize(Number(event.target.value))}
              title={t('contentBrowser.actions.thumbnailSize', { size: thumbnailSize })}
            />
          </label>
          <Switch
            layout="row"
            className="cb-settings-switch-row"
            label={t('contentBrowser.actions.detailPanel')}
            checked={detailPanelOpen}
            data-action={CONTENT_BROWSER_ACTIONS.toggleDetailPanel}
            onCheckedChange={(checked) => {
              setDetailPanelOpen(checked);
              setDetailPanelExpanded(false);
            }}
          />
          {client && project ? <Button variant="quiet" size="compact" aria-expanded={runtimeOpen} onClick={() => {
            setRuntimeOpen(!runtimeOpen);
            setMenu(null);
            if (!runtimeOpen) void revealPanel?.().catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error)));
          }}>{t('contentBrowser.runtimeTools')}</Button> : null}
        </div>
      </FloatingMenu>

      <ContextMenu
        open={Boolean(contextMenu)}
        anchorRect={contextMenu?.anchor ?? null}
        items={contextMenu ? toFxMenuItems(contextMenu.items) : []}
        onClose={() => setContextMenu(null)}
        label={t('contentBrowser.contextMenu')}
        containerProps={{ 'data-action': CONTENT_BROWSER_ACTIONS.showContextMenu }}
      />
    </div>
  );
}
