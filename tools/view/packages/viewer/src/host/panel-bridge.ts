import type { FrontendPlatform } from '@forgeax/engine-host/platform';
import type { SlotRegistry, PanelClaim, PanelMount, Dispose, AssetPanelMount, PageTypeRegistry } from '@forgeax/view-workspace-core/frontend-contract';
import { reportWorkspaceCommandError } from '@forgeax/view-workspace-core/command-error';
type PanelModule = Record<string, (input: Record<string, unknown> & { mountElement: HTMLElement }) => Dispose | Promise<Dispose>>;
export async function loadViewPanels() {
  const pending = globalThis.__forgeaxViewPanelsPromise;
  if (pending) {
    try {
      return await pending as PanelModule;
    } catch (error) {
      throw new Error('View panels development bundle failed to load', { cause: error });
    }
  }
  const href = globalThis.__forgeaxViewPanelsUrl ?? '/panels.js';
  try {
    return await import(/* @vite-ignore */ href) as PanelModule;
  } catch (error) {
    throw new Error(`View panels bundle failed to load from ${href}`, { cause: error });
  }
}

export async function waitForViewSlot(registry: SlotRegistry, slot: string) {
  if (typeof registry?.resolveWhenReady === 'function') {
    return registry.resolveWhenReady(slot);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  return registry.resolve(slot);
}

export async function mountViewReactPanel({ registry, id, slot, home, titleKey, dockTitleHidden, activity, layout, panel, props }: PanelMount & { registry: SlotRegistry }) {
  if (!registry) throw new TypeError('mountViewReactPanel requires viewSlotRegistry');
  id ??= slot!;
  const unclaim = registry.claim({ id, home, titleKey, dockTitleHidden, activity, layout } as PanelClaim);
  try {
    const mountElement = await waitForViewSlot(registry, id);
    const panels = await loadViewPanels();
    const mountName = `mount${panel}Panel`;
    if (typeof panels[mountName] !== 'function') {
      throw new Error(`View panels bundle is missing ${mountName}`);
    }
    const unmountPanel = await panels[mountName]({
      slot: id,
      ...props,
      mountElement,
    });
    return async () => {
      await unmountPanel?.();
      unclaim();
    };
  } catch (error) {
    unclaim();
    throw error;
  }
}

export async function mountViewReactPanelInto({ element, panel, props }: { element: HTMLElement; panel: string; props?: Record<string, unknown> }) {
  if (!element) throw new TypeError('mountViewReactPanelInto requires element');
  const panels = await loadViewPanels();
  const mountName = `mount${panel}Panel`;
  if (typeof panels[mountName] !== 'function') {
    throw new Error(`View panels bundle is missing ${mountName}`);
  }
  return panels[mountName]({ ...props, mountElement: element });
}

export function createViewPanelHost({ registry, pageRegistry, overlayRoot, platform }: { registry: SlotRegistry; pageRegistry: PageTypeRegistry; overlayRoot?: HTMLElement; platform?: FrontendPlatform }) {
  if (!registry) throw new TypeError('createViewPanelHost requires viewSlotRegistry');
  let revealer: ((slot: string, signal?: AbortSignal) => Promise<boolean>) | undefined;
  let edgeDismisser: ((slot: string) => boolean) | undefined;
  const matches = (options: AssetPanelMount, type: ReturnType<PageTypeRegistry['getTypes']>[number]) => {
    const selector = type.resourceSelector;
    if (selector?.kinds) return selector.kinds.some(kind => options.kinds.includes(kind));
    if (selector?.fallback) {
      const resource = type.controller?.getResource?.();
      return !!resource && 'asset' in resource && options.kinds.includes(resource.asset.kind);
    }
    return false;
  };
  const mountAssetPanel = (options: AssetPanelMount): Dispose => {
    if (!options.id || !Array.isArray(options.kinds) || !options.kinds.length || options.kinds.some(kind => typeof kind !== 'string' || !kind)) throw new TypeError('asset panel requires id and supported kinds');
    let active = true;
    const mounted = new Map<string, { dispose?: Dispose; token: object }>();
    const resourceUnsubs = new Map<string, () => void>();
    const reconcile = (types = pageRegistry.getTypes()) => {
      const currentFallbacks = new Set(types.filter(type => type.resourceSelector?.fallback).map(type => type.typeId));
      for (const [typeId, unsubscribe] of resourceUnsubs) if (!currentFallbacks.has(typeId)) { unsubscribe(); resourceUnsubs.delete(typeId); }
      for (const type of types) {
        if (currentFallbacks.has(type.typeId) && !resourceUnsubs.has(type.typeId)) {
          resourceUnsubs.set(type.typeId, () => {});
          const unsubscribe = type.controller?.subscribeTitle?.(() => reconcile()) ?? (() => {});
          resourceUnsubs.set(type.typeId, unsubscribe);
        }
      }
      const supported = new Set(types.filter(type => matches(options, type)).map(type => type.typeId));
      for (const [typeId, state] of mounted) if (!supported.has(typeId)) {
        mounted.delete(typeId);
        void state.dispose?.();
      }
      for (const type of types) {
        if (!supported.has(type.typeId) || mounted.has(type.typeId)) continue;
        const token = {};
        const id = `${options.id}:${type.typeId}`;
        const state: { dispose?: Dispose; token: object } = { token };
        mounted.set(type.typeId, state);
        void mountViewReactPanel({ registry, ...options, id, home: { kind: 'page', pageType: type.typeId }, props: {
          ...options.props,
          assetPage: {
            pageTypeId: type.typeId,
            getResource: () => pageRegistry.getTypes().find(current => current.typeId === type.typeId)?.controller?.getResource?.(),
            subscribe: (listener: () => void) => pageRegistry.getTypes().find(current => current.typeId === type.typeId)?.controller?.subscribeTitle?.(listener) ?? (() => {}),
            onBeforeClose: (listener: (signal: AbortSignal) => void | Promise<void>) => pageRegistry.onBeforeClose(type.typeId, listener),
          },
          overlayRoot, writeClipboard: platform?.writeClipboard, addConversationReference: platform?.addConversationReference,
        } }).then(dispose => {
          if (!active || mounted.get(type.typeId)?.token !== token) void dispose();
          else state.dispose = dispose;
        }).catch(error => {
          reportWorkspaceCommandError(error, { operation: 'view.panel.mount' });
          if (mounted.get(type.typeId)?.token === token) mounted.delete(type.typeId);
        });
      }
    };
    const unsubscribe = pageRegistry.subscribe(reconcile);
    const release = () => {
      if (!active) return;
      active = false;
      unsubscribe();
      for (const stop of resourceUnsubs.values()) stop();
      resourceUnsubs.clear();
      for (const state of mounted.values()) void state.dispose?.();
      mounted.clear();
    };
    return release;
  };
  return Object.freeze({
    registry,
    setRevealer(next: (slot: string, signal?: AbortSignal) => Promise<boolean>) {
      revealer = next;
      return () => { if (revealer === next) revealer = undefined; };
    },
    setEdgeDismisser(next: (slot: string) => boolean) {
      edgeDismisser = next;
      return () => { if (edgeDismisser === next) edgeDismisser = undefined; };
    },
    reveal(slot: string, options?: { signal?: AbortSignal }) { return revealer?.(slot, options?.signal) ?? Promise.resolve(false); },
    dismissUnpinnedEdge(slot: string) { return edgeDismisser?.(slot) ?? false; },
    waitForSlot: (slot: string) => waitForViewSlot(registry, slot),
    mount(slot: string, node: HTMLElement) {
      return registry.mount(slot, node);
    },
    claim(claim: PanelClaim) {
      return registry.claim(claim);
    },
    mountAssetPanel,
    mountPanel(options: PanelMount) {
      return mountViewReactPanel({ registry, ...options, props: { ...options.props, overlayRoot, writeClipboard: platform?.writeClipboard, addConversationReference: platform?.addConversationReference } });
    },
    mountPanelInto(options: { element: HTMLElement; panel: string; props?: Record<string, unknown> }) {
      return mountViewReactPanelInto({ ...options, props: { ...options.props, overlayRoot, writeClipboard: platform?.writeClipboard, addConversationReference: platform?.addConversationReference } });
    },
  });
}
