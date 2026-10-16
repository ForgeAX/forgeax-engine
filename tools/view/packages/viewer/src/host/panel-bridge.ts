import type { FrontendPlatform } from '@forgeax/engine-host/platform';
import type { SlotRegistry, PanelClaim, PanelMount, Dispose } from '@forgeax/view-workspace-core/frontend-contract';
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

export async function mountViewReactPanel({ registry, id, slot, pageType, titleKey, dockTitleHidden, activity, layout, panel, props }: PanelMount & { registry: SlotRegistry }) {
  if (!registry) throw new TypeError('mountViewReactPanel requires viewSlotRegistry');
  id ??= slot!;
  if (typeof pageType !== 'string' || pageType.trim() === '') {
    throw new TypeError('mountViewReactPanel requires pageType');
  }
  const unclaim = registry.claim({ id, pageType, titleKey, dockTitleHidden, activity, layout });
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

export function createViewPanelHost({ registry, overlayRoot, platform }: { registry: SlotRegistry; overlayRoot?: HTMLElement; platform?: FrontendPlatform }) {
  if (!registry) throw new TypeError('createViewPanelHost requires viewSlotRegistry');
  let revealer: ((slot: string, signal?: AbortSignal) => Promise<boolean>) | undefined;
  return Object.freeze({
    registry,
    setRevealer(next: (slot: string, signal?: AbortSignal) => Promise<boolean>) {
      revealer = next;
      return () => { if (revealer === next) revealer = undefined; };
    },
    reveal(slot: string, options?: { signal?: AbortSignal }) { return revealer?.(slot, options?.signal) ?? Promise.resolve(false); },
    waitForSlot: (slot: string) => waitForViewSlot(registry, slot),
    mount(slot: string, node: HTMLElement) {
      return registry.mount(slot, node);
    },
    claim(claim: PanelClaim) {
      return registry.claim(claim);
    },
    mountPanel(options: PanelMount) {
      return mountViewReactPanel({ registry, ...options, props: { ...options.props, overlayRoot, writeClipboard: platform?.writeClipboard, addConversationReference: platform?.addConversationReference } });
    },
    mountPanelInto(options: { element: HTMLElement; panel: string; props?: Record<string, unknown> }) {
      return mountViewReactPanelInto({ ...options, props: { ...options.props, overlayRoot, writeClipboard: platform?.writeClipboard, addConversationReference: platform?.addConversationReference } });
    },
  });
}
