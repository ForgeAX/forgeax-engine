import type { PageType, PageTypeContribution, ResourceSelector, PageResourceOpenRequest } from '@forgeax/view-workspace-core/frontend-contract';
import type { WorkspaceAsset } from '@forgeax/view-workspace-core/contract';
import { logResourceOpen, summarizeResourceAsset } from '@forgeax/view-workspace-core/resource-open';
import type { PresentationOwner } from '@forgeax/view-workspace-core/frontend-contract';
import { workspaceError } from '@forgeax/view-workspace-core/contract';

const PAGE_TYPE_FIELDS = new Set([
  'typeId',
  'context',
  'titleKey',
  'title',
  'order',
  'closable',
  'singleton',
  'initial',
  'openable',
  'layout',
  'showPanelRail',
  'hideWhenInactive',
  'createController',
  'resourceSelector',
  'resourcePresentation',
  'priority',
]);

function normalizePageController(createController: PageTypeContribution['createController']) {
  if (createController === undefined) return undefined;
  if (typeof createController !== 'function') {
    throw new TypeError('page type createController must be a function');
  }
  const controller = createController();
  if (controller == null) return undefined;
  if (typeof controller !== 'object' || Array.isArray(controller)) {
    throw new TypeError('page type controller must be an object');
  }
  const { getTitle, getResource, subscribeTitle, dispose, beforeClose, getStatus } = controller;
  if (getResource !== undefined && typeof getResource !== 'function') throw new TypeError('page controller getResource must be a function');
  if (getTitle !== undefined && typeof getTitle !== 'function') {
    throw new TypeError('page controller getTitle must be a function');
  }
  if (subscribeTitle !== undefined && typeof subscribeTitle !== 'function') {
    throw new TypeError('page controller subscribeTitle must be a function');
  }
  if (beforeClose !== undefined && typeof beforeClose !== 'function') throw new TypeError('page controller beforeClose must be a function');
  if (getStatus !== undefined && typeof getStatus !== 'function') throw new TypeError('page controller getStatus must be a function');
  if (dispose !== undefined && typeof dispose !== 'function') {
    throw new TypeError('page controller dispose must be a function');
  }
  return Object.freeze({
    ...(beforeClose === undefined ? {} : { beforeClose }),
    ...(getStatus === undefined ? {} : { getStatus }),
    ...(getResource === undefined ? {} : { getResource }),
    ...(getTitle === undefined ? {} : { getTitle }),
    ...(subscribeTitle === undefined ? {} : { subscribeTitle }),
    ...(dispose === undefined ? {} : { dispose }),
  });
}

/**
 * Resolve the visible page tab title. Live `getTitle()` wins; otherwise the
 * registered titleKey/title is the idle fallback. The shell never reads
 * workspace/scene fields here.
 */
export function resolvePageTypeTitle(pageType: PageType | undefined, translate?: (key: string) => string) {
  const live = pageType?.controller?.getTitle?.();
  if (typeof live === 'string' && live.trim() !== '') return live.trim();
  return resolvePageTypeLabel(pageType, translate);
}

/** Page creation names the registered type, independently of any open asset. */
export function resolvePageTypeLabel(pageType: PageType | undefined, translate?: (key: string) => string) {
  if (typeof pageType?.titleKey === 'string' && pageType.titleKey !== '' && typeof translate === 'function') {
    return translate(pageType.titleKey);
  }
  return pageType?.title ?? pageType?.typeId ?? '';
}

export function subscribePageTypeTitles(pageTypes: readonly PageType[], listener: () => void) {
  const types = Array.isArray(pageTypes) ? pageTypes : [];
  const unsubs = types
    .map((pageType) => pageType?.controller?.subscribeTitle?.(listener))
    .filter((unsub) => typeof unsub === 'function');
  return () => {
    for (const unsub of unsubs) unsub();
  };
}

export function readPageTypeTitleRevision(pageTypes: readonly PageType[]) {
  const types = Array.isArray(pageTypes) ? pageTypes : [];
  return types.map(pageType => {
    const title = pageType.controller?.getTitle?.() ?? '';
    const status = pageType.controller?.getStatus?.();
    return status ? JSON.stringify([title, status]) : title;
  }).join('\0');
}

function normalizePageType(input: PageTypeContribution) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('page type must be an object');
  }
  for (const field of Object.keys(input)) {
    if (!PAGE_TYPE_FIELDS.has(field)) throw new TypeError(`Unknown page type field: ${field}`);
  }
  if (typeof input.typeId !== 'string' || input.typeId.trim() === '') {
    throw new TypeError('page type requires typeId');
  }
  if (
    (typeof input.titleKey !== 'string' || input.titleKey.trim() === '') &&
    (typeof input.title !== 'string' || input.title.trim() === '')
  ) {
    throw new TypeError('page type requires titleKey or title');
  }
  if (!Number.isFinite(input.order)) throw new TypeError('page type requires numeric order');
  for (const field of [
    'closable',
    'singleton',
    'initial',
    'openable',
    'showPanelRail',
    'hideWhenInactive',
  ] as const) {
    if (typeof input[field] !== 'boolean') {
      throw new TypeError(`page type requires boolean ${field}`);
    }
  }
  if (input.layout !== 'dock' && input.layout !== 'surface') {
    throw new TypeError('page type requires layout dock or surface');
  }
  if (input.context !== 'project' && input.context !== 'artifact') throw new TypeError('page type requires context project or artifact');
  const controller = normalizePageController(input.createController);
  const resourceSelector = normalizeResourceSelector(input.resourceSelector);
  if (input.resourcePresentation !== undefined && !['preview', 'details'].includes(input.resourcePresentation)) throw new TypeError('resourcePresentation requires preview or details');
  const priority = normalizePriority(input.priority);
  return Object.freeze({
    typeId: input.typeId,
    context: input.context,
    ...(input.titleKey === undefined ? {} : { titleKey: input.titleKey }),
    ...(input.title === undefined ? {} : { title: input.title }),
    order: input.order,
    closable: input.closable,
    singleton: input.singleton,
    initial: input.initial,
    openable: input.openable,
    layout: input.layout,
    showPanelRail: input.showPanelRail,
    hideWhenInactive: input.hideWhenInactive,
    ...(controller === undefined ? {} : { controller }),
    ...(resourceSelector === undefined ? {} : { resourceSelector }),
    ...(input.resourcePresentation === undefined ? {} : { resourcePresentation: input.resourcePresentation }),
    ...(priority === undefined ? {} : { priority }),
  });
}

function normalizeResourceSelector(value: ResourceSelector | undefined) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('page type resourceSelector must be an object');
  }
  for (const field of Object.keys(value)) {
    if (field !== 'kinds' && field !== 'fallback' && field !== 'extensions') {
      throw new TypeError(`Unknown resourceSelector field: ${field}`);
    }
  }
  const hasKinds = Object.hasOwn(value, 'kinds');
  const hasFallback = Object.hasOwn(value, 'fallback');
  const hasExtensions = Object.hasOwn(value, 'extensions');
  if (Number(hasKinds) + Number(hasFallback) + Number(hasExtensions) !== 1) {
    throw new TypeError('page type resourceSelector requires kinds, extensions or fallback');
  }
  if (hasExtensions) {
    if (!Array.isArray(value.extensions) || value.extensions.length === 0 || value.extensions.some((extension: string) => !/^\.[a-z0-9]+$/.test(extension))) {
      throw new TypeError('page type resourceSelector.extensions must contain lowercase extensions');
    }
    return Object.freeze({ extensions: Object.freeze([...value.extensions]) });
  }
  if (hasKinds) {
    if (!Array.isArray(value.kinds) || value.kinds.length === 0) {
      throw new TypeError('page type resourceSelector.kinds must be a non-empty array');
    }
    const kinds = value.kinds.map((kind: string) => {
      if (typeof kind !== 'string' || kind.trim() === '') {
        throw new TypeError('page type resourceSelector.kinds entries must be non-empty strings');
      }
      return kind.trim();
    });
    return Object.freeze({ kinds: Object.freeze(kinds) });
  }
  if (value.fallback !== true) {
    throw new TypeError('page type resourceSelector.fallback must be true');
  }
  return Object.freeze({ fallback: true });
}

function normalizePriority(value: number | undefined) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) throw new TypeError('page type priority must be a finite number');
  return value;
}

function compareResourcePageTypes(left: PageType, right: PageType) {
  return (right.priority ?? 0) - (left.priority ?? 0)
    || left.order - right.order
    || left.typeId.localeCompare(right.typeId);
}

export function resolveResourcePageType(pageTypes: readonly PageType[], request: PageResourceOpenRequest | Pick<WorkspaceAsset, 'kind'> | null | undefined) {
  const types = Array.isArray(pageTypes) ? pageTypes : [];
  if (request && 'file' in request) {
    const extension = request.file?.extension?.toLowerCase();
    const match = types.filter((pageType) => pageType.resourceSelector?.extensions?.includes(extension)).sort(compareResourcePageTypes)[0];
    return match ? Object.freeze({ ok: true, pageType: match, match: 'extension' }) : Object.freeze({ ok: false, error: Object.freeze({ code: 'view-resource-page-unavailable', expected: `a PageType plugin for ${extension}`, hint: 'Install a matching file viewer plugin.', detail: { extension } }) });
  }
  const asset = request && 'asset' in request ? request.asset : request;
  const kind = typeof asset?.kind === 'string' ? asset.kind.trim() : '';
  if (kind === '') {
    return Object.freeze({
      ok: false,
      error: Object.freeze({
        code: 'view-resource-page-unavailable',
        expected: 'an Engine asset kind',
        hint: 'Open an Engine asset whose snapshot includes kind.',
        detail: Object.freeze({ kind: asset?.kind ?? null }),
      }),
    });
  }
  const kindMatches = types
    .filter((pageType) => !(request && 'detailsOnly' in request && request.detailsOnly)
      && pageType?.resourceSelector?.kinds?.includes(kind))
    .sort(compareResourcePageTypes);
  if (kindMatches.length > 0) {
    return Object.freeze({ ok: true, pageType: kindMatches[0], match: 'kind' });
  }
  const fallbacks = types
    .filter((pageType) => pageType?.resourceSelector?.fallback === true)
    .sort(compareResourcePageTypes);
  if (fallbacks.length > 0) {
    return Object.freeze({ ok: true, pageType: fallbacks[0], match: 'fallback' });
  }
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: 'view-resource-page-unavailable',
      expected: `a PageType plugin that accepts asset kind ${kind}`,
      hint: 'Install a matching asset viewer plugin, or a fallback asset page plugin.',
      detail: Object.freeze({ kind }),
    }),
  });
}

/**
 * Decide whether a resolved PageType should focus an already-open singleton
 * or open a new page. Non-openable types (Scene) can still be focused.
 */
export function planResourcePageActivation(pages: readonly { id: string; typeId: string }[], pageType: PageType | undefined) {
  if (!pageType || typeof pageType !== 'object') {
    return Object.freeze({ action: 'none' });
  }
  const list = Array.isArray(pages) ? pages : [];
  if (pageType.singleton) {
    const existing = list.find((page) => page.typeId === pageType.typeId);
    if (existing) {
      return Object.freeze({ action: 'focus', pageId: existing.id, pageType });
    }
  }
  if (pageType.openable !== true) {
    return Object.freeze({ action: 'none', pageType });
  }
  return Object.freeze({
    action: 'open',
    pageId: pageType.singleton ? `page-${pageType.typeId}` : undefined,
    pageType,
  });
}

function normalizeOpenResource(input: PageResourceOpenRequest) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('openResource requires an object');
  }
  if (typeof input.requestId !== 'string' || input.requestId.trim() === '') {
    throw new TypeError('openResource requires requestId');
  }
  if ('file' in input) {
    const file = input.file;
    if (typeof file?.path !== 'string' || !file.path || typeof file.projectId !== 'string' || !file.projectId || typeof file.extension !== 'string' || !/^\.[a-z0-9]+$/.test(file.extension) || !file.path.toLowerCase().endsWith(file.extension)) throw new TypeError('openResource requires a matching project file path, extension and projectId');
    return Object.freeze({ requestId: input.requestId, sequence: Number.isSafeInteger(input.sequence) ? input.sequence : 0, file: Object.freeze({ ...file }) });
  }
  const asset = input.asset;
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
    throw new TypeError('openResource requires asset');
  }
  if (typeof asset.kind !== 'string' || asset.kind.trim() === '') {
    throw new TypeError('openResource requires asset.kind');
  }
  return Object.freeze({
    requestId: input.requestId,
    sequence: Number.isSafeInteger(input.sequence) ? input.sequence : 0,
    asset: Object.freeze({ ...asset }),
    ...(input.preview === undefined ? {} : { preview: input.preview }),
    ...(input.inspection === undefined ? {} : { inspection: input.inspection }),
  });
}

export function createViewPageTypeRegistry({ onChange }: { onChange?: (types: readonly PageType[]) => void } = {}) {
  const types = new Map<string, PageType>();
  const mounts = new Map<string, { node: HTMLElement; anchor?: HTMLElement }>();
  const anchors = new Map<string, HTMLElement>();
  const listeners = new Set<(types: readonly PageType[]) => void>();
  let snapshot: readonly PageType[] = Object.freeze([]);
  const notify = () => {
    snapshot = Object.freeze(
      [...types.values()].sort((a, b) => a.order - b.order || a.typeId.localeCompare(b.typeId)),
    );
    for (const listener of listeners) listener(snapshot);
    onChange?.(snapshot);
  };
  return Object.freeze({
    registerType(input: PageTypeContribution) {
      const pageType = normalizePageType(input);
      if (types.has(pageType.typeId)) {
        throw new Error(`View page type is already registered: ${pageType.typeId}`);
      }
      types.set(pageType.typeId, pageType);
      notify();
      return () => {
        if (types.get(pageType.typeId) !== pageType) return;
        types.delete(pageType.typeId);
        pageType.controller?.dispose?.();
        mounts.get(pageType.typeId)?.node.remove?.();
        mounts.delete(pageType.typeId);
        anchors.delete(pageType.typeId);
        notify();
      };
    },
    subscribe(listener: (types: readonly PageType[]) => void) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    getTypes: () => snapshot,
    mount(typeId: string, node: HTMLElement) {
      if (!types.has(typeId)) throw new Error(`View page type is not registered: ${typeId}`);
      if (!node || typeof node !== 'object') throw new TypeError('page mount requires a node');
      if (mounts.has(typeId)) throw new Error(`View page content is already mounted: ${typeId}`);
      const mount: { node: HTMLElement; anchor?: HTMLElement } = { node };
      mounts.set(typeId, mount);
      const anchor = anchors.get(typeId);
      if (anchor && node.parentNode !== anchor) anchor.replaceChildren(node);
      return () => {
        if (mounts.get(typeId) !== mount) return;
        node.remove?.();
        mounts.delete(typeId);
      };
    },
    attach(typeId: string, anchor: HTMLElement) {
      if (!types.has(typeId)) throw new Error(`View page type is not registered: ${typeId}`);
      if (!anchor?.replaceChildren) throw new TypeError('page attach requires an anchor element');
      anchors.set(typeId, anchor);
      const mount = mounts.get(typeId);
      if (!mount) return undefined;
      mount.anchor = anchor;
      if (mount.node.parentNode !== anchor) anchor.replaceChildren(mount.node);
      return mount.node;
    },
  });
}

export function createViewPageHost({ registry }: { registry?: ReturnType<typeof createViewPageTypeRegistry> } = {}) {
  if (!registry?.registerType) throw new TypeError('createViewPageHost requires pageRegistry');
  const listeners = new Set<(request: PageResourceOpenRequest) => void>();
  let lastRequest: PageResourceOpenRequest | undefined;
  let presentation: { owner: PresentationOwner; lifetime: AbortController } | undefined;
  return Object.freeze({
    attachPresentation(owner: PresentationOwner) {
      if (presentation) throw new Error('View presentation already has an owner');
      const lease = { owner, lifetime: new AbortController() };
      presentation = lease;
      return () => { if (presentation === lease) presentation = undefined; lease.lifetime.abort(); };
    },
    callPresentation: (async (operation, args, signal) => {
      const lease = presentation;
      if (!lease) throw workspaceError('view-presentation-unavailable', 'a mounted View Shell', 'Wait for the View frontend to mount.');
      if (signal.aborted) throw workspaceError('view-presentation-cancelled', 'an active presentation request', 'Read presentation.get before retrying.');
      const active = AbortSignal.any([signal, lease.lifetime.signal]);
      try {
        const result = await lease.owner(operation, args, active);
        if (active.aborted || presentation !== lease) throw workspaceError('view-presentation-retired', 'the same mounted View Shell to complete the action', 'Read presentation.get after the frontend mounts again.');
        return result;
      } catch (error) {
        if (lease.lifetime.signal.aborted) throw workspaceError('view-presentation-retired', 'the same mounted View Shell to complete the action', 'Read presentation.get after the frontend mounts again.');
        throw error;
      }
    }) satisfies PresentationOwner,
    registry,
    registerType: (pageType: PageTypeContribution) => registry.registerType(pageType),
    mount: (typeId: string, node: HTMLElement) => registry.mount(typeId, node),
    getAssetPresentation(asset: Pick<WorkspaceAsset, 'kind'>) {
      const selected = resolveResourcePageType(registry.getTypes(), asset);
      return selected.ok ? selected.pageType.resourcePresentation ?? 'details' : undefined;
    },
    openResource(input: PageResourceOpenRequest) {
      const request = normalizeOpenResource(input);
      lastRequest = request;
      logResourceOpen('page-host-open-resource', {
        requestId: request.requestId,
        sequence: request.sequence,
        asset: 'asset' in request ? summarizeResourceAsset(request.asset) : null,
        listenerCount: listeners.size,
      });
      for (const listener of listeners) listener(request);
      return request;
    },
    subscribeResourceOpen(listener: (request: PageResourceOpenRequest) => void) {
      if (typeof listener !== 'function') {
        throw new TypeError('subscribeResourceOpen requires a function');
      }
      listeners.add(listener);
      if (lastRequest) listener(lastRequest);
      return () => listeners.delete(listener);
    },
  });
}

export function listOpenablePageTypes(pageTypes: readonly PageType[], pages: readonly { typeId: string }[]) {
  const openTypes = new Set(pages.map((page) => page.typeId));
  return pageTypes.filter(
    (pageType) => pageType.openable && (!pageType.singleton || !openTypes.has(pageType.typeId)),
  );
}
