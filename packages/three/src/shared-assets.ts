import type { World } from '@forgeax/engine-ecs';
import type { Asset, Handle, TagOf } from '@forgeax/engine-types';

interface DisposableSource {
  addEventListener(type: 'dispose', listener: () => void): void;
  removeEventListener(type: 'dispose', listener: () => void): void;
}

export function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

interface Entry<Payload extends Asset> {
  readonly values: readonly unknown[];
  readonly handle: Handle<TagOf<Payload>, 'shared'>;
  dirty: boolean;
  readonly invalidate: () => void;
}

/** Source leases only. World owns payloads; a rejected preparation releases its new leases. */
export class SharedAssets<Source extends DisposableSource, Payload extends Asset> {
  private entries = new Map<Source, Entry<Payload>>();
  private pending: Map<Source, Entry<Payload>> | undefined;

  constructor(
    private readonly world: World,
    private readonly target: TagOf<Payload>,
  ) {}

  read(
    source: Source,
    values: readonly unknown[],
  ): { handle: Handle<TagOf<Payload>, 'shared'>; payload: Payload } | undefined {
    const entry = this.pending?.get(source) ?? this.entries.get(source);
    if (entry === undefined || entry.dirty || !sameValues(values, entry.values)) return undefined;
    this.pending?.set(source, entry);
    return {
      handle: entry.handle,
      payload: this.world.sharedRefs.resolve<TagOf<Payload>, Payload>(entry.handle).unwrap(),
    };
  }

  write(
    source: Source,
    values: readonly unknown[],
    payload: Payload,
  ): { handle: Handle<TagOf<Payload>, 'shared'>; payload: Payload } {
    if (this.pending === undefined) throw new Error('resource preparation has not begun');
    const previous = this.pending.get(source);
    const handle = this.world.allocSharedRef(this.target, payload);
    const entry = {
      values,
      handle,
      dirty: false,
      invalidate: () => {
        entry.dirty = true;
      },
    };
    source.addEventListener('dispose', entry.invalidate);
    this.pending.set(source, entry);
    if (previous !== undefined && previous !== this.entries.get(source))
      this.release(source, previous);
    return { handle, payload };
  }

  begin(): void {
    if (this.pending !== undefined) throw new Error('resource preparation is already active');
    this.pending = new Map();
  }

  commit(): void {
    if (this.pending === undefined) throw new Error('resource preparation has not begun');
    for (const [source, entry] of this.entries) {
      if (this.pending.get(source) !== entry) this.release(source, entry);
    }
    this.entries = this.pending;
    this.pending = undefined;
  }

  abort(): void {
    for (const [source, entry] of this.pending ?? []) {
      if (this.entries.get(source) !== entry) this.release(source, entry);
    }
    this.pending = undefined;
  }

  dispose(): void {
    this.abort();
    for (const [source, entry] of this.entries) this.release(source, entry);
    this.entries.clear();
  }

  private release(source: Source, entry: Entry<Payload>): void {
    source.removeEventListener('dispose', entry.invalidate);
    this.world.sharedRefs.release(entry.handle).unwrap();
  }
}
