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
  retained: boolean;
  seen: number;
  readonly invalidate: () => void;
}

/** Source leases only; the surrounding asset adoption owns content commit and rollback. */
export class SharedAssets<Source extends object, Payload extends Asset> {
  private readonly entries = new Map<Source, Map<string, Entry<Payload>>>();
  /** Only replacements are staged; unchanged resources retain their original entry. */
  private readonly pending = new Map<Source, Map<string, Entry<Payload>>>();
  private active = false;
  private epoch = 0;

  constructor(private readonly assets: AssetRegistry) {}

  read(
    source: Source,
    values: readonly unknown[] | undefined,
    variant = '',
  ): { handle: AssetHandle<Payload['kind']>; payload: Payload } | undefined {
    const entry = this.pending.get(source)?.get(variant) ?? this.entries.get(source)?.get(variant);
    if (
      entry === undefined ||
      entry.dirty ||
      (values !== undefined && !sameValues(values, entry.values))
    )
      return undefined;
    if (this.active) entry.seen = this.epoch;
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
    if (!this.active) throw new Error('resource preparation has not begun');
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
      values: values.slice(),
      handle,
      dirty: false,
      retained: previous?.retained ?? false,
      seen: this.epoch,
      invalidate: () => {
        entry.dirty = true;
        entry.retained = false;
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
    if (!this.active) throw new Error('resource preparation has not begun');
    let variants = this.pending.get(source);
    if (variants === undefined) {
      variants = new Map();
      this.pending.set(source, variants);
    }
    variants.set(variant, entry);
  }

  begin(): void {
    if (this.active) throw new Error('resource preparation is already active');
    this.active = true;
  }

  /** Explicit init retains a source until dispose; ordinary frame discovery still sweeps unused leases. */
  retain(source: Source, variant = ''): void {
    const entry = this.pending.get(source)?.get(variant) ?? this.entries.get(source)?.get(variant);
    if (entry !== undefined) entry.retained = true;
  }

  /** Unswept passes share usage until the next output/readback boundary. */
  commit(sweep = true): void {
    if (!this.active) throw new Error('resource preparation has not begun');
    for (const [source, variants] of this.entries) {
      for (const [variant, entry] of variants) {
        const pending = this.pending.get(source)?.get(variant);
        if (
          pending !== undefined ||
          entry.dirty ||
          (sweep && !entry.retained && entry.seen !== this.epoch)
        ) {
          disposable(source)?.removeEventListener('dispose', entry.invalidate);
          if (pending?.handle !== entry.handle) this.assets.release(entry.handle).unwrap();
          variants.delete(variant);
        }
      }
      if (variants.size === 0) this.entries.delete(source);
    }
    for (const [source, variants] of this.pending) {
      let committed = this.entries.get(source);
      if (committed === undefined) {
        committed = new Map();
        this.entries.set(source, committed);
      }
      for (const [variant, entry] of variants) committed.set(variant, entry);
    }
    this.pending.clear();
    this.active = false;
    if (sweep) this.epoch++;
  }

  abort(): void {
    for (const [source, variants] of this.pending) {
      for (const [variant, entry] of variants) {
        if (entry !== this.entries.get(source)?.get(variant))
          disposable(source)?.removeEventListener('dispose', entry.invalidate);
      }
    }
    this.pending.clear();
    this.active = false;
    this.epoch++;
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
