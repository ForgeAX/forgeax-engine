import type { WorkspaceAsset, WorkspaceOpenRequest } from './contract.ts';
import type { AssetReferenceService } from './asset-references.ts';
import type { PresentationOwner, PresentationResource } from './presentation.ts';
export type { PanelDockLocation, PanelPlacement, PresentationOwner, PresentationSnapshot } from './presentation.ts';
export type ViewFileOpenRequest = { requestId: string; sequence: number; file: { path: string; extension: string; projectId: string } };
export type PageResourceOpenRequest = WorkspaceOpenRequest | ViewFileOpenRequest;

export type Dispose = () => void | Promise<void>;
export type PanelLayout = {
  dock: 'fill' | 'top' | 'bottom' | 'left' | 'right' | 'right-bottom';
  size?: { value: number; unit: 'px' | 'fraction'; additionalPx?: number };
  stack: 'tabs' | 'split'; order: number;
};
type PanelClaimFields = {
  id: string; slot?: string; titleKey?: string; closable?: boolean; dockTitleHidden?: boolean;
  activity?: { labelKey?: string; icon?: string };
};
export type PanelClaim =
  | (PanelClaimFields & { home: { kind: 'page'; pageType: string }; layout: PanelLayout })
  | (PanelClaimFields & { home: { kind: 'shell-bottom' }; layout: { order: number } });
export type PanelMount = PanelClaim & { panel: string; props?: Record<string, unknown> };
export type AssetPanelMount = Omit<PanelClaimFields, 'id' | 'slot'> & { layout: PanelLayout; id: string; kinds: readonly string[]; panel: string; props?: Record<string, unknown> };
export type PageController = {
  beforeClose?: (signal: AbortSignal) => void | Promise<void>;
  getStatus?: () => { phase: 'opening' | 'failed'; message?: string } | undefined;
  getResource?: () => PresentationResource | undefined;
  getTitle?: () => string | undefined; subscribeTitle?: (listener: () => void) => () => void; dispose?: () => void;
};
export type ResourceSelector = { kinds: readonly string[]; fallback?: never; extensions?: never } | { extensions: readonly string[]; kinds?: never; fallback?: never } | { fallback: true; kinds?: never; extensions?: never };
export type PageType = {
  typeId: string; context: 'project' | 'artifact'; titleKey?: string; title?: string; order: number;
  closable: boolean; singleton: boolean; initial: boolean; openable: boolean;
  layout: 'dock' | 'surface'; showPanelRail: boolean; hideWhenInactive: boolean;
  resourceSelector?: ResourceSelector; priority?: number; controller?: PageController;
  resourcePresentation?: 'preview' | 'details';
};
export type PageTypeContribution = Omit<PageType, 'controller'> & { createController?: () => PageController | undefined };
export type PageHost = {
  attachPresentation?(owner: PresentationOwner): () => void;
  callPresentation?: PresentationOwner;
  registerType(type: PageTypeContribution): () => void;
  mount(typeId: string, node: HTMLElement): () => void;
  openResource(input: PageResourceOpenRequest): PageResourceOpenRequest;
  subscribeResourceOpen(listener: (request: PageResourceOpenRequest) => void): () => void;
  getAssetPresentation?(asset: Pick<WorkspaceAsset, 'kind'>): 'preview' | 'details' | undefined;
};
export type PageTypeRegistry = {
  getTypes(): readonly PageType[];
  subscribe(listener: (types: readonly PageType[]) => void): () => void;
  onBeforeClose(typeId: string, listener: (signal: AbortSignal) => void | Promise<void>): Dispose;
  beforeClose(typeId: string, signal: AbortSignal): Promise<void>;
};
export type SlotRegistry = {
  subscribe(listener: (claims: readonly PanelClaim[]) => void): () => void;
  getClaims(): readonly PanelClaim[];
  claim(claim: PanelClaim): () => void;
  resolve(id: string, anchor?: HTMLElement): HTMLElement;
  resolveWhenReady(id: string): Promise<HTMLElement>;
  mount(id: string, child: HTMLElement): () => void;
};
export type PanelHost = {
  registry: SlotRegistry;
  waitForSlot(slot: string): Promise<HTMLElement>;
  mount(slot: string, node: HTMLElement): () => void;
  claim(claim: PanelClaim): () => void;
  mountPanel(options: PanelMount): Promise<Dispose>;
  mountAssetPanel(options: AssetPanelMount): Dispose;
  mountPanelInto(options: { element: HTMLElement; panel: string; props?: Record<string, unknown> }): Promise<Dispose>;
  reveal?(slot: string, options?: { signal?: AbortSignal }): Promise<boolean>;
  dismissUnpinnedEdge?(slot: string): boolean;
};

export type ContentBrowserDetailContext = { client: import('./client.ts').ViewWorkspaceClient; sourcePath: string; addConversationReference?: (reference: { title: string; text: string }) => Promise<void> };
export type ContentBrowserDetailContribution = {
  id: string; titleKey: string;
  matches(input: { kind: 'file' | 'asset'; path: string; assetKind?: string }): boolean;
  mount(element: HTMLElement, context: ContentBrowserDetailContext): Dispose | Promise<Dispose>;
};
export type ContentBrowserDetailTabs = {
  register(contribution: ContentBrowserDetailContribution): Dispose;
  getSnapshot(): readonly ContentBrowserDetailContribution[];
  subscribe(listener: () => void): () => void;
};
export type AssetBrowserReveal = { projectId: string; guid: string; targetId: string; targetGeneration?: number };
export type AssetBrowserService = {
  available(): boolean;
  revealAsset(input: AssetBrowserReveal): Promise<boolean>;
};
export type ResourceAssetActionResolver = (value: unknown) => { onOpen?: () => void; onBrowse?: () => void } | undefined;
export type ResourceIdentity = {
  PAGE_TYPE: string; PAGE_TITLE_I18N_KEY: string; PAGE_ORDER: number; RESOURCE_SELECTOR: ResourceSelector; PAGE_PRIORITY?: number;
  PREVIEW_SLOT?: string; PREVIEW_TITLE_I18N_KEY?: string; PREVIEW_ICON?: string; PREVIEW_LAYOUT?: PanelLayout; PREVIEW_PANEL?: string;
  PROPERTIES_SLOT: string; PROPERTIES_TITLE_I18N_KEY: string; PROPERTIES_ICON: string; PROPERTIES_LAYOUT: PanelLayout; PROPERTIES_PANEL: string;
};
export type ViewLayoutConfig = { responsiveAutoTuck?: boolean };
export type FrontendConfig = { pageHost?: PageHost; panelHost?: PanelHost; document?: Document; layout?: ViewLayoutConfig };

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    pageHost: PageHost;
    panelHost: PanelHost;
    viewSlotRegistry: SlotRegistry;
    viewAssetBrowser?: AssetBrowserService;
    viewAssetReferences?: AssetReferenceService;
    contentBrowserDetailTabs: ContentBrowserDetailTabs;
  }
}
