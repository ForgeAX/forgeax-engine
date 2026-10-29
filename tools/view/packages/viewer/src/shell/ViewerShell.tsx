import type { PanelClaim as SlotClaim, SlotRegistry, PageType, PageHost, PanelPlacement, PresentationOwner, PresentationSnapshot } from '@forgeax/view-workspace-core/frontend-contract';
import type { PageResourceOpenRequest as ResourceOpenRequest } from '@forgeax/view-workspace-core/frontend-contract';
import type { createViewPageTypeRegistry } from '../host/page-registry.ts';
import type { createViewPanelHost } from '../host/panel-bridge.ts';
type PageRegistry = ReturnType<typeof createViewPageTypeRegistry>;
type PanelPresentation = {
  pageType: string;
  reveal(slot: string): boolean;
  dismissUnpinnedEdge(slot: string): boolean;
  read(): PresentationSnapshot['panels'];
  returnSharedHomePanels(): Promise<void>;
};
type ShellPanelPresentation = Pick<PanelPresentation, 'reveal' | 'read'> & { isVisible(slot: string): boolean };
type ReadPanelPlacement = (api: DockviewApi | null, panelId: string) => PanelPlacement;
import {
  DockviewReact,
  getPanelData,
  themeAbyss,
  type DockviewApi,
  type DockviewDidDropEvent,
  type DockviewReadyEvent,
  type GetTabContextMenuItemsParams,
  type IDockviewDefaultTabProps,
  type IDockviewPanelProps,
} from 'dockview';
import { flushSync } from 'react-dom';
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
import type { DragEvent as ReactDragEvent } from 'react';
import 'dockview/dist/styles/dockview.css';

import { useTheme } from '@forgeax/view-components/theme';
import { themePreferences } from '@forgeax/view-components/theme';
import { SUPPORTED_LOCALES, useTranslation } from '../i18n';
import {
  listOpenablePageTypes,
  readPageTypeTitleRevision,
  resolvePageTypeLabel,
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
import { claimsForPage, panelLayoutSignature, refreshDockPanelTitles, reconcileDockPanels } from './panel-reconciler.ts';
import {
  bottomEdgeGroup,
  canTransferPanelBetweenDocks,
  ensureGridGroup,
  panelPlacementFor,
  panelPositionForDrop,
  shellBottomPosition,
  shellHomeClaimForPanel,
  transferDockPanel,
  transferSourceFor,
  type DockviewInstance,
  type DockviewOwner,
} from './panel-transfer.ts';
import { installEdgeDrawer, type EdgeDrawerController } from './workbench-layout/edge-drawer.ts';
import {
  EDGE_PIN_CLASS,
  EdgePinScopeContext,
  edgePinScopeFor,
  useEdgePinScope,
  type EdgePinScope,
} from './workbench-layout/edge-pin-store.ts';
import { useWorkbenchSidebar } from './workbench-layout/use-workbench-sidebar';
import { installUeDockDrag, isUeDragging, type UeDragOptions } from './ue-drag/controller';
import { PAGE_WORKBENCH_EDGES } from './workbench-layout/constants.ts';
import type { HostConnection } from './HostConnectionIndicator';
import {
  HeaderConnectionStatus,
  WorkspaceProjectRecovery,
  useProjectSessionState,
  type WorkspaceRecoveryClient,
} from './WorkspaceProjectRecovery';
import { WorkspaceCommandErrorHost } from './WorkspaceCommandErrorHost';

const EMPTY_CLAIMS: readonly SlotClaim[] = [];
const EMPTY_PAGE_TYPES: readonly PageType[] = [];
type ViewPage = PageTabItem & { pageType: PageType };

function trackPanelTransfer(pending: Map<string, Promise<void>>, id: string, start: () => Promise<boolean>, onChange: () => void) {
  let finish!: () => void;
  const settled = new Promise<void>(resolve => { finish = resolve; });
  pending.set(id, settled);
  onChange();
  let transfer: Promise<boolean>;
  try { transfer = start(); }
  catch (error) { transfer = Promise.reject(error); }
  void transfer.then(finish, finish).then(() => {
    if (pending.get(id) === settled) {
      pending.delete(id);
      onChange();
    }
  });
  return transfer;
}

function createPageId(typeId: string) {
  return `${typeId}-${crypto.randomUUID()}`;
}

function pageIdFor(pageType: PageType) {
  return pageType.singleton ? `page-${pageType.typeId}` : createPageId(pageType.typeId);
}

function useViewPages(pageTypes: readonly PageType[], titleFor: (type: PageType) => string, pageRegistry: PageRegistry, beforeClosePage?: (pageId: string) => Promise<void>) {
  const [pages, setPages] = useState<ViewPage[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const userSelectedPage = useRef(false);
  const closeRequests = useRef(new Map<string, Promise<void>>());
  const closeLifetime = useMemo(() => new AbortController(), []);
  useEffect(() => () => closeLifetime.abort(), [closeLifetime]);
  const typesById = useMemo(
    () => new Map(pageTypes.map((pageType) => [pageType.typeId, pageType])),
    [pageTypes],
  );

  useEffect(() => {
    setPages((current) => {
      const next = current.map((page) => {
        const pageType = typesById.get(page.typeId);
        return pageType && !closeRequests.current.has(page.id)
          ? { ...page, pageType, title: titleFor(pageType), closable: pageType.closable }
          : page;
      });
      for (const pageType of pageTypes) {
        if (pageType.initial && !next.some((page) => page.typeId === pageType.typeId)) {
          const page = {
            id: pageIdFor(pageType),
            title: titleFor(pageType),
            typeId: pageType.typeId,
            closable: pageType.closable,
            pageType,
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

  const currentTypes = useRef(typesById);
  currentTypes.current = typesById;
  const closePage = useCallback((pageId: string, signal = closeLifetime.signal, force = false): Promise<void> => {
    const pending = closeRequests.current.get(pageId);
    if (pending) return pending;
    const page = pages.find(entry => entry.id === pageId);
    if (!page || !force && page.closable === false) return Promise.resolve();
    const pageType = typesById.get(page.typeId);
    const controller = pageType?.controller;
    const completion = (async () => {
      signal.throwIfAborted();
      if (pageType) {
        await pageRegistry.beforeClose(page.typeId, signal);
        await controller?.beforeClose?.(signal);
      }
      await beforeClosePage?.(pageId);
      signal.throwIfAborted();
      const currentType = currentTypes.current.get(page.typeId);
      if (force && !pageType) {
        if (currentType) {
          throw new DOMException('Page type was re-registered while retiring', 'AbortError');
        }
      } else if (currentType?.controller !== controller) {
        throw new DOMException('Page controller changed while closing', 'AbortError');
      }
      userSelectedPage.current = true;
      flushSync(() => setPages(current => {
        const index = current.findIndex(entry => entry.id === pageId);
        const next = current.filter(entry => entry.id !== pageId);
        setActivePageId(active => active === pageId ? next[Math.min(index, next.length - 1)]?.id ?? null : active);
        return next;
      }));
    })().finally(() => { closeRequests.current.delete(pageId); });
    closeRequests.current.set(pageId, completion);
    return completion;
  }, [beforeClosePage, closeLifetime, pageRegistry, pages, typesById]);
  useEffect(() => {
    for (const page of pages) {
      if (typesById.has(page.typeId)) continue;
      void closePage(page.id, closeLifetime.signal, true).catch(error => {
        if (!closeLifetime.signal.aborted) reportWorkspaceCommandError(error, { operation: 'view.page.retire' });
      });
    }
  }, [closeLifetime, closePage, pages, typesById]);
  const closeMany = useCallback(async (ids: readonly string[]) => {
    const results = await Promise.allSettled(ids.map(id => closePage(id)));
    for (const result of results) if (result.status === 'rejected') reportWorkspaceCommandError(result.reason);
  }, [closePage]);
  const closeOthers = useCallback((pageId: string) => {
    userSelectedPage.current = true;
    setActivePageId(pageId);
    void closeMany(pages.filter(page => page.id !== pageId && page.closable !== false).map(page => page.id));
  }, [closeMany, pages]);
  const closeToRight = useCallback((pageId: string) => {
    const index = pages.findIndex(page => page.id === pageId);
    if (index >= 0) void closeMany(pages.slice(index + 1).filter(page => page.closable !== false).map(page => page.id));
  }, [closeMany, pages]);

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
      { id, title: titleFor(pageType), typeId, closable: pageType.closable, pageType },
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
  attach: (id: string, anchor?: HTMLElement) => void;
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
  const anchorRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (anchorRef.current) params.attach(id, anchorRef.current);
  }, [id, params]);
  return (
    <div className="fx-view-dock-panel">
      <div
        ref={anchorRef}
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
  registerPanelPresentation,
  registerDockview,
  returnSharedHomePanels,
  readPanelPlacement,
  preservePanelIds,
  resolveDropDock,
  onCrossDockDrop,
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
  registerPanelPresentation?: (pageId: string, presentation: PanelPresentation) => () => void;
  registerDockview?: (api: DockviewApi, owner: DockviewOwner, host?: HTMLElement) => () => void;
  returnSharedHomePanels: (api: DockviewApi) => Promise<void>;
  readPanelPlacement: ReadPanelPlacement;
  preservePanelIds: Pick<ReadonlySet<string>, 'has'>;
  resolveDropDock: NonNullable<UeDragOptions['resolveDropDock']>;
  onCrossDockDrop: NonNullable<UeDragOptions['onCrossDockDrop']>;
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
  useLayoutEffect(() => registerPanelPresentation?.(pageId, {
    pageType: pageTypeId,
    reveal(slot) {
      const panel = apiRef.current?.getPanel(slot);
      if (!panel) return false;
      panel.api.setActive();
      if (panel.api.location.type === 'edge') edgeDrawerRef.current?.revealPanel(slot);
      return true;
    },
    dismissUnpinnedEdge(slot) {
      const panel = apiRef.current?.getPanel(slot);
      const drawer = edgeDrawerRef.current;
      if (!panel || panel.api.location.type !== 'edge' || drawer?.getOpenPanelId() !== slot) return false;
      if (pinScopeRef.current?.pinnedIn(panel.group.id) === slot) return false;
      drawer.forceClose();
      return true;
    },
    read: () => claims.map(claim => {
      const panel = apiRef.current?.getPanel(claim.id);
      const visible = panel?.api.location.type === 'edge'
        ? edgeDrawerRef.current?.getOpenPanelId() === claim.id : panel?.api.isVisible === true;
      return { id: claim.id, title: titleForClaim(claim), mounted: !!panel,
        visible: active && visible, active: active && panel?.api.isActive === true,
        placement: readPanelPlacement(apiRef.current, claim.id) };
    }),
    returnSharedHomePanels: () => {
      const api = apiRef.current;
      return api ? returnSharedHomePanels(api) : Promise.resolve();
    },
  }), [active, claims, pageId, pageTypeId, readPanelPlacement, registerPanelPresentation, returnSharedHomePanels, titleForClaim]);
  const [dockReadyRevision, setDockReadyRevision] = useState(0);
  const [presentationReady, setPresentationReady] = useState(0);
  const [panelTopologyRevision, setPanelTopologyRevision] = useState(0);
  const panelLayoutSignatureRef = useRef<string | null>(null);
  const [dockExtent, setDockExtent] = useState({ width: 0, height: 0 });
  const primaryPanelIds = useMemo(
    () => new Set(claims.filter(claim => 'dock' in claim.layout && claim.layout.dock === 'fill').map(claim => claim.id)),
    [claims],
  );
  const sidebar = useWorkbenchSidebar({
    workbenchRef,
    dockHostRef,
    apiRef,
    layoutReady,
    presentationReady,
    edgeDrawerRef,
    primaryPanelIds,
    panelTopologyRevision,
    responsiveAutoTuck,
    edges: PAGE_WORKBENCH_EDGES,
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
    ensureGridGroup(event.api);
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
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return undefined;
    return registerDockview?.(api, { kind: 'page', pageId, pageType: pageTypeId }, dockHostRef.current ?? undefined);
  }, [dockReadyRevision, pageId, pageTypeId, registerDockview]);
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return undefined;
    let frame = 0;
    const attachActive = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const id = api.activePanel?.id;
        const panel = id ? api.getPanel(id) : undefined;
        const anchor = panel && [...panel.group.element.querySelectorAll<HTMLElement>('[data-forgeax-view-slot]')]
          .find(node => node.dataset.forgeaxViewSlot === id);
        if (id && anchor && getClaimsSnapshot(slotRegistry).some(claim => claim.id === id)) slotRegistry.resolve(id, anchor);
      });
    };
    const subscription = api.onDidActivePanelChange(attachActive);
    attachActive();
    return () => {
      cancelAnimationFrame(frame);
      subscription.dispose();
    };
  }, [dockReadyRevision, slotRegistry]);
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
    reconcileDockPanels(api, claims, {
      titleFor: titleForClaim,
      preservePanelIds,
      attach: (id: string, anchor?: HTMLElement) => {
        if (getClaimsSnapshot(slotRegistry).some((claim) => claim.id === id)) slotRegistry.resolve(id, anchor);
      },
      availableWidth,
      availableHeight,
    });
    if (!edgeDrawerRef.current && api.panels.length > 0 && dockHostRef.current) {
      const edgeDrawer = installEdgeDrawer(api, dockHostRef.current, { edges: PAGE_WORKBENCH_EDGES });
      edgeDrawerRef.current = edgeDrawer;
      willDropRef.current = edgeDrawer.onWillDrop;
      ueDragDisposeRef.current = installUeDockDrag(api, dockHostRef.current, {
        closeEdgeDrawer: () => edgeDrawerRef.current?.forceClose(),
        edges: PAGE_WORKBENCH_EDGES,
        resolveDropDock,
        onCrossDockDrop,
      });
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
    const nextPanelLayoutSignature = panelLayoutSignature(claims);
    if (panelLayoutSignatureRef.current !== nextPanelLayoutSignature) {
      panelLayoutSignatureRef.current = nextPanelLayoutSignature;
      setPanelTopologyRevision((revision) => revision + 1);
    }
  }, [active, claims, dockExtent.height, dockExtent.width, dockReadyRevision, layoutReady, onCrossDockDrop, resolveDropDock, sidebar.applyNow, slotRegistry, titleForClaim]);
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

function ShellBottomDock({
  claims,
  allClaims,
  slotRegistry,
  titleForClaim,
  registerDockview,
  registerPresentation,
  readPanelPlacement,
  preservePanelIds,
  canDropIntoEmptyEdge,
  onDragOver,
  onDrop,
  resolveDropDock,
  onCrossDockDrop,
}: {
  claims: SlotClaim[];
  allClaims: readonly SlotClaim[];
  slotRegistry: SlotRegistry;
  titleForClaim: (claim: SlotClaim) => string;
  registerDockview: (api: DockviewApi, owner: DockviewOwner, host?: HTMLElement) => () => void;
  registerPresentation: (presentation: ShellPanelPresentation) => () => void;
  readPanelPlacement: ReadPanelPlacement;
  preservePanelIds: Pick<ReadonlySet<string>, 'has'>;
  canDropIntoEmptyEdge: () => boolean;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
  resolveDropDock: NonNullable<UeDragOptions['resolveDropDock']>;
  onCrossDockDrop: NonNullable<UeDragOptions['onCrossDockDrop']>;
}) {
  const { t } = useTranslation();
  const apiRef = useRef<DockviewApi | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const edgeDrawerRef = useRef<EdgeDrawerController | null>(null);
  const ueDragDisposeRef = useRef<(() => void) | null>(null);
  const [ready, setReady] = useState(false);
  const [readyRevision, setReadyRevision] = useState(0);
  const [extent, setExtent] = useState({ width: 0, height: 0 });
  const [dropTargetActive, setDropTargetActive] = useState(false);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    edgeDrawerRef.current?.dispose();
    ueDragDisposeRef.current?.();
    ueDragDisposeRef.current = null;
    edgeDrawerRef.current = hostRef.current
      ? installEdgeDrawer(event.api, hostRef.current, { edges: ['bottom'] })
      : null;
    if (hostRef.current) {
      ueDragDisposeRef.current = installUeDockDrag(event.api, hostRef.current, {
        closeEdgeDrawer: () => edgeDrawerRef.current?.forceClose(),
        edges: ['bottom'],
        resolveDropDock,
        onCrossDockDrop,
      });
    }
    setReady(true);
    setReadyRevision(revision => revision + 1);
  }, [onCrossDockDrop, resolveDropDock]);

  useEffect(() => () => {
    ueDragDisposeRef.current?.();
    ueDragDisposeRef.current = null;
    edgeDrawerRef.current?.dispose();
    edgeDrawerRef.current = null;
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    if (!ready || !api) return undefined;
    return registerDockview(api, { kind: 'shell-bottom' }, hostRef.current ?? undefined);
  }, [ready, readyRevision, registerDockview]);

  useLayoutEffect(() => {
    const isVisible = (slot: string) => {
      const panel = apiRef.current?.getPanel(slot);
      return panel?.api.location.type === 'edge'
        ? edgeDrawerRef.current?.getOpenPanelId() === slot
        : panel?.api.isVisible === true;
    };
    return registerPresentation({
      reveal: slot => edgeDrawerRef.current?.revealPanel(slot) ?? false,
      isVisible,
      read: () => claims.map(claim => {
        const panel = apiRef.current?.getPanel(claim.id);
        return {
          id: claim.id,
          title: titleForClaim(claim),
          mounted: !!panel,
          visible: isVisible(claim.id),
          active: panel?.api.isActive === true,
          placement: readPanelPlacement(apiRef.current, claim.id),
        };
      }),
    });
  }, [claims, readPanelPlacement, registerPresentation, titleForClaim]);

  useLayoutEffect(() => {
    if (!ready || !hostRef.current || typeof ResizeObserver === 'undefined') return undefined;
    const host = hostRef.current;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      setExtent({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => {
    const api = apiRef.current;
    if (!ready || !api) return;
    const width = extent.width || hostRef.current?.clientWidth || 0;
    const height = extent.height || hostRef.current?.clientHeight || 0;
    if (width > 0 && height > 0) api.layout(width, height);
    reconcileDockPanels(api, claims, {
      titleFor: titleForClaim,
      preservePanelIds,
      shellBottom: true,
      attach: (id, anchor) => {
        if (getClaimsSnapshot(slotRegistry).some(claim => claim.id === id)) slotRegistry.resolve(id, anchor);
      },
      availableWidth: width,
      availableHeight: height,
    });
    edgeDrawerRef.current?.refreshBottomSpan();
  }, [claims, extent.height, extent.width, ready, readyRevision, slotRegistry, titleForClaim]);

  useEffect(() => {
    const documentObject = globalThis.document;
    if (!ready || !documentObject) return undefined;
    const updateDropTarget = () => {
      const active = canDropIntoEmptyEdge();
      setDropTargetActive(current => current === active ? current : active);
    };
    const clearDropTarget = () => setDropTargetActive(false);
    documentObject.addEventListener('dragover', updateDropTarget, true);
    documentObject.addEventListener('dragend', clearDropTarget, true);
    documentObject.addEventListener('drop', clearDropTarget, true);
    return () => {
      documentObject.removeEventListener('dragover', updateDropTarget, true);
      documentObject.removeEventListener('dragend', clearDropTarget, true);
      documentObject.removeEventListener('drop', clearDropTarget, true);
    };
  }, [canDropIntoEmptyEdge, ready, readyRevision]);

  const getTabContextMenuItems = useCallback((params: GetTabContextMenuItemsParams) => {
    const claim = allClaims.find(row => row.id === params.panel.id);
    return claim?.closable === false ? [] : [{ label: t('view.dock.close'), action: () => params.panel.api.close() }];
  }, [allClaims, t]);

  return (
    <div className="fx-view-shell-bottom" data-drop-active={dropTargetActive}>
      <div ref={hostRef} className="fx-view-dockview-host fx-view-shell-bottom__host">
        <DockviewReact
          className="fx-view-dockview"
          theme={{ ...themeAbyss, name: 'forgeax-view-abyss', gap: 6, edgeGroupCollapsedSize: 32 }}
          components={{ slot: DockSlot }}
          defaultTabComponent={ForgeaxDockTab}
          onReady={onReady}
          onWillDrop={event => edgeDrawerRef.current?.onWillDrop(event) ?? true}
          getTabContextMenuItems={getTabContextMenuItems}
          disableFloatingGroups={false}
          hideBorders
        />
      </div>
      <div
        className="fx-view-shell-bottom__drop-target"
        aria-hidden="true"
        onDragOver={onDragOver}
        onDrop={onDrop}
      />
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
  onSelectPageType?: (typeId: string, signal?: AbortSignal) => void | Promise<unknown>;
  responsiveAutoTuck?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { theme, preference, setTheme } = useTheme();
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
  const panelPresentations = useRef(new Map<string, PanelPresentation>());
  const shellPanelPresentation = useRef<ShellPanelPresentation | undefined>(undefined);
  const dockviewInstances = useRef(new Map<string, DockviewInstance>());
  const pendingPanelTransferCompletions = useRef(new Map<string, Promise<void>>());
  const [dockviewRevision, setDockviewRevision] = useState(0);
  const claimsRef = useRef(claims);
  claimsRef.current = claims;
  const startPanelTransfer = useCallback((options: Parameters<typeof transferDockPanel>[0]) =>
    trackPanelTransfer(
      pendingPanelTransferCompletions.current,
      options.id,
      () => transferDockPanel(options),
      () => setDockviewRevision(revision => revision + 1),
    ), []);
  const titleForPageType = useCallback(
    (pageType: PageType) => {
      const title = resolvePageTypeTitle(pageType, t);
      const resource = pageType.controller?.getResource?.();
      if (pageType.typeId === 'scene' || !resource || !('asset' in resource)) return title;
      const kindKey = `view.pages.${resource.asset.kind}`;
      const kindLabel = t(kindKey);
      return `[${kindLabel === kindKey ? resource.asset.kind : kindLabel}]${title}`;
    },
    [pageTitleRevision, t],
  );
  const beforeClosePage = useCallback(async (pageId: string) => {
    await panelPresentations.current.get(pageId)?.returnSharedHomePanels();
  }, []);
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
  } = useViewPages(pageTypes, titleForPageType, pageRegistry, beforeClosePage);
  const openPageRef = useRef(openPage);
  openPageRef.current = openPage;
  const registerPanelPresentation = useCallback((pageId: string, presentation: PanelPresentation) => {
    panelPresentations.current.set(pageId, presentation);
    return () => { if (panelPresentations.current.get(pageId) === presentation) panelPresentations.current.delete(pageId); };
  }, []);
  const registerShellPanelPresentation = useCallback((presentation: ShellPanelPresentation) => {
    shellPanelPresentation.current = presentation;
    return () => { if (shellPanelPresentation.current === presentation) shellPanelPresentation.current = undefined; };
  }, []);
  useEffect(() => panelHost?.setRevealer(async (slot, signal) => {
    if (signal?.aborted) return false;
    const claim = claimsRef.current.find(item => item.id === slot);
    if (!claim) return false;
    const mounted = [...dockviewInstances.current.values()].find(instance => instance.api.getPanel(slot));
    if (mounted?.owner.kind === 'shell-bottom') {
      return shellPanelPresentation.current?.reveal(slot) ?? false;
    }
    const targetPageId = mounted?.owner.kind === 'page' ? mounted.owner.pageId : undefined;
    const targetPageType = mounted?.owner.kind === 'page' ? mounted.owner.pageType
      : claim.home.kind === 'page' ? claim.home.pageType : undefined;
    if (!targetPageType) {
      for (let attempt = 0; attempt < 80; attempt++) {
        if (signal?.aborted) return false;
        if (shellPanelPresentation.current?.reveal(slot)) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    }
    const existing = targetPageId
      ? pages.find(page => page.id === targetPageId)
      : pages.find(page => page.id === activePageId && page.typeId === targetPageType) ?? pages.find(page => page.typeId === targetPageType);
    if (existing) selectLocalPage(existing.id);
    else openPageRef.current(targetPageType);
    await onSelectPageType?.(targetPageType, signal);
    for (let attempt = 0; attempt < 80; attempt++) {
      if (signal?.aborted) return false;
      const presentation = existing ? panelPresentations.current.get(existing.id)
        : [...panelPresentations.current.values()].find(owner => owner.pageType === targetPageType);
      if (presentation?.reveal(slot)) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }), [activePageId, onSelectPageType, pages, panelHost, selectLocalPage]);
  useEffect(() => panelHost?.setEdgeDismisser(slot => {
    for (const presentation of panelPresentations.current.values()) {
      if (presentation.dismissUnpinnedEdge(slot)) return true;
    }
    return false;
  }), [panelHost]);
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
  const selectPage = (pageId: string, signal?: AbortSignal) => {
    selectLocalPage(pageId);
    const page = pages.find(page => page.id === pageId);
    if (page) return onSelectPageType?.(page.typeId, signal);
  };
  // This lease reads committed Shell/Dock owners; it stores no second UI model.
  const presentationOwner = useRef<PresentationOwner | undefined>(undefined);
  useLayoutEffect(() => {
    const read = (): PresentationSnapshot => ({
      shellState: requiresProject && projectSession.restoring ? 'project-restoring' : 'mounted',
      activePageId,
      pages: pages.map(page => {
        const resource = pageTypes.find(type => type.typeId === page.typeId)?.controller?.getResource?.();
        return { id: page.id, typeId: page.typeId, title: page.title, closable: page.closable !== false, ...(resource ? { resource } : {}) };
      }),
      pageTypes: pageTypes.map(type => ({ typeId: type.typeId, title: resolvePageTypeLabel(type, t), openable: type.openable })),
      panels: (() => {
        const panels = new Map((activePage ? panelPresentations.current.get(activePage.id)?.read() ?? [] : []).map(panel => [panel.id, panel]));
        for (const claim of claims) {
          if (claim.home.kind !== 'shell-bottom') continue;
          const instance = [...dockviewInstances.current.values()].find(candidate => candidate.api.getPanel(claim.id));
          const panel = instance?.owner.kind === 'shell-bottom'
            ? shellPanelPresentation.current?.read().find(item => item.id === claim.id)
            : instance?.owner.kind === 'page'
              ? panelPresentations.current.get(instance.owner.pageId)?.read().find(item => item.id === claim.id)
              : undefined;
          const runtimePanel = instance?.api.getPanel(claim.id);
          panels.set(claim.id, panel ?? {
            id: claim.id,
            title: titleForClaim(claim),
            mounted: runtimePanel !== undefined,
            visible: instance?.owner.kind === 'page'
              ? instance.owner.pageId === activePageId && runtimePanel?.api.isVisible === true
              : instance?.owner.kind === 'shell-bottom' && shellPanelPresentation.current?.isVisible(claim.id) === true,
            active: runtimePanel?.api.isActive === true,
            placement: panelPlacementFor(instance?.owner, runtimePanel?.api.location.type),
          });
        }
        return [...panels.values()];
      })(),
      hasMorePages: false, hasMorePageTypes: false, hasMorePanels: false,
      appearance: { theme, preference, language: i18n.language },
    });
    presentationOwner.current = async (operation, args, signal) => {
      if (signal.aborted) throw workspaceError('view-presentation-cancelled', 'an active presentation request', 'Read presentation.get before retrying.');
      if (operation === 'presentation.get') return read();
      if (operation === 'presentation.panel.reveal') {
        const id = typeof args.panelId === 'string' ? args.panelId : '';
        const claim = claims.find(row => row.id === id);
        if (!claim || !panelHost?.reveal) throw workspaceError('view-presentation-panel-missing', 'a registered panel ID', 'Read presentation.get.');
        if (signal.aborted) throw workspaceError('view-presentation-cancelled', 'an active presentation request', 'Read presentation.get before retrying.');
        if (!await panelHost.reveal(id, { signal })) throw workspaceError('view-presentation-panel-unavailable', 'a mounted native panel', 'Wait for the panel to mount and read presentation.get.');
      } else {
        const page = pages.find(row => row.id === args.pageId);
        const type = pageTypes.find(row => row.typeId === args.typeId);
        if (operation === 'presentation.page.open') {
          if (!type?.openable)
            throw workspaceError('view-presentation-page-unavailable', 'an openable page type', 'Read presentation.get and choose a returned page type.');
        } else if (!page) throw workspaceError('view-presentation-page-missing', 'an existing page ID', 'Read presentation.get.');
        if (operation === 'presentation.page.close' && page?.closable === false)
          throw workspaceError('view-presentation-page-required', 'a closable page', 'Keep required workspace pages open.');
        let activation: unknown;
        flushSync(() => {
          if (operation === 'presentation.page.open') { openPage(type!.typeId); activation = onSelectPageType?.(type!.typeId, signal); }
          else if (operation === 'presentation.page.select') activation = selectPage(page!.id, signal);
          else if (operation === 'presentation.page.close') activation = closePage(page!.id, signal);
        });
        await activation;
        flushSync(() => {});
      }
      return presentationOwner.current!('presentation.get', {}, signal);
    };
  });
  useEffect(() => pageHost?.attachPresentation?.((operation, args, signal) => presentationOwner.current!(operation, args, signal)), [pageHost]);
  const openDockPages = useMemo(
    () => pages.filter((page) => page.pageType.layout === 'dock'),
    [pages],
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
      .map((pageType) => ({ typeId: pageType.typeId, title: resolvePageTypeLabel(pageType, t) })),
    [pageTypes, pages, t],
  );
  const titleForClaim = useCallback(
    (claim: SlotClaim) => (claim.titleKey ? t(claim.titleKey) : claim.id),
    [i18n.language, t],
  );

  const resolveDropDock = useCallback((point: { x: number; y: number }, sourceApi: DockviewApi, panelId: string) => {
    const sourceOwner = dockviewInstances.current.get(sourceApi.id)?.owner;
    const claim = shellHomeClaimForPanel(panelId, claimsRef.current);
    for (const instance of dockviewInstances.current.values()) {
      const host = instance.host;
      if (instance.api === sourceApi || !host) continue;
      const pageRow = host.closest<HTMLElement>('.fx-view-workspace-row');
      if (pageRow && !pageRow.classList.contains('is-active')) continue;
      const rect = host.getBoundingClientRect();
      if (point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) continue;
      if (!canTransferPanelBetweenDocks(sourceOwner, instance.owner, claim)) return null;
      return {
        api: instance.api,
        host,
        edges: instance.owner.kind === 'page' ? PAGE_WORKBENCH_EDGES : ['bottom'] as const,
      };
    }
    const source = dockviewInstances.current.get(sourceApi.id);
    if (source?.host) {
      const sourceHost = source.host;
      const rect = sourceHost.getBoundingClientRect();
      if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) {
        return {
          api: sourceApi,
          host: sourceHost,
          edges: source.owner.kind === 'page' ? PAGE_WORKBENCH_EDGES : ['bottom'] as const,
        };
      }
    }
    return null;
  }, []);

  const onCrossDockDrop = useCallback(async ({
    sourceApi,
    targetApi,
    panelId,
    position,
    sourceWasEdge,
  }: Parameters<NonNullable<UeDragOptions['onCrossDockDrop']>>[0]) => {
    const sourceOwner = dockviewInstances.current.get(sourceApi.id)?.owner;
    const targetOwner = dockviewInstances.current.get(targetApi.id)?.owner;
    const claim = shellHomeClaimForPanel(panelId, claimsRef.current);
    if (!claim || !canTransferPanelBetweenDocks(sourceOwner, targetOwner, claim)
      || pendingPanelTransferCompletions.current.has(panelId)) return false;
    try {
      return await startPanelTransfer({
        sourceApi,
        targetApi,
        id: panelId,
        claim,
        registry: slotRegistry,
        title: titleForClaim(claim),
        position,
        sourceWasEdge,
      });
    } catch (error) {
      reportWorkspaceCommandError(error, { operation: 'view.panel.transfer' });
      throw error;
    }
  }, [slotRegistry, startPanelTransfer, titleForClaim]);

  const registerDockview = useCallback((api: DockviewApi, owner: DockviewOwner, host?: HTMLElement) => {
    const instance = { api, owner, host } satisfies DockviewInstance;
    dockviewInstances.current.set(api.id, instance);
    const onUnhandledDragOver = api.onUnhandledDragOverEvent(event => {
      const source = transferSourceFor(event.getData(), api, dockviewInstances.current, claimsRef.current);
      if (source && event.group) event.accept();
    });
    const onDidDrop = api.onDidDrop(event => {
      const source = transferSourceFor(event.getData(), api, dockviewInstances.current, claimsRef.current);
      if (!source || pendingPanelTransferCompletions.current.has(source.panelId)) return;
      void startPanelTransfer({
        sourceApi: source.source,
        targetApi: api,
        id: source.panelId,
        claim: source.claim,
        registry: slotRegistry,
        title: titleForClaim(source.claim),
        position: panelPositionForDrop(event),
      }).catch(error => reportWorkspaceCommandError(error, { operation: 'view.panel.transfer' }));
    });
    setDockviewRevision(revision => revision + 1);
    return () => {
      onUnhandledDragOver.dispose();
      onDidDrop.dispose();
      if (dockviewInstances.current.get(api.id) === instance) dockviewInstances.current.delete(api.id);
      queueMicrotask(() => {
        if (dockviewInstances.current.size > 0 && !dockviewInstances.current.has(api.id)) {
          setDockviewRevision(revision => revision + 1);
        }
      });
    };
  }, [slotRegistry, startPanelTransfer, titleForClaim]);

  const returnSharedHomePanels = useCallback(async (sourceApi: DockviewApi) => {
    const candidates = [...sourceApi.panels].flatMap(panel => {
      const claim = claimsRef.current.find(candidate => candidate.id === panel.id && candidate.home.kind === 'shell-bottom');
      return claim ? [{ id: panel.id, claim }] : [];
    });
    if (candidates.length === 0) return;
    const shell = [...dockviewInstances.current.values()].find(instance => instance.owner.kind === 'shell-bottom');
    if (!shell) throw new Error('View Shell bottom dock is not ready');
    for (const { id, claim } of candidates) {
      const pending = pendingPanelTransferCompletions.current.get(id);
      if (pending) await pending;
      if (!sourceApi.getPanel(id) || shell.api.getPanel(id)) continue;
      await startPanelTransfer({
        sourceApi,
        targetApi: shell.api,
        id,
        claim,
        registry: slotRegistry,
        title: titleForClaim(claim),
        position: shellBottomPosition(shell.api),
      });
    }
  }, [slotRegistry, startPanelTransfer, titleForClaim]);

  const canDropIntoEmptyShellEdge = useCallback(() => {
    const shell = [...dockviewInstances.current.values()].find(instance => instance.owner.kind === 'shell-bottom');
    const edgeGroup = shell && bottomEdgeGroup(shell.api);
    if (!shell || !edgeGroup || edgeGroup.panels.length > 0) return false;
    const source = transferSourceFor(getPanelData(), shell.api, dockviewInstances.current, claimsRef.current);
    return Boolean(source && !pendingPanelTransferCompletions.current.has(source.panelId));
  }, []);

  const onShellBottomDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!canDropIntoEmptyShellEdge()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, [canDropIntoEmptyShellEdge]);

  const onShellBottomDrop = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!canDropIntoEmptyShellEdge()) return;
    const shell = [...dockviewInstances.current.values()].find(instance => instance.owner.kind === 'shell-bottom');
    const source = shell && transferSourceFor(getPanelData(), shell.api, dockviewInstances.current, claimsRef.current);
    if (!shell || !source || pendingPanelTransferCompletions.current.has(source.panelId)) return;
    event.preventDefault();
    event.stopPropagation();
    void startPanelTransfer({
      sourceApi: source.source,
      targetApi: shell.api,
      id: source.panelId,
      claim: source.claim,
      registry: slotRegistry,
      title: titleForClaim(source.claim),
      position: shellBottomPosition(shell.api),
    }).then(moved => {
      if (moved) shellPanelPresentation.current?.reveal(source.panelId);
    }).catch(error => reportWorkspaceCommandError(error, { operation: 'view.panel.transfer' }));
  }, [canDropIntoEmptyShellEdge, slotRegistry, startPanelTransfer, titleForClaim]);

  const readPanelPlacement = useCallback((api: DockviewApi | null, panelId: string) => {
    const panel = api?.getPanel(panelId);
    return panelPlacementFor(api ? dockviewInstances.current.get(api.id)?.owner : undefined, panel?.api.location.type);
  }, []);

  const pageClaimsFor = useCallback((pageId: string, pageTypeId: string) => {
    const api = [...dockviewInstances.current.values()].find(instance =>
      instance.owner.kind === 'page' && instance.owner.pageId === pageId)?.api;
    return claimsForPage(claims, pageTypeId, api);
  }, [claims, dockviewRevision]);
  const shellClaims = useMemo(() => {
    const shell = [...dockviewInstances.current.values()].find(instance => instance.owner.kind === 'shell-bottom')?.api;
    return claims.filter(claim => claim.home.kind === 'shell-bottom' && (
      pendingPanelTransferCompletions.current.has(claim.id) ||
      shell?.getPanel(claim.id) !== undefined ||
      ![...dockviewInstances.current.values()].some(instance =>
        instance.owner.kind === 'page' && instance.api.getPanel(claim.id) !== undefined)
    ));
  }, [claims, dockviewRevision]);

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
        onSelect={id => { void Promise.resolve(selectPage(id)).catch(() => {}); }}
        onClose={id => { void closePage(id).catch(error => reportWorkspaceCommandError(error)); }}
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
      ) : (
      <div className="fx-view-main-col">
        {openDockPages.map((page) => {
          const status = pageTypes.find(type => type.typeId === page.typeId)?.controller?.getStatus?.();
          return (<div key={page.id} style={{ display: page.id === activePageId ? 'flex' : 'none', flex: '1 1 0', minWidth: 0, minHeight: 0, position: 'relative' }}>
          <DockPageWorkbench
            key={page.id}
            pageId={page.id}
            pageTypeId={page.typeId}
            registerPanelPresentation={registerPanelPresentation}
            registerDockview={registerDockview}
            returnSharedHomePanels={returnSharedHomePanels}
            readPanelPlacement={readPanelPlacement}
            preservePanelIds={pendingPanelTransferCompletions.current}
            resolveDropDock={resolveDropDock}
            onCrossDockDrop={onCrossDockDrop}
            claims={pageClaimsFor(page.id, page.typeId)}
            slotRegistry={slotRegistry}
            titleForClaim={titleForClaim}
            active={page.id === activePageId}
            responsiveAutoTuck={responsiveAutoTuck}
            hideWhenInactive={page.pageType.hideWhenInactive === true}
            layoutHostId={page.typeId === VIEW_PAGE_TYPES.scene ? VIEW_LAYOUT_HOST_ID : undefined}
          />
          {status && <div className="fx-resource-page-status" role={status.phase === 'opening' ? 'status' : 'alert'} data-phase={status.phase}>
            {status.phase === 'opening' ? t('view.resourceOpening') : status.message ?? t('view.resourceFailed')}
          </div>}
          </div>);
        })}
        {openSurfacePageTypes.map((pageType) => (
          <PageSurface
            key={pageType.typeId}
            pageType={pageType}
            pageRegistry={pageRegistry}
            active={activePage?.typeId === pageType.typeId}
          />
        ))}
      </div>
      )}
      <ShellBottomDock
        claims={shellClaims}
        allClaims={claims}
        slotRegistry={slotRegistry}
        titleForClaim={titleForClaim}
        registerDockview={registerDockview}
        registerPresentation={registerShellPanelPresentation}
        readPanelPlacement={readPanelPlacement}
        preservePanelIds={pendingPanelTransferCompletions.current}
        canDropIntoEmptyEdge={canDropIntoEmptyShellEdge}
        onDragOver={onShellBottomDragOver}
        onDrop={onShellBottomDrop}
        resolveDropDock={resolveDropDock}
        onCrossDockDrop={onCrossDockDrop}
      />
    </div>
  );
}
