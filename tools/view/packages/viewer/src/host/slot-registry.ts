import type { PanelClaim, PanelLayout } from '@forgeax/view-workspace-core/frontend-contract';
const PANEL_DOCKS = new Set(['fill', 'top', 'bottom', 'left', 'right', 'right-bottom']);
const PANEL_STACKS = new Set(['tabs', 'split']);

function slotElementId(slot: string) {
  return `forgeax-view-slot-${slot}`;
}

function normalizeLayout(layout: unknown, home: PanelClaim['home']): PanelClaim['layout'] {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    throw new TypeError('panel claim requires layout');
  }
  const value = layout as Record<string, unknown>;
  const fields = home.kind === 'page' ? ['dock', 'size', 'stack', 'order'] : ['order'];
  for (const field of Object.keys(layout)) {
    if (!fields.includes(field)) {
      if (home.kind === 'shell-bottom') {
        throw new TypeError(`shell-bottom panel layout supports only order; unknown field: ${field}`);
      }
      throw new TypeError(`Unknown panel layout field: ${field}`);
    }
  }

  if (!Number.isFinite(value.order)) throw new TypeError('panel layout requires numeric order');
  if (home.kind === 'shell-bottom') return Object.freeze({ order: value.order as number });

  const pageLayout = value as unknown as PanelLayout;
  const dock = pageLayout.dock;
  if (!PANEL_DOCKS.has(dock ?? '')) {
    throw new TypeError('panel layout dock must be fill, top, bottom, left, right, or right-bottom');
  }
  if (!PANEL_STACKS.has(pageLayout.stack)) {
    throw new TypeError('panel layout stack must be tabs or split');
  }
  let size: PanelLayout['size'];
  if (pageLayout.size !== undefined) {
    if (!pageLayout.size || typeof pageLayout.size !== 'object' || Array.isArray(pageLayout.size)) {
      throw new TypeError('panel layout size must be an object');
    }
    for (const field of Object.keys(pageLayout.size)) {
      if (!['value', 'unit', 'additionalPx'].includes(field)) {
        throw new TypeError(`Unknown panel layout size field: ${field}`);
      }
    }
    if (!Number.isFinite(pageLayout.size.value) || pageLayout.size.value <= 0) {
      throw new TypeError('panel layout size value must be positive');
    }
    if (pageLayout.size.unit !== 'px' && pageLayout.size.unit !== 'fraction') {
      throw new TypeError('panel layout size unit must be px or fraction');
    }
    if (pageLayout.size.unit === 'fraction' && pageLayout.size.value > 1) {
      throw new TypeError('panel layout fraction must not exceed 1');
    }
    if (pageLayout.size.additionalPx !== undefined && (pageLayout.size.unit !== 'fraction' || !Number.isFinite(pageLayout.size.additionalPx) || pageLayout.size.additionalPx < 0)) {
      throw new TypeError('panel layout additionalPx must be a nonnegative fraction offset');
    }
    size = Object.freeze({ value: pageLayout.size.value, unit: pageLayout.size.unit, ...(pageLayout.size.additionalPx === undefined ? {} : { additionalPx: pageLayout.size.additionalPx }) });
  }
  return Object.freeze({
    dock,
    ...(size === undefined ? {} : { size }),
    stack: pageLayout.stack,
    order: pageLayout.order,
  });
}

function normalizeHome(home: unknown) {
  if (!home || typeof home !== 'object' || Array.isArray(home)) throw new TypeError('panel claim requires home');
  const value = home as Record<string, unknown>;
  if (value.kind === 'page' && Object.keys(value).every(field => ['kind', 'pageType'].includes(field))
      && typeof value.pageType === 'string' && value.pageType.trim() !== '') {
    return Object.freeze({ kind: 'page' as const, pageType: value.pageType });
  }
  if (value.kind === 'shell-bottom' && Object.keys(value).every(field => field === 'kind')) {
    return Object.freeze({ kind: 'shell-bottom' as const });
  }
  throw new TypeError('panel home must be a page with pageType or shell-bottom');
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
        const pageA = a.home.kind === 'page' ? a.home.pageType : 'workspace';
        const pageB = b.home.kind === 'page' ? b.home.pageType : 'workspace';
        const pageDelta = pageA.localeCompare(pageB);
        return pageDelta || a.layout.order - b.layout.order || a.id.localeCompare(b.id);
      }),
    );
    for (const listener of listeners) listener(snapshot);
    onChange?.(snapshot);
    document.defaultView?.dispatchEvent?.(
      new CustomEvent('forgeax-view-slot-layout', { detail: { claims: snapshot } }),
    );
  };
  const ensureMountHost = (id: string, anchor?: HTMLElement) => {
    const claim = claims.get(id);
    if (!claim) throw new Error(`View panel is not claimed: ${id}`);
    let host = mountHosts.get(id);
    if (!host) {
      host = document.createElement('div');
      host.className = 'fx-view-slot-mount-host';
      host.dataset.forgeaxViewMountHost = id;
      mountHosts.set(id, host);
    }
    const target = anchor ?? document.getElementById(slotElementId(id));
    if (target && host.parentNode !== target) target.replaceChildren(host);
    return host;
  };
  const resolveWhenReady = (id: string) => Promise.resolve(ensureMountHost(id));
  return Object.freeze({
    subscribe(listener: (claims: readonly PanelClaim[]) => void) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    claim(input: PanelClaim) {
      let { id, slot, titleKey, activity, layout, closable, dockTitleHidden } = input as PanelClaim;
      const { home } = input as PanelClaim;
      id ??= slot!;
      if (!id) throw new TypeError('panel claim requires id');
      const normalizedHome = normalizeHome(home);
      const normalizedLayout = normalizeLayout(layout, normalizedHome);
      if (closable !== undefined && typeof closable !== 'boolean') {
        throw new TypeError('panel claim closable must be a boolean');
      }
      if (dockTitleHidden !== undefined && typeof dockTitleHidden !== 'boolean') {
        throw new TypeError('panel claim dockTitleHidden must be a boolean');
      }
      const claim = Object.freeze({
        id,
        home: normalizedHome,
        titleKey,
        ...(activity === undefined ? {} : { activity: Object.freeze({ ...activity }) }),
        layout: normalizedLayout,
        ...(closable === undefined ? {} : { closable }),
        ...(dockTitleHidden === undefined ? {} : { dockTitleHidden }),
      }) as PanelClaim;
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
