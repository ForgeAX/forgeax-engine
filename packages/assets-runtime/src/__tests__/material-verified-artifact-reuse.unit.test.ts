import { webcrypto } from 'node:crypto';
import { MaterialArtifactRegistry, ShaderRegistry } from '@forgeax/engine-shader';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shareVerifiedArtifactBytes } from '../internal/shared-immutable.js';
import { createMaterialLoader, type MaterialPublication } from '../material/loader.js';
import { installMaterialReadyShaders } from '../material/runtime-shader.js';
import { materialPublicationFixture, materialRecordFixture } from './fixtures/material-publication';

afterEach(() => {
  vi.unstubAllGlobals();
});

const passes = [{ name: 'Forward', program: { module: `game::verified${'v'.repeat(300)}` } }];

function fixture(index: number) {
  const record = materialRecordFixture({
    guid: `019f0000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    passes,
  });
  return { record, publication: materialPublicationFixture(record) };
}

function load(publication: MaterialPublication) {
  const record = publication.record as ReturnType<typeof materialRecordFixture>;
  return createMaterialLoader({ loadPublication: async () => publication }).load({
    guid: record.guid,
    specializationKey: record.specializationKey,
  });
}

function stubDigest() {
  const digest = vi.fn((algorithm: string, data: BufferSource) =>
    webcrypto.subtle.digest(algorithm, data),
  );
  vi.stubGlobal('crypto', { subtle: { digest } });
  return digest;
}

describe.each([
  'native',
  'fallback',
] as const)('realm-verified material program reuse (%s hashing)', (mode) => {
  it('admits bytes equal to the realm-verified view without rehashing or copying', async () => {
    const digest = mode === 'native' ? stubDigest() : undefined;
    if (mode === 'fallback') vi.stubGlobal('crypto', {});
    const { record, publication } = fixture(1);
    const program = record.programs[0];
    if (program === undefined) throw new Error('missing program');
    const verified = shareVerifiedArtifactBytes(program.artifact.digest, program.artifact.bytes);
    const ready = await load(publication);
    if (ready.status !== 'Ready') throw new Error(ready.error.code);
    expect(digest?.mock.calls.length ?? 0).toBe(0);
    const bytes = ready.record.programs[0]?.artifact.bytes;
    expect(bytes).toEqual(verified);
    // The native path snapshots views before awaiting and adopts the realm view.
    if (mode === 'native') expect(bytes).toBe(verified);
    else expect(bytes).not.toBe(verified);
    const published = publication.artifacts?.[program.artifact.path]?.bytes;
    expect(bytes).not.toBe(published);
  });

  it('rejects tampered bytes that claim a realm-verified digest', async () => {
    const digest = mode === 'native' ? stubDigest() : undefined;
    if (mode === 'fallback') vi.stubGlobal('crypto', {});
    const { record, publication } = fixture(2);
    const program = record.programs[0];
    if (program === undefined) throw new Error('missing program');
    shareVerifiedArtifactBytes(program.artifact.digest, program.artifact.bytes);
    const published = publication.artifacts?.[program.artifact.path]?.bytes;
    if (published === undefined) throw new Error('missing artifact');
    published[published.length - 1] = (published[published.length - 1] ?? 0) ^ 1;
    expect(await load(publication)).toMatchObject({
      status: 'Error',
      error: {
        code: 'asset-artifact-integrity-mismatch',
        detail: { field: program.artifact.path, expected: program.artifact.digest },
      },
    });
    expect(digest?.mock.calls.length ?? 1).toBe(1);
  });

  it('keeps a mismatching published digest an integrity failure', async () => {
    if (mode === 'native') stubDigest();
    else vi.stubGlobal('crypto', {});
    const { record, publication } = fixture(3);
    const program = record.programs[0];
    if (program === undefined) throw new Error('missing program');
    shareVerifiedArtifactBytes(program.artifact.digest, program.artifact.bytes);
    const artifacts = publication.artifacts as Record<
      string,
      { bytes: Uint8Array; digest?: string }
    >;
    const published = artifacts[program.artifact.path];
    if (published === undefined) throw new Error('missing artifact');
    artifacts[program.artifact.path] = { ...published, digest: 'sha256:other' };
    expect(await load(publication)).toMatchObject({
      status: 'Error',
      error: {
        code: 'asset-artifact-integrity-mismatch',
        detail: { expected: program.artifact.digest, actual: program.artifact.digest },
      },
    });
  });
});

describe('realm-verified material shader install', () => {
  it('installs programs admitted from the shared view and still rejects a conflict', async () => {
    stubDigest();
    const shaders = new ShaderRegistry({ manifestUrl: undefined });
    const artifacts = new MaterialArtifactRegistry();
    const first = fixture(4);
    const program = first.record.programs[0];
    if (program === undefined) throw new Error('missing program');
    const verified = shareVerifiedArtifactBytes(program.artifact.digest, program.artifact.bytes);
    for (const index of [4, 5]) {
      const ready = await load(fixture(index).publication);
      if (ready.status !== 'Ready') throw new Error(ready.error.code);
      installMaterialReadyShaders(shaders, ready, artifacts);
    }
    // The registry retains a private copy; callers may mutate their retained bytes.
    expect(artifacts.get(program.specializationKey)?.bytes).toEqual(verified);
    expect(artifacts.get(program.specializationKey)?.bytes).not.toBe(verified);
    const ready = await load(fixture(6).publication);
    if (ready.status !== 'Ready') throw new Error(ready.error.code);
    const conflicting = {
      ...ready,
      record: {
        ...ready.record,
        parameterContract: {
          parameters: [{ name: 'factor', type: 'f32' }],
          values: {},
        },
      },
    } as unknown as typeof ready;
    expect(() => installMaterialReadyShaders(shaders, conflicting, artifacts)).toThrow(
      expect.objectContaining({
        code: 'material-artifact-conflict',
        detail: expect.objectContaining({ dimension: 'param-schema' }),
      }),
    );
  });
});
