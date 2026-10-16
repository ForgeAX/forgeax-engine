/**
 * Close a resource returned by a platform adapter without assuming an
 * implementation type. Platform implementations may expose either dispose or
 * close; an effect callback is also accepted for test and host adapters.
 */
export async function disposeResource(resource: null | undefined | (() => void | Promise<void>) | { dispose?: () => void | Promise<void>; close?: () => void | Promise<void> }) {
  if (!resource) return;
  if (typeof resource === 'function') {
    await resource();
    return;
  }
  if (typeof resource.dispose === 'function') {
    await resource.dispose();
    return;
  }
  if (typeof resource.close === 'function') {
    await resource.close();
  }
}
