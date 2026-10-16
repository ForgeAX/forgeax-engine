/**
 * How a work may touch one bound resource. `write` and `read-write` bindings
 * are the work's storage outputs. `unknown` means neither an explicit layout
 * nor a WGSL declaration for the slot was recorded.
 */
export type BindingAccess = 'read' | 'write' | 'read-write' | 'unknown';

/** Access an explicit `createBindGroupLayout` entry grants. */
export function layoutEntryAccess(entry: GPUBindGroupLayoutEntry): BindingAccess {
  if (entry.buffer !== undefined) return entry.buffer.type === 'storage' ? 'read-write' : 'read';
  if (entry.storageTexture !== undefined) {
    const access = entry.storageTexture.access ?? 'write-only';
    return access === 'write-only' ? 'write' : access === 'read-write' ? 'read-write' : 'read';
  }
  return 'read';
}

const DECLARATION =
  /((?:@(?:group|binding)\s*\(\s*\d+\s*\)\s*){2})var(\s*<[^>]*>)?\s+\w+\s*:\s*([^;=]+)/g;

/**
 * Access per `group:binding` declared by WGSL modules, for pipelines whose
 * bind groups come from an `auto` layout and so carry no recorded entry.
 */
export function wgslBindingAccess(
  sources: readonly (string | null)[],
): ReadonlyMap<string, BindingAccess> {
  const result = new Map<string, BindingAccess>();
  for (const source of sources) {
    if (source === null) continue;
    for (const match of source.matchAll(DECLARATION)) {
      const attributes = match[1] ?? '';
      const group = /@group\s*\(\s*(\d+)/.exec(attributes)?.[1];
      const binding = /@binding\s*\(\s*(\d+)/.exec(attributes)?.[1];
      if (group === undefined || binding === undefined) continue;
      const key = `${group}:${binding}`;
      const access = declarationAccess(match[2] ?? '', match[3] ?? '');
      const previous = result.get(key);
      result.set(key, previous === undefined ? access : widen(previous, access));
    }
  }
  return result;
}

function declarationAccess(addressSpace: string, type: string): BindingAccess {
  if (/storage/.test(addressSpace)) return /read_write/.test(addressSpace) ? 'read-write' : 'read';
  const storageTexture = /texture_storage_\w+\s*<[^,>]+,\s*(\w+)/.exec(type)?.[1];
  if (storageTexture === 'write') return 'write';
  if (storageTexture === 'read_write') return 'read-write';
  return 'read';
}

function widen(a: BindingAccess, b: BindingAccess): BindingAccess {
  if (a === b) return a;
  if (a === 'read') return b;
  if (b === 'read') return a;
  return 'read-write';
}
