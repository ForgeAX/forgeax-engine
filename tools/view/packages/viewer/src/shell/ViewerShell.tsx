import type { PanelClaim as SlotClaim, SlotRegistry, PageType, PageHost } from '@forgeax/view-workspace-core/frontend-contract';
import type { PageResourceOpenRequest as ResourceOpenRequest } from '@forgeax/view-workspace-core/frontend-contract';
import type { createViewPageTypeRegistry } from '../host/page-registry.ts';
import type { createViewPanelHost } from '../host/panel-bridge.ts';
type PageRegistry = ReturnType<typeof createViewPageTypeRegistry>;
import {
  DockviewReact,
  themeAbyss,
  type DockviewApi,
  type DockviewReadyEvent,
  type GetTabContextMenuItemsParams,
  type IDockviewDefaultTabProps,
  type IDockviewPanelProps,
} from 'dockview';
import { Box, Pin, X } from 'lucide-react';
import {
  IconButton,
  MenuDropdown,
  PageTabStrip,
  Text,
  type PageTabItem,
} from '@forgeax/view-components';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import 'dockview/dist/styles/dockview.css';

import { useTheme } from '@forgeax/view-components/theme';
import { themePreferences } from '@forgeax/view-components/theme';
import { SUPPORTED_LOCALES, useTranslation } from '../i18n';
import {
  listOpenablePageTypes,
  readPageTypeTitleRevision,
  resolvePageTypeTitle,
  resolveResourcePageType,
  planResourcePageActivation,
  subscribePageTypeTitles,
} from '../host/page-registry.ts';
import { slotElementId, VIEW_LAYOUT_HOST_ID } from './slots';
import {
  applyDefaultDockTitleHidden,
  DockTitleRestoreButton,
  isDockTitleHidden,
  setDockTitleHidden,
} from './dock-title';
import { reportWorkspaceCommandError } from '@forgeax/view-workspace-core/command-error';
import { VIEW_PAGE_TYPES, workspaceError } from '@forgeax/view-workspace-core/contract';
import { logResourceOpen, summarizeResourceAsset } from '@forgeax/view-workspace-core/resource-open';
import { claimsForPage, refreshDockPanelTitles, reconcileDockPanels } from './panel-reconciler.ts';
import { installEdgeDrawer, type EdgeDrawerController } from './workbench-layout/edge-drawer.ts';
import {
  EDGE_PIN_CLASS,
  EdgePinScopeContext,
  edgePinScopeFor,
  useEdgePinScope,
  type EdgePinScope,
} from './workbench-layout/edge-pin-store.ts';
import { useWorkbenchSidebar } from './workbench-layout/use-workbench-sidebar';
import { installUeDockDrag, isUeDragging } from './ue-drag/controller';
import type { HostConnection } from './HostConnectionIndicator';
import { ViewTraceExportButton } from './ViewTraceExportButton';
import {
  HeaderConnectionStatus,
  WorkspaceProjectRecovery,
  useProjectSessionState,
  type WorkspaceRecoveryClient,
} from './WorkspaceProjectRecovery';
import { WorkspaceCommandErrorHost } from './WorkspaceCommandErrorHost';

const EMPTY_CLAIMS: readonly SlotClaim[] = [];
const EMPTY_PAGE_TYPES: readonly PageType[] = [];

function createPageId(typeId: string) {
  return `${typeId}-${crypto.randomUUID()}`;
}

function pageIdFor(pageType: PageType) {
  return pageType.singleton ? `page-${pageType.typeId}` : createPageId(pageType.typeId);
}

function useViewPages(pageTypes: readonly PageType[], titleFor: (type: PageType) => string) {
  const [pages, setPages] = useState<PageTabItem[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const userSelectedPage = useRef(false);
  const typesById = useMemo(
    () => new Map(pageTypes.map((pageType) => [pageType.typeId, pageType])),
    [pageTypes],
  );

  useEffect(() => {
    setPages((current) => {
      const next = current
        .filter((page) => typesById.has(page.typeId))
        .map((page) => {
          const pageType = typesById.get(page.typeId)!;
          return { ...page, title: titleFor(pageType), closable: pageType.closable };
        });
      for (const pageType of pageTypes) {
        if (pageType.initial && !next.some((page) => page.typeId === pageType.typeId)) {
          const page = {
            id: pageIdFor(pageType),
            title: titleFor(pageType),
            typeId: pageType.typeId,
            closable: pageType.closable,
          };
          const index = next.findIndex((existing) => {
            const type = typesById.get(existing.typeId);
            return type && (type.order > pageType.order ||
              (type.order === pageType.order && type.typeId > pageType.typeId));
          });
          next.splice(index < 0 ? next.length : index, 0, page);
        }
      }
      return next;
    });
  }, [pageTypes, titleFor, typesById]);

  useEffect(() => {
    if (!userSelectedPage.current) {
      const firstInitial = pageTypes.find((type) => type.initial && pages.some((page) => page.typeId === type.typeId));
      if (firstInitial) {
        const preferredId = pages.find((page) => page.typeId === firstInitial.typeId)!.id;
        if (preferredId !== activePageId) setActivePageId(preferredId);
        return;
      }
    }
    if (pages.some((page) => page.id === activePageId)) return;
    setActivePageId(pages[0]?.id ?? null);
  }, [activePageId, pages, pageTypes]);

  const selectPage = useCallback((pageId: string) => {
    userSelectedPage.current = true;
    setActivePageId(pageId);
  }, []);

  const closePage = useCallback(
    (pageId: string) => {
      userSelectedPage.current = true;
      setPages((current) => {
        const next = current.filter((page) => page.id !== pageId);
        if (activePageId === pageId) {
          const closedIndex = current.findIndex((page) => page.id === pageId);
          const fallback = next[Math.min(closedIndex, next.length - 1)] ?? next[0];
          setActivePageId(fallback?.id ?? null);
        }
        return next;
      });
    },
    [activePageId],
  );

  const closeOthers = useCallback((pageId: string) => {
    userSelectedPage.current = true;
    setPages((current) => current.filter((page) => page.id === pageId || page.closable === false));
    setActivePageId(pageId);
  }, []);

  const closeToRight = useCallback((pageId: string) => {
    setPages((current) => {
      const index = current.findIndex((page) => page.id === pageId);
      if (index < 0) return current;
      return current.filter((page, i) => i <= index || page.closable === false);
    });
  }, []);

  const reorderPages = useCallback((pageId: string, toIndex: number) => {
    setPages((current) => {
      const fromIndex = current.findIndex((page) => page.id === pageId);
      if (fromIndex < 0 || fromIndex === toIndex) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const openPage = useCallback((typeId: string) => {
    const pageType = typesById.get(typeId);
    const plan = planResourcePageActivation(pages, pageType);
    logResourceOpen('shell-open-page', {
      typeId,
      action: plan.action,
      pageId: 'pageId' in plan ? plan.pageId ?? null : null,
      openable: pageType?.openable === true,
      singleton: pageType?.singleton === true,
    }, { level: plan.action === 'none' ? 'warn' : 'info' });
    if (plan.action === 'focus') {
      userSelectedPage.current = true;
      setActivePageId(plan.pageId);
      return;
    }
    if (plan.action !== 'open' || !pageType) return;
    userSelectedPage.current = true;
    const id = plan.pageId ?? pageIdFor(pageType);
    setPages((current) => [
      ...current,
      { id, title: titleFor(pageType), typeId, closable: pageType.closable },
    ]);
    setActivePageId(id);
  }, [pages, titleFor, typesById]);

  const activePage = useMemo(
    () => pages.find((page) => page.id === activePageId) ?? null,
    [activePageId, pages],
  );

  return {
    pages,
    activePageId,
    activePage,
    selectPage,
    closePage,
    closeOthers,
    closeToRight,
    reorderPages,
    openPage,
  };
}
type DockPanelParams = {
  id: string;
  attach: (id: string) => void;
  titleKey?: string;
  closable?: boolean;
};

function ForgeaxDockTab({
  api,
  containerApi: _containerApi,
  params,
  hideClose,
  closeActionOverride,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  tabLocation: _tabLocation,
  ...rest
}: IDockviewDefaultTabProps) {
  const { t } = useTranslation();
  const panelParams = params as DockPanelParams | undefined;
  const tabLabel = panelParams?.titleKey ? t(panelParams.titleKey) : api.title;
  const pinned = panelParams?.closable === false;
  const suppressClose = hideClose ?? pinned;
  const isEdge = api.location.type === 'edge';
  const pinScope = useEdgePinScope();
  const edgePinned = useSyncExternalStore(
    (listener) => pinScope?.subscribe(listener) ?? (() => {}),
    () => pinScope?.pinnedIn(api.group.id) === api.id,
    () => pinScope?.pinnedIn(api.group.id) === api.id,
  );
  return (
    <div
      className="dv-default-tab fx-dock-tab"
      {...rest}
      onPointerDown={onPointerDown}
      onPointerUp={(event) => {
        if (event.button === 1 && !suppressClose) {
          event.preventDefault();
          api.close();
          return;
        }
        onPointerUp?.(event);
      }}
      onPointerLeave={onPointerLeave}
    >
      <Box className="fx-dock-tab-icon" size={13} />
      <div className="dv-default-tab-content">{tabLabel}</div>
      {isEdge ? (
        <div
          className={`dv-default-tab-action ${EDGE_PIN_CLASS}${edgePinned ? ` ${EDGE_PIN_CLASS}--on` : ''}`}
          role="button"
          aria-pressed={edgePinned}
          aria-label={edgePinned ? t('view.dock.unpinTab') : t('view.dock.pinTab')}
          title={edgePinned ? t('view.dock.unpinTab') : t('view.dock.pinTab')}
          data-fx-edge-pin-panel={api.id}
          onPointerDown={(event) => event.preventDefault()}
        >
          <Pin size={12} />
        </div>
      ) : null}
      {!suppressClose ? (
        <div
          className="dv-default-tab-action"
          role="button"
          aria-label={t('view.close')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (closeActionOverride) closeActionOverride();
            else api.close();
          }}
        >
          <X size={13} />
        </div>
      ) : null}
    </div>
  );
}

function subscribeRegistry(registry: SlotRegistry, onStoreChange: () => void) {
  if (!registry?.subscribe) return () => {};
  return registry.subscribe(() => onStoreChange());
}

function getClaimsSnapshot(registry: SlotRegistry): readonly SlotClaim[] {
  return registry?.getClaims?.() ?? EMPTY_CLAIMS;
}

function subscribePageRegistry(registry: PageRegistry, onStoreChange: () => void) {
  if (!registry?.subscribe) return () => {};
  return registry.subscribe(() => onStoreChange());
}

function getPageTypesSnapshot(registry: PageRegistry): readonly PageType[] {
  return registry?.getTypes?.() ?? EMPTY_PAGE_TYPES;
}

function DockSlot({ params }: IDockviewPanelProps<DockPanelParams>) {
  const id = params.id;
  useLayoutEffect(() => {
    params.attach(id);
  }, [id, params]);
  return (
    <div className="fx-view-dock-panel">
      <div
        id={slotElementId(id)}
        className="fx-view-slot-mount"
        data-forgeax-view-slot={id}
      />
      <DockTitleRestoreButton />
    </div>
  );
}

function PageSurface({
  pageType,
  pageRegistry,
  active,
}: {
  pageType: PageType;
  pageRegistry: PageRegistry;
  active: boolean;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (anchorRef.current) pageRegistry.attach(pageType.typeId, anchorRef.current);
  }, [pageRegistry, pageType.typeId]);
  return (
    <div
      ref={anchorRef}
      className={`fx-view-page-mount${active ? ' is-active' : ''}`}
      data-forgeax-view-page={pageType.typeId}
      aria-hidden={!active}
      hidden={!active && pageType.hideWhenInactive}
    />
  );
}

function DockPageWorkbench({
  pageId,
  pageTypeId,
  claims,
  slotRegistry,
  titleForClaim,
  active,
  layoutHostId,
  hideWhenInactive,
  responsiveAutoTuck,
  registerPanelRevealer,
}: {
  pageId: string;
  pageTypeId: string;
  claims: SlotClaim[];
  slotRegistry: SlotRegistry;
  titleForClaim: (claim: SlotClaim) => string;
  active: boolean;
  layoutHostId?: string;
  hideWhenInactive: boolean;
  responsiveAutoTuck: boolean;
  registerPanelRevealer?: (pageType: string, reveal: (slot: string) => boolean) => () => void;
}) {
  const { t } = useTranslation();
  const apiRef = useRef<DockviewApi | null>(null);
  const workbenchRef = useRef<HTMLElement | null>(null);
  const dockHostRef = useRef<HTMLDivElement | null>(null);
  const ueDragDisposeRef = useRef<(() => void) | null>(null);
  const edgeDrawerRef = useRef<EdgeDrawerController | null>(null);
  const willDropRef = useRef<EdgeDrawerController['onWillDrop']>(
    () => true,
  );
  const [edgePinScope, setEdgePinScope] = useState<EdgePinScope | null>(null);
  const pinScopeRef = useRef<EdgePinScope | null>(null);
  pinScopeRef.current = edgePinScope;
  const [layoutReady, setLayoutReady] = useState(false);
  useEffect(() => registerPanelRevealer?.(pageTypeId, slot => {
    const panel = apiRef.current?.getPanel(slot);
    if (!panel) return false;
    panel.api.setActive();
    if (panel.api.location.type === 'edge') edgeDrawerRef.current?.revealPanel(slot);
    return true;
  }), [pageTypeId, registerPanelRevealer]);
  const [dockReadyRevision, setDockReadyRevision] = useState(0);
  const [presentationReady, setPresentationReady] = useState(0);
  const [dockExtent, setDockExtent] = useState({ width: 0, height: 0 });
  const sidebar = useWorkbenchSidebar({
    workbenchRef,
    dockHostRef,
    apiRef,
    layoutReady,
    presentationReady,
    edgeDrawerRef,
    responsiveAutoTuck,
  });
  const panelClosableById = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const claim of claims) {
      map.set(claim.id, claim.closable !== false);
    }
    return map;
  }, [claims]);
  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    ueDragDisposeRef.current?.();
    edgeDrawerRef.current?.dispose();
    edgeDrawerRef.current = null;
    willDropRef.current = () => true;
    const pinScope = edgePinScopeFor(event.api);
    pinScopeRef.current = pinScope;
    setEdgePinScope(pinScope);
    setLayoutReady(true);
    setDockReadyRevision((revision) => revision + 1);
    setPresentationReady(0);
  }, []);
  useLayoutEffect(() => {
    if (!layoutReady) return undefined;
    const element = dockHostRef.current ?? workbenchRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const sync = () => {
      const rect = element.getBoundingClientRect();
      setDockExtent({
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [layoutReady]);
  useEffect(
    () => () => {
      ueDragDisposeRef.current?.();
      ueDragDisposeRef.current = null;
      edgeDrawerRef.current?.dispose();
      edgeDrawerRef.current = null;
      setEdgePinScope(null);
    },
    [],
  );
  const getTabContextMenuItems = useCallback((params: GetTabContextMenuItemsParams) => {
    const hidden = isDockTitleHidden(params.group.element);
    const targetClosable = panelClosableById.get(params.panel.id) ?? true;
    const hasClosableOthers = params.group.panels.some(
      (panel) => panel.id !== params.panel.id && panelClosableById.get(panel.id) !== false,
    );
    const onEdge = params.panel.api.location.type === 'edge';
    const tabPinned = onEdge && pinScopeRef.current?.pinnedIn(params.group.id) === params.panel.id;
    const panelItems = [
      ...(targetClosable
        ? [{
            label: t('view.dock.close'),
            action: () => params.panel.api.close(),
          }]
        : []),
      ...(hasClosableOthers
        ? [{
            label: t('view.dock.closeOthers'),
            action: () => {
              for (const panel of [...params.group.panels]) {
                if (panel.id === params.panel.id) continue;
                if (panelClosableById.get(panel.id) === false) continue;
                panel.api.close();
              }
            },
          }]
        : []),
    ];
    if (onEdge) {
      panelItems.push({
        label: tabPinned ? t('view.dock.unpinTab') : t('view.dock.pinTab'),
        action: () => {
          const drawer = edgeDrawerRef.current;
          if (!drawer) return;
          if (tabPinned) drawer.unpinPanel(params.group.id);
          else drawer.pinPanel(params.group.id, params.panel.id);
        },
      });
    }
    if (params.group.panels.length !== 1) return panelItems;
    const titleBarItems = [{
      label: hidden ? t('view.dock.showTitleBar') : t('view.dock.hideTitleBar'),
      action: () => setDockTitleHidden(params.group.element, !hidden),
    }];
    if (panelItems.length === 0) return titleBarItems;
    return [...titleBarItems, 'separator' as const, ...panelItems];
  }, [panelClosableById, t]);
  useEffect(() => {
    if (!layoutReady) return;
    const api = apiRef.current;
    if (!api) return;
    const availableWidth = dockExtent.width > 0
      ? dockExtent.width
      : dockHostRef.current?.clientWidth ?? workbenchRef.current?.clientWidth ?? 0;
    const availableHeight = dockExtent.height > 0
      ? dockExtent.height
      : dockHostRef.current?.clientHeight ?? workbenchRef.current?.clientHeight ?? 0;
    // Initial fractional sizes need a real presentation extent. Existing
    // panels keep their user layout when an inactive page becomes visible.
    if (availableWidth > 0 && availableHeight > 0) api.layout(availableWidth, availableHeight);
    const hadContentBrowser = Boolean(api.getPanel('content-browser'));
    reconcileDockPanels(api, claims, {
      titleFor: titleForClaim,
      attach: (id: string) => {
        if (getClaimsSnapshot(slotRegistry).some((claim) => claim.id === id)) slotRegistry.resolve(id);
      },
      availableWidth,
      availableHeight,
    });
    if (!edgeDrawerRef.current && api.panels.length > 0 && dockHostRef.current) {
      const edgeDrawer = installEdgeDrawer(api, dockHostRef.current);
      edgeDrawerRef.current = edgeDrawer;
      willDropRef.current = edgeDrawer.onWillDrop;
      ueDragDisposeRef.current = installUeDockDrag(api, dockHostRef.current, {
        closeEdgeDrawer: () => edgeDrawerRef.current?.forceClose(),
      });
    }
    if (!hadContentBrowser) {
      const panel = api.getPanel('content-browser');
      const bottom = api.groups.find((group) => group.api.location.type === 'edge' && group.api.location.position === 'bottom');
      if (panel && bottom) {
        panel.api.moveTo({ group: bottom, position: 'center' });
        bottom.element.classList.remove('fx-edge-empty');
        api.setEdgeGroupVisible?.('bottom', true);
        bottom.api.collapse?.();
        edgeDrawerRef.current?.refreshBottomSpan();
      }
    }
    for (const claim of claims) {
      if (claim.dockTitleHidden !== true) continue;
      const panel = api.getPanel(claim.id);
      applyDefaultDockTitleHidden(panel?.group?.element, true);
    }
    sidebar.applyNow();
    if (availableWidth > 0 && availableHeight > 0 && claims.length > 0) {
      setPresentationReady((generation) => (generation === 0 ? 1 : generation));
    }
  }, [active, claims, dockExtent.height, dockExtent.width, dockReadyRevision, layoutReady, sidebar.applyNow, slotRegistry, titleForClaim]);
  useLayoutEffect(() => {
    if (!layoutReady) return;
    const api = apiRef.current;
    if (!api) return;
    refreshDockPanelTitles(api, claims, titleForClaim);
  }, [claims, layoutReady, titleForClaim]);
  useEffect(() => {
    if (!layoutReady) return;
    if (active) {
      edgeDrawerRef.current?.resumePinned();
      return;
    }
    edgeDrawerRef.current?.suspendForPage();
  }, [active, layoutReady]);
  return (
    <div
      className={`fx-view-workspace-row${active ? ' is-active' : ''}`}
      data-forgeax-view-dock-page={pageTypeId}
      data-forgeax-view-page-id={pageId}
      aria-hidden={!active}
      inert={!active}
      hidden={!active && hideWhenInactive}
    >
      <main
        ref={workbenchRef}
        id={layoutHostId}
        className="fx-view-workbench"
        data-forgeax-view={layoutHostId ? 'layout-host' : undefined}
        data-fx-workbench-stage={sidebar.state.stage}
      >
        <div ref={dockHostRef} className="fx-view-dockview-host">
          <EdgePinScopeContext.Provider value={edgePinScope}>
            <DockviewReact
              className="fx-view-dockview"
              theme={{ ...themeAbyss, name: 'forgeax-view-abyss', gap: 6, edgeGroupCollapsedSize: 32 }}
              components={{ slot: DockSlot }}
              defaultTabComponent={ForgeaxDockTab}
              onReady={onReady}
              onWillDrop={(event) => {
                if (isUeDragging()) return false;
                return willDropRef.current(event);
              }}
              getTabContextMenuItems={getTabContextMenuItems}
              disableFloatingGroups={false}
              hideBorders
            />
          </EdgePinScopeContext.Provider>
        </div>
      </main>
    </div>
  );
}

export function ViewerShell({
  slotRegistry,
  pageRegistry,
  pageHost,
  panelHost,
  hostConnection = { phase: 'connected' },
  workspaceClient,
  selectedPageType,
  onSelectPageType,
  responsiveAutoTuck = true,
}: {
  slotRegistry: SlotRegistry;
  pageRegistry: PageRegistry;
  pageHost?: PageHost;
  panelHost?: ReturnType<typeof createViewPanelHost>;
  hostConnection?: HostConnection;
  workspaceClient?: WorkspaceRecoveryClient;
  selectedPageType?: string;
  onSelectPageType?: (typeId: string) => void;
  responsiveAutoTuck?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { preference, setTheme } = useTheme();
  const projectSession = useProjectSessionState(workspaceClient);
  const claims = useSyncExternalStore(
    (listener) => subscribeRegistry(slotRegistry, listener),
    () => getClaimsSnapshot(slotRegistry),
    () => EMPTY_CLAIMS,
  );
  const pageTypes = useSyncExternalStore(
    (listener) => subscribePageRegistry(pageRegistry, listener),
    () => getPageTypesSnapshot(pageRegistry),
    () => EMPTY_PAGE_TYPES,
  );
  const subscribeTitles = useCallback(
    (listener: () => void) => subscribePageTypeTitles(pageTypes, listener),
    [pageTypes],
  );
  const getTitleRevision = useCallback(
    () => readPageTypeTitleRevision(pageTypes),
    [pageTypes],
  );
  const pageTitleRevision = useSyncExternalStore(subscribeTitles, getTitleRevision, getTitleRevision);
  const titleForPageType = useCallback(
    (pageType: PageType) => resolvePageTypeTitle(pageType, t),
    [pageTitleRevision, t],
  );
  const {
    pages,
    activePageId,
    activePage,
    selectPage: selectLocalPage,
    closePage,
    closeOthers,
    closeToRight,
    reorderPages,
    openPage,
  } = useViewPages(pageTypes, titleForPageType);
  const openPageRef = useRef(openPage);
  openPageRef.current = openPage;
  const panelRevealers = useRef(new Map<string, (slot: string) => boolean>());
  const registerPanelRevealer = useCallback((pageType: string, reveal: (slot: string) => boolean) => {
    panelRevealers.current.set(pageType, reveal);
    return () => { if (panelRevealers.current.get(pageType) === reveal) panelRevealers.current.delete(pageType); };
  }, []);
  useEffect(() => panelHost?.setRevealer(async slot => {
    const claim = claims.find(item => item.id === slot);
    if (!claim) return false;
    openPageRef.current(claim.pageType);
    onSelectPageType?.(claim.pageType);
    // The Editor page and Dock are registered after its frontend modules mount.
    // A reveal from another initial page must wait for that real registration.
    for (let attempt = 0; attempt < 80; attempt++) {
      if (panelRevealers.current.get(claim.pageType)?.(slot)) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }), [claims, onSelectPageType, panelHost]);
  const pageTypesRef = useRef(pageTypes);
  pageTypesRef.current = pageTypes;
  const handledOpenRequest = useRef<{ requestId: string; sequence: number; ok: boolean } | null>(null);
  useEffect(() => {
    if (!pageHost) return undefined;
    if (!pageHost.subscribeResourceOpen) {
      logResourceOpen('shell-open-listener-skipped', {
        reason: 'subscribe-resource-open-missing',
      }, { level: 'warn' });
      return undefined;
    }
    return pageHost.subscribeResourceOpen((request) => {
      const previous = handledOpenRequest.current;
      const sequence = request.sequence ?? 0;
      if (previous?.requestId === request.requestId && previous.sequence === sequence && previous.ok) {
        logResourceOpen('shell-open-duplicate-skipped', {
          requestId: request.requestId,
          sequence,
        });
        return;
      }
      const resolved = resolveResourcePageType(pageTypesRef.current, request);
      if (!resolved.ok) {
        handledOpenRequest.current = { requestId: request.requestId, sequence, ok: false };
        logResourceOpen('shell-resolve-failed', {
          requestId: request.requestId,
          sequence,
          asset: 'asset' in request ? summarizeResourceAsset(request.asset) : null,
          error: resolved.error?.code ?? null,
          pageTypeCount: pageTypesRef.current.length,
          selectorCount: pageTypesRef.current.filter((pageType) => pageType.resourceSelector).length,
        }, { level: 'warn' });
        if (pageTypesRef.current.some((pageType) => pageType.resourceSelector)) {
          reportWorkspaceCommandError(
            workspaceError(
              resolved.error.code,
              resolved.error.expected,
              resolved.error.hint,
              resolved.error.detail,
            ),
            { operation: 'file' in request ? 'file.open' : 'asset.open' },
          );
        }
        return;
      }
      handledOpenRequest.current = { requestId: request.requestId, sequence, ok: true };
      logResourceOpen('shell-resolve-ok', {
        requestId: request.requestId,
        sequence,
        asset: 'asset' in request ? summarizeResourceAsset(request.asset) : null,
        pageType: resolved.pageType.typeId,
      });
      openPageRef.current(resolved.pageType.typeId);
    });
  }, [pageHost, pageTypes]);
  const requiresProject = pageTypes.find(page => page.typeId === activePage?.typeId)?.context !== 'artifact';
  const requestedPageId = pages.find(page => page.typeId === selectedPageType)?.id;
  useEffect(() => {
    if (requestedPageId) selectLocalPage(requestedPageId);
  }, [requestedPageId, selectLocalPage]);
  const selectPage = (pageId: string) => {
    selectLocalPage(pageId);
    const page = pages.find(page => page.id === pageId);
    if (page) onSelectPageType?.(page.typeId);
  };
  const openDockPages = useMemo(
    () => pages.filter((page) => pageTypes.find((pageType) => pageType.typeId === page.typeId)?.layout === 'dock'),
    [pageTypes, pages],
  );
  const openSurfacePageTypes = useMemo(
    () =>
      pageTypes.filter(
        (pageType) =>
          pageType.layout === 'surface' &&
          pages.some((page) => page.typeId === pageType.typeId),
      ),
    [pageTypes, pages],
  );
  const openablePageTypes = useMemo(
    () => (listOpenablePageTypes(pageTypes, pages) as PageType[])
      .map((pageType) => ({ typeId: pageType.typeId, title: titleForPageType(pageType) })),
    [pageTypes, pages, titleForPageType],
  );
  const titleForClaim = useCallback(
    (claim: SlotClaim) => (claim.titleKey ? t(claim.titleKey) : claim.id),
    [i18n.language, t],
  );

  useEffect(() => {
    const root = globalThis.document?.documentElement;
    if (!root?.dataset) return undefined;
    if (activePage?.typeId) root.dataset.forgeaxViewActivePage = activePage.typeId;
    else delete root.dataset.forgeaxViewActivePage;
    return () => {
      if (root.dataset.forgeaxViewActivePage === activePage?.typeId) {
        delete root.dataset.forgeaxViewActivePage;
      }
    };
  }, [activePage?.typeId]);

  const pageTabLabels = useMemo(
    () => ({
      tabList: t('view.pageTabs.openPages'),
      newPage: t('view.pageTabs.newPage'),
      allPages: t('view.pageTabs.allPages'),
      noOpenableTypes: t('view.pageTabs.noOpenableTypes'),
      closeTab: t('view.pageTabs.closeTab'),
      contextClose: t('view.pageTabs.context.close'),
      contextCloseOthers: t('view.pageTabs.context.closeOthers'),
      contextCloseToRight: t('view.pageTabs.context.closeToRight'),
    }),
    [t],
  );

  return (
    <div className="fx-view-app" data-forgeax-view="shell">
      {!projectSession.restoring && <WorkspaceCommandErrorHost />}

      <PageTabStrip
        leading={(<div className="fx-view-brand">
          <Text as="strong" variant="caption" tone="primary">ForgeaX View</Text>
        </div>)}
        trailing={(<div className="fx-view-header__prefs">
          <ViewTraceExportButton />
          <HeaderConnectionStatus connection={hostConnection} workspaceClient={workspaceClient} />
          <MenuDropdown
            label={t('view.theme')}
            align="end"
            items={themePreferences.map((name) => ({
              id: name,
              label: name === 'system' ? t('view.themeSystem') : name === 'light' ? t('view.themeLight') : t('view.themeDark'),
              selected: preference === name,
              onSelect: () => setTheme(name),
            }))}
            trigger={(
              <IconButton
                variant="quiet"
                size="compact"
                label={t('view.theme')}
                icon={preference === 'system' ? <Monitor className="fx-icon" /> : preference === 'light' ? <Sun className="fx-icon" /> : <Moon className="fx-icon" />}
              />
            )}
          />
          <MenuDropdown
            label={t('view.language')}
            align="end"
            items={SUPPORTED_LOCALES.map((locale) => ({
              id: locale.code,
              label: locale.nativeLabel,
              selected: i18n.language === locale.code,
              onSelect: () => i18n.changeLanguage(locale.code),
            }))}
            trigger={(
              <IconButton
                variant="quiet"
                size="compact"
                label={t('view.language')}
                icon={(
                  <span className="fx-locale-trigger" aria-hidden>
                    {t(`view.localeShort.${i18n.language}`)}
                  </span>
                )}
              />
            )}
          />
        </div>)}
        pages={pages}
        activePageId={activePageId}
        onSelect={selectPage}
        onClose={closePage}
        onCloseOthers={closeOthers}
        onCloseToRight={closeToRight}
        onReorder={reorderPages}
        newPageTypes={openablePageTypes}
        onNewPage={openPage}
        labels={pageTabLabels}
      />
      {workspaceClient ? <WorkspaceProjectRecovery client={workspaceClient} required={requiresProject} /> : null}
      {requiresProject && projectSession.restoring ? (
        <main className="fx-view-project-restoring" role="status" aria-live="polite">
          <Text as="strong" variant="heading" tone="primary">{t('view.projectRecovery.restoringTitle')}</Text>
          <Text variant="body" tone="secondary">{t('view.projectRecovery.restoringDescription')}</Text>
        </main>
      ) : (<>

      <div className="fx-view-main-col">
        {openDockPages.map((page) => (
          <DockPageWorkbench
            key={page.id}
            pageId={page.id}
            pageTypeId={page.typeId}
            registerPanelRevealer={registerPanelRevealer}
            claims={claimsForPage(claims, page.typeId)}
            slotRegistry={slotRegistry}
            titleForClaim={titleForClaim}
            active={page.id === activePageId}
            responsiveAutoTuck={responsiveAutoTuck}
            hideWhenInactive={pageTypes.some(type => type.typeId === page.typeId && type.hideWhenInactive)}
            layoutHostId={page.typeId === VIEW_PAGE_TYPES.editor ? VIEW_LAYOUT_HOST_ID : undefined}
          />
        ))}
        {openSurfacePageTypes.map((pageType) => (
          <PageSurface
            key={pageType.typeId}
            pageType={pageType}
            pageRegistry={pageRegistry}
            active={activePage?.typeId === pageType.typeId}
          />
        ))}
      </div>
      </>)}
    </div>
  );
}
