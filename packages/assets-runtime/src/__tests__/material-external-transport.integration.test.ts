import { createMaterialProgramSetDigest } from '@forgeax/engine-pack';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
import { loadMaterialReadyByGuid } from '../registry/load-by-guid.js';
import { materialProductionFixture as publication } from './fixtures/material-production.js';
import { MATERIAL_CONTEXT, materialRecordFixture } from './fixtures/material-publication.js';

async function withPublication<T>(
  fixture: Awaited<ReturnType<typeof publication>>,
  run: (
    registry: AssetRegistry,
    shaders: ShaderRegistry,
    fetcher: ReturnType<typeof vi.fn<typeof globalThis.fetch>>,
  ) => Promise<T>,
) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/pack-index.json') return new Response(JSON.stringify(fixture.entries));
    if (path === fixture.entry.packageUrl) return new Response(JSON.stringify(fixture.pack));
    const file = fixture.files.get(path.slice(1));
    return file ? new Response(file.source as BodyInit) : new Response('missing', { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  const shaders = new ShaderRegistry({
    manifestUrl: undefined,
    device: {
      createShaderModule() {
        throw new Error('no GPU compilation');
      },
    } as never,
  });
  try {
    const registry = new AssetRegistry(shaders);
    registry.configurePackIndex('/pack-index.json');
    return await run(registry, shaders, fetcher);
  } finally {
    vi.unstubAllGlobals();
  }
}

async function load(fixture: Awaited<ReturnType<typeof publication>>) {
  return withPublication(fixture, async (registry, shaders) => {
    const guid = AssetGuid.parse(fixture.record.guid);
    if (!guid.ok) throw guid.error;
    const loaded = await registry.loadByGuid(guid.value);
    return { loaded, readiness: registry.getMaterialReadiness(fixture.record.guid), shaders };
  });
}

it('publishes external-only material programs and restores the original verified bytes through GUID loading', async () => {
  const fixture = await publication();
  const cooked = fixture.pack.assets[0].payload.cooked;
  expect(cooked.programs[0].artifact).not.toHaveProperty('bytes');
  expect(fixture.original.programs[0].artifact.bytes).toEqual([
    ...fixture.firstProgram.artifact.bytes,
  ]);
  const result = await load(fixture);
  expect(result.loaded).toMatchObject({ ok: true });
  expect(result.readiness).toMatchObject({
    status: 'Ready',
    artifactDigest: fixture.record.artifactDigest,
  });
  for (const program of fixture.record.programs)
    expect(result.shaders.findMaterialArtifact(program.specializationKey)).toMatchObject({
      ok: true,
      value: { source: new TextDecoder().decode(program.artifact.bytes) },
    });
});

it('hydrates a compact record only from the external validated shader artifact', async () => {
  const fixture = await publication();
  for (const program of fixture.pack.assets[0].payload.cooked.programs)
    delete program.artifact.bytes;
  expect((await load(fixture)).readiness).toMatchObject({ status: 'Ready' });
});

it.each([
  'loadByGuid',
  'loadMaterialReadyByGuid',
] as const)('hashes the complete hydrated program manifest once through %s', async (entry) => {
  const fixture = await publication();
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  try {
    if (entry === 'loadByGuid') {
      expect((await load(fixture)).readiness).toMatchObject({ status: 'Ready' });
    } else {
      await withPublication(fixture, async (registry) => {
        expect(
          await loadMaterialReadyByGuid(registry, {
            guid: fixture.record.guid,
            specializationKey: fixture.record.specializationKey,
          }),
        ).toMatchObject({ status: 'Ready' });
      });
    }
    const manifests = encode.mock.calls.filter(([input]) => {
      if (!input?.startsWith('{')) return false;
      const value = JSON.parse(input);
      return Array.isArray(value.passes) && Array.isArray(value.programs);
    });
    expect(manifests).toHaveLength(1);
  } finally {
    encode.mockRestore();
  }
});

it('rejects the record schema before checking its program digest or installing shaders', async () => {
  const fixture = await publication();
  const cooked = fixture.pack.assets[0].payload.cooked;
  cooked.schemaVersion = 'material-cook/invalid';
  cooked.programs[0].artifact.digest = `sha256:${'0'.repeat(64)}`;
  const result = await load(fixture);
  expect(result.loaded).toMatchObject({ ok: true });
  expect(result.readiness).toMatchObject({
    status: 'Error',
    error: { code: 'material-cook-record-invalid', detail: { field: 'schemaVersion' } },
  });
  expect(result.shaders.findMaterialArtifact(fixture.firstProgram.specializationKey).ok).toBe(
    false,
  );
});

it('independently verifies the material digest after the external descriptor accepts its bytes', async () => {
  const fixture = await publication();
  const cooked = fixture.pack.assets[0].payload.cooked;
  const program = cooked.programs[0];
  program.artifact.digest = `sha256:${'0'.repeat(64)}`;
  cooked.artifactDigest = createMaterialProgramSetDigest(cooked.programs, cooked.resolved.passes);
  cooked.receipt.identity.artifactDigest = cooked.artifactDigest;
  const result = await load(fixture);
  expect(result.loaded).toMatchObject({ ok: true });
  expect(result.readiness).toMatchObject({
    status: 'Error',
    error: {
      code: 'asset-artifact-integrity-mismatch',
      detail: {
        field: program.artifact.path,
        expected: program.artifact.digest,
        actual: fixture.firstProgram.artifact.digest,
      },
    },
  });
  expect(result.shaders.findMaterialArtifact(fixture.firstProgram.specializationKey).ok).toBe(
    false,
  );
});

it('accepts the previous inline-plus-external production payload', async () => {
  const fixture = await publication();
  fixture.pack.assets[0].payload.cooked = fixture.original;
  expect((await load(fixture)).readiness).toMatchObject({ status: 'Ready' });
});

it.each([
  'missing-descriptor',
  'corrupt-external',
  'inconsistent-inline',
  'invalid-record',
] as const)('rejects %s without weakening the existing material contracts', async (failure) => {
  const fixture = await publication();
  const asset = fixture.pack.assets[0];
  const program = asset.payload.cooked.programs[0];
  delete program.artifact.bytes;
  if (failure === 'missing-descriptor') delete asset.artifacts[program.artifact.path];
  if (failure === 'corrupt-external') {
    const descriptor = asset.artifacts[program.artifact.path];
    fixture.files.set(`assets/${descriptor.path}`, {
      type: 'asset',
      source: new Uint8Array(fixture.firstProgram.artifact.bytes.length),
    });
  }
  if (failure === 'inconsistent-inline')
    program.artifact.bytes = [...new Uint8Array(fixture.firstProgram.artifact.bytes.length)];
  if (failure === 'invalid-record') asset.payload.cooked.artifactDigest = 'sha256:invalid';
  const result = await load(fixture);
  if (failure === 'corrupt-external') {
    expect(result.loaded).toMatchObject({
      ok: false,
      error: { code: 'asset-artifact-integrity-mismatch' },
    });
  } else {
    expect(result.loaded).toMatchObject({ ok: true });
    expect(result.readiness).toMatchObject({
      status: 'Error',
      error: { code: 'material-cook-record-invalid' },
    });
  }
});

it('retains complete inline bytes when the production source has no external descriptor', async () => {
  const fixture = await publication(false);
  expect(fixture.pack.assets[0].payload.cooked).toEqual(fixture.original);
  expect((await load(fixture)).readiness).toMatchObject({ status: 'Ready' });
});

it('hydrates distinct programs sharing one artifact with a single external read', async () => {
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
  const fixture = await publication(true, record);
  await withPublication(fixture, async (registry, _shaders, fetcher) => {
    const reads = vi.spyOn(registry.artifactCache, 'read');
    const ready = await loadMaterialReadyByGuid(registry, {
      guid: record.guid,
      specializationKey: record.specializationKey ?? 'missing-fixture-specialization',
    });
    expect(ready).toMatchObject({
      status: 'Ready',
      record: {
        programs: [
          { artifact: { bytes: fixture.firstProgram.artifact.bytes } },
          { artifact: { bytes: fixture.firstProgram.artifact.bytes } },
        ],
      },
    });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('.bin'))).toHaveLength(1);
  });
});
