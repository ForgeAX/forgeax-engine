import type {
  ArtifactDescriptor,
  ArtifactVerificationStatus,
  AssetEvidence,
  AssetEvidenceError,
  AssetEvidenceInputs,
  AssetEvidenceLocator,
  CookProduct,
  CookReceipt,
  PackageVerificationEvidence,
  SourceDeclarationEvidence,
} from '@forgeax/engine-types';
import {
  projectAssetEvidence,
  projectCookProductEvidence,
  type Result,
} from '@forgeax/engine-types';

/** Pack artifact descriptor with verification supplied by an offline verifier. */
export interface OfflineArtifactInput extends ArtifactDescriptor {
  readonly verification?: ArtifactVerificationStatus;
}

/** Validated Pack v2 package facts consumed by the offline projector. */
export interface OfflinePackageInput {
  readonly guid: string;
  readonly digest?: string;
  readonly artifacts: Readonly<Record<string, OfflineArtifactInput>>;
}

/** Node/CLI input shape; it intentionally has no runtime or WebSocket fields. */
export interface OfflineAssetEvidenceInput {
  readonly guid: string;
  readonly source?: SourceDeclarationEvidence;
  readonly locator?: AssetEvidenceLocator;
  readonly receipt?: CookReceipt;
  readonly package?: OfflinePackageInput;
  readonly product?: CookProduct;
}

function packageEvidence(input: OfflinePackageInput): NonNullable<AssetEvidenceInputs['package']> {
  return {
    guid: input.guid,
    ...(input.digest === undefined ? {} : { digest: input.digest }),
    artifacts: Object.fromEntries(
      Object.entries(input.artifacts).map(([key, artifact]) => [
        key,
        {
          descriptor: artifact,
          verification: artifact.verification ?? 'passed',
        },
      ]),
    ),
  };
}

/** Build the shared evidence view without loading runtime assets or opening WS. */
export function buildOfflineAssetEvidence(
  input: OfflineAssetEvidenceInput,
): Promise<Result<AssetEvidence, AssetEvidenceError>> {
  if (input.product !== undefined) {
    return Promise.resolve(projectCookProductEvidence(input.product, input.locator));
  }
  const evidenceInput: AssetEvidenceInputs = {
    guid: input.guid,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.locator === undefined ? {} : { locator: input.locator }),
    ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
    ...(input.package === undefined ? {} : { package: packageEvidence(input.package) }),
  };
  return Promise.resolve(projectAssetEvidence(evidenceInput));
}

export function packageVerification(
  input: OfflinePackageInput | undefined,
): PackageVerificationEvidence | undefined {
  if (input === undefined) return undefined;
  const packageInput = packageEvidence(input);
  const statuses = Object.values(packageInput.artifacts).map(
    (artifact) => artifact.verification ?? 'notChecked',
  );
  return {
    status: statuses.some((status) => status === 'failed')
      ? 'failed'
      : statuses.length > 0 && statuses.every((status) => status === 'passed')
        ? 'passed'
        : 'notChecked',
    ...(input?.digest === undefined ? {} : { digest: input.digest }),
  };
}
