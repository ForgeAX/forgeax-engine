import type { WorkspaceOpenRequest } from './contract.ts';
export type ViewFileOpenRequest = { requestId: string; sequence: number; file: { path: string; extension: string; projectId: string } };
export type PageResourceOpenRequest = WorkspaceOpenRequest | ViewFileOpenRequest;

export type Dispose = () => void | Promise<void>;
export type PanelLayout = {
  dock: 'fill' | 'top' | 'bottom' | 'left' | 'right';
  size?: { value: number; unit: 'px' | 'fraction' };
  stack: 'tabs' | 'split'; order: number;
};
export type PanelClaim = {
  id: string; slot?: string; pageType: string; titleKey?: string; closable?: boolean; dockTitleHidden?: boolean;
  activity?: { labelKey?: string; icon?: string }; layout: PanelLayout;
};
export type PanelMount = PanelClaim & { panel: string; props?: Record<string, unknown> };
export type PageController = {
  getTitle?: () => string | undefined; subscribeTitle?: (listener: () => void) => () => void; dispose?: () => void;
};
export type ResourceSelector = { kinds: readonly string[]; fallback?: never; extensions?: never } | { extensions: readonly string[]; kinds?: never; fallback?: never } | { fallback: true; kinds?: never; extensions?: never };
export type PageType = {
  typeId: string; context: 'project' | 'artifact'; titleKey?: string; title?: string; order: number;
  closable: boolean; singleton: boolean; initial: boolean; openable: boolean;
  layout: 'dock' | 'surface'; showPanelRail: boolean; hideWhenInactive: boolean;
  resourceSelector?: ResourceSelector; priority?: number; controller?: PageController;
};
export type PageTypeContribution = Omit<PageType, 'controller'> & { createController?: () => PageController | undefined };
export type PageHost = {
  registerType(type: PageTypeContribution): () => void;
  mount(typeId: string, node: HTMLElement): () => void;
  openResource(input: PageResourceOpenRequest): PageResourceOpenRequest;
  subscribeResourceOpen(listener: (request: PageResourceOpenRequest) => void): () => void;
};
export type SlotRegistry = {
  subscribe(listener: (claims: readonly PanelClaim[]) => void): () => void;
  getClaims(): readonly PanelClaim[];
  claim(claim: PanelClaim): () => void;
  resolve(id: string): HTMLElement;
  resolveWhenReady(id: string): Promise<HTMLElement>;
  mount(id: string, child: HTMLElement): () => void;
};
export type PanelHost = {
  registry: SlotRegistry;
  waitForSlot(slot: string): Promise<HTMLElement>;
  mount(slot: string, node: HTMLElement): () => void;
  claim(claim: PanelClaim): () => void;
  mountPanel(options: PanelMount): Promise<Dispose>;
  mountPanelInto(options: { element: HTMLElement; panel: string; props?: Record<string, unknown> }): Promise<Dispose>;
  reveal?(slot: string): Promise<boolean>;
};
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
  }
}
