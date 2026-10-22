/**
 * Realm-wide immutable asset facts that runtime copies may share by identity.
 *
 * Package entry points bundle private module instances, so this state lives on
 * a realm symbol: a fact retained by the Pack reader is recognised by the
 * Material loader and by every content copy in the same realm.
 *
 * Two kinds of value are admitted:
 * - deep-frozen JSON facts, which no owner can mutate;
 * - integrity-verified, content-addressed artifact bytes. Like every typed
 *   array inside a frozen runtime payload they are read-only by contract; one
 *   view per digest replaces one private copy per referencing asset.
 */
const key = Symbol.for('forgeax.assets.shared-immutable-data');

interface SharedImmutableData {
  readonly values: WeakSet<object>;
  readonly abis: WeakSet<object>;
  readonly payloads: WeakSet<object>;
  readonly bytes: Map<string, WeakRef<Uint8Array<ArrayBuffer>>>;
  readonly collected: FinalizationRegistry<string> | undefined;
}

const realm = globalThis as typeof globalThis & { [key: symbol]: unknown };
if (realm[key] === undefined) {
  const bytes = new Map<string, WeakRef<Uint8Array<ArrayBuffer>>>();
  realm[key] = {
    values: new WeakSet<object>(),
    abis: new WeakSet<object>(),
    payloads: new WeakSet<object>(),
    bytes,
    collected:
      typeof FinalizationRegistry === 'function'
        ? new FinalizationRegistry<string>((digest) => {
            if (bytes.get(digest)?.deref() === undefined) bytes.delete(digest);
          })
        : undefined,
  } satisfies SharedImmutableData;
}
const shared = realm[key] as SharedImmutableData;

/** Values runtime copies keep by identity instead of duplicating. */
export function isSharedImmutableAssetData(value: object): boolean {
  return shared.values.has(value);
}

/** Admit a material program ABI that its owner has already deep-frozen. */
export function shareFrozenMaterialAbi(abi: object): void {
  shared.abis.add(abi);
  shared.values.add(abi);
}

export function isSharedMaterialAbi(value: object): boolean {
  return shared.abis.has(value);
}

export function markRetainedMaterialPayload(payload: object): void {
  shared.payloads.add(payload);
}

export function isRetainedMaterialPayload(payload: object): boolean {
  return shared.payloads.has(payload);
}

/**
 * Return the realm's one view for verified artifact bytes. The caller must
 * already have checked that `bytes` hash to `digest`; equal digests and
 * lengths then denote equal content. The first caller's bytes are copied into
 * an exact private buffer, so the returned view never aliases caller storage.
 */
export function shareVerifiedArtifactBytes(
  digest: string,
  bytes: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const existing = shared.bytes.get(digest)?.deref();
  if (existing !== undefined && existing.byteLength === bytes.byteLength) return existing;
  const owned = new Uint8Array(bytes);
  shared.values.add(owned);
  if (typeof WeakRef === 'function') {
    shared.bytes.set(digest, new WeakRef(owned));
    shared.collected?.register(owned, digest);
  }
  return owned;
}
