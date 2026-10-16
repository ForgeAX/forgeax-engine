import type { CatalogDiagnostic } from './asset-producer.js';
import type { CatalogEntry } from './catalog.js';

/** Versioned wire shape shared by the asset producer and browser consumers. */
export const RUNTIME_ASSET_BINDING_SCHEMA = 'runtime-asset-binding-v1' as const;
export const RUNTIME_CATALOG_SNAPSHOT_SCHEMA = 'runtime-catalog-snapshot-v1' as const;

export type RuntimeScopeStatus = 'unbound' | 'transitioning' | 'ready' | 'degraded' | 'unavailable';

/**
 * Logical projection of one package-declared asset root into the runtime
 * catalog coordinate space. This carries no filesystem path across the wire.
 */
export interface RuntimeCatalogRoot {
  readonly root: string;
  readonly catalogPrefix: string;
}

/**
 * The only identity a browser-side asset consumer may use for a dev realm.
 * `scopeId` describes ownership; `generation` rejects stale browser work.
 * Filesystem roots intentionally do not cross this wire contract; catalogRoots
 * is only the logical declaration-to-catalog projection used by browser views.
 */
export interface RuntimeAssetBinding {
  readonly schemaVersion: typeof RUNTIME_ASSET_BINDING_SCHEMA;
  readonly gameId: string;
  readonly scopeId: string;
  readonly generation: number;
  readonly status: RuntimeScopeStatus;
  readonly catalogUrl: string;
  readonly importUrlBase: string;
  readonly packageUrlBase: string;
  readonly catalogRoots?: readonly RuntimeCatalogRoot[];
  readonly authority?: 'authoritative' | 'degraded';
  readonly diagnostics?: readonly CatalogDiagnostic[];
}

export function isRuntimeCatalogRoots(value: unknown): value is readonly RuntimeCatalogRoot[] {
  return (
    Array.isArray(value) &&
    value.every(
      (root) =>
        root !== null &&
        typeof root === 'object' &&
        typeof (root as { root?: unknown }).root === 'string' &&
        typeof (root as { catalogPrefix?: unknown }).catalogPrefix === 'string',
    )
  );
}

/** Authority-bearing catalog response for one runtime scope. */
export interface RuntimeCatalogSnapshot {
  readonly schemaVersion: typeof RUNTIME_CATALOG_SNAPSHOT_SCHEMA;
  readonly scopeId: string;
  readonly generation: number;
  readonly authority: 'authoritative' | 'degraded';
  readonly entries: readonly CatalogEntry[];
  readonly diagnostics: readonly CatalogDiagnostic[];
}

/** Validate the existing Catalog containers; callers validate rows and expected scope. */
export function readCatalogRows(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== 'object') return undefined;
  const snapshot = value as Record<string, unknown>;
  return snapshot.schemaVersion === RUNTIME_CATALOG_SNAPSHOT_SCHEMA &&
    typeof snapshot.scopeId === 'string' &&
    typeof snapshot.generation === 'number' &&
    Number.isSafeInteger(snapshot.generation) &&
    snapshot.authority === 'authoritative' &&
    Array.isArray(snapshot.entries)
    ? snapshot.entries
    : undefined;
}

/**
 * Make a route below the engine's scoped runtime namespace. The helper is
 * deliberately pure so hosts and tests cannot drift on URL construction.
 */
export function runtimeScopePath(
  binding: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'>,
  suffix = '',
): string {
  const normalized = suffix.length === 0 ? '' : `/${suffix.replace(/^\/+/, '')}`;
  return `/__pack/scopes/${encodeURIComponent(binding.scopeId)}/${binding.generation}${normalized}`;
}

/**
 * Create the fixed binding used by a standalone Vite game host.
 *
 * A standalone host still has one explicit realm: its game owns the roots and
 * the browser endpoints are derived from the same scope/generation pair. The
 * optional scope override is only for a host-level test server that mounts
 * several standalone entrypoints behind one deliberately shared test realm;
 * production hosts should leave it unset.
 */
export function createStandaloneRuntimeAssetBinding(
  gameId: string,
  scopeId = gameId,
  basePath = '',
): RuntimeAssetBinding {
  const normalizedBase = basePath === '/' ? '' : basePath.replace(/\/+$/, '');
  const identity = { scopeId, generation: 1 } as const;
  const scopedPath = runtimeScopePath(identity);
  const hostPrefix = normalizedBase.startsWith('/') ? normalizedBase : `/${normalizedBase}`;
  const prefix = normalizedBase.length === 0 ? '' : hostPrefix;
  return {
    schemaVersion: RUNTIME_ASSET_BINDING_SCHEMA,
    gameId,
    scopeId,
    generation: identity.generation,
    status: 'ready',
    catalogUrl: `${prefix}${scopedPath}/catalog.json`,
    importUrlBase: `${prefix}${scopedPath}/import`,
    packageUrlBase: prefix,
  };
}

export function runtimeScopeMatches(
  binding: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'> | undefined,
  scopeId: string,
  generation: number,
): boolean {
  return binding?.scopeId === scopeId && binding.generation === generation;
}
