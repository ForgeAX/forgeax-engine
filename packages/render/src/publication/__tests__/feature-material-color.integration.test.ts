import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createMaterialArtifactDigest, createMaterialProgramSetDigest } from '@forgeax/engine-pack';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { type MaterialAsset, type MaterialProgramAbi, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { materialRecordFixture } from '../../../../assets-runtime/src/__tests__/fixtures/material-publication';
import { renderMaterialContext } from '../../extract/material-context';
import type { RenderFeature } from '../../features/types';
import { materialProgramSelectionsForMaterial } from '../../render-system-extract';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';

async function fixture(includePlain: boolean) {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const context = renderMaterialContext(device.caps).materialContext;
  if (context === undefined) throw new Error('Missing structural material context');
  const record = materialRecordFixture({
    passes: [{ name: 'particle-ribbon', program: { module: 'game::particle' } }],
    contexts: [context],
  });
  const original = record.programs[0];
  if (original === undefined) throw new Error('Missing fixture program');
  const abi = {
    directEntry: 'vs_main',
    materialRow: { byteLength: 16, fields: [] },
    resourceSlots: [],
    uvSets: [],
    vertexInputs: [],
    alphaMask: { cutoff: 'alphaCutoff', source: 'baseColor.a' },
    reflection: { layoutIdentity: 'layout', resourceSlots: [], vertexInputs: [] },
    receiptIdentity: 'layout',
    generation: record.publicationGeneration,
  } satisfies MaterialProgramAbi;
  const plain = {
    ...original,
    selections: original.selections.map((selection) => ({
      ...selection,
      address: 'direct' as const,
      entry: 'vs_main',
      abi,
    })),
  };
  const bytes = new TextEncoder().encode('published intrinsic color fixture');
  const colored = {
    ...plain,
    specializationKey: `program/${createMaterialArtifactDigest(bytes)}`,
    artifact: {
      mediaType: 'text/wgsl' as const,
      path: 'color.wgsl',
      digest: createMaterialArtifactDigest(bytes),
      bytes,
    },
    selections: plain.selections.map((selection) => ({
      ...selection,
      abi: {
        ...abi,
        vertexInputs: [{ semantic: 'color', location: 2, format: 'float32x4' }],
        reflection: {
          ...abi.reflection,
          vertexInputs: [{ semantic: 'color', location: 2, format: 'float32x4' }],
        },
      },
    })),
  };
  const programs = includePlain ? [plain, colored] : [colored];
  const artifactDigest = createMaterialProgramSetDigest(programs, record.resolved.passes);
  const [firstPass, ...remainingPasses] = record.resolved.passes;
  if (firstPass === undefined) throw Error('Missing fixture material pass');
  const material: MaterialAsset = { kind: 'material', passes: [firstPass, ...remainingPasses] };
  assets.catalog(record.guid, material).unwrap();
  assets.recordMaterialReadiness(record.guid, {
    status: 'Ready',
    record: {
      ...record,
      programs,
      artifactDigest,
      receipt: { ...record.receipt, identity: { ...record.receipt.identity, artifactDigest } },
    },
  });
  expect(
    assets
      .getMaterialProjectionForPayload(material)
      ?.passes[0]?.programs.find(
        (program) => program.specializationKey === colored.specializationKey,
      )?.abi?.vertexInputs,
  ).toEqual([{ semantic: 'color', location: 2, format: 'float32x4' }]);
  const feature: RenderFeature<null> = {
    identity: 'feature-owned-layout',
    extract: () => ok(null),
    assetDependencies: () => [record.guid],
    plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
  };
  const identity = { source: 'feature-material-color', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, device.caps, [feature]);
  return { world, assets, material, publisher, identity, programs, context };
}

it.each([
  false,
  true,
])('transports the feature material ABI closure without guessing a Mesh binding (plain=%s)', async (includePlain) => {
  const f = await fixture(includePlain);
  const receiver = new RenderPublicationReceiver(f.identity);
  const receiving = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  try {
    const candidate = f.publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    const keys = f.programs.map((program) => program.specializationKey).sort();
    expect(packet.programs.map((program) => program.key).sort()).toEqual(keys);
    expect(receiver.accept(packet, receiving).ok).toBe(true);
    for (const key of keys)
      expect(receiving.shaderRegistry.findMaterialArtifact(key).ok).toBe(true);
    candidate.accept();
    const unchanged = f.publisher.prepare(0).unwrap();
    expect(unchanged.packet.programs).toEqual([]);
    unchanged.discard();
  } finally {
    receiver.dispose();
    f.publisher.dispose();
  }
});

it('keeps color-unavailable material selection fail closed after feature publication', async () => {
  const f = await fixture(false);
  try {
    const candidate = f.publisher.prepare(0).unwrap();
    candidate.accept();
    expect(() =>
      materialProgramSelectionsForMaterial(f.material, f.assets, f.context, 'direct', false),
    ).toThrow(expect.objectContaining({ code: 'material-specialization-not-cooked' }));
  } finally {
    f.publisher.dispose();
  }
});
