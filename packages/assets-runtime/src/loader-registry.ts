// @forgeax/engine-assets-runtime - LoaderRegistry (feat-20260603-asset-import-loader-injection M1 / w2).
//
// The runtime half of the engine's third DIP instance (after RHI + Console):
// an injectable table that maps `asset.kind` -> a `Loader` (the contract SSOT
// lives in `@forgeax/engine-types`, plan-strategy D-2). `AssetRegistry` holds
// one of these (constructor-injected, D-7) and dispatches `loadByGuid` through
// `get(kind)` instead of a hardcoded `if (kind === ...)` chain (D-1).
//
// Shape mirrors the Console `Registry` (packages/console/src/registry.ts)
// register/lookup pattern (research Finding 8), with one deliberate
// difference: the injected unit here is an **object** `{ kind, load }`, not a
// bare function, because a "one kind -> one loader" dispatch table is the
// natural shape (plan-strategy D-1 alt-B rejection).
//
// Fail-fast semantics (charter P3): `register` throws on a malformed loader
// or duplicate kind at wire time, so one canonical owner cannot be silently
// replaced by a later seed table.

import type { ArtifactDescriptor, LoadContext, Loader } from '@forgeax/engine-types';

export interface PackArtifactInput {
  readonly descriptor: ArtifactDescriptor;
  readonly bytes: Uint8Array;
}

export interface PackLoaderInput {
  readonly guid: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly refs: readonly string[];
  readonly streams?: Readonly<
    Record<string, { readonly descriptor: ArtifactDescriptor; readonly url: string }>
  >;
  readonly artifacts: Readonly<Record<string, PackArtifactInput>>;
}

export interface PackLoader {
  readonly kind: string;
  readonly references?: 'eager' | 'deferred';
  load(input: PackLoaderInput, ctx: LoadContext): unknown;
}

export type PackLoadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

/**
 * Injectable `asset.kind` -> {@link Loader} table held by `AssetRegistry`.
 *
 * @example Wire + dispatch (host side)
 * ```ts
 * import { LoaderRegistry, wireDefaultLoaders } from '@forgeax/engine-assets-runtime';
 * const loaders = new LoaderRegistry();
 * wireDefaultLoaders(loaders);
 * const meshLoader = loaders.get('mesh'); // Loader | undefined
 * ```
 */
export class LoaderRegistry {
  referencePolicy(kind: string): 'eager' | 'deferred' {
    return this.packLoaders.get(kind)?.references ?? this.loaders.get(kind)?.references ?? 'eager';
  }
  // feat-20260623 M4 / w13: the Map stores Loader<unknown> so host custom kinds
  // (Loader<MyPayload>) are accepted. The P in Loader<P> is covariant (output
  // only: load() returns P), so Loader<Asset> is assignable to Loader<unknown>.
  private readonly loaders = new Map<string, Loader<unknown>>();
  private readonly packLoaders = new Map<string, PackLoader>();

  /**
   * Register a loader for its `loader.kind`. Fail-fast on a malformed loader
   * (charter P3); rejects a repeated kind so the canonical owner cannot be replaced.
   *
   * @param loader the `{ kind, load }` object to register.
   * @throws TypeError when `loader.kind` is empty or `loader.load` is not a
   *   function — a wire-time misconfiguration the host must fix.
   */
  register(loader: Loader<unknown>): () => void {
    if (typeof loader.kind !== 'string' || loader.kind.length === 0) {
      throw new TypeError(
        `LoaderRegistry.register: loader.kind must be a non-empty string (got ${JSON.stringify(loader.kind)})`,
      );
    }
    if (typeof loader.load !== 'function') {
      throw new TypeError(
        `LoaderRegistry.register: loader.load must be a function for kind "${loader.kind}"`,
      );
    }
    if (this.loaders.has(loader.kind)) {
      throw new TypeError(`LoaderRegistry.register: duplicate loader kind "${loader.kind}"`);
    }
    this.loaders.set(loader.kind, loader);
    return () => {
      if (this.loaders.get(loader.kind) === loader) this.loaders.delete(loader.kind);
    };
  }

  registerPackLoader(loader: PackLoader): () => void {
    if (typeof loader.kind !== 'string' || loader.kind.length === 0) {
      throw new TypeError('LoaderRegistry.registerPackLoader: kind must be non-empty');
    }
    if (typeof loader.load !== 'function') {
      throw new TypeError(
        `LoaderRegistry.registerPackLoader: load must be a function for ${loader.kind}`,
      );
    }
    if (this.packLoaders.has(loader.kind)) {
      throw new TypeError(
        `LoaderRegistry.registerPackLoader: duplicate loader kind "${loader.kind}"`,
      );
    }
    this.packLoaders.set(loader.kind, loader);
    return () => {
      if (this.packLoaders.get(loader.kind) === loader) this.packLoaders.delete(loader.kind);
    };
  }

  async loadPack(input: PackLoaderInput, ctx: LoadContext): Promise<PackLoadResult> {
    const packLoader = this.packLoaders.get(input.kind);
    if (packLoader !== undefined) {
      const output = await packLoader.load(input, ctx);
      if (isPackLoadResult(output)) return output;
      return { ok: true, value: output };
    }
    const loader = this.loaders.get(input.kind);
    if (loader === undefined) {
      return { ok: false, error: new Error(`no loader registered for ${input.kind}`) };
    }
    if (loader.loadPack !== undefined) {
      const output = await loader.loadPack(input, ctx);
      if (isPackLoadResult(output)) return output;
      return { ok: true, value: output };
    }
    const output = await loader.load(input.payload, input.refs, ctx);
    if (isPackLoadResult(output)) return output;
    return { ok: true, value: output };
  }

  /**
   * Look up the loader registered for `kind`. Returns `undefined` when no
   * loader is wired — the `AssetRegistry` consumer maps that to a structured
   * `AssetError(code='loader-not-registered')` with the registered kinds in
   * `.detail` (charter P3).
   */
  get(kind: string): Loader<unknown> | undefined {
    return this.loaders.get(kind);
  }

  /**
   * The kinds currently wired, in insertion order. Fed into the
   * `loader-not-registered` error `.detail.registeredKinds` so AI users see
   * exactly what is injectable.
   */
  registeredKinds(): readonly string[] {
    return [...this.loaders.keys()];
  }
}

function isPackLoadResult(value: unknown): value is PackLoadResult {
  return (
    value !== null &&
    typeof value === 'object' &&
    'ok' in value &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}
