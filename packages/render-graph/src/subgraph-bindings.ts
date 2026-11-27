import { handleData } from './kernel-internal.js';
import type { GraphAccess, GraphAccessUsage } from './types.js';

const role = {
  'uniform-read': 1,
  'storage-read': 2,
  'storage-write': 4,
  'storage-read-write': 8,
  'indirect-read': 16,
  'vertex-read': 32,
  'index-read': 64,
  'copy-src': 128,
  'copy-dst': 256,
  'sampled-read': 512,
  'sampled-storage-read-write': 1024,
  'sampled-storage-write': 2048,
  'color-attachment': 4096,
  'depth-stencil-read': 8192,
  'depth-stencil-write': 16384,
  'acceleration-structure-build': 32768,
  'acceleration-structure-read': 65536,
} satisfies Record<GraphAccessUsage, number>;

function grants(usage: GraphAccessUsage): number {
  switch (usage) {
    case 'depth-stencil-write':
      return role[usage] | role['depth-stencil-read'];
    case 'storage-read-write':
      return role[usage] | role['storage-read'] | role['storage-write'];
    case 'sampled-storage-read-write':
      return (
        role[usage] |
        role['sampled-read'] |
        role['storage-read'] |
        role['storage-write'] |
        role['storage-read-write'] |
        role['sampled-storage-write']
      );
    default:
      return role[usage];
  }
}

export function coversUsage(port: GraphAccessUsage, child: GraphAccessUsage): boolean {
  return (grants(port) & role[child]) !== 0;
}

/** Actual buffer and view bindings of one graph. Replacing a slot unlinks its old handle,
 * even when several logical resources alias it or its subgraph pass is inactive. */
export class SubgraphBindings {
  private readonly buffers = new Map<object, number>();
  private readonly views = new Map<object, number>();
  private readonly previous: Uint32Array;
  readonly next: Uint32Array;
  private readonly permissions = new WeakMap<readonly GraphAccess[], ReadonlyMap<number, number>>();

  constructor(
    capacity: number,
    buffers: readonly (object | undefined)[],
    views: readonly (object | undefined)[],
  ) {
    this.previous = new Uint32Array(capacity);
    this.next = new Uint32Array(capacity);
    for (let id = 1; id < buffers.length; id++) this.replace('buffer', id, undefined, buffers[id]);
    for (let id = 1; id < views.length; id++)
      this.replace('texture-view', id, undefined, views[id]);
  }

  replace(
    kind: 'buffer' | 'texture-view',
    id: number,
    old: object | undefined,
    value: object | undefined,
  ): void {
    if (old === value) return;
    const heads = kind === 'buffer' ? this.buffers : this.views;
    if (old !== undefined) {
      const prev = this.previous[id] as number,
        next = this.next[id] as number;
      if (prev !== 0) this.next[prev] = next;
      else if (next === 0) heads.delete(old);
      else heads.set(old, next);
      if (next !== 0) this.previous[next] = prev;
    }
    const head = value === undefined ? 0 : (heads.get(value) ?? 0);
    this.previous[id] = 0;
    this.next[id] = head;
    if (value !== undefined) {
      if (head !== 0) this.previous[head] = id;
      heads.set(value, id);
    }
  }

  first(kind: 'buffer' | 'texture-view', handle: object): number {
    return (kind === 'buffer' ? this.buffers : this.views).get(handle) ?? 0;
  }

  /** A pass grants a union of roles per logical slot. Separate read and write grants do not
   * grant read-write access. Static permissions never contain a physical device handle. */
  grantsFor(ports: readonly GraphAccess[]): ReadonlyMap<number, number> {
    const current = this.permissions.get(ports);
    if (current !== undefined) return current;
    const allowed = new Map<number, number>();
    for (const port of ports) {
      const data = handleData(port.resource);
      if (data !== undefined)
        allowed.set(data.id, (allowed.get(data.id) ?? 0) | grants(port.usage));
    }
    this.permissions.set(ports, allowed);
    return allowed;
  }

  static allows(mask: number | undefined, usage: GraphAccessUsage): boolean {
    return ((mask ?? 0) & role[usage]) !== 0;
  }
}
