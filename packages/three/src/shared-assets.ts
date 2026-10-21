import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { Asset, AssetHandle } from '@forgeax/engine-types';

interface DisposableSource {
  addEventListener(type: 'dispose', listener: () => void): void;
  removeEventListener(type: 'dispose', listener: () => void): void;
}

export function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

function disposable(source: object): DisposableSource | undefined {
  return 'addEventListener' in source && 'removeEventListener' in source
    ? (source as DisposableSource)
    : undefined;
}

interface Entry<Payload extends Asset> {
  readonly values: readonly unknown[];
  readonly handle: AssetHandle<Payload['kind']>;
  dirty: boolean;
  readonly invalidate: () => void;
}

/** Source leases only; the surrounding asset adoption owns content commit and rollback. */
export class SharedAssets<Source extends object, Payload extends Asset> {
  private entries = new Map<Source, Map<string, Entry<Payload>>>();
  private pending: Map<Source, Map<string, Entry<Payload>>> | undefined;

  constructor(private readonly assets: AssetRegistry) {}

  read(
    source: Source,
    values: readonly unknown[] | undefined,
    variant = '',
  ): { handle: AssetHandle<Payload['kind']>; payload: Payload } | undefined {
    const entry = this.pending?.get(source)?.get(variant) ?? this.entries.get(source)?.get(variant);
    if (
      entry === undefined ||
      entry.dirty ||
      (values !== undefined && !sameValues(values, entry.values))
    )
      return undefined;
    if (this.pending !== undefined) this.stage(source, variant, entry);
    return {
      handle: entry.handle,
      payload: runtimeAssets(this.assets).borrow<Payload>(entry.handle).unwrap(),
    };
  }

  write(
    source: Source,
    values: readonly unknown[],
    payload: Payload,
    variant = '',
  ): { handle: AssetHandle<Payload['kind']>; payload: Payload } {
    if (this.pending === undefined) throw new Error('resource preparation has not begun');
    const committed = this.entries.get(source)?.get(variant);
    const pending = this.pending.get(source)?.get(variant);
    const previous = pending ?? committed;
    const handle =
      previous !== undefined && !previous.dirty
        ? previous.handle
        : this.assets.create(payload).unwrap();
    if (
      previous !== undefined &&
      !previous.dirty &&
      runtimeAssets(this.assets).borrow<Payload>(handle).unwrap() !== payload
    )
      this.assets.replace<Payload['kind'], Asset>(handle, payload).unwrap();
    const entry = {
      values,
      handle,
      dirty: false,
      invalidate: () => {
        entry.dirty = true;
      },
    };
    disposable(source)?.addEventListener('dispose', entry.invalidate);
    if (pending !== undefined && pending !== committed) {
      disposable(source)?.removeEventListener('dispose', pending.invalidate);
      if (pending.handle !== committed?.handle && pending.handle !== handle)
        this.assets.release(pending.handle).unwrap();
    }
    this.stage(source, variant, entry);
    return { handle, payload };
  }

  private stage(source: Source, variant: string, entry: Entry<Payload>): void {
    if (this.pending === undefined) throw new Error('resource preparation has not begun');
    let variants = this.pending.get(source);
    if (variants === undefined) {
      variants = new Map();
      this.pending.set(source, variants);
    }
    variants.set(variant, entry);
  }

  begin(): void {
    if (this.pending !== undefined) throw new Error('resource preparation is already active');
    this.pending = new Map();
  }

  commit(): void {
    if (this.pending === undefined) throw new Error('resource preparation has not begun');
    for (const [source, variants] of this.entries) {
      for (const [variant, entry] of variants) {
        const pending = this.pending.get(source)?.get(variant);
        if (pending !== entry) {
          disposable(source)?.removeEventListener('dispose', entry.invalidate);
          if (pending?.handle !== entry.handle) this.assets.release(entry.handle).unwrap();
        }
      }
    }
    this.entries = this.pending;
    this.pending = undefined;
  }

  abort(): void {
    for (const [source, variants] of this.pending ?? []) {
      for (const [variant, entry] of variants) {
        if (entry !== this.entries.get(source)?.get(variant))
          disposable(source)?.removeEventListener('dispose', entry.invalidate);
      }
    }
    this.pending = undefined;
  }

  dispose(): void {
    this.abort();
    for (const [source, variants] of this.entries) {
      for (const entry of variants.values()) {
        disposable(source)?.removeEventListener('dispose', entry.invalidate);
        this.assets.release(entry.handle).unwrap();
      }
    }
    this.entries.clear();
  }
}
