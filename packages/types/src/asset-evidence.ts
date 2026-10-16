import type {
  ArtifactDescriptor,
  ArtifactVerificationStatus,
  ContentEncoding,
  CookFreshness,
  CookOrigin,
  CookReceiptStatus,
  CookStatus,
  Integrity,
  RuntimeEvidenceStatus,
} from './asset.js';
import {
  ASSET_EVIDENCE_ERROR_HINTS,
  type AssetEvidenceError,
  type AssetEvidenceErrorCode,
} from './asset-errors.js';
import { err, ok, type Result } from './result.js';

export type {
  AssetEvidenceError,
  AssetEvidenceErrorCode,
  AssetEvidenceErrorDetail,
} from './asset-errors.js';

/** Producer-owned cook attempt; a receipt is evidence only for its own input fingerprint. */
export interface CookReceipt {
  readonly guid: string;
  readonly origin: CookOrigin;
  readonly status: CookReceiptStatus;
  readonly inputFingerprint: string;
  readonly outputDigest?: string;
  readonly error?: {
    readonly code: string;
    readonly expected: string;
    readonly hint: string;
    readonly detail?: unknown;
  };
}

export type { CookProduct } from './asset.js';

/** Source-side declaration used to compare current input with a producer receipt. */
export interface SourceDeclarationEvidence {
  readonly origin: CookOrigin;
  readonly sourcePath?: string;
  readonly inputFingerprint?: string;
}

/** Verification state for the Pack v2 package envelope, independent of cook freshness. */
export interface PackageVerificationEvidence {
  readonly status: ArtifactVerificationStatus;
  readonly digest?: string;
}

/** Descriptor plus the explicit verification result for one package artifact. */
export interface AssetEvidenceArtifact {
  readonly descriptor: ArtifactDescriptor;
  readonly verification: ArtifactVerificationStatus;
}

export type AssetEvidenceStatus = 'passed' | 'notChecked' | 'failed' | 'unknown';

/** Derived GUID evidence; use the closed states literally and follow error hints. */
export interface AssetEvidence {
  readonly guid: string;
  readonly packageUrl?: string;
  readonly cookReceiptUrl?: string;
  readonly source?: SourceDeclarationEvidence;
  readonly cook: {
    readonly status: CookStatus;
    readonly freshness: CookFreshness;
    readonly receipt?: CookReceipt;
  };
  readonly package?: PackageVerificationEvidence;
  readonly artifacts: Readonly<Record<string, AssetEvidenceArtifact>>;
  readonly runtime: {
    readonly status: RuntimeEvidenceStatus;
  };
}

/** Catalog navigation only; the URLs locate evidence but do not prove readiness. */
export interface AssetEvidenceLocator {
  readonly packageUrl: string;
  readonly cookReceiptUrl?: string;
}

export interface AssetEvidencePackageInput {
  readonly guid: string;
  readonly digest?: string;
  readonly artifacts: Readonly<
    Record<
      string,
      {
        readonly descriptor: ArtifactDescriptor;
        readonly verification?: ArtifactVerificationStatus;
      }
    >
  >;
}

/** Inputs accepted by the pure projector; producers supply facts, not inferred status. */
export interface AssetEvidenceInputs {
  readonly guid: string;
  readonly source?: SourceDeclarationEvidence;
  readonly sources?: readonly SourceDeclarationEvidence[];
  readonly locator?: AssetEvidenceLocator;
  readonly locators?: readonly AssetEvidenceLocator[];
  readonly receipt?: CookReceipt;
  readonly receipts?: readonly CookReceipt[];
  readonly packageVerification?: PackageVerificationEvidence;
  readonly package?: AssetEvidencePackageInput;
  readonly artifacts?: Readonly<Record<string, ArtifactDescriptor>>;
  readonly artifactVerification?: Readonly<Record<string, ArtifactVerificationStatus>>;
  readonly runtime?: { readonly status: RuntimeEvidenceStatus };
}

/** Project the one public producer product into the shared evidence view. */
export function projectCookProductEvidence(
  product: import('./asset.js').CookProduct,
  locator?: AssetEvidenceLocator,
): Result<AssetEvidence, AssetEvidenceError> {
  if (product.receipt.guid !== product.guid) {
    return conflict(
      'asset-evidence-receipt-conflict',
      product.guid,
      product.receipt.guid,
      product.guid,
    );
  }
  if (product.receipt.outputDigest !== product.digest) {
    return conflict(
      'asset-evidence-digest-mismatch',
      product.guid,
      product.digest,
      product.receipt.outputDigest ?? 'missing receipt digest',
    );
  }
  return projectAssetEvidence({
    guid: product.guid,
    source: {
      origin: product.receipt.origin,
      inputFingerprint: product.receipt.inputFingerprint,
    },
    ...(locator === undefined ? {} : { locator }),
    receipt: product.receipt,
    package: {
      guid: product.guid,
      digest: product.digest,
      artifacts: Object.fromEntries(
        Object.entries(product.artifacts).map(([key, descriptor]) => [
          key,
          { descriptor, verification: 'passed' as const },
        ]),
      ),
    },
  });
}

export { ASSET_EVIDENCE_ERROR_HINTS } from './asset-errors.js';

function conflict(
  code: AssetEvidenceErrorCode,
  guid: string,
  observed: string,
  expected: string,
): Result<never, AssetEvidenceError> {
  return err({
    code,
    expected,
    hint: ASSET_EVIDENCE_ERROR_HINTS[code],
    detail: { guid, observed, expected },
  });
}

function distinct<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const identity = key(value);
    if (!seen.has(identity)) {
      seen.add(identity);
      result.push(value);
    }
  }
  return result;
}

function chooseSource(
  inputs: AssetEvidenceInputs,
): Result<SourceDeclarationEvidence | undefined, AssetEvidenceError> {
  const values = distinct(
    [inputs.source, ...(inputs.sources ?? [])].filter(
      (value): value is SourceDeclarationEvidence => value !== undefined,
    ),
    (value) => JSON.stringify(value),
  );
  if (values.length > 1) {
    return conflict(
      'asset-evidence-source-conflict',
      inputs.guid,
      JSON.stringify(values),
      'one source declaration per GUID',
    );
  }
  return ok(values[0]);
}

function chooseLocator(
  inputs: AssetEvidenceInputs,
): Result<AssetEvidenceLocator | undefined, AssetEvidenceError> {
  const values = distinct(
    [inputs.locator, ...(inputs.locators ?? [])].filter(
      (value): value is AssetEvidenceLocator => value !== undefined,
    ),
    (value) => JSON.stringify(value),
  );
  if (values.length > 1) {
    return conflict(
      'asset-evidence-locator-conflict',
      inputs.guid,
      JSON.stringify(values),
      'one package locator per GUID',
    );
  }
  return ok(values[0]);
}

function chooseReceipt(
  inputs: AssetEvidenceInputs,
): Result<CookReceipt | undefined, AssetEvidenceError> {
  const values = distinct(
    [inputs.receipt, ...(inputs.receipts ?? [])].filter(
      (value): value is CookReceipt => value !== undefined,
    ),
    (value) => JSON.stringify(value),
  );
  if (values.length > 1) {
    return conflict(
      'asset-evidence-receipt-conflict',
      inputs.guid,
      JSON.stringify(values),
      'one cook receipt per GUID',
    );
  }
  const receipt = values[0];
  if (receipt !== undefined && receipt.guid.toLowerCase() !== inputs.guid.toLowerCase()) {
    return conflict(
      'asset-evidence-receipt-conflict',
      inputs.guid,
      receipt.guid,
      `receipt GUID ${inputs.guid}`,
    );
  }
  return ok(receipt);
}

function packageEvidence(inputs: AssetEvidenceInputs): PackageVerificationEvidence | undefined {
  if (inputs.packageVerification !== undefined) return inputs.packageVerification;
  if (inputs.package === undefined) return undefined;
  const statuses = Object.values(inputs.package.artifacts).map(
    (artifact) => artifact.verification ?? 'notChecked',
  );
  const status = statuses.some((value) => value === 'failed')
    ? 'failed'
    : statuses.length > 0 && statuses.every((value) => value === 'passed')
      ? 'passed'
      : 'notChecked';
  return {
    status,
    ...(inputs.package.digest !== undefined ? { digest: inputs.package.digest } : {}),
  };
}

function artifactsEvidence(
  inputs: AssetEvidenceInputs,
): Readonly<Record<string, AssetEvidenceArtifact>> {
  const descriptors =
    inputs.artifacts ??
    Object.fromEntries(
      Object.entries(inputs.package?.artifacts ?? {}).map(([key, value]) => [
        key,
        value.descriptor,
      ]),
    );
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      {
        descriptor,
        verification:
          inputs.artifactVerification?.[key] ??
          inputs.package?.artifacts[key]?.verification ??
          'notChecked',
      },
    ]),
  );
}

function freshness(
  source: SourceDeclarationEvidence | undefined,
  receipt: CookReceipt | undefined,
): CookFreshness {
  if (source?.origin === 'authoredPack') return 'notApplicable';
  if (receipt === undefined) return 'unknown';
  if (source?.inputFingerprint === undefined) return 'unknown';
  return source.inputFingerprint === receipt.inputFingerprint ? 'current' : 'stale';
}

function cookStatus(
  source: SourceDeclarationEvidence | undefined,
  receipt: CookReceipt | undefined,
): CookStatus {
  if (source?.origin === 'authoredPack') return 'notRequired';
  if (receipt?.status === 'failed') return 'failed';
  if (receipt?.status === 'succeeded') return 'ready';
  if (source?.origin === 'sourceMeta') return 'notCooked';
  return 'unknown';
}

/** Join source, locator, receipt, package, artifact, and runtime facts into one view. */
export function projectAssetEvidence(
  inputs: AssetEvidenceInputs,
): Result<AssetEvidence, AssetEvidenceError> {
  const sourceResult = chooseSource(inputs);
  if (!sourceResult.ok) return sourceResult;
  const locatorResult = chooseLocator(inputs);
  if (!locatorResult.ok) return locatorResult;
  const receiptResult = chooseReceipt(inputs);
  if (!receiptResult.ok) return receiptResult;

  const source = sourceResult.value;
  const locator = locatorResult.value;
  const receipt = receiptResult.value;
  const packageVerification = packageEvidence(inputs);
  if (
    receipt?.outputDigest !== undefined &&
    packageVerification?.digest !== undefined &&
    receipt.outputDigest !== packageVerification.digest
  ) {
    return conflict(
      'asset-evidence-digest-mismatch',
      inputs.guid,
      packageVerification.digest,
      receipt.outputDigest,
    );
  }

  return ok({
    guid: inputs.guid,
    ...(locator?.packageUrl !== undefined ? { packageUrl: locator.packageUrl } : {}),
    ...(locator?.cookReceiptUrl !== undefined ? { cookReceiptUrl: locator.cookReceiptUrl } : {}),
    ...(source !== undefined ? { source } : {}),
    cook: {
      status: cookStatus(source, receipt),
      freshness: freshness(source, receipt),
      ...(receipt !== undefined ? { receipt } : {}),
    },
    ...(packageVerification !== undefined ? { package: packageVerification } : {}),
    artifacts: artifactsEvidence(inputs),
    runtime: { status: inputs.runtime?.status ?? 'unknown' },
  });
}

export type {
  ArtifactVerificationStatus,
  CookFreshness,
  CookStatus,
  RuntimeEvidenceStatus,
} from './asset.js';
export type { ArtifactDescriptor, ContentEncoding, Integrity };
