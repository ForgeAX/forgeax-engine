let sequence = 0;

/**
 * Generate an identifier in both browser and Node consumers. The workspace
 * contract is imported by the frontend bundle, so it must not depend on a
 * Node-only module. `crypto.randomUUID` remains the preferred source while
 * the other branches keep tests and older browser targets deterministic in
 * shape without introducing another runtime.
 */
export function createWorkspaceId(prefix = 'workspace') {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  if (typeof crypto?.getRandomValues === 'function') {
    const values = new Uint32Array(4);
    crypto.getRandomValues(values);
    return `${prefix}:${Array.from(values, (value) => value.toString(16).padStart(8, '0')).join('')}`;
  }
  sequence = (sequence + 1) >>> 0;
  return `${prefix}:${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}
