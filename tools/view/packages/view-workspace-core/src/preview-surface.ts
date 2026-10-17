import type { EngineWorkspaceTarget } from '@forgeax/engine/app';
import type { WorkspaceTarget } from './contract.ts';
import type { ViewWorkspaceClient } from './client.ts';
import type { ViewPresentation, PreviewOwner } from './engine-presentation.ts';
export type PreviewSurfaceResult = { ok: true; dispose?: () => void | Promise<void> } | { ok: false; error: { code: string; expected: string; hint: string } };
export type PreviewSurfaceOptions = { presentation?: ViewPresentation; target?: WorkspaceTarget; container?: HTMLElement | null; canvas?: unknown; owner?: PreviewOwner; sceneTargetId?: string; api?: Pick<ViewWorkspaceClient, 'resizePreview'> };

import { keepSurfaceInContainer, watchUntilReady } from './adopt-surface.ts';
import { logResourceOpen } from './resource-open.ts';
import { attachPreviewRenderResizeSync } from './render-resize-sync.ts';

const OWNER_PLACEMENT = 'owner';
const containerOwners = new WeakMap<HTMLElement, PreviewOwner>();

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
  return {
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
    logResourceOpen('preview-surface-hosted', {
      pageType: surfaceOwner.pageType,
      panelId: surfaceOwner.panelId,
      targetId: String(target.targetId),
      surfaceTag: surface.tagName ?? null,
    });
    const releasePlacement = () => {
      // Return the borrowed surface to Engine parking before awaiting cleanup.
      stopKeep();
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
    return {
      ok: true,
      dispose: async () => {
        releasePlacement();
        const detach = await attachment;
        await detach?.();
      },
    };
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
