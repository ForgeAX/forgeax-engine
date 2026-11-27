import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type {
  AssetPublicationEnvelope,
  AssetPublicationExternalEvidence,
  AssetPublicationOutput,
} from './asset-producer.js';

export interface AssetPublicationInput {
  readonly sourcePath: string;
  readonly sourceRevision: string;
  /** Optional caller generation; the protocol owner derives one when omitted. */
  readonly generation?: number;
  readonly digest: string;
  readonly packageUrl: string;
  readonly inputFingerprint: string;
  readonly outputs: readonly AssetPublicationOutput[];
  readonly externalEvidence: readonly AssetPublicationExternalEvidence[];
}

/** Compare the receipt fields common to every publication reader. */
export function assetPublicationReceiptMatches(publication: AssetPublicationEnvelope): boolean {
  const receipt = publication.receipt;
  return (
    receipt?.schemaVersion === 'asset-publication-receipt/1' &&
    receipt.sourcePath === publication.sourcePath &&
    receipt.sourceRevision === publication.sourceRevision &&
    receipt.outputDigest === publication.digest &&
    receipt.outputSetDigest === publication.outputSetDigest
  );
}

export function assetPublicationOutputSetDigest(
  outputs: readonly AssetPublicationOutput[],
): string {
  // The property order is the existing canonical digest order.
  const rows = outputs.map((output) =>
    JSON.stringify({
      digest: output.digest ?? null,
      guid: output.guid.toLowerCase(),
      kind: output.kind ?? null,
      refs: [...output.refs].map((guid) => guid.toLowerCase()),
      sourceKey: output.sourceKey ?? null,
    }),
  );
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(`[${rows.join(',')}]`)))}`;
}

/** Derive a stable positive generation from the accepted publication tuple. */
export function assetPublicationGeneration(input: {
  readonly sourceRevision: string;
  readonly digest: string;
  readonly outputSetDigest: string;
}): number {
  const hash = bytesToHex(
    sha256(
      new TextEncoder().encode(
        `${input.sourceRevision}\n${input.digest}\n${input.outputSetDigest}`,
      ),
    ),
  );
  const generation = Number.parseInt(hash.slice(0, 8), 16);
  return generation > 0 ? generation : 1;
}

/** Build the complete producer-owned tuple after the package route is finalized. */
export function createAssetPublication(input: AssetPublicationInput): AssetPublicationEnvelope {
  const outputSetDigest = assetPublicationOutputSetDigest(input.outputs);
  const publicationGeneration =
    input.generation ??
    assetPublicationGeneration({
      sourceRevision: input.sourceRevision,
      digest: input.digest,
      outputSetDigest,
    });
  return {
    schemaVersion: 'asset-publication/1',
    sourcePath: input.sourcePath,
    sourceRevision: input.sourceRevision,
    generation: publicationGeneration,
    digest: input.digest,
    outputSetDigest,
    outputs: input.outputs,
    receipt: {
      schemaVersion: 'asset-publication-receipt/1',
      sourcePath: input.sourcePath,
      sourceRevision: input.sourceRevision,
      inputFingerprint: input.inputFingerprint,
      outputDigest: input.digest,
      outputSetDigest,
      externalEvidence: input.externalEvidence,
    },
    externalEvidence: input.externalEvidence,
    current: {
      generation: publicationGeneration,
      digest: input.digest,
      outputSetDigest,
      packageUrl: input.packageUrl,
      receiptKey: input.inputFingerprint,
    },
  };
}
