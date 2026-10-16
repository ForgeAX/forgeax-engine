import type { AssetEnvelopeV2 } from './asset.js';
import type { AssetLoadError } from './asset-errors.js';
import type { ArtifactDescriptor, Asset } from './index.js';
import type { Result } from './result.js';

/** The built-in kind vocabulary is derived from the authoritative Asset union. */
export type BuiltinAssetKind = Asset['kind'];
export type BuiltinAssetPayload<K extends BuiltinAssetKind> = Extract<Asset, { kind: K }>;

declare const assetKindPayload: unique symbol;

/** A host kind token binds its payload type to both decoder installation and load. */
export interface AssetKind<P, K extends string = string> {
  readonly kind: K;
  readonly [assetKindPayload]: (value: P) => P;
}

export type AssetKindPayload<K> = K extends AssetKind<infer P, string> ? P : never;
export type BuiltinAssetKindToken<K extends BuiltinAssetKind> = AssetKind<
  BuiltinAssetPayload<K>,
  K
>;

/** Only verified, device-neutral input is visible to a decoder. */
export interface AssetArtifactReader {
  /** Admit a validated descriptor without reading its streaming body. */
  locate?(descriptor: ArtifactDescriptor): string | undefined;
  read(descriptor: ArtifactDescriptor): Promise<Result<Uint8Array, AssetLoadError>>;
}

export interface AssetDecoderInput<P> {
  readonly envelope: AssetEnvelopeV2<P>;
  readonly artifacts: AssetArtifactReader;
  readonly signal: AbortSignal;
}

export interface AssetDecoder<P> {
  readonly references?: 'eager' | 'deferred';
  decode(input: AssetDecoderInput<P>): Promise<AssetDecoderResult<P>>;
}

/** Owner contribution installed into one host decoder map. */
export interface AssetDecoderContribution<P, K extends string = string> {
  readonly kind: AssetKind<P, K>;
  readonly decoder: AssetDecoder<P>;
  readonly consumer: string;
}

/**
 * Erased view used when one realm stores contributions for heterogeneous kinds.
 * The owner-facing contribution remains fully typed; only the assembly list
 * forgets its payload while the registry dispatches by the closed kind string.
 */
export interface AssetDecoderContributionRef {
  readonly kind: { readonly kind: string };
  readonly decoder: AssetDecoder<unknown>;
  readonly consumer: string;
}

export type AssetDecoderResult<P> = Result<P, AssetLoadError>;

/** Releasing a lease is intentionally idempotent and has one public action. */
export interface AssetDecoderLease {
  readonly kind: string;
  dispose(): void;
}

export type AssetRegistryAction = 'load' | 'snapshot' | 'subscribe' | 'installDecoder' | 'dispose';

/** Machine-readable grouping used by the root API manifest and static gates. */
export interface AssetRuntimeApiGroups {
  readonly registry: 'AssetRegistry';
  readonly catalog: 'CatalogSource';
  readonly decoder: 'AssetDecoder';
  readonly failure: 'AssetLoadError';
  readonly observation: 'AssetSnapshot';
}
