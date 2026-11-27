import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { Asset, AssetHandle } from '@forgeax/engine-types';

interface DisposableSource {
  addEventListener(type: 'dispose', listener: () => void): void;
  removeEventListener(type: 'dispose', listener: () => void): void;
}

export function sameValues(a: ArrayLike<unknown>, b: ArrayLike<unknown>): boolean {
  const length = a.length;
  if (length !== b.length) return false;
  for (let index = 0; index < length; index++)
    if (index in a && !Object.is(a[index], b[index])) return false;
  return true;
}

function matchesValues(
  previous: readonly unknown[],
  values: readonly unknown[],
  suffix: readonly unknown[] | undefined,
): boolean {
  if (suffix === undefined) return sameValues(values, previous);
  return (
    previous.length === values.length + suffix.length &&
    values.every((value, index) => Object.is(value, previous[index])) &&
    suffix.every((value, index) => Object.is(value, previous[values.length + index]))
  );
}

function disposable(source: object): DisposableSource | undefined {
  return 'addEventListener' in source && 'removeEventListener' in source
    ? (source as DisposableSource)
    : undefined;
}

interface Entry<Source extends object, Payload extends Asset, SourceData> {
  readonly source: Source;
  readonly variant: string;
  values: unknown[];
  readonly handle: AssetHandle<Payload['kind']>;
  readonly sourceData: SourceData | undefined;
  dirty: boolean;
  retained: boolean;
  pins: number;
  releasePin?: (() => void) | undefined;
  seen: number;
  readonly invalidate: () => void;
}

export interface SharedAssetStorage<Source, Payload extends Asset> {
  find(
    source: Source,
    payload: Payload,
    previous: AssetHandle<Payload['kind']> | undefined,
  ): AssetHandle<Payload['kind']> | undefined;
  canReplace(payload: Payload): boolean;
  record(source: Source, handle: AssetHandle<Payload['kind']>): void;
}

/** Source leases only; the surrounding asset adoption owns content commit and rollback. */
export class SharedAssets<Source extends object, Payload extends Asset, SourceData = never> {
  private readonly entries = new Map<Source, Map<string, Entry<Source, Payload, SourceData>>>();
  /** Only replacements are staged; unchanged resources retain their original entry. */
  private readonly pending = new Map<Source, Map<string, Entry<Source, Payload, SourceData>>>();
  private readonly signatureEdits = new Map<
    Entry<Source, Payload, SourceData>,
    ReadonlyMap<number, unknown> | readonly unknown[]
  >();
  private active = false;
  private epoch = 0;
  // Pinned and explicitly retained addresses never enter an ordinary output sweep.
  private readonly sweepable = new Set<Entry<Source, Payload, SourceData>>();
  private seen = 0;
  private readonly invalidated = new Set<Entry<Source, Payload, SourceData>>();

  private observe(entry: Entry<Source, Payload, SourceData>): void {
    if (entry.seen === this.epoch) return;
    entry.seen = this.epoch;
    if (!entry.retained && entry.pins === 0) this.seen++;
  }

  constructor(
    private readonly assets: AssetRegistry,
    private readonly storage?: SharedAssetStorage<Source, Payload>,
  ) {}

  read(
    source: Source,
    values: readonly unknown[] | undefined,
    variant = '',
    suffix?: readonly unknown[],
  ):
    | {
        handle: AssetHandle<Payload['kind']>;
        payload: Payload;
        sourceData: SourceData | undefined;
        values: readonly unknown[];
      }
    | undefined {
    const entry = this.pending.get(source)?.get(variant) ?? this.entries.get(source)?.get(variant);
    if (
      entry === undefined ||
      entry.dirty ||
      (values !== undefined && !matchesValues(entry.values, values, suffix))
    )
      return undefined;
    if (this.active) this.observe(entry);
    return {
      values: entry.values,
      sourceData: entry.sourceData,
      handle: entry.handle,
      payload: runtimeAssets(this.assets).resolveStoredAsset<Payload>(entry.handle).unwrap(),
    };
  }

  /** Revalidate a prepared binding after other source callbacks without borrowing its payload again. */
  readHandle(
    source: Source,
    values: readonly unknown[],
    variant: string,
    accepted: readonly unknown[] | undefined,
  ): AssetHandle<Payload['kind']> | undefined {
    const entry = this.pending.get(source)?.get(variant) ?? this.entries.get(source)?.get(variant);
    if (
      entry === undefined ||
      entry.dirty ||
      (entry.values !== accepted && !sameValues(entry.values, values))
    )
      return undefined;
    if (this.active) this.observe(entry);
    return entry.handle;
  }

  /** Borrow a live candidate even when its source signature changed. */
  previous(
    source: Source,
    variant: string,
  ):
    | { readonly handle: AssetHandle<Payload['kind']>; readonly values: readonly unknown[] }
    | undefined {
    const entry = this.pending.get(source)?.get(variant) ?? this.entries.get(source)?.get(variant);
    return entry?.dirty ? undefined : entry;
  }

  /** An unchanged source derivation can outlive the published payload's revision. */
  sourceData(source: Source, variant: string): SourceData | undefined {
    const entry = this.pending.get(source)?.get(variant) ?? this.entries.get(source)?.get(variant);
    return entry?.dirty ? undefined : entry?.sourceData;
  }

  write(
    source: Source,
    values: readonly unknown[],
    payload: Payload,
    variant = '',
    sourceData?: SourceData,
    createdHandle?: AssetHandle<Payload['kind']>,
  ): {
    handle: AssetHandle<Payload['kind']>;
    payload: Payload;
    sourceData: SourceData | undefined;
  } {
    if (!this.active) throw new Error('resource preparation has not begun');
    const committed = this.entries.get(source)?.get(variant);
    const pending = this.pending.get(source)?.get(variant);
    const previous = pending ?? committed;
    const current = previous?.dirty ? undefined : previous?.handle;
    // Dispose invalidates this source even while a material still retains its old bytes.
    const alias = previous?.dirty ? undefined : this.storage?.find(source, payload, current);
    let handle: AssetHandle<Payload['kind']>;
    if (alias !== undefined) {
      if (alias !== pending?.handle && alias !== committed?.handle)
        this.assets.retain(alias).unwrap();
      handle = alias;
    } else if (current === undefined) {
      handle = createdHandle ?? this.assets.create(payload).unwrap();
    } else {
      const accepted = runtimeAssets(this.assets).resolveStoredAsset<Payload>(current).unwrap();
      if (accepted === payload || this.storage?.canReplace(accepted) !== false) {
        handle = current;
        if (accepted !== payload)
          this.assets.replace<Payload['kind'], Asset>(handle, payload).unwrap();
      } else handle = this.assets.create(payload).unwrap();
    }
    this.storage?.record(source, handle);
    const entry = {
      source,
      variant,
      sourceData,
      values: values.slice(),
      handle,
      dirty: false,
      pins: previous?.pins ?? 0,
      releasePin: previous?.releasePin,
      retained: previous !== undefined && !previous.dirty && previous.retained,
      seen: this.epoch,
      invalidate: () => {
        if (this.entries.get(source)?.get(variant) === entry) this.invalidated.add(entry);
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
    return { handle, payload, sourceData };
  }

  /** Record the source lanes of a content edit without replacing its lease. */
  editSignature(
    source: Source,
    variant: string,
    edits: ReadonlyMap<number, unknown> | readonly unknown[],
  ): void {
    if (!this.active) throw new Error('resource preparation has not begun');
    const entry = this.pending.get(source)?.get(variant) ?? this.entries.get(source)?.get(variant);
    if (entry === undefined || entry.dirty) throw new Error('resource signature has no live lease');
    this.observe(entry);
    this.signatureEdits.set(entry, edits);
  }

  private stage(source: Source, variant: string, entry: Entry<Source, Payload, SourceData>): void {
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

  /** Keep an existing source lease for a still-attached, temporarily unused draw. */
  markUsed(source: Source, variant = ''): SourceData | undefined {
    const entry = this.pending.get(source)?.get(variant) ?? this.entries.get(source)?.get(variant);
    if (!this.active || entry === undefined || entry.dirty) return undefined;
    this.observe(entry);
    return entry.sourceData;
  }

  /** Explicit init retains a source until dispose; ordinary frame discovery still sweeps unused leases. */
  retain(source: Source, variant = ''): void {
    const entry = this.pending.get(source)?.get(variant) ?? this.entries.get(source)?.get(variant);
    if (entry === undefined || entry.retained || entry.dirty) return;
    if (entry.pins === 0 && entry === this.entries.get(source)?.get(variant)) {
      this.sweepable.delete(entry);
      if (entry.seen === this.epoch) this.seen--;
    }
    entry.retained = true;
  }

  /** A resident projection holds this address across per-view resource sweeps. */
  pin(source: Source, variant: string): (() => void) | undefined {
    const entry = this.entries.get(source)?.get(variant);
    if (!entry || entry.dirty) return;
    if (entry.pins++ === 0 && !entry.retained) {
      this.sweepable.delete(entry);
      if (entry.seen === this.epoch) this.seen--;
    }
    if (!entry.releasePin) {
      const release = () => {
        const current = this.entries.get(source)?.get(variant);
        if (!current || current.releasePin !== release || current.pins === 0) return;
        if (--current.pins === 0 && !current.retained) {
          this.sweepable.add(current);
          if (current.seen === this.epoch) this.seen++;
        }
      };
      entry.releasePin = release;
    }
    return entry.releasePin;
  }

  /** Unswept passes share usage until the next output/readback boundary. */
  commit(sweep = true): void {
    if (!this.active) throw new Error('resource preparation has not begun');
    // All committed leases were observed, or another view still owns the
    // observation window. Only dirty leases or unseen output members need a sweep.
    for (const entry of this.invalidated) this.removeCommitted(entry);
    if (sweep && this.seen < this.sweepable.size) {
      for (const entry of this.sweepable)
        if (entry.seen !== this.epoch) this.removeCommitted(entry);
    }
    for (const [source, variants] of this.pending) {
      let committed = this.entries.get(source);
      if (committed === undefined) {
        committed = new Map();
        this.entries.set(source, committed);
      }
      for (const [variant, entry] of variants) {
        const old = committed.get(variant);
        if (old !== undefined) this.retire(source, old, entry);
        committed.set(variant, entry);
        if (!entry.retained && entry.pins === 0) {
          this.sweepable.add(entry);
          this.seen++;
        }
        if (entry.dirty) this.invalidated.add(entry);
      }
    }
    for (const [entry, edits] of this.signatureEdits) {
      if ('get' in edits) {
        for (const [lane, value] of edits) entry.values[lane] = value;
      } else entry.values = edits.slice();
    }
    this.signatureEdits.clear();
    this.pending.clear();
    this.active = false;
    if (sweep) {
      this.epoch++;
      this.seen = 0;
    }
  }

  private removeCommitted(entry: Entry<Source, Payload, SourceData>): void {
    const { source, variant } = entry;
    const variants = this.entries.get(source);
    if (!variants) throw new Error('Committed asset lost its source address');
    this.retire(source, entry, this.pending.get(source)?.get(variant));
    variants.delete(variant);
    if (variants.size === 0) this.entries.delete(source);
  }

  private retire(
    source: Source,
    entry: Entry<Source, Payload, SourceData>,
    replacement?: Entry<Source, Payload, SourceData>,
  ): void {
    this.invalidated.delete(entry);
    disposable(source)?.removeEventListener('dispose', entry.invalidate);
    if (replacement?.handle !== entry.handle) this.assets.release(entry.handle).unwrap();
    if (!entry.retained && entry.pins === 0) {
      this.sweepable.delete(entry);
      if (entry.seen === this.epoch) this.seen--;
    }
  }

  abort(preserveUsage = false): void {
    for (const [source, variants] of this.pending) {
      for (const [variant, entry] of variants) {
        if (entry !== this.entries.get(source)?.get(variant))
          disposable(source)?.removeEventListener('dispose', entry.invalidate);
      }
    }
    this.signatureEdits.clear();
    this.pending.clear();
    this.active = false;
    if (!preserveUsage) {
      this.epoch++;
      this.seen = 0;
    }
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
    this.sweepable.clear();
    this.invalidated.clear();
  }
}
