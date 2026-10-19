import type { ViewWorkspaceClient } from './client.ts';
import type { WorkspaceTarget } from './contract.ts';
import { VIEW_WORKSPACE_TAB_ID } from './contract.ts';
import { reportWorkspaceCommandError } from './command-error.ts';

const DEFAULT_DEBOUNCE_MS = 100;
const CAMERA_BUSY_RETRY_MS = 100;
const CAMERA_BUSY_RETRIES = 20;

function cameraInteractionBusy(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === 'view-workspace-target-busy' || code === 'engine-workspace-target-busy';
}

/** Forward the host element extent through preview.resize (device pixels). */
export function attachPreviewRenderResizeSync({
  api,
  surface,
  target,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: { api?: Pick<ViewWorkspaceClient, 'resizePreview'>; surface?: HTMLElement; target?: WorkspaceTarget | null; debounceMs?: number } = {}) {
  if (!api || typeof api.resizePreview !== 'function' || !surface || !target?.targetId || !Number.isSafeInteger(target.generation)) {
    return () => {};
  }
  const host = surface;
  if (!host || typeof ResizeObserver === 'undefined') {
    return () => {};
  }

  let requestedWidth = target.width ?? 0;
  let requestedHeight = target.height ?? 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const controller = new AbortController();

  const submit = (width: number, height: number, attempt: number) => {
    requestedWidth = width;
    requestedHeight = height;
    void Promise.resolve()
      .then(() => !disposed && api.resizePreview({
        tabId: VIEW_WORKSPACE_TAB_ID,
        targetId: String(target.targetId),
        targetGeneration: target.generation,
        width,
        height,
        reportError: false,
        signal: controller.signal,
      }))
      .catch((error: unknown) => {
        if (disposed || controller.signal.aborted) return;
        const current = requestedWidth === width && requestedHeight === height;
        // Seeding the mesh pivot holds a camera transaction. Engine refuses
        // resize until that transaction commits, so wait and try the same extent.
        if (cameraInteractionBusy(error) && (!current || attempt < CAMERA_BUSY_RETRIES)) {
          if (current) retryTimer = setTimeout(() => submit(width, height, attempt + 1), CAMERA_BUSY_RETRY_MS);
          return;
        }
        if (current) requestedWidth = requestedHeight = 0;
        reportWorkspaceCommandError(error, { operation: 'preview.resize', signal: controller.signal });
      });
  };

  const flush = () => {
    if (disposed) return;
    const dpr = Math.max(1, surface.ownerDocument?.defaultView?.devicePixelRatio ?? 1);
    const width = Math.round(host.clientWidth * dpr);
    const height = Math.round(host.clientHeight * dpr);
    if (width <= 0 || height <= 0) return;
    if (width === requestedWidth && height === requestedHeight) return;
    clearTimeout(retryTimer);
    submit(width, height, 0);
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  const observer = new ResizeObserver(schedule);
  observer.observe(host);
  // The first extent belongs to attachment; only later layout changes debounce.
  flush();

  return () => {
    disposed = true;
    controller.abort();
    clearTimeout(timer);
    clearTimeout(retryTimer);
    observer.disconnect();
  };
}

/** @deprecated Use attachPreviewRenderResizeSync */
export const attachViewportRenderResizeSync = attachPreviewRenderResizeSync;
