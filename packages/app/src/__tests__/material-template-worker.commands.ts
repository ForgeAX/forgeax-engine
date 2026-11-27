import { fileURLToPath } from 'node:url';
import { createRuntimePackPublication } from '@forgeax/engine-pack/build';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { produceScriptablePackProducts } from '../../../import/src/scriptable-pack-host.js';
import { createMaterialPackCooker } from '../../../shader-compiler/src/index.js';

export async function produceWorkerMaterialTemplate() {
  const sourcePath = fileURLToPath(
    new URL('./material-template-worker.bootstrap.ts', import.meta.url),
  );
  const packageId = definePackageId('01900000-0000-7000-8000-000000000082');
  const product = (
    await produceScriptablePackProducts({
      sources: [
        {
          definition: definePack({
            schemaVersion: '2.0.0',
            packageId,
            build: () =>
              ok({
                'material/red': {
                  ...createBuiltinMaterialAsset('unlit'),
                  values: { baseColor: [1, 0, 0, 1] },
                },
              }),
          }),
          sourcePath,
          displaySourcePath: sourcePath,
          sourceClosure: [],
          policy: {
            base: '/',
            packagePath: 'worker-material-template.runtime-pack.json',
            artifactPath: (guid, key) => `worker-material-template/${guid}/${key}`,
          },
        },
      ],
      cookers: [createMaterialPackCooker()],
    })
  )
    .unwrap()
    .get(sourcePath);
  if (product === undefined) throw new Error('Missing Worker material Pack');
  const { finalized, publication } = product;
  const material = finalized.pack.assets[0];
  if (material === undefined || finalized.artifacts.length !== 1)
    throw new Error('Expected one source artifact in the Worker material Pack');
  const runtime = createRuntimePackPublication({
    pack: { assets: finalized.pack.assets },
    scopeId: 'asset-runtime',
    sourcePath,
    sourceRevision: publication.sourceRevision,
    packageUrl: finalized.packageUrl,
    inputFingerprint: publication.receipt.inputFingerprint,
    digest: finalized.digest,
    outputs: publication.outputs,
    externalEvidence: publication.externalEvidence,
  });
  return {
    row: {
      guid: material.guid,
      kind: 'material',
      packageUrl: finalized.packageUrl,
      sourcePath,
      publication: runtime.publication,
    },
    pack: JSON.stringify(runtime.pack),
    artifacts: Object.fromEntries(
      finalized.artifacts.map(({ path, bytes }) => [`/${path}`, new TextDecoder().decode(bytes)]),
    ),
  };
}

export const materialTemplateWorkerCommands = {
  produceWorkerMaterialTemplate,
};

declare module 'vitest/browser' {
  interface BrowserCommands {
    produceWorkerMaterialTemplate(): Promise<
      Awaited<ReturnType<typeof produceWorkerMaterialTemplate>>
    >;
  }
}
