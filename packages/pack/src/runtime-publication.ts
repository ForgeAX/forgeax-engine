import type { ToolCommandContract } from '@forgeax/engine-tool-runtime';
import type {
  AssetPublicationEnvelope,
  AssetPublicationExternalEvidence,
  AssetPublicationOutput,
  CatalogEntry,
  PackV2,
  PluginBuildTarget,
} from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { PackBlob } from './blob.js';
import type { PackProgram } from './program.js';

/** Portable delivered bytes. Decoding and dependency readiness remain loader responsibilities. */
export interface FixedPackExecution {
  readonly programs: Readonly<Record<string, PackProgram>>;
  /** Membership is the producer's explicit executable plugin projection for this target. */
  readonly tools: Readonly<Record<string, ToolCommandContract>>;
}

export interface FixedPackPublication {
  readonly pack: PackV2;
  readonly rows: readonly CatalogEntry[];
  /** Original transport bytes keyed by the unchanged package-relative artifact path. */
  readonly blobs: Readonly<Record<string, PackBlob>>;
  readonly executions?: Readonly<Partial<Record<PluginBuildTarget, FixedPackExecution>>>;
}

export interface RuntimePackAssetInput {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly payload: unknown;
  readonly refs?: readonly string[];
  readonly artifacts?: Readonly<Record<string, unknown>>;
}

export interface RuntimePackInput {
  readonly assets: readonly RuntimePackAssetInput[];
}

export interface RuntimePackEnvelope {
  readonly schemaVersion: '2.0.0';
  readonly kind: 'internal-text-package';
  readonly scopeId: string;
  readonly generation: number;
  readonly digest: string;
  readonly outputSetDigest: string;
  readonly assets: readonly RuntimePackAsset[];
}

export interface RuntimePackPublication {
  readonly pack: RuntimePackEnvelope;
  readonly publication: AssetPublicationEnvelope;
}

interface RuntimePackAsset extends RuntimePackAssetInput {
  readonly refs: readonly string[];
  readonly artifacts: Readonly<Record<string, unknown>>;
}

export interface RuntimePackPublicationInput {
  readonly pack: RuntimePackInput;
  readonly scopeId: string;
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly packageUrl: string;
  readonly inputFingerprint?: string;
  readonly digest?: string;
  readonly generation?: number;
  readonly outputs?: readonly AssetPublicationOutput[];
  /** Author/producer keys by normalized GUID when deriving output rows. */
  readonly sourceKeys?: ReadonlyMap<string, string>;
  readonly externalEvidence?: readonly AssetPublicationExternalEvidence[];
}

function isRuntimePackEnvelope(value: unknown): value is RuntimePackEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === '2.0.0' &&
    record.kind === 'internal-text-package' &&
    typeof record.scopeId === 'string' &&
    record.scopeId.length > 0 &&
    typeof record.generation === 'number' &&
    Number.isSafeInteger(record.generation) &&
    record.generation > 0 &&
    Array.isArray(record.assets)
  );
}

/**
 * Return the immutable Pack content used by DDC identity.  Runtime scope and
 * publication generation fence a live consumer, but do not change the
 * cooked asset bytes represented by an immutable DDC key.
 */
export function stripRuntimePackLifecycle(value: unknown): unknown {
  if (!isRuntimePackEnvelope(value)) return value;
  const { scopeId: _scopeId, generation: _generation, ...semantic } = value;
  return semantic;
}

/** Rehydrate a DDC Pack payload into the active runtime scope for transport. */
export function bindRuntimePackScope(value: unknown, scopeId: string, generation: number): unknown {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { readonly schemaVersion?: unknown }).schemaVersion !== '2.0.0' ||
    (value as { readonly kind?: unknown }).kind !== 'internal-text-package' ||
    !Array.isArray((value as { readonly assets?: unknown }).assets)
  ) {
    return value;
  }
  // The accepted Catalog tuple is authoritative for a live transport. This
  // also repairs a legacy DDC body whose publication generation predates the
  // current accepted candidate.
  return { ...(value as Record<string, unknown>), scopeId, generation };
}

function stable(value: unknown): string {
  if (value instanceof Uint8Array) {
    let binary = '';
    for (let offset = 0; offset < value.length; offset += 8192) {
      binary += String.fromCharCode(...value.subarray(offset, offset + 8192));
    }
    return `bytes:${btoa(binary)}`;
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(stable(value))))}`;
}

function normalizedAssets(pack: RuntimePackInput): readonly RuntimePackAsset[] {
  return pack.assets.map((asset) => {
    const payload = asset.payload;
    const canonicalPayload =
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      !(payload instanceof Uint8Array) &&
      typeof (payload as Record<string, unknown>).kind !== 'string'
        ? { ...(payload as Record<string, unknown>), kind: asset.kind }
        : payload;
    return {
      ...asset,
      payload: canonicalPayload,
      refs: [...(asset.refs ?? [])].map((ref) => ref.toLowerCase()),
      artifacts: asset.artifacts ?? {},
    };
  });
}

function outputFor(asset: RuntimePackAsset, sourceKey?: string): AssetPublicationOutput {
  return {
    guid: asset.guid.toLowerCase(),
    sourceKey: sourceKey ?? asset.guid.toLowerCase(),
    kind: asset.kind,
    digest: digest({
      guid: asset.guid.toLowerCase(),
      kind: asset.kind,
      name: asset.name,
      payload: asset.payload,
      refs: asset.refs,
      artifacts: asset.artifacts,
    }),
    refs: asset.refs,
  };
}

function outputSetDigest(outputs: readonly AssetPublicationOutput[]): string {
  return digest(
    outputs.map((output) => ({
      guid: output.guid.toLowerCase(),
      sourceKey: output.sourceKey,
      kind: output.kind,
      digest: output.digest,
      refs: [...output.refs].map((guid) => guid.toLowerCase()),
    })),
  );
}

function publicationGeneration(
  sourceRevision: string,
  valueDigest: string,
  outputs: string,
): number {
  const value = bytesToHex(
    sha256(new TextEncoder().encode(`${sourceRevision}\n${valueDigest}\n${outputs}`)),
  );
  const generation = Number.parseInt(value.slice(0, 8), 16);
  return generation > 0 ? generation : 1;
}

export function createRuntimePackPublication(
  input: RuntimePackPublicationInput,
): RuntimePackPublication {
  const assets = normalizedAssets(input.pack);
  const semantic = {
    schemaVersion: '2.0.0' as const,
    kind: 'internal-text-package' as const,
    assets: [...assets].sort((left, right) =>
      left.guid.toLowerCase().localeCompare(right.guid.toLowerCase()),
    ),
  };
  const valueDigest = input.digest ?? digest(semantic);
  const outputs =
    input.outputs ??
    assets.map((asset) => outputFor(asset, input.sourceKeys?.get(asset.guid.toLowerCase())));
  const outputDigest = outputSetDigest(outputs);
  const generation =
    input.generation ?? publicationGeneration(input.sourceRevision, valueDigest, outputDigest);
  const externalEvidence = input.externalEvidence ?? [];
  const inputFingerprint = input.inputFingerprint ?? input.sourceRevision;
  const publication: AssetPublicationEnvelope = {
    schemaVersion: 'asset-publication/1',
    sourcePath: input.sourcePath,
    sourceRevision: input.sourceRevision,
    generation,
    digest: valueDigest,
    outputSetDigest: outputDigest,
    outputs,
    receipt: {
      schemaVersion: 'asset-publication-receipt/1',
      sourcePath: input.sourcePath,
      sourceRevision: input.sourceRevision,
      inputFingerprint,
      outputDigest: valueDigest,
      outputSetDigest: outputDigest,
      externalEvidence,
    },
    externalEvidence,
    current: {
      generation,
      digest: valueDigest,
      outputSetDigest: outputDigest,
      packageUrl: input.packageUrl,
      receiptKey: inputFingerprint,
    },
  };
  return {
    pack: {
      ...semantic,
      scopeId: input.scopeId,
      generation,
      digest: valueDigest,
      outputSetDigest: outputDigest,
    },
    publication,
  };
}
