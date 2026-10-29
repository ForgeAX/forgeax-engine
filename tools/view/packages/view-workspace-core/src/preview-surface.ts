import type { EngineWorkspaceTarget } from '@forgeax/engine/app';
import type { WorkspaceState, WorkspaceTarget } from './contract.ts';
import type { ViewWorkspaceClient } from './client.ts';
import type { ViewPresentation, PreviewOwner } from './engine-presentation.ts';
export type PreviewSurfaceResult = { ok: true; ready?: Promise<void>; dispose?: () => void | Promise<void> } | { ok: false; error: { code: string; expected: string; hint: string } };
export type PreviewSurfaceOptions = { requestId?: string; presentation?: ViewPresentation; target?: WorkspaceTarget; container?: HTMLElement | null; canvas?: unknown; owner?: PreviewOwner; sceneTargetId?: string; api?: Pick<ViewWorkspaceClient, 'resizePreview'> };

import { keepSurfaceInContainer, watchUntilReady } from './adopt-surface.ts';
import { logResourceOpen } from './resource-open.ts';
import { attachPreviewRenderResizeSync } from './render-resize-sync.ts';

const OWNER_PLACEMENT = 'owner';
const containerOwners = new WeakMap<HTMLElement, PreviewOwner>();

const NATIVE_PREVIEW_PROTOCOL = 'forgeax.view.preview/1';
function previewScope(state: WorkspaceState | null | undefined) {
  const target = state?.projectTarget;
  return state?.project && target && state.projectPhase === 'running' ? {
    projectId: state.project.id, targetId: target.targetId, generation: target.generation,
    sessionId: target.sessionId, worldId: target.worldId, browserGeneration: state.browserGeneration,
  } : undefined;
}
type PreviewScope = NonNullable<ReturnType<typeof previewScope>>;
type NativePreviewRequest = { protocol: typeof NATIVE_PREVIEW_PROTOCOL; scope: PreviewScope; leaseId: string;
  target?: WorkspaceTarget; owner?: PreviewOwner; hidden?: boolean; finishCamera?: boolean };
type DocumentPreviewLease = { target: WorkspaceTarget; container: HTMLElement; owner: PreviewOwner };
const samePreviewScope = (left: PreviewScope | undefined, right: PreviewScope | undefined) =>
  left !== undefined && right !== undefined && left.projectId === right.projectId && left.targetId === right.targetId
  && left.generation === right.generation && left.sessionId === right.sessionId && left.worldId === right.worldId
  && left.browserGeneration === right.browserGeneration;
const retiredPreview = () => new DOMException('View preview identity changed', 'AbortError');

/** Borrow one retained isolated document; only its owning platform disposes the iframe. */
export function createNativePreviewPresentation({ presentation, client, document, window }: {
  presentation: ViewPresentation; client: ViewWorkspaceClient; document: Document; window: Window & typeof globalThis;
}) {
  type Placement = { target: EngineWorkspaceTarget; container: HTMLElement; owner: PreviewOwner; leaseId: string;
    resolve(): void; reject(error: unknown): void; dock?: HTMLElement | null };
  const placements = new Set<Placement>();
  let state: WorkspaceState | null = null;
  let scene: HTMLElement | undefined;
  let frame: HTMLIFrameElement | undefined;
  let originalStyle: string | null = null;
  let disposed = false;
  let active: Placement | undefined;
  let activeKey = '';
  let pending: AbortController | undefined;
  let sequence = Promise.resolve();
  const realm = document.defaultView!;
  const frameFor = (target: EngineWorkspaceTarget) => {
    const loaded = new URL(window.location.href);
    if (loaded.searchParams.get('forgeaxWorkspaceTarget') !== target.targetId) return;
    const surface = presentation.createSurface?.({ target: { ...target, url: loaded.href }, document });
    if (!surface || typeof surface !== 'object' || !('tagName' in surface) || surface.tagName !== 'IFRAME') return;
    if (surface !== frame) {
      if (frame) originalStyle === null ? frame.removeAttribute('style') : frame.setAttribute('style', originalStyle);
      frame = surface as HTMLIFrameElement;
      originalStyle = frame.getAttribute('style');
    }
    return frame;
  };
  const request = (scope: PreviewScope, input: Omit<NativePreviewRequest, 'protocol' | 'scope'>, signal: AbortSignal) => {
    if (!samePreviewScope(scope, previewScope(state))) return Promise.reject(retiredPreview());
    const surface = state?.projectTarget && frameFor(state.projectTarget as EngineWorkspaceTarget);
    if (!surface?.contentWindow) return Promise.reject(new Error('view-preview-document-unavailable'));
    return new Promise<void>((resolve, reject) => {
      const channel = new realm.MessageChannel();
      let finished = false;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        realm.clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        surface.removeEventListener('load', cancel);
        channel.port1.close();
        error ? reject(error) : resolve();
      };
      const cancel = () => { channel.port1.postMessage({ cancelled: true }); finish(retiredPreview()); };
      const timer = realm.setTimeout(() => {
        channel.port1.postMessage({ cancelled: true });
        finish(new Error('view-preview-document-timeout'));
      }, 15000);
      signal.addEventListener('abort', cancel, { once: true });
      surface.addEventListener('load', cancel, { once: true });
      channel.port1.onmessage = event => {
        if (!samePreviewScope(scope, previewScope(state))) { cancel(); return; }
        finish(event.data?.ok === true ? undefined : new Error(event.data?.error ?? 'view-preview-invalid-reply'));
      };
      channel.port1.start();
      if (signal.aborted) { cancel(); return; }
      try { surface.contentWindow!.postMessage({ protocol: NATIVE_PREVIEW_PROTOCOL, scope, ...input }, '*', [channel.port2]); }
      catch (error) { finish(error); }
    });
  };
  const clearDock = (entry: Placement) => {
    if (entry.dock?.dataset.forgeaxViewDocumentSurface === entry.leaseId) delete entry.dock.dataset.forgeaxViewDocumentSurface;
    entry.dock = undefined;
  };
  const visible = (element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    return element.isConnected && box.width > 0 && box.height > 0;
  };
  const place = () => {
    if (disposed) return;
    for (const entry of placements) {
      const dock = entry.container.closest<HTMLElement>('.fx-view-dockview-host');
      if (dock !== entry.dock) { clearDock(entry); entry.dock = dock; }
      if (dock && dock.dataset.forgeaxViewDocumentSurface !== entry.leaseId) dock.dataset.forgeaxViewDocumentSurface = entry.leaseId;
    }
    const scope = previewScope(state);
    const page = document.documentElement.dataset.forgeaxViewActivePage;
    const selected = scope ? [...placements].find(entry => (page === undefined || page === entry.owner.pageType) && visible(entry.container)) : undefined;
    const sceneVisible = scope && scene && (page === undefined || page === 'scene') && visible(scene)
      && state?.targetBinding !== 'play' && (!state?.play || state.play.phase === 'ready');
    const anchor = selected?.container ?? (sceneVisible ? scene : undefined);
    if (scope && state?.projectTarget) frameFor(state.projectTarget as EngineWorkspaceTarget);
    if (frame) {
      const box = anchor?.getBoundingClientRect();
      const style = { position: 'fixed', border: '0px', transform: 'none',
        visibility: anchor ? 'visible' : 'hidden',
        'pointer-events': !selected || selected.owner.pageType === 'mesh' ? 'auto' : 'none',
        ...(box ? { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` } : {}) };
      for (const [key, value] of Object.entries(style)) if (frame.style.getPropertyValue(key) !== value) frame.style.setProperty(key, value);
    }
    const key = JSON.stringify([scope, selected?.leaseId]);
    if (key === activeKey) return;
    activeKey = key;
    pending?.abort();
    const previous = active;
    active = selected;
    if (!scope || (!selected && !previous)) return;
    const controller = new AbortController();
    pending = controller;
    sequence = sequence.catch(() => {}).then(async () => {
      if (disposed || activeKey !== key) return;
      await request(scope, selected ? { leaseId: selected.leaseId, target: selected.target, owner: selected.owner }
        : { leaseId: previous!.leaseId, hidden: true }, controller.signal);
      if (activeKey === key) selected?.resolve();
    });
    void sequence.catch(error => { if (activeKey === key) selected?.reject(error); });
  };
  const resize = new realm.ResizeObserver(place);
  const mutation = new realm.MutationObserver(place);
  const root = document.getElementById('root');
  if (root) mutation.observe(root, { attributes: true, childList: true, subtree: true, attributeFilter: ['style', 'class', 'hidden'] });
  mutation.observe(document.documentElement, { attributes: true, attributeFilter: ['data-forgeax-view-active-page'] });
  realm.addEventListener('resize', place);
  realm.addEventListener('scroll', place, true);
  const accept = (next: WorkspaceState) => {
    const before = previewScope(state);
    const changed = !state || !samePreviewScope(before, previewScope(next)) || state.targetBinding !== next.targetBinding
      || state.play?.phase !== next.play?.phase || state.play?.target.targetId !== next.play?.target.targetId;
    state = next;
    if (changed) place();
  };
  const unsubscribe = client.subscribe(accept);
  void client.getState().then(next => { if (!disposed && !state) accept(next); }).catch(() => {});
  const adapter: ViewPresentation = {
    surfacePlacement: 'owner',
    createSurface: ({ target }) => frameFor(target),
    attachScene({ container }) {
      scene = container;
      resize.observe(container);
      place();
      return () => { resize.unobserve(container); if (scene === container) scene = undefined; place(); };
    },
    async finishPreviewCamera(target) {
      const scope = previewScope(state);
      if (!scope || disposed) return;
      const entry = [...placements].find(item => String(item.target.targetId) === String(target.targetId)
        && (target.generation === undefined || item.target.generation === target.generation));
      if (!entry || active?.leaseId !== entry.leaseId) return;
      await request(scope, { leaseId: entry.leaseId, finishCamera: true }, new AbortController().signal);
    },
    attachPreview({ target, container, owner }) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const ready = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
      const entry: Placement = { target, container, owner, leaseId: realm.crypto.randomUUID(), resolve, reject };
      placements.add(entry);
      resize.observe(container);
      place();
      return { ready, async dispose() {
        placements.delete(entry);
        clearDock(entry);
        resize.unobserve(container);
        resolve();
        place();
        await sequence;
      } };
    },
  };
  return { presentation: adapter, async dispose() {
    disposed = true;
    pending?.abort();
    unsubscribe(); resize.disconnect(); mutation.disconnect();
    realm.removeEventListener('resize', place); realm.removeEventListener('scroll', place, true);
    await sequence.catch(() => {});
    const scope = previewScope(state);
    try { if (active && scope) await request(scope, { leaseId: active.leaseId, hidden: true }, new AbortController().signal); }
    finally {
      if (frame) originalStyle === null ? frame.removeAttribute('style') : frame.setAttribute('style', originalStyle);
      for (const entry of placements) { clearDock(entry); entry.resolve(); }
      placements.clear();
    }
  } };
}

/** Install only in the document that owns the public Engine preview surfaces. */
export function installNativePreviewHost({ presentation, client, document, window, createContainer, onPreview, onFinishCamera }: {
  presentation: ViewPresentation; client: ViewWorkspaceClient; document: Document; window: Window & typeof globalThis;
  createContainer(): HTMLElement;
  onPreview?: (preview: DocumentPreviewLease | undefined) => Promise<void> | void;
  onFinishCamera?: () => Promise<void> | void;
}) {
  let state: WorkspaceState | null = null;
  let active: { leaseId: string; target: WorkspaceTarget; scope: PreviewScope; dispose(): Promise<void> } | undefined;
  let queue = Promise.resolve();
  const lifetime = new AbortController();
  const incoming = new Map<AbortController, MessagePort>();
  const retire = async () => {
    const previous = active;
    active = undefined;
    await onPreview?.(undefined);
    await previous?.dispose();
  };
  const current = (scope: PreviewScope) => samePreviewScope(scope, previewScope(state));
  const present = async (input: NativePreviewRequest, signal: AbortSignal) => {
    if (!current(input.scope)) throw retiredPreview();
    if (typeof input.leaseId !== 'string' || !input.leaseId || input.leaseId.length > 128) throw new Error('view-preview-lease-invalid');
    if (input.finishCamera) {
      if (active?.leaseId === input.leaseId) await onFinishCamera?.();
      return;
    }
    if (input.hidden) { if (active?.leaseId === input.leaseId) await retire(); return; }
    // The parent can receive the open receipt before this document's event pump.
    const latest = await client.getState({ signal });
    signal.throwIfAborted();
    if (!current(input.scope)) throw retiredPreview();
    state = latest;
    if (!current(input.scope)) throw retiredPreview();
    const target = state?.previews?.find(value => value.target.targetId === input.target?.targetId
      && value.target.generation === input.target.generation)?.target;
    const local = target && presentation.resolveTarget?.(target.targetId);
    if (!target || !local || target.targetId === state?.projectTarget?.targetId || local.asset?.kind === 'scene'
      || target.worldId !== local.target.worldId || target.sessionId !== local.target.sessionId
      || input.target?.worldId !== target.worldId || input.target.sessionId !== target.sessionId) throw new Error('view-preview-target-stale');
    if (!input.owner?.panelId || !input.owner.pageType) throw new Error('view-preview-owner-unavailable');
    if (active?.leaseId === input.leaseId) return;
    await retire();
    signal.throwIfAborted();
    if (!current(input.scope)) throw retiredPreview();
    const container = createContainer();
    container.dataset.forgeaxDocumentPreview = target.targetId;
    Object.assign(container.style, { position: 'fixed', inset: '0', display: 'flex', overflow: 'hidden', zIndex: '1' });
    document.body.append(container);
    const scene = state?.projectTarget && presentation.createSurface?.({ target: state.projectTarget as EngineWorkspaceTarget, document }) as HTMLElement | undefined;
    const visibility = scene?.style.visibility;
    if (scene) scene.style.visibility = 'hidden';
    const restore = () => { container.remove(); if (scene) scene.style.visibility = visibility ?? ''; };
    let bound: PreviewSurfaceResult;
    try { bound = bindWorkspacePreviewSurface({ presentation, target, container, owner: input.owner, api: client, sceneTargetId: state?.projectTarget?.targetId }); }
    catch (error) { restore(); throw error; }
    if (!bound.ok) { restore(); throw new Error(bound.error.hint); }
    const attachment = bound;
    active = { leaseId: input.leaseId, target, scope: input.scope, async dispose() {
      await attachment.dispose?.(); restore();
    } };
    try {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(retiredPreview());
        signal.addEventListener('abort', cancel, { once: true });
        Promise.resolve(attachment.ready).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
        if (signal.aborted) cancel();
      });
      signal.throwIfAborted();
      if (!current(input.scope)) throw retiredPreview();
      await onPreview?.({ target, container, owner: input.owner });
    } catch (error) { await retire(); throw error; }
  };
  const receive = (event: MessageEvent<NativePreviewRequest>) => {
    if (lifetime.signal.aborted || event.source !== window.parent || event.source === window
      || event.data?.protocol !== NATIVE_PREVIEW_PROTOCOL || event.ports.length !== 1) return;
    const port = event.ports[0]!;
    if (incoming.size >= 8) { port.postMessage({ ok: false, error: 'view-preview-busy' }); port.close(); return; }
    const controller = new AbortController();
    incoming.set(controller, port);
    port.onmessage = () => controller.abort();
    port.start();
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    const task = queue.catch(() => {}).then(() => { signal.throwIfAborted(); return present(event.data, signal); });
    queue = task.then(() => {}, () => {});
    void task.then(() => port.postMessage({ ok: true }), error => port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { incoming.delete(controller); port.close(); });
  };
  const accept = (next: WorkspaceState) => {
    if (state && !samePreviewScope(previewScope(state), previewScope(next)))
      for (const controller of incoming.keys()) controller.abort();
    state = next;
    if (!active) return;
    const target = next.previews?.find(entry => entry.target.targetId === active!.target.targetId)?.target;
    if (!current(active.scope) || target?.generation !== active.target.generation || target?.worldId !== active.target.worldId) {
      for (const controller of incoming.keys()) controller.abort();
      const retiring = retire();
      queue = queue.then(() => retiring).catch(() => {});
    }
  };
  const unsubscribe = client.subscribe(accept);
  void client.getState().then(next => { if (!lifetime.signal.aborted && !state) accept(next); }).catch(() => {});
  window.addEventListener('message', receive);
  return async () => {
    lifetime.abort(); unsubscribe(); window.removeEventListener('message', receive);
    await queue;
    await retire();
  };
}

function previewSurfaceError(code: string, expected: string, hint: string): Extract<PreviewSurfaceResult, { ok: false }> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, expected, hint }),
  });
}

function placementOf(presentation: ViewPresentation | undefined) {
  return presentation?.surfacePlacement === OWNER_PLACEMENT ? OWNER_PLACEMENT : 'shell';
}

function isCanvasNode(node: unknown): node is HTMLCanvasElement {
  return node != null && typeof node === 'object' && 'tagName' in node && typeof node.tagName === 'string' && node.tagName.toLowerCase() === 'canvas';
}

function isPanelContainer(node: unknown): node is HTMLElement {
  if (!node || typeof node !== 'object' || isCanvasNode(node)) return false;
  return ('replaceChildren' in node && typeof node.replaceChildren === 'function') || ('append' in node && typeof node.append === 'function');
}

function surfaceCanvas(surface: HTMLElement) {
  if (isCanvasNode(surface)) return surface;
  return typeof surface?.querySelector === 'function' ? surface.querySelector('canvas') : null;
}

function isSceneOwnerSurface(surface: HTMLElement, container: HTMLElement, { target, sceneTargetId }: Pick<PreviewSurfaceOptions, 'target' | 'sceneTargetId'> = {}) {
  if (surface?.id === 'app-shell' || surface?.id === 'app') return true;
  if (
    sceneTargetId != null &&
    target?.targetId != null &&
    String(sceneTargetId) === String(target.targetId)
  ) {
    return true;
  }
  const marker = surface?.dataset?.forgeaxViewSurface;
  if (marker === 'engine-canvas' || marker === 'engine-target') return true;
  if (typeof surface?.closest !== 'function') return false;
  const viewport = surface.closest('[data-forgeax-view-mount-host="viewport"]');
  if (!viewport) return false;
  if (container === viewport || container?.contains?.(viewport)) return false;
  return true;
}

function fillPresentationSurface(surface: HTMLElement | null) {
  if (!surface?.style) return;
  Object.assign(surface.style, {
    width: '100%',
    height: '100%',
    maxWidth: '100%',
    maxHeight: '100%',
    transform: 'none',
    position: 'relative',
    overflow: 'hidden',
    flex: '1 1 auto',
    minWidth: '0',
    minHeight: '0',
    display: 'block',
  });
}

/**
 * Stamp a panel/page owner onto presentation. Asset pages only host the
 * Engine type-preview surface; they do not create a canvas.
 */
export function dedicatedPreviewPresentation(presentation: ViewPresentation | undefined, owner: PreviewOwner): ViewPresentation | undefined {
  if (!presentation || typeof presentation !== 'object') return undefined;
  let placement: { targetId: string; generation?: number; release: () => Promise<void> } | undefined;
  return {
    retainPlacement(target, release) {
      const lease = { ...target, release };
      placement = lease;
      return () => { if (placement === lease) placement = undefined; };
    },
    async releaseSurface(target) {
      if (placement?.targetId === target.targetId && placement.generation === target.generation) await placement.release();
    },
    get surfacePlacement() {
      return presentation.surfacePlacement;
    },
    get owner() {
      return owner ?? presentation.owner;
    },
    createSurface(input) {
      return presentation.createSurface?.(input);
    },
    attach(input) {
      return presentation.attach?.({ ...input, owner });
    },
    detach(input) {
      return presentation.detach?.(input);
    },
    get attachPreview() { return presentation.attachPreview; },
    resolveTarget(targetId) {
      return presentation.resolveTarget?.(targetId);
    },
    async finishPreviewCamera(target) {
      await presentation.finishPreviewCamera?.(target);
    },
  };
}

/**
 * Place an Engine type-preview surface into the container owned by one asset
 * panel. The panel never creates a canvas; Engine `createSurface` returns the
 * live surface. Scene owner canvases are refused.
 *
 * @param {{
 *   presentation?: object,
 *   target?: { targetId?: string | number },
 *   container?: HTMLElement,
 *   owner?: { panelId?: string, pageType?: string },
 *   sceneTargetId?: string | number,
 *   api?: { resizePreview?: (input: object) => Promise<unknown> },
 * }} [options]
 * @returns {{ ok: true, dispose?: () => unknown } | { ok: false, error: { code: string, expected: string, hint: string } }}
 */
export function bindWorkspacePreviewSurface({
  presentation,
  requestId,
  target,
  container,
  canvas,
  owner,
  sceneTargetId,
  api,
}: PreviewSurfaceOptions = {}): PreviewSurfaceResult {
  if (canvas !== undefined || isCanvasNode(container)) {
    throw new TypeError('bindWorkspacePreviewSurface requires a panel-owned container, not a canvas');
  }
  if (!isPanelContainer(container)) {
    throw new TypeError('bindWorkspacePreviewSurface requires a panel-owned container');
  }
  if (!target || (typeof target.targetId !== 'string' && typeof target.targetId !== 'number')) {
    return previewSurfaceError(
      'view-preview-target-unavailable',
      'an Engine preview target identity',
      'Open the asset through Engine asset.open before attaching a preview surface.',
    );
  }
  if (presentation?.attachPreview && target.targetId !== sceneTargetId) {
    const surfaceOwner = owner ?? presentation.owner;
    if (!surfaceOwner?.panelId || !surfaceOwner.pageType) return previewSurfaceError(
      'view-preview-owner-unavailable', 'a stable asset preview panel owner', 'Bind the preview through its PageType panel contribution.');
    const claimed = containerOwners.get(container);
    if (claimed && claimed !== surfaceOwner) return previewSurfaceError(
      'view-preview-canvas-owned', 'a container used by exactly one asset preview panel', 'Create a new container for this asset preview panel.');
    const attachment = presentation.attachPreview({ target: target as EngineWorkspaceTarget, container, owner: surfaceOwner });
    containerOwners.set(container, surfaceOwner);
    let disposal: Promise<void> | undefined;
    let forget = () => {};
    const dispose = () => {
      if (disposal) return disposal;
      forget();
      if (containerOwners.get(container) === surfaceOwner) containerOwners.delete(container);
      return disposal = attachment.dispose();
    };
    forget = presentation.retainPlacement?.({ targetId: target.targetId, generation: target.generation }, dispose) ?? (() => {});
    return { ok: true, ready: attachment.ready, dispose };
  }
  if (placementOf(presentation) === OWNER_PLACEMENT) {
    return previewSurfaceError(
      'view-preview-surface-unavailable',
      'a shell-placed Engine preview surface dedicated to this panel',
      'The Engine owner surface stays on the Scene viewport; asset preview cannot relocate that iframe.',
    );
  }
  if (!presentation || typeof presentation.createSurface !== 'function') {
    return previewSurfaceError(
      'view-preview-surface-unavailable',
      'an Engine presentation that can create a type-preview surface',
      'The asset tab hosts a DOM container; Engine createSurface places the live canvas into it.',
    );
  }
  const surfaceOwner = owner ?? presentation.owner;
  if (!surfaceOwner?.panelId || !surfaceOwner?.pageType) {
    return previewSurfaceError(
      'view-preview-owner-unavailable',
      'a stable asset preview panel owner',
      'Bind the preview through its PageType panel contribution.',
    );
  }
  const claimedBy = containerOwners.get(container);
  if (claimedBy !== undefined && claimedBy !== surfaceOwner) {
    return previewSurfaceError(
      'view-preview-canvas-owned',
      'a container used by exactly one asset preview panel',
      'Create a new container for this asset preview panel.',
    );
  }

  const missingSurface = () => previewSurfaceError(
    'view-preview-surface-unavailable',
    'an Engine type-preview surface for this target',
    'Engine must expose a type-preview surface via createSurface; the tab does not create a canvas.',
  );
  const refuseScene = () => previewSurfaceError(
    'view-preview-surface-unavailable',
    'a shell-placed Engine preview surface dedicated to this panel',
    'The Engine owner surface stays on the Scene viewport; asset preview cannot relocate that iframe.',
  );

  const resolveSurface = () => {
    const surface = presentation.createSurface!({
      target: target as EngineWorkspaceTarget,
      document: container.ownerDocument,
    });
    return surface && typeof surface === 'object' && 'tagName' in surface && typeof surface.tagName === 'string' ? surface as HTMLElement : null;
  };

  const installSurface = (surface: HTMLElement): Extract<PreviewSurfaceResult, { ok: true }> => {
    containerOwners.set(container, surfaceOwner);
    container.dataset.forgeaxPreviewPanel = surfaceOwner.panelId;
    container.dataset.forgeaxPreviewPage = surfaceOwner.pageType;
    container.dataset.forgeaxAssetPreview = String(target.targetId);
    const stopKeep = keepSurfaceInContainer({
      document: container.ownerDocument,
      getContainer: () => container,
      getSurface: () => surface,
      replace: true,
    });
    fillPresentationSurface(surface);
    const canvasNode = surfaceCanvas(surface);
    fillPresentationSurface(canvasNode);
    const resizeTarget = Number.isSafeInteger(target.generation)
      ? { targetId: String(target.targetId), generation: target.generation }
      : null;
    const detachResize = resizeTarget && api
      ? attachPreviewRenderResizeSync({ api, surface: container, target: resizeTarget })
      : () => {};
    if (canvasNode?.dataset) {
      canvasNode.dataset.forgeaxAssetPreview = String(target.targetId);
      canvasNode.dataset.forgeaxPreviewPanel = surfaceOwner.panelId;
      canvasNode.dataset.forgeaxPreviewPage = surfaceOwner.pageType;
    }
    const attachedAt = performance.now();
    const completed = (event: Event) => {
      const frame = (event as CustomEvent<{ presentation?: string; frameId?: number; worldIdentity?: string }>).detail;
      if (frame?.presentation !== 'ready' || (target.worldId && frame.worldIdentity !== target.worldId)) return;
      canvasNode?.removeEventListener?.('forgeax:frame-completed', completed);
      logResourceOpen('timing', { requestId, stage: 'first-ready-frame', targetId: target.targetId, frameId: frame.frameId, at: Date.now(), elapsedMs: Math.round(performance.now() - attachedAt) });
    };
    canvasNode?.addEventListener?.('forgeax:frame-completed', completed);
    logResourceOpen('preview-surface-hosted', {
      requestId, at: Date.now(),
      pageType: surfaceOwner.pageType,
      panelId: surfaceOwner.panelId,
      targetId: String(target.targetId),
      surfaceTag: surface.tagName ?? null,
    });
    const releasePlacement = () => {
      // Return the borrowed surface to Engine parking before awaiting cleanup.
      stopKeep();
      canvasNode?.removeEventListener?.('forgeax:frame-completed', completed);
      detachResize();
      // React may bind this same Engine surface again before detach resolves.
      // Release this placement synchronously so old cleanup cannot remove it.
      if (surface.parentNode === container) {
        if (typeof container.removeChild === 'function') container.removeChild(surface);
        else container.replaceChildren?.();
      }
      if (containerOwners.get(container) === surfaceOwner) containerOwners.delete(container);
      delete container.dataset.forgeaxPreviewPanel;
      delete container.dataset.forgeaxPreviewPage;
      delete container.dataset.forgeaxAssetPreview;
    };
    let attachment: Promise<void | (() => void)>;
    try {
      attachment = typeof presentation.attach === 'function'
        ? Promise.resolve(presentation.attach({ target: target as EngineWorkspaceTarget, element: surface, owner: surfaceOwner }))
        : Promise.resolve();
    } catch (cause) {
      releasePlacement();
      throw cause;
    }
    let disposal: Promise<void> | undefined;
    let forgetPlacement = () => {};
    const dispose = () => {
      if (disposal) return disposal;
      releasePlacement();
      forgetPlacement();
      disposal = attachment.then(async detach => { await detach?.(); });
      return disposal;
    };
    forgetPlacement = presentation.retainPlacement?.({ targetId: String(target.targetId), generation: target.generation }, dispose) ?? (() => {});
    return { ok: true, ready: attachment.then(() => {}), dispose };
  };

  const first = resolveSurface();
  if (first) {
    if (isSceneOwnerSurface(first, container, { target, sceneTargetId })) return refuseScene();
    return installSurface(first);
  }

  const document = container.ownerDocument;
  const win = document?.defaultView ?? globalThis;
  const Observer = document?.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const canWatch = typeof Observer === 'function' || typeof win.requestAnimationFrame === 'function';
  if (!canWatch) return missingSurface();

  let hosted: Extract<PreviewSurfaceResult, { ok: true }> | undefined;
  const stopWatch = watchUntilReady({
    document,
    probe: () => {
      if (hosted) return true;
      const surface = resolveSurface();
      if (!surface || isSceneOwnerSurface(surface, container, { target, sceneTargetId })) return false;
      hosted = installSurface(surface);
      return true;
    },
  });
  return {
    ok: true,
    dispose: async () => {
      stopWatch();
      await hosted?.dispose?.();
    },
  };
}
