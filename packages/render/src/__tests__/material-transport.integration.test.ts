import {
  createMaterialProgramSetDigest,
  serializeCookedMaterialRecord,
  validateCookedMaterialRecord,
} from '@forgeax/engine-pack';
import { expect, it, vi } from 'vitest';
import { materialProductionFixture } from '../../../assets-runtime/src/__tests__/fixtures/material-production.js';
import {
  MATERIAL_CONTEXT,
  materialRecordFixture,
} from '../../../assets-runtime/src/__tests__/fixtures/material-publication.js';
import { createAssetRegistry, createCatalogSource } from '../../../assets-runtime/src/index.js';
import { materialContribution } from '../assets/asset-decoders.js';

function cookedRecord(value: unknown): unknown {
  if (value === null || typeof value !== 'object')
    throw new Error('decoded material must be a payload');
  return Reflect.get(value, 'cooked');
}

async function load(fixture: Awaited<ReturnType<typeof materialProductionFixture>>) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === fixture.entry.packageUrl) return new Response(JSON.stringify(fixture.pack));
    const file = fixture.files.get(path.slice(1));
    return file ? new Response(file.source as BodyInit) : new Response('missing', { status: 404 });
  });
  const registry = createAssetRegistry({
    catalog: createCatalogSource({ entries: fixture.entries }),
    fetcher,
  });
  const lease = registry.installDecoder(materialContribution.kind, materialContribution.decoder);
  try {
    return { result: await registry.load(fixture.record.guid, 'material'), fetcher };
  } finally {
    lease.dispose();
    registry.dispose();
  }
}

it('loads production compact transport through the actual Render decoder with the complete original cooked record', async () => {
  const fixture = await materialProductionFixture();
  expect(fixture.pack.assets[0].payload.cooked.programs[0].artifact).not.toHaveProperty('bytes');
  const { result, fetcher } = await load(fixture);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw result.error;
  const parsed = validateCookedMaterialRecord(cookedRecord(result.value));
  expect(parsed).toEqual({ ok: true, value: fixture.record });
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('.bin'))).toHaveLength(1);
});

it('retains the existing typed inline transport contract', async () => {
  const fixture = await materialProductionFixture();
  fixture.pack.assets[0].payload.cooked = JSON.parse(serializeCookedMaterialRecord(fixture.record));
  const { result, fetcher } = await load(fixture);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw result.error;
  expect(validateCookedMaterialRecord(cookedRecord(result.value))).toEqual({
    ok: true,
    value: fixture.record,
  });
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('.bin'))).toHaveLength(0);
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
      code: failure === 'corrupt-external' ? 'asset-integrity-failed' : 'asset-package-invalid',
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
  const { result, fetcher } = await load(fixture);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw result.error;
  expect(validateCookedMaterialRecord(cookedRecord(result.value))).toEqual({
    ok: true,
    value: record,
  });
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('.bin'))).toHaveLength(1);
});
