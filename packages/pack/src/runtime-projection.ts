import type {
  AssetEnvelopeV2,
  AssetPublicationTuple,
  AssetRuntimeArtifactDescriptor,
  PackV2,
  PackV2Error,
  Result,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

export interface RuntimeAssetProjectionInput<P = unknown> {
  readonly guid: string;
  readonly kind: string;
  readonly payload: P;
  readonly refs: readonly string[];
  readonly artifacts: Readonly<Record<string, AssetRuntimeArtifactDescriptor>>;
}

export interface RuntimePackProjectionInput<P = unknown> extends AssetPublicationTuple {
  readonly assets: readonly RuntimeAssetProjectionInput<P>[];
}

function invalid(observed: string, expected: string): Result<never, PackV2Error> {
  return err({
    code: 'pack-v2-envelope-invalid',
    expected,
    hint: 'publish one verified Pack v2 envelope with one atomic publication tuple',
    detail: { observed, expected },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRuntimePublicationTuple(value: unknown): value is AssetPublicationTuple {
  return (
    isRecord(value) &&
    typeof value.scopeId === 'string' &&
    value.scopeId.length > 0 &&
    typeof value.generation === 'number' &&
    Number.isInteger(value.generation) &&
    value.generation > 0 &&
    typeof value.digest === 'string' &&
    value.digest.length > 0 &&
    typeof value.outputSetDigest === 'string' &&
    value.outputSetDigest.length > 0
  );
}

function isAsset(value: unknown): value is RuntimeAssetProjectionInput {
  return (
    isRecord(value) &&
    typeof value.guid === 'string' &&
    value.guid.length > 0 &&
    typeof value.kind === 'string' &&
    value.kind.length > 0 &&
    Array.isArray(value.refs) &&
    value.refs.every((ref) => typeof ref === 'string') &&
    isRecord(value.artifacts)
  );
}

/** Project producer facts into the only runtime Pack v2 envelope. */
export function projectRuntimePack<P = unknown>(value: unknown): Result<PackV2<P>, PackV2Error> {
  if (
    !isRecord(value) ||
    (('schemaVersion' in value || 'kind' in value) &&
      (value.schemaVersion !== '2.0.0' || value.kind !== 'internal-text-package'))
  ) {
    return invalid('legacy or malformed pack input', 'runtime Pack v2');
  }
  if (
    !isRuntimePublicationTuple(value) ||
    !Array.isArray(value.assets) ||
    !value.assets.every(isAsset)
  ) {
    return invalid('incomplete publication tuple or asset envelope', 'verified runtime Pack v2');
  }

  const seen = new Set<string>();
  for (const asset of value.assets) {
    const guid = asset.guid.toLowerCase();
    if (seen.has(guid)) {
      return err({
        code: 'pack-v2-duplicate-guid',
        expected: 'one asset envelope per GUID',
        hint: 'publish one producer row and recook the package output set',
        detail: { guid: asset.guid, paths: [] },
      });
    }
    seen.add(guid);
  }

  return ok({
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    scopeId: value.scopeId,
    generation: value.generation,
    digest: value.digest,
    outputSetDigest: value.outputSetDigest,
    assets: value.assets as readonly AssetEnvelopeV2<P>[],
  });
}
