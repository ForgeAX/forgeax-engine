import {
  collectMaterialCookRefs,
  type MaterialCookReceipt,
  serializeMaterialCookReceipt,
  validateMaterialCookReceipt,
} from '@forgeax/engine-pack';
import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

describe('material cook parity characterization', () => {
  const identity = {
    materialContractDigest: 'sha256:material-contract',
    sourceRevision: 'sha256:source-revision',
    sourceClosureDigest: 'sha256:source-closure',
    layoutIdentity: 'sha256:layout',
    programIdentity: 'sha256:program',
    pipelineIdentity: 'sha256:pipeline',
    materialPublicationIdentity: 'sha256:publication',
    cookIdentity: 'sha256:cook',
    compilerFingerprint: 'sha256:compiler',
    wasm: {
      sourceContentKey: 'sha256:wasm-source',
      artifactSha256: 'sha256:wasm-artifact',
      glueSha256: 'sha256:wasm-glue',
    },
    artifactDigest: 'sha256:output',
    valueGeneration: 1,
    dependencyGeneration: 1,
    cookGeneration: 1,
  } as const;

  const receipt = {
    schemaVersion: 'material-cook/4' as const,
    sourceClosure: ['materials/child.wgsl', 'materials/root.material.json'],
    profile: 'webgpu/v1',
    compilerVersion: 'compiler/1',
    identity,
    derivedInterface: { layoutIdentity: identity.layoutIdentity },
  } satisfies MaterialCookReceipt;

  it('keeps receipt bytes stable for equivalent source closure order', () => {
    const coldBytes = serializeMaterialCookReceipt(receipt);
    const warmBytes = serializeMaterialCookReceipt({
      ...receipt,
      sourceClosure: [...receipt.sourceClosure].reverse(),
    });

    expect(warmBytes).toBe(coldBytes);
    expect(validateMaterialCookReceipt(JSON.parse(coldBytes))).toMatchObject({ ok: true });
  });

  it('keeps texture and sampler references out of the material compile identity witness', () => {
    const material: MaterialAsset = {
      kind: 'material',
      parameters: [{ name: 'albedo', type: 'texture' }],
      values: {
        albedo: {
          texture: 'texture-a',
          sampler: 'sampler-a',
          coordinates: { set: 0, transform: { offset: [0, 0], scale: [1, 1], rotation: 0 } },
        },
      },
    };
    const refs = collectMaterialCookRefs(material);
    const receipt = {
      schemaVersion: 'material-reflection-characterization/1',
      status: 'intermediate',
      observations: {
        refs,
        compileIdentityInputs: ['source-closure', 'profile', 'compiler-version', 'layout'],
        expectedFailure: 'current cook key still requires M4 mutation proof',
      },
    } as const;

    expect(refs).toEqual({
      parent: [],
      textures: ['texture-a'],
      samplers: ['sampler-a'],
      modules: [],
    });
    expect(receipt.status).toBe('intermediate');
  });

  it('rejects stale artifact and layout mutations before publication', () => {
    expect(
      validateMaterialCookReceipt(
        { ...receipt, identity: { ...identity, artifactDigest: 'sha256:stale' } },
        { artifactDigest: identity.artifactDigest },
      ),
    ).toMatchObject({ ok: false, error: { code: 'material-cook-record-invalid' } });
    expect(
      validateMaterialCookReceipt(
        {
          ...receipt,
          identity: { ...identity, layoutIdentity: 'sha256:changed' },
          derivedInterface: { layoutIdentity: 'sha256:changed' },
        },
        { layoutIdentity: identity.layoutIdentity },
      ),
    ).toMatchObject({ ok: false, error: { code: 'material-cook-record-invalid' } });
  });
});
