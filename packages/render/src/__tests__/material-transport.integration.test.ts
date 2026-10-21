import {
  type CookedMaterialRecord,
  createMaterialProgramSetDigest,
  serializeCookedMaterialRecord,
} from '@forgeax/engine-pack';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { materialProductionFixture } from '../../../assets-runtime/src/__tests__/fixtures/material-production.js';
import {
  MATERIAL_CONTEXT,
  materialRecordFixture,
} from '../../../assets-runtime/src/__tests__/fixtures/material-publication.js';
import { AssetRegistry, createCatalogSource } from '../../../assets-runtime/src/index.js';
import { runtimeAssets } from '../../../assets-runtime/src/internal/runtime-assets.js';
import { materialContribution } from '../assets/asset-decoders.js';

async function load(fixture: Awaited<ReturnType<typeof materialProductionFixture>>) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === fixture.entry.packageUrl) return new Response(JSON.stringify(fixture.pack));
    const file = fixture.files.get(path.slice(1));
    return file ? new Response(file.source as BodyInit) : new Response('missing', { status: 404 });
  });
  const registry = new AssetRegistry({
    catalog: createCatalogSource({ entries: fixture.entries }),
    fetcher,
  });
  const lease = registry.installDecoder(materialContribution.kind, materialContribution.decoder);
  try {
    const loaded = await registry.load(fixture.record.guid, 'material');
    if (!loaded.ok) return { result: loaded, fetcher };
    const result = registry.read(loaded.value);
    const projection = registry.getMaterialProjectionForPayload(
      runtimeAssets(registry).borrow<MaterialAsset>(loaded.value).unwrap(),
    );
    const sources = fixture.record.programs.map((program) => {
      const artifact = registry.shaderRegistry.findMaterialArtifact(program.specializationKey);
      return artifact.ok ? artifact.value.source : artifact.error;
    });
    return { result, projection, sources, fetcher };
  } finally {
    lease.dispose();
    registry.dispose();
  }
}

function expectPublished(
  loaded: Awaited<ReturnType<typeof load>>,
  record: CookedMaterialRecord,
): void {
  expect(loaded.result).toMatchObject({ ok: true });
  if (!loaded.result.ok) throw loaded.result.error;
  // Cook records stay with the publication and shader owners, not mutable content.
  expect(loaded.result.value).not.toHaveProperty('cooked');
  expect(loaded.projection).toMatchObject({
    materialGuid: record.guid,
    specializationKey: record.specializationKey,
    artifactHash: record.artifactDigest,
  });
  expect(loaded.sources).toEqual(
    record.programs.map((program) => new TextDecoder().decode(program.artifact.bytes)),
  );
}

it('loads production compact transport through the actual Render decoder with the complete original cooked record', async () => {
  const fixture = await materialProductionFixture();
  expect(fixture.pack.assets[0].payload.cooked.programs[0].artifact).not.toHaveProperty('bytes');
  const loaded = await load(fixture);
  expectPublished(loaded, fixture.record);
  expect(loaded.fetcher.mock.calls.filter(([url]) => String(url).endsWith('.bin'))).toHaveLength(1);
});

it('retains the existing typed inline transport contract', async () => {
  const fixture = await materialProductionFixture(false);
  expect(fixture.pack.assets[0].payload.cooked).toEqual(
    JSON.parse(serializeCookedMaterialRecord(fixture.record)),
  );
  const loaded = await load(fixture);
  expectPublished(loaded, fixture.record);
  expect(loaded.fetcher.mock.calls.filter(([url]) => String(url).endsWith('.bin'))).toHaveLength(0);
});

it.each([
  'missing-descriptor',
  'corrupt-external',
  'program-digest-mismatch',
  'invalid-descriptor-path',
] as const)('rejects compact %s at the owning typed material path', async (failure) => {
  const fixture = await materialProductionFixture();
  const asset = fixture.pack.assets[0];
  const artifact = asset.payload.cooked.programs[0].artifact;
  if (failure === 'missing-descriptor') delete asset.artifacts[artifact.path];
  if (failure === 'corrupt-external') {
    const descriptor = asset.artifacts[artifact.path];
    fixture.files.set(`assets/${descriptor.path}`, {
      type: 'asset',
      source: new Uint8Array(fixture.firstProgram.artifact.bytes.length),
    });
  }
  if (failure === 'invalid-descriptor-path')
    asset.artifacts[artifact.path].path = '../outside.wgsl';
  if (failure === 'program-digest-mismatch') artifact.digest = `sha256:${'0'.repeat(64)}`;
  const { result } = await load(fixture);
  expect(result).toMatchObject({
    ok: false,
    error: {
      code:
        failure === 'corrupt-external'
          ? 'asset-integrity-failed'
          : failure === 'program-digest-mismatch'
            ? 'asset-decode-failed'
            : 'asset-package-invalid',
      ...(failure === 'program-digest-mismatch'
        ? { detail: { cause: { code: 'material-cook-record-invalid' } } }
        : {}),
    },
  });
});

it('restores every compact program sharing one verified external read', async () => {
  const original = materialRecordFixture({
    contexts: [MATERIAL_CONTEXT, { ...MATERIAL_CONTEXT, geometry: 'skinned' }],
  });
  const programs = original.programs.map((program, index) => ({
    ...program,
    specializationKey: `${program.specializationKey}/${index}`,
  }));
  const artifactDigest = createMaterialProgramSetDigest(programs, original.resolved.passes);
  const record = {
    ...original,
    programs,
    artifactDigest,
    receipt: { ...original.receipt, identity: { ...original.receipt.identity, artifactDigest } },
  };
  const fixture = await materialProductionFixture(true, record);
  const loaded = await load(fixture);
  expectPublished(loaded, record);
  expect(loaded.fetcher.mock.calls.filter(([url]) => String(url).endsWith('.bin'))).toHaveLength(1);
});
