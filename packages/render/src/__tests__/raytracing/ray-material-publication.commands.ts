import {
  createMaterialLoader,
  materialParametersToParamSchema,
  projectMaterialRecord,
  selectMaterialPassProgram,
} from '@forgeax/engine-assets-runtime';
import { serializeCookedMaterialRecord, validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { type RaySurfaceProgram, rayMaterialContract } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { normaliseForPack } from '../../../../import/src/import-runner';
import type { createMaterialPackCooker } from '../../../../shader-compiler/src/index';
import { Materials } from '../../materials';

export function emissionRayMaterial() {
  return Materials.standard({
    baseColor: [0, 0, 0, 1],
    emissive: [1, 0.5, 0.25],
    emissiveIntensity: 2,
    specular: 0,
  });
}

/** Complete real cook, wire publication and loader admission for one material. */
export async function prepareRayMaterialPublication(
  id: string,
  asset: MaterialAsset,
  cooker: ReturnType<typeof createMaterialPackCooker>,
) {
  const draft = await cooker.cook({ guid: id, source: asset });
  // Exercise the publication transport and complete loader gate before the
  // existing GPU reference consumes the selected bytes. No fixture cook of
  // a second ray material stands in for the ordinary publication.
  const record = validateCookedMaterialRecord(
    JSON.parse(JSON.stringify(normaliseForPack((draft.payload as { cooked: unknown }).cooked))),
  ).unwrap();
  const ready = await createMaterialLoader({
    loadPublication: async () => ({ guid: id, record, artifacts: draft.artifacts }),
  }).load({ guid: id, specializationKey: record.specializationKey ?? '' });
  if (ready.status !== 'Ready')
    throw new Error(`ray fixture publication failed: ${JSON.stringify(ready)}`);
  const selected = selectMaterialPassProgram(projectMaterialRecord(ready.record), 'forward', {
    backend: 'webgpu',
    capability: 'storage-buffer',
    pipeline: 'ray',
    geometry: 'mesh',
    pass: 'ray-hit',
    profile: 'forgeax-material-ray-v1',
    toolchain: 'naga-oil',
    instrumentation: 'none',
  });
  const artifact = ready.record.programs.find(
    (program) => program.specializationKey === selected.specializationKey,
  )?.artifact;
  if (artifact === undefined) throw new Error('selected ray artifact is absent');
  const [firstPass, ...remainingPasses] = ready.record.resolved.passes;
  if (firstPass === undefined || asset.parent !== undefined)
    throw new Error('ray fixture requires a complete root material');
  const resolved: MaterialAsset = {
    ...asset,
    ...ready.record.resolved,
    passes: [firstPass, ...remainingPasses],
  };
  const program: RaySurfaceProgram = {
    context: 'ray-hit',
    wgsl: new TextDecoder().decode(artifact.bytes),
    paramSchema: materialParametersToParamSchema(ready.record.parameterContract.parameters, id),
    contract: rayMaterialContract(resolved),
    sourceClosureDigest: ready.record.receipt.identity.sourceClosureDigest,
  };
  return {
    name: id,
    asset: resolved,
    program,
    // Compiler artifacts are UTF-8 WGSL. JSON carries strings rather than
    // expanding every byte into a JS number in the Browser command channel.
    cookedPublication: {
      record: serializeCookedMaterialRecord(ready.record),
      artifacts: Object.fromEntries(
        ready.record.programs.map(({ artifact }) => [
          artifact.path,
          new TextDecoder().decode(artifact.bytes),
        ]),
      ),
    },
    publication: {
      program: selected.specializationKey,
      artifactDigest: artifact.digest,
      cookIdentity: ready.record.receipt.identity.cookIdentity,
    },
  };
}
