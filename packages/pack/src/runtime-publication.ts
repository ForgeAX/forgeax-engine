import type { ToolCommandContract } from '@forgeax/engine-tool-runtime';
import type {
  AssetEnvelopeV2,
  AssetPublicationEnvelope,
  AssetPublicationExternalEvidence,
  AssetPublicationOutput,
  CatalogEntry,
  PackV2,
  PluginBuildTarget,
} from '@forgeax/engine-types';
import { createAssetPublication, encodeBase64, sha256 } from '@forgeax/engine-types';
import type { PackBlob } from './blob.js';
import { decodeMaterialProgramWire, encodeMaterialProgramWire } from './material-program-wire.js';
import type { PackProgram } from './program.js';

/** Portable delivered bytes. Decoding and dependency readiness remain loader responsibilities. */
export const RUNTIME_PACK_SUFFIX = '.runtime-pack.json';

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

export interface RuntimePackAssetInput
  extends Pick<AssetEnvelopeV2, 'guid' | 'kind' | 'name' | 'payload'> {
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

function isRuntimePackDocument(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { schemaVersion, kind, assets } = value as Record<string, unknown>;
  return schemaVersion === '2.0.0' && kind === 'internal-text-package' && Array.isArray(assets);
}

function isRuntimePackEnvelope(value: unknown): value is RuntimePackEnvelope {
  if (!isRuntimePackDocument(value)) return false;
  const { scopeId, generation } = value;
  return (
    typeof scopeId === 'string' &&
    scopeId.length > 0 &&
    typeof generation === 'number' &&
    Number.isSafeInteger(generation) &&
    generation > 0
  );
}

/**
 * Return the immutable Pack content used by DDC identity.  Runtime scope and
 * publication generation fence a live consumer, but do not change the
 * cooked asset bytes represented by an immutable DDC key.
 */
export function stripRuntimePackLifecycle(value: unknown): unknown {
  const decoded = decodeMaterialProgramWire(value);
  if (!decoded.ok || !isRuntimePackEnvelope(decoded.value)) return value;
  const { scopeId: _scopeId, generation: _generation, ...semantic } = decoded.value;
  return decoded.value === value ? semantic : encodeMaterialProgramWire(semantic);
}

/** Rehydrate a DDC Pack payload after optional admission of the decoded contents. */
export function bindRuntimePackScope(
  value: unknown,
  scopeId: string,
  generation: number,
  admit?: (pack: unknown) => boolean,
): unknown {
  const decoded = decodeMaterialProgramWire(value);
  if (!decoded.ok || admit?.(decoded.value) === false) return value;
  const pack = decoded.value;
  if (!isRuntimePackDocument(pack)) return pack;
  // The accepted Catalog tuple is authoritative for a live transport. This
  // also repairs a legacy DDC body whose publication generation predates the
  // current accepted candidate.
  const bound = { ...pack, scopeId, generation };
  return pack === value ? bound : encodeMaterialProgramWire(bound);
}

function* stableArray(value: readonly unknown[]): Generator<string> {
  yield '[';
  // Legacy program bytes arrive as dense numeric arrays. Batch native JSON
  // formatting without changing their digests or buffering an entire array.
  const numbers: number[] = [];
  Object.setPrototypeOf(numbers, null);
  let runStart = 0;
  function flushNumbers(): string {
    const chunk = `${runStart > 0 ? ',' : ''}${JSON.stringify(numbers).slice(1, -1)}`;
    numbers.length = 0;
    return chunk;
  }
  for (let index = 0; index < value.length; index++) {
    const present = index in value;
    const item = present ? value[index] : undefined;
    if (typeof item === 'number') {
      if (numbers.length === 0) runStart = index;
      numbers[numbers.length] = item;
      if (numbers.length === 1024) yield flushNumbers();
      continue;
    }
    if (numbers.length > 0) yield flushNumbers();
    if (index > 0) yield ',';
    // The legacy canonical representation skips a hole's value but keeps its separator.
    if (present) yield* stable(item);
  }
  if (numbers.length > 0) yield flushNumbers();
  yield ']';
}

function* stable(value: unknown): Generator<string> {
  if (value instanceof Uint8Array) yield `bytes:${encodeBase64(value)}`;
  else if (Array.isArray(value)) yield* stableArray(value);
  else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    yield '{';
    let first = true;
    for (const key of Object.keys(record).sort()) {
      if (!first) yield ',';
      first = false;
      yield `${JSON.stringify(key)}:`;
      yield* stable(record[key]);
    }
    yield '}';
  } else yield JSON.stringify(value) ?? 'null';
}
function digest(value: unknown): string {
  return `sha256:${sha256(stable(value))}`;
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

function semanticRuntimePack(assets: readonly RuntimePackAsset[]) {
  return {
    schemaVersion: '2.0.0' as const,
    kind: 'internal-text-package' as const,
    assets: [...assets].sort((left, right) =>
      left.guid.toLowerCase().localeCompare(right.guid.toLowerCase()),
    ),
  };
}

function withPublicationScope(
  pack: ReturnType<typeof semanticRuntimePack>,
  scopeId: string,
  { generation, digest, outputSetDigest }: AssetPublicationEnvelope,
): RuntimePackEnvelope {
  return { ...pack, scopeId, generation, digest, outputSetDigest };
}

/** Bind transport bytes to the scope using the already-prepared publication. */
export function bindRuntimePackPublication(
  pack: RuntimePackInput,
  scopeId: string,
  publication: AssetPublicationEnvelope,
): RuntimePackEnvelope {
  return withPublicationScope(semanticRuntimePack(normalizedAssets(pack)), scopeId, publication);
}

export function createRuntimePackPublication(
  input: RuntimePackPublicationInput,
): RuntimePackPublication {
  const assets = normalizedAssets(input.pack);
  const semantic = semanticRuntimePack(assets);
  const valueDigest = input.digest ?? digest(semantic);
  const outputs =
    input.outputs ??
    assets.map((asset) => outputFor(asset, input.sourceKeys?.get(asset.guid.toLowerCase())));
  const publication = createAssetPublication({
    sourcePath: input.sourcePath,
    sourceRevision: input.sourceRevision,
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    digest: valueDigest,
    packageUrl: input.packageUrl,
    inputFingerprint: input.inputFingerprint ?? input.sourceRevision,
    outputs,
    externalEvidence: input.externalEvidence ?? [],
  });
  return {
    pack: withPublicationScope(semantic, input.scopeId, publication),
    publication,
  };
}
