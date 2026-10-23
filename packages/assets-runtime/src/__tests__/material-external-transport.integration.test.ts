import { createMaterialProgramSetDigest } from '@forgeax/engine-pack';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { materialContribution } from '../../../render/src/assets/asset-decoders';
import { AssetRegistry } from '../asset-registry.js';
import { runtimeAssets } from '../internal/runtime-assets';
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
    const registry = new AssetRegistry({ shaderRegistry: shaders });
    registry.installDecoder(materialContribution.kind, materialContribution.decoder);
    registry.configurePackIndex('/pack-index.json');
    return await run(registry, shaders, fetcher);
  } finally {
    vi.unstubAllGlobals();
  }
}

async function load(fixture: Awaited<ReturnType<typeof publication>>) {
  return withPublication(fixture, async (registry, shaders) => {
    const loaded = await registry.load(fixture.record.guid, 'material');
    const projection = loaded.ok
      ? registry.getMaterialProjectionForPayload(
          runtimeAssets(registry)
            .borrow<import('@forgeax/engine-types').MaterialAsset>(loaded.value)
            .unwrap(),
        )
      : undefined;
    return { loaded, projection, shaders };
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
  expect(result.projection).toMatchObject({
    artifactHash: fixture.record.artifactDigest,
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
  expect((await load(fixture)).loaded).toMatchObject({ ok: true });
});

it('hashes the complete hydrated program manifest at most once during asset admission', async () => {
  const fixture = await publication();
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  try {
    expect((await load(fixture)).loaded).toMatchObject({ ok: true });
    const manifests = encode.mock.calls.filter(([input]) => {
      if (!input?.startsWith('{')) return false;
      const value = JSON.parse(input);
      return Array.isArray(value.passes) && Array.isArray(value.programs);
    });
    // An identical manifest hashed earlier in this realm reuses its digest instead.
    expect(manifests.length).toBeLessThanOrEqual(1);
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
  expect(result.loaded).toMatchObject({
    ok: false,
    error: {
      code: 'asset-decode-failed',
      detail: {
        cause: { code: 'material-cook-record-invalid', detail: { field: 'schemaVersion' } },
      },
    },
  });
  expect(result.shaders.findMaterialArtifact(fixture.firstProgram.specializationKey).ok).toBe(
    false,
  );
});

it('rejects a material digest that differs from its verified external descriptor', async () => {
  const fixture = await publication();
  const cooked = fixture.pack.assets[0].payload.cooked;
  const program = cooked.programs[0];
  program.artifact.digest = `sha256:${'0'.repeat(64)}`;
  cooked.artifactDigest = createMaterialProgramSetDigest(cooked.programs, cooked.resolved.passes);
  cooked.receipt.identity.artifactDigest = cooked.artifactDigest;
  const result = await load(fixture);
  expect(result.loaded).toMatchObject({
    ok: false,
    error: {
      code: 'asset-decode-failed',
      detail: { cause: { code: 'asset-artifact-integrity-mismatch' } },
    },
  });
  expect(result.shaders.findMaterialArtifact(fixture.firstProgram.specializationKey).ok).toBe(
    false,
  );
});

it('accepts the previous inline-plus-external production payload', async () => {
  const fixture = await publication();
  fixture.pack.assets[0].payload.cooked = fixture.original;
  expect((await load(fixture)).loaded).toMatchObject({ ok: true });
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
      error: { code: 'asset-integrity-failed' },
    });
  } else {
    expect(result.loaded).toMatchObject({
      ok: false,
      error: {
        code:
          failure === 'missing-descriptor' || failure === 'inconsistent-inline'
            ? 'asset-package-invalid'
            : 'asset-decode-failed',
        ...(failure === 'invalid-record'
          ? { detail: { cause: { code: 'material-cook-record-invalid' } } }
          : {}),
      },
    });
  }
});

it('retains complete inline bytes when the production source has no external descriptor', async () => {
  const fixture = await publication(false);
  expect(fixture.pack.assets[0].payload.cooked).toEqual(fixture.original);
  expect((await load(fixture)).loaded).toMatchObject({ ok: true });
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
    const ready = await registry.load(record.guid, 'material');
    expect(ready).toMatchObject({ ok: true });
    for (const program of record.programs)
      expect(registry.getMaterialArtifact(program.specializationKey)?.bytes).toEqual(
        fixture.firstProgram.artifact.bytes,
      );
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('.bin'))).toHaveLength(1);
  });
});
