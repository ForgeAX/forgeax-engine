/** Event-path ownership and lifecycle reset primitives for browser hosts. */

export interface UiOwnershipResult {
  readonly owned: boolean;
  readonly source: 'composed-path' | 'target-fallback' | 'unknown';
}

export interface UiInputResetBoundaryOptions {
  readonly clear: () => void;
  readonly signal?: AbortSignal;
}

export interface UiInputResetBoundary {
  readonly reset: () => void;
  readonly dispose: () => void;
}

function contains(root: Node, value: EventTarget | null): boolean {
  const document = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
  const NodeCtor = document?.defaultView?.Node ?? globalThis.Node;
  return NodeCtor && value instanceof NodeCtor ? value === root || root.contains(value) : false;
}

export function resolveUiOwnership(event: Event, host: Node): UiOwnershipResult {
  const path = event.composedPath;
  if (typeof path === 'function') {
    const composed = path.call(event);
    return {
      owned:
        composed.some((item) => contains(host, item)) ||
        (composed.length === 0 && contains(host, event.target)),
      source: composed.length === 0 ? 'target-fallback' : 'composed-path',
    };
  }
  if ('target' in event) {
    return { owned: contains(host, event.target), source: 'target-fallback' };
  }
  return { owned: false, source: 'unknown' };
}

export function isUiOwnedEvent(event: Event, host: Node): boolean {
  return resolveUiOwnership(event, host).owned;
}

export function createUiInputResetBoundary(
  options: UiInputResetBoundaryOptions,
): UiInputResetBoundary {
  let disposed = false;
  const reset = (): void => {
    if (!disposed) options.clear();
  };
  const onAbort = (): void => reset();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  return {
    reset,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}
