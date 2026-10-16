import { type NativeCooker, NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import type {
  ImportError,
  ImportErrorDetail,
  ImportedAsset,
  ImportProduct,
  ImportProductFinalizeOptions,
  ImportProductFinalizeResult,
  Result,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import type { ImportRunnerFs, RunImportMeta } from './import-runner.js';
import { runImport } from './import-runner.js';
import type { ImporterRegistry } from './importer-registry.js';

export type ProducerReadiness = 'before-consume' | 'on-demand';

export interface ProducerReadinessError {
  readonly code: 'producer-readiness-invalid';
  readonly expected: "'before-consume' or 'on-demand'";
  readonly hint: 'set producerReadiness to before-consume or on-demand';
  readonly detail: { readonly value: unknown };
}

export type ProducerReadinessResult =
  | { readonly ok: true; readonly value: ProducerReadiness }
  | { readonly ok: false; readonly error: ProducerReadinessError };

export function parseProducerReadiness(value: unknown): ProducerReadinessResult {
  if (value === undefined || value === 'before-consume' || value === 'on-demand') {
    return { ok: true, value: value ?? 'before-consume' };
  }
  return {
    ok: false,
    error: {
      code: 'producer-readiness-invalid',
      expected: "'before-consume' or 'on-demand'",
      hint: 'set producerReadiness to before-consume or on-demand',
      detail: { value },
    },
  };
}

export interface SourcePackageProducerInput {
  readonly meta: RunImportMeta;
  readonly registry: ImporterRegistry;
  readonly fs: ImportRunnerFs;
  readonly cookers?: readonly NativeCooker[];
}

export interface SourcePackageClosureDetail {
  readonly stage: 'closure';
  readonly declaredGuids: readonly string[];
  readonly producedGuids: readonly string[];
  readonly missingGuids: readonly string[];
  readonly unexpectedGuids: readonly string[];
  readonly duplicateGuids: readonly string[];
}

export interface SourcePackageClosureError {
  readonly code: 'source-package-guid-closure-mismatch';
  readonly expected: string;
  readonly hint: string;
  readonly detail: SourcePackageClosureDetail;
}

export interface SourcePackageProduct {
  readonly anchorGuid: string;
  readonly declaredGuids: readonly string[];
  readonly product: ImportProduct<unknown>;
}

type SourcePackageFinalizeError = Extract<
  ImportProductFinalizeResult,
  { readonly ok: false }
>['error'];

/** Apply an importer-owned transport finalizer without teaching the adapter its kind. */
export async function finalizeSourcePackage(
  product: ImportProduct<unknown>,
  finalizer:
    | ((
        product: ImportProduct<unknown>,
        options: ImportProductFinalizeOptions,
      ) => ImportProductFinalizeResult | Promise<ImportProductFinalizeResult>)
    | undefined,
  artifactUrl: ImportProductFinalizeOptions['artifactUrl'],
): Promise<Result<ImportProduct<unknown>, SourcePackageFinalizeError>> {
  if (finalizer === undefined) return ok(product);
  const result = await finalizer(product, { artifactUrl });
  if (!result.ok) return err(result.error);
  return ok({
    ...product,
    assets: product.assets.map((asset, index) =>
      index === 0 ? { ...asset, payload: result.value.asset } : asset,
    ),
  });
}

export type SourcePackageProducerResult =
  | { readonly ok: true; readonly value: SourcePackageProduct }
  | { readonly ok: false; readonly error: SourcePackageClosureError | ImportError };

function closureError(
  declaredGuids: readonly string[],
  producedGuids: readonly string[],
): SourcePackageClosureError {
  const declared = new Set(declaredGuids.map((guid) => guid.toLowerCase()));
  const produced = new Set(producedGuids.map((guid) => guid.toLowerCase()));
  const counts = new Map<string, number>();
  for (const guid of producedGuids) {
    const key = guid.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicateGuids = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([guid]) => guid);
  return {
    code: 'source-package-guid-closure-mismatch',
    expected: 'the importer to return exactly one asset for every declared Meta GUID',
    hint: 'repair the Meta declaration or importer output, then rebuild the whole source package',
    detail: {
      stage: 'closure',
      declaredGuids,
      producedGuids,
      missingGuids: declaredGuids.filter((guid) => !produced.has(guid.toLowerCase())),
      unexpectedGuids: producedGuids.filter((guid) => !declared.has(guid.toLowerCase())),
      duplicateGuids,
    },
  };
}

function producedGuidsFromImportFailure(
  declaredGuids: readonly string[],
  detail: ImportErrorDetail,
): readonly string[] {
  if ('missingGuids' in detail) {
    return declaredGuids.filter((guid) => !detail.missingGuids.includes(guid));
  }
  if ('unexpectedGuids' in detail) return [...declaredGuids, ...detail.unexpectedGuids];
  return [];
}

export async function produceSourcePackage(
  input: SourcePackageProducerInput,
): Promise<SourcePackageProducerResult> {
  const declaredGuids = input.meta.subAssets.map((asset) => asset.guid);
  const cookers = new NativeCookerRegistry();
  for (const cooker of input.cookers ?? []) cookers.register(cooker);
  const result = await runImport(
    { ...input.meta, buildPack: false },
    input.registry,
    input.fs,
    cookers,
  );
  if (!result.ok) {
    // Only output-topology failures describe GUID closure. Preserve the owning
    // import error for missing modules, unreadable sources and conversion failures.
    if (result.error.code !== 'guid-mismatch' && result.error.code !== 'import-produced-no-assets')
      return result;
    const producedGuids = producedGuidsFromImportFailure(declaredGuids, result.error.detail);
    return {
      ok: false,
      error: closureError(declaredGuids, producedGuids),
    };
  }
  if ('skipped' in result.value) {
    return { ok: false, error: closureError(declaredGuids, []) };
  }

  const producedGuids = result.value.product.assets.map((asset) => asset.guid);
  const declaredSet = new Set(declaredGuids.map((guid) => guid.toLowerCase()));
  const producedSet = new Set(producedGuids.map((guid) => guid.toLowerCase()));
  const hasDuplicate =
    new Set(producedGuids.map((guid) => guid.toLowerCase())).size !== producedGuids.length;
  const complete =
    !hasDuplicate &&
    declaredGuids.length === producedGuids.length &&
    declaredGuids.every((guid) => producedSet.has(guid.toLowerCase())) &&
    producedGuids.every((guid) => declaredSet.has(guid.toLowerCase()));
  if (!complete) return { ok: false, error: closureError(declaredGuids, producedGuids) };

  const product = result.value.product;
  const anchorGuid = [...declaredGuids].sort((left, right) => left.localeCompare(right))[0];
  if (anchorGuid === undefined)
    return { ok: false, error: closureError(declaredGuids, producedGuids) };
  return {
    ok: true,
    value: {
      anchorGuid,
      declaredGuids,
      product,
    },
  };
}

export function sourcePackageAssetsByGuid(
  source: SourcePackageProduct,
): ReadonlyMap<string, ImportedAsset<unknown>> {
  return new Map(source.product.assets.map((asset) => [asset.guid.toLowerCase(), asset]));
}
