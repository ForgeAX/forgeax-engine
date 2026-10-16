/** Closed structured error contracts for Pack v2 and asset evidence. */

export type AssetLoadErrorCode =
  | 'asset-guid-invalid'
  | 'asset-kind-mismatch'
  | 'asset-not-found'
  | 'asset-not-ready'
  | 'catalog-unavailable'
  | 'catalog-discontinuous'
  | 'asset-fetch-failed'
  | 'asset-integrity-failed'
  | 'asset-package-invalid'
  | 'asset-decoder-missing'
  | 'asset-decode-failed'
  | 'asset-dependency-failed'
  | 'asset-superseded'
  | 'asset-load-cancelled'
  | 'asset-runtime-disposed';

export const ASSET_LOAD_ERROR_HINTS: Readonly<Record<AssetLoadErrorCode, string>> = {
  'asset-guid-invalid': 'provide a valid asset GUID and retry the current publication',
  'asset-kind-mismatch': 'pass the Catalog kind or the matching custom AssetKind token',
  'asset-not-found': 'inspect the producer Catalog and rebuild the missing publication',
  'asset-not-ready': 'wait for the current publication or inspect its producer lifecycle',
  'catalog-unavailable': 'inspect the scope and create a fresh Registry for a new scope',
  'catalog-discontinuous': 'reconcile the Catalog baseline before loading the current row',
  'asset-fetch-failed': 'verify the package locator and republish the Pack',
  'asset-integrity-failed': 'verify the artifact digest and recook the Pack',
  'asset-package-invalid': 'validate the Pack v2 envelope and recook invalid output',
  'asset-decoder-missing': 'install the owner decoder lease for this kind',
  'asset-decode-failed': 'inspect the structured decoder detail and repair the owner output',
  'asset-dependency-failed': 'repair the dependency publication named in detail and retry',
  'asset-superseded': 'load the current publication instead of the superseded ticket',
  'asset-load-cancelled': 'retry with a live AbortSignal when the request is still needed',
  'asset-runtime-disposed': 'obtain a new Registry from the current realm',
};

type AssetLoadErrorBase<C extends AssetLoadErrorCode, D> = {
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: D;
};

export type AssetLoadError =
  | AssetLoadErrorBase<'asset-guid-invalid', { readonly guid: string }>
  | AssetLoadErrorBase<
      'asset-kind-mismatch',
      { readonly guid: string; readonly expectedKind: string; readonly actualKind: string }
    >
  | AssetLoadErrorBase<'asset-not-found', { readonly guid: string }>
  | AssetLoadErrorBase<'asset-not-ready', { readonly guid: string; readonly generation: number }>
  | AssetLoadErrorBase<'catalog-unavailable', { readonly scopeId: string }>
  | AssetLoadErrorBase<
      'catalog-discontinuous',
      {
        readonly scopeId: string;
        readonly expectedGeneration: number;
        readonly actualGeneration: number;
      }
    >
  | AssetLoadErrorBase<'asset-fetch-failed', { readonly guid: string; readonly packageUrl: string }>
  | AssetLoadErrorBase<
      'asset-integrity-failed',
      {
        readonly guid: string;
        readonly artifactKey: string;
        readonly expectedDigest: string;
        readonly actualDigest: string;
      }
    >
  | AssetLoadErrorBase<'asset-package-invalid', { readonly guid: string; readonly reason: string }>
  | AssetLoadErrorBase<'asset-decoder-missing', { readonly kind: string }>
  | AssetLoadErrorBase<'asset-decode-failed', { readonly guid: string; readonly kind: string }>
  | AssetLoadErrorBase<
      'asset-dependency-failed',
      { readonly guid: string; readonly dependencyGuid: string }
    >
  | AssetLoadErrorBase<'asset-superseded', { readonly guid: string; readonly generation: number }>
  | AssetLoadErrorBase<'asset-load-cancelled', { readonly guid: string }>
  | AssetLoadErrorBase<'asset-runtime-disposed', { readonly scopeId: string }>;

export type AssetArtifactErrorCode =
  | 'asset-artifact-path-invalid'
  | 'asset-artifact-missing'
  | 'asset-artifact-integrity-mismatch'
  | 'asset-artifact-media-unsupported'
  | 'asset-artifact-codec-unsupported'
  | 'asset-artifact-encoding-unsupported'
  | 'asset-artifact-decode-failed';

export type AssetArtifactErrorDetail =
  | {
      readonly guid: string;
      readonly artifactKey: string;
      readonly observed: string;
      readonly expected: string;
    }
  | {
      readonly guid: string;
      readonly artifactKey: string;
      readonly observed: string;
      readonly expected: string;
      readonly path: string;
    };

export type AssetArtifactError =
  | {
      readonly code: 'asset-artifact-path-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: Extract<AssetArtifactErrorDetail, { readonly artifactKey: string }>;
    }
  | {
      readonly code: 'asset-artifact-missing';
      readonly expected: string;
      readonly hint: string;
      readonly detail: Extract<AssetArtifactErrorDetail, { readonly path: string }>;
    }
  | {
      readonly code: Exclude<
        AssetArtifactErrorCode,
        'asset-artifact-path-invalid' | 'asset-artifact-missing'
      >;
      readonly expected: string;
      readonly hint: string;
      readonly detail: Extract<AssetArtifactErrorDetail, { readonly artifactKey: string }>;
    };

export type PackV2ErrorCode =
  | 'pack-v2-version-unsupported'
  | 'pack-v2-envelope-invalid'
  | 'pack-v2-duplicate-guid'
  | 'pack-v2-duplicate-artifact-key'
  | 'pack-v2-artifact-descriptor-invalid';

export type PackV2ErrorDetail =
  | { readonly observed: string; readonly expected: string }
  | { readonly guid: string; readonly paths: readonly string[] }
  | { readonly guid: string; readonly artifactKey: string }
  | { readonly guid: string; readonly artifactKey: string; readonly field: string };

export interface PackV2Error {
  readonly code: PackV2ErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PackV2ErrorDetail;
}

export type AssetEvidenceErrorDetail =
  | { readonly capability: string; readonly stage: string }
  | { readonly guid: string; readonly observed: string; readonly expected: string };

export interface AssetEvidenceError {
  readonly code: AssetEvidenceErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AssetEvidenceErrorDetail;
}

export const ASSET_EVIDENCE_ERROR_HINTS = {
  'asset-evidence-capability-missing':
    'provide the missing evidence capability, then rerun asset lookup or verify',
  'asset-evidence-source-conflict':
    'keep one source declaration per GUID and rerun the offline evidence projection',
  'asset-evidence-locator-conflict':
    'keep one packageUrl per GUID and rebuild the catalog before verifying the asset',
  'asset-evidence-receipt-conflict':
    'keep one producer-owned receipt per GUID and rerun cook before verifying the asset',
  'asset-evidence-digest-mismatch':
    'recook the source or restore the package bytes, then rerun artifact verification',
} satisfies Readonly<Record<string, string>>;

export type AssetEvidenceErrorCode = keyof typeof ASSET_EVIDENCE_ERROR_HINTS;

/** Ordered author-to-runtime stages used by structured recovery errors. */
export type AssetErrorStage =
  | 'author-validation'
  | 'external-declaration'
  | 'import'
  | 'native-cook'
  | 'ddc-validation'
  | 'runtime-parse'
  | 'editor-capability';

/** AI-readable next action; it does not grant a cache or runtime write authority. */
export interface AssetStageRecovery {
  readonly action: string;
  readonly command?: string;
  readonly retryable: boolean;
}

export type AssetStageErrorDetail =
  | { readonly authoringPath: string; readonly rule: string }
  | { readonly sourceKey: string; readonly sourceIndex?: number }
  | { readonly sourcePath: string; readonly importer?: string }
  | { readonly guid: string; readonly producer: string }
  | { readonly guid: string; readonly observedDigest: string; readonly expectedDigest: string }
  | { readonly guid: string; readonly packageUrl: string }
  | { readonly capability: string; readonly assetKind: string };

export interface AssetStageErrorBase<S extends AssetErrorStage, C extends string> {
  readonly stage: S;
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AssetStageErrorDetail;
  readonly recovery: AssetStageRecovery;
}

type AssetStageErrorWithDetail<
  S extends AssetErrorStage,
  C extends string,
  D extends AssetStageErrorDetail,
> = Omit<AssetStageErrorBase<S, C>, 'detail'> & { readonly detail: D };

export type AuthorValidationError = AssetStageErrorWithDetail<
  'author-validation',
  'author-validation-failed',
  Extract<AssetStageErrorDetail, { readonly authoringPath: string }>
>;
export type ExternalDeclarationError = AssetStageErrorWithDetail<
  'external-declaration',
  'external-declaration-invalid',
  Extract<AssetStageErrorDetail, { readonly sourceKey: string }>
>;
export type ImportStageError = AssetStageErrorWithDetail<
  'import',
  'import-failed',
  Extract<AssetStageErrorDetail, { readonly sourcePath: string }>
>;
export type NativeCookError = AssetStageErrorWithDetail<
  'native-cook',
  'native-cook-failed',
  Extract<AssetStageErrorDetail, { readonly guid: string; readonly producer: string }>
>;
export type DdcValidationError = AssetStageErrorWithDetail<
  'ddc-validation',
  'ddc-validation-failed',
  Extract<AssetStageErrorDetail, { readonly observedDigest: string }>
>;
export type RuntimeParseError = AssetStageErrorWithDetail<
  'runtime-parse',
  'runtime-parse-failed',
  Extract<AssetStageErrorDetail, { readonly packageUrl: string }>
>;
export type EditorCapabilityError = AssetStageErrorWithDetail<
  'editor-capability',
  'editor-capability-unavailable',
  Extract<AssetStageErrorDetail, { readonly capability: string }>
>;

export type AssetStageError =
  | AuthorValidationError
  | ExternalDeclarationError
  | ImportStageError
  | NativeCookError
  | DdcValidationError
  | RuntimeParseError
  | EditorCapabilityError;

export type AssetStageErrorCode = AssetStageError['code'];

export const ASSET_STAGE_ERROR_HINTS: Readonly<Record<AssetStageErrorCode, string>> = {
  'author-validation-failed': 'read the authoring rule and apply the suggested recovery',
  'external-declaration-invalid': 'repair the sourceKey declaration and retry recovery',
  'import-failed': 'fix the importer input or registration, then retry recovery',
  'native-cook-failed': 'fix the native producer and rerun recovery',
  'ddc-validation-failed': 'repair the cooked artifact and rerun recovery',
  'runtime-parse-failed': 'repair the package payload and rerun recovery',
  'editor-capability-unavailable': 'register the capability and retry recovery',
};
