import { type ImportProduct, isDeepFrozenJson } from '@forgeax/engine-types';
import type { DdcPack, RunImportMeta } from './import-runner.js';

/**
 * Shared digest and Pack projection: supported numeric views become arrays,
 * rather than the indexed objects that JSON.stringify produces for native views.
 * Objects and arrays remain owned copies; primitive values need no view checks.
 */
export function normaliseForPack(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  // Deep-frozen JSON holds no byte views and cannot change: share it as is, so
  // later digests keep seeing one object.
  if (Object.isFrozen(value) && isDeepFrozenJson(value)) return value;
  if (
    value instanceof Float32Array ||
    value instanceof Float64Array ||
    value instanceof Uint8Array ||
    value instanceof Uint8ClampedArray ||
    value instanceof Uint16Array ||
    value instanceof Uint32Array ||
    value instanceof Int8Array ||
    value instanceof Int16Array ||
    value instanceof Int32Array
  ) {
    return Array.from(value as ArrayLike<number>);
  }
  if (Array.isArray(value)) {
    return value.map(normaliseForPack);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      normaliseForPack(entry),
    ]),
  );
}

function declarationFields(
  declaration: RunImportMeta['subAssets'][number] | undefined,
): Pick<DdcPack['assets'][number], 'sourceKey' | 'sourceIndex' | 'relations'> {
  if (declaration === undefined) return {};
  return {
    sourceIndex: declaration.sourceIndex,
    ...(declaration.sourceKey !== undefined ? { sourceKey: declaration.sourceKey } : {}),
    ...(declaration.relations !== undefined ? { relations: declaration.relations } : {}),
  };
}

/** Project validated producer assets to the canonical logical Pack v2 document. */
export function projectImportPack(
  product: Pick<ImportProduct<unknown>, 'assets'>,
  meta?: RunImportMeta,
  payload: (asset: ImportProduct<unknown>['assets'][number]) => unknown = (asset) => asset.payload,
): DdcPack {
  const declarations =
    meta === undefined ? undefined : new Map(meta.subAssets.map((asset) => [asset.guid, asset]));
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    ...(meta?.packageId === undefined ? {} : { packageId: meta.packageId }),
    ...(meta?.provenance === undefined ? {} : { provenance: meta.provenance }),
    ...(meta?.revision === undefined ? {} : { revision: meta.revision }),
    ...(meta?.diagnostics === undefined ? {} : { diagnostics: meta.diagnostics }),
    assets: product.assets.map((asset) => ({
      guid: asset.guid,
      kind: asset.kind,
      ...(declarations === undefined ? {} : declarationFields(declarations.get(asset.guid))),
      ...(asset.name === undefined ? {} : { name: asset.name }),
      payload: normaliseForPack(payload(asset)) as Record<string, unknown>,
      refs: asset.refs.map((reference) => reference.guid),
      artifacts: asset.artifacts,
    })),
  };
}
