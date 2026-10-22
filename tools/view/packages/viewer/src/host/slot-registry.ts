import type { PanelClaim, PanelLayout } from '@forgeax/view-workspace-core/frontend-contract';
const PANEL_DOCKS = new Set(['fill', 'top', 'bottom', 'left', 'right', 'right-bottom']);
const PANEL_STACKS = new Set(['tabs', 'split']);

function normalizeLayout(layout: PanelLayout | undefined) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    throw new TypeError('panel claim requires layout');
  }
  for (const field of Object.keys(layout)) {
    if (!['dock', 'size', 'stack', 'order'].includes(field)) {
      throw new TypeError(`Unknown panel layout field: ${field}`);
    }
  }
  if (!PANEL_DOCKS.has(layout.dock)) {
    throw new TypeError('panel layout dock must be fill, top, bottom, left, right, or right-bottom');
  }
  if (!PANEL_STACKS.has(layout.stack)) {
    throw new TypeError('panel layout stack must be tabs or split');
  }
  if (!Number.isFinite(layout.order)) throw new TypeError('panel layout requires numeric order');
  let size: PanelLayout['size'];
  if (layout.size !== undefined) {
    if (!layout.size || typeof layout.size !== 'object' || Array.isArray(layout.size)) {
      throw new TypeError('panel layout size must be an object');
    }
    for (const field of Object.keys(layout.size)) {
      if (!['value', 'unit', 'additionalPx'].includes(field)) {
        throw new TypeError(`Unknown panel layout size field: ${field}`);
      }
    }
    if (!Number.isFinite(layout.size.value) || layout.size.value <= 0) {
      throw new TypeError('panel layout size value must be positive');
    }
    if (layout.size.unit !== 'px' && layout.size.unit !== 'fraction') {
      throw new TypeError('panel layout size unit must be px or fraction');
    }
    if (layout.size.unit === 'fraction' && layout.size.value > 1) {
      throw new TypeError('panel layout fraction must not exceed 1');
    }
    if (layout.size.additionalPx !== undefined && (layout.size.unit !== 'fraction' || !Number.isFinite(layout.size.additionalPx) || layout.size.additionalPx < 0)) {
      throw new TypeError('panel layout additionalPx must be a nonnegative fraction offset');
    }
    size = Object.freeze({ value: layout.size.value, unit: layout.size.unit, ...(layout.size.additionalPx === undefined ? {} : { additionalPx: layout.size.additionalPx }) });
  }
  return Object.freeze({
    dock: layout.dock,
    ...(size === undefined ? {} : { size }),
    stack: layout.stack,
    order: layout.order,
  });
}

function slotElementId(slot: string) {
  return `forgeax-view-slot-${slot}`;
}

export function createViewSlotRegistry(document = globalThis.document, { onChange }: { onChange?: (claims: readonly PanelClaim[]) => void } = {}) {
  if (!document?.createElement) throw new TypeError('View slot registry requires a document');
  const claims = new Map<string, PanelClaim>();
  const mountHosts = new Map<string, HTMLElement>();
  const listeners = new Set<(claims: readonly PanelClaim[]) => void>();
  let snapshot: readonly PanelClaim[] = Object.freeze([]);
  const notify = () => {
    snapshot = Object.freeze(
      [...claims.values()].sort((a, b) => {
        const pageDelta = a.pageType.localeCompare(b.pageType);
        return pageDelta || a.layout.order - b.layout.order || a.id.localeCompare(b.id);
      }),
    );
    for (const listener of listeners) listener(snapshot);
    onChange?.(snapshot);
    document.defaultView?.dispatchEvent?.(
      new CustomEvent('forgeax-view-slot-layout', { detail: { claims: snapshot } }),
    );
  };
  const ensureMountHost = (id: string) => {
    const claim = claims.get(id);
    if (!claim) throw new Error(`View panel is not claimed: ${id}`);
    let host = mountHosts.get(id);
    if (!host) {
      host = document.createElement('div');
      host.className = 'fx-view-slot-mount-host';
      host.dataset.forgeaxViewMountHost = id;
      mountHosts.set(id, host);
    }
    const anchor = document.getElementById(slotElementId(id));
    if (anchor && host.parentNode !== anchor) anchor.replaceChildren(host);
    return host;
  };
  const resolveWhenReady = (id: string) => Promise.resolve(ensureMountHost(id));
  return Object.freeze({
    subscribe(listener: (claims: readonly PanelClaim[]) => void) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    claim({ id, slot, pageType, titleKey, activity, layout, closable, dockTitleHidden }: Partial<PanelClaim> = {}) {
      id ??= slot!;
      if (!id) throw new TypeError('panel claim requires id');
      if (typeof pageType !== 'string' || pageType.trim() === '') {
        throw new TypeError('panel claim requires pageType');
      }
      if (closable !== undefined && typeof closable !== 'boolean') {
        throw new TypeError('panel claim closable must be a boolean');
      }
      if (dockTitleHidden !== undefined && typeof dockTitleHidden !== 'boolean') {
        throw new TypeError('panel claim dockTitleHidden must be a boolean');
      }
      const claim = Object.freeze({
        id,
        pageType,
        titleKey,
        ...(activity === undefined ? {} : { activity: Object.freeze({ ...activity }) }),
        layout: normalizeLayout(layout),
        ...(closable === undefined ? {} : { closable }),
        ...(dockTitleHidden === undefined ? {} : { dockTitleHidden }),
      });
      claims.set(id, claim);
      notify();
      return () => {
        if (claims.get(id) !== claim) return;
        claims.delete(id);
        mountHosts.get(id)?.replaceChildren?.();
        mountHosts.delete(id);
        notify();
      };
    },
    getClaims: () => snapshot,
    resolve: ensureMountHost,
    resolveWhenReady,
    mount(id: string, child: HTMLElement) {
      const parent = ensureMountHost(id);
      parent.replaceChildren(child);
      return () => {
        if (parent.contains(child)) parent.replaceChildren();
      };
    },
  });
}
