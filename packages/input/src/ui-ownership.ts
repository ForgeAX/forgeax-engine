/** Event-path ownership primitives for browser hosts. */

export interface UiOwnershipResult {
  readonly owned: boolean;
  readonly source: 'composed-path' | 'target-fallback' | 'unknown';
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
