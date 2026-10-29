import { previewShouldCapture } from '@forgeax/view-workspace-core/preview-camera';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { MaterialPreviewState, WorkspaceTarget } from '@forgeax/view-workspace-core/contract';

export {
  cameraPoseForRestore,
  cameraPoseWithPivot,
  commitPreviewCameraPivot,
  meshAabbCenter,
  previewCameraKey,
  previewShouldCapture,
  rememberInitialPreviewCamera,
  restorePreviewCamera,
} from '@forgeax/view-workspace-core/preview-camera';

export function materialPreviewShouldCapture(event: Event, surface: HTMLElement | null | undefined, pageType = 'material') {
  return previewShouldCapture(event, surface, pageType);
}

/** Samples only object rotation. Camera gestures retain the shared viewport controller. */
export function attachMaterialRotation({ element, client, target, signal, shouldCapture, onError }: {
  element: HTMLElement; client: Pick<ViewWorkspaceClient, 'call'>; target: WorkspaceTarget;
  signal: AbortSignal; shouldCapture: (event: Event) => boolean; onError: (error: unknown) => void;
}) {
  const window = element.ownerDocument.defaultView!;
  let drag: { id: number; x: number; y: number } | undefined;
  let frame: number | undefined;
  let dx = 0, dy = 0, disposed = false, sending = false;
  let pending: Promise<void> = Promise.resolve();
  const cancel = () => {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined; dx = 0; dy = 0;
    const id = drag?.id; drag = undefined;
    if (id !== undefined && element.hasPointerCapture?.(id)) element.releasePointerCapture(id);
  };
  const schedule = () => {
    if (frame !== undefined || sending || disposed || signal.aborted || (!dx && !dy)) return;
    frame = window.requestAnimationFrame(() => {
      frame = undefined;
      const yaw = -dx * 0.01, pitch = -dy * 0.01;
      dx = 0; dy = 0; sending = true;
      pending = client.call<MaterialPreviewState>('preview.material.rotate', {
        targetId: target.targetId, targetGeneration: target.generation, yaw, pitch,
      }, { signal, reportError: false }).then(() => {}, error => {
        cancel();
        if (!disposed && !signal.aborted) onError(error);
      }).finally(() => { sending = false; schedule(); });
    });
  };
  const down = (event: PointerEvent) => {
    if (disposed || signal.aborted || event.button !== 0 || !shouldCapture(event)) return;
    event.preventDefault(); element.focus();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    element.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    dx += event.clientX - drag.x; dy += event.clientY - drag.y;
    drag.x = event.clientX; drag.y = event.clientY;
    schedule();
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== drag?.id) return;
    drag = undefined;
    if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId);
    schedule();
  };
  const lost = () => { if (drag) cancel(); };
  const focusout = (event: FocusEvent) => { if (!element.contains(event.relatedTarget as Node | null)) cancel(); };
  const hidden = () => { if (element.ownerDocument.hidden) cancel(); };
  element.addEventListener('pointerdown', down);
  element.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  element.addEventListener('pointercancel', cancel);
  element.addEventListener('lostpointercapture', lost);
  element.addEventListener('focusout', focusout);
  window.addEventListener('blur', cancel);
  element.ownerDocument.addEventListener('visibilitychange', hidden);
  signal.addEventListener('abort', cancel, { once: true });
  return {
    async settle() { cancel(); await pending; },
    dispose() {
      disposed = true; cancel();
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', cancel);
      element.removeEventListener('lostpointercapture', lost);
      element.removeEventListener('focusout', focusout);
      window.removeEventListener('blur', cancel);
      element.ownerDocument.removeEventListener('visibilitychange', hidden);
      signal.removeEventListener('abort', cancel);
    },
  };
}
