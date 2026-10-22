import type { AssetEnvelope } from './asset-reference.js';
/** Pack v2 asset-local artifact contract. */

export type ContentEncoding = 'identity' | 'zstd';

export interface AssetCodec {
  readonly name: string;
  /** Container identity is orthogonal to runtime texture color semantics. */
  readonly container?: 'ktx2' | 'basis';
  readonly profile?: string;
  readonly version?: string;
}

/** Runtime projection of a codec failure without losing recovery context. */
export interface AssetCodecFailureDetail {
  readonly sourcePath: string;
  readonly codecCode: string;
  readonly codecExpected: string;
  readonly codecHint: string;
  readonly codecDetail: Readonly<Record<string, unknown>>;
  readonly container: NonNullable<AssetCodec['container']>;
  readonly profile?: string;
  readonly targetFormat?: string;
  readonly capabilities: Readonly<{
    readonly bc: boolean;
    readonly etc2: boolean;
    readonly astc: boolean;
  }>;
}

export interface Integrity {
  readonly algorithm: 'sha256';
  readonly digest: string;
}

export interface ArtifactDescriptor {
  /** Native Host transport consumes the URL; the loader admits its descriptor without reading the body. */
  readonly delivery?: 'stream';
  readonly path: string;
  readonly mediaType: string;
  readonly assetCodec?: AssetCodec;
  readonly contentEncoding?: ContentEncoding;
  readonly byteLength?: number;
  readonly integrity?: Integrity;
  /** Stored window in a content-addressed transport chunk; integrity covers this artifact only. */
  readonly byteRange?: {
    readonly offset: number;
    readonly length: number;
    readonly bundleDigest: string;
  };
}

/** The publication identity shared by one Catalog row and one Pack envelope. */
export interface AssetPublicationTuple {
  readonly scopeId: string;
  readonly generation: number;
  readonly digest: string;
  readonly outputSetDigest: string;
}

/** Runtime validation requires every artifact integrity fact before decode. */
export interface AssetRuntimeArtifactDescriptor extends ArtifactDescriptor {
  readonly contentEncoding: ContentEncoding;
  readonly byteLength: number;
  readonly integrity: Integrity;
}

/** Shared completed output produced by every build-time asset producer. */
export interface CookProduct<P = unknown> {
  readonly guid: string;
  readonly payload: P;
  readonly refs: readonly string[];
  readonly artifacts: Readonly<Record<string, ArtifactDescriptor>>;
  readonly digest: string;
  readonly receipt: import('./asset-evidence.js').CookReceipt;
}

/** The canonical verified asset envelope consumed by runtime decoders. */
export interface AssetEnvelopeV2<P = unknown> extends Omit<AssetEnvelope<P>, 'refs'> {
  readonly refs: readonly string[];
  readonly artifacts: Readonly<Record<string, AssetRuntimeArtifactDescriptor>>;
}

/** The canonical Pack v2 envelope; its publication tuple is atomic. */
export interface PackV2<P = unknown> extends AssetPublicationTuple {
  readonly schemaVersion: '2.0.0';
  readonly kind: 'internal-text-package';
  readonly assets: readonly AssetEnvelopeV2<P>[];
}

/** Cooked PCM16 little-endian WAV window index. Hashes cover data windows only. */
export interface AudioStreamManifest {
  readonly format: 'wav-pcm16/1';
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly frames: number;
  readonly dataOffset: number;
  readonly chunkFrames: number;
  readonly hashes: readonly string[];
}

export type AudioClipAsset = {
  readonly kind: 'audio';
  readonly sourceKey: string;
  readonly mediaType: `audio/${string}`;
} & (
  | { readonly bytes: Uint8Array; readonly stream?: never }
  | { readonly bytes?: never; readonly stream: AudioStreamManifest & { readonly url: string } }
);

export type CookStatus = 'notRequired' | 'notCooked' | 'failed' | 'ready' | 'unknown';
export type CookFreshness = 'notApplicable' | 'current' | 'stale' | 'unknown';
export type ArtifactVerificationStatus = 'notChecked' | 'passed' | 'failed';
export type RuntimeEvidenceStatus = 'ready' | 'provisional' | 'unknown' | 'notChecked';
export type CookReceiptStatus = 'loading' | 'succeeded' | 'failed';
export type CookOrigin = 'authoredPack' | 'sourceMeta';

export type {
  AssetEvidence,
  AssetEvidenceArtifact,
  AssetEvidenceInputs,
  AssetEvidenceLocator,
  AssetEvidencePackageInput,
  AssetEvidenceStatus,
  CookReceipt,
  PackageVerificationEvidence,
  SourceDeclarationEvidence,
} from './asset-evidence.js';
export { projectAssetEvidence, projectCookProductEvidence } from './asset-evidence.js';
