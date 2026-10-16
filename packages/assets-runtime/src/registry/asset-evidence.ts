import {
  type AssetEvidence,
  type AssetEvidenceError,
  type AssetEvidenceInputs,
  err,
  projectAssetEvidence,
  type Result,
} from '@forgeax/engine-types';

/** Host-injected runtime bridge; the adapter never imports CLI, Vite, or Node policy. */
export interface RuntimeEvidenceSource {
  readonly evidence: (
    guid: string,
  ) => Promise<AssetEvidenceInputs | Result<AssetEvidenceInputs, AssetEvidenceError>>;
}

/** Runtime SDK view over the shared AssetEvidence projector. */
export interface RuntimeAssetEvidenceAdapter {
  readonly inspect: (guid: string) => Promise<Result<AssetEvidence, AssetEvidenceError>>;
  readonly verifyByGuid: (guid: string) => Promise<Result<AssetEvidence, AssetEvidenceError>>;
}

function missingCapability(guid: string): Result<never, AssetEvidenceError> {
  return err({
    code: 'asset-evidence-capability-missing',
    expected: 'an injected runtime evidence source',
    hint: 'configure an evidence source before calling inspect(guid) or verifyByGuid(guid)',
    detail: { capability: 'runtime evidence source', stage: `guid:${guid}` },
  });
}

async function project(
  source: RuntimeEvidenceSource,
  guid: string,
): Promise<Result<AssetEvidence, AssetEvidenceError>> {
  const input = await source.evidence(guid);
  if ('ok' in input) {
    if (!input.ok) return input;
    return projectAssetEvidence(input.value);
  }
  return projectAssetEvidence(input);
}

/** Create an adapter; omitted source intentionally returns capability-missing errors. */
export function createRuntimeAssetEvidenceAdapter(
  source?: RuntimeEvidenceSource,
): RuntimeAssetEvidenceAdapter {
  const read = async (guid: string): Promise<Result<AssetEvidence, AssetEvidenceError>> =>
    source === undefined ? missingCapability(guid) : project(source, guid);
  return { inspect: read, verifyByGuid: read };
}
