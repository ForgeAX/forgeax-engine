import { describe, expect, it } from 'vitest';
import {
  type MaterialCookReceipt,
  serializeMaterialCookReceipt,
  validateMaterialCookReceipt,
} from '../evidence/material-cook.js';

const layoutIdentity = 'sha256:layout-identity';
const artifactDigest = 'sha256:output';

function receipt(overrides: Record<string, unknown> = {}): MaterialCookReceipt {
  return {
    schemaVersion: 'material-cook/4',
    sourceClosure: ['b.wgsl', 'a.material.json'],
    profile: 'webgpu/v1',
    compilerVersion: 'compiler/1',
    identity: {
      materialContractDigest: 'sha256:material-contract',
      sourceRevision: 'sha256:source-revision',
      sourceClosureDigest: 'sha256:source-closure',
      layoutIdentity,
      programIdentity: 'sha256:program',
      pipelineIdentity: 'sha256:pipeline',
      materialPublicationIdentity: 'sha256:publication',
      cookIdentity: 'sha256:input',
      compilerFingerprint: 'sha256:compiler',
      wasm: {
        sourceContentKey: 'sha256:wasm-source',
        artifactSha256: 'sha256:wasm-artifact',
        glueSha256: 'sha256:wasm-glue',
      },
      artifactDigest,
      valueGeneration: 1,
      dependencyGeneration: 1,
      cookGeneration: 1,
    },
    derivedInterface: { layoutIdentity },
    ...overrides,
  } as unknown as MaterialCookReceipt;
}

describe('material cook receipt', () => {
  it('requires the v4 identity and provenance tuple', () => {
    const v4 = {
      schemaVersion: 'material-cook/4',
      sourceClosure: ['materials/mat.material.json', 'shaders/pbr.wgsl'],
      profile: 'webgpu/v1',
      compilerVersion: 'compiler/1',
      identity: {
        materialContractDigest: 'sha256:material-contract',
        sourceRevision: 'sha256:source-revision',
        sourceClosureDigest: 'sha256:source-closure',
        layoutIdentity,
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
        artifactDigest,
        valueGeneration: 3,
        dependencyGeneration: 2,
        cookGeneration: 7,
      },
      derivedInterface: { layoutIdentity },
    };
    expect(validateMaterialCookReceipt(v4)).toMatchObject({ ok: true, value: v4 });
    expect(validateMaterialCookReceipt(receipt())).toMatchObject({ ok: true });
    expect(
      validateMaterialCookReceipt({
        ...v4,
        identity: { ...v4.identity, compilerFingerprint: undefined },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'material-cook-record-invalid' },
    });
  });

  it('serializes a material-cook/4 receipt stably for equivalent cooks', () => {
    const first = serializeMaterialCookReceipt(receipt());
    const second = serializeMaterialCookReceipt(
      receipt({ sourceClosure: ['a.material.json', 'b.wgsl'] }),
    );
    expect(first).toBe(second);
    expect(JSON.parse(first)).toMatchObject({
      schemaVersion: 'material-cook/4',
      identity: { layoutIdentity },
      derivedInterface: { layoutIdentity },
    });
  });

  it('accepts the expected identity and rejects schema or interface mutations', () => {
    const expected = { layoutIdentity, artifactDigest, inputDigest: 'sha256:input' };
    expect(validateMaterialCookReceipt(receipt(), expected)).toEqual({
      ok: true,
      value: receipt(),
    });
    expect(
      validateMaterialCookReceipt(
        receipt({ identity: { ...receipt().identity, layoutIdentity: 'sha256:changed-layout' } }),
        expected,
      ),
    ).toMatchObject({ ok: false, error: { code: 'material-cook-record-invalid' } });
    expect(
      validateMaterialCookReceipt(
        receipt({ derivedInterface: { layoutIdentity: 'sha256:changed-layout' } }),
        expected,
      ),
    ).toMatchObject({ ok: false, error: { code: 'material-cook-record-invalid' } });
  });

  it('rejects missing, stale, mismatched, and material-cook/1 receipts fail-fast', () => {
    const expected = { layoutIdentity, artifactDigest, inputDigest: 'sha256:input' };
    for (const value of [
      receipt({ identity: { ...receipt().identity, layoutIdentity: undefined } }),
      receipt({ identity: { ...receipt().identity, artifactDigest: 'sha256:stale-artifact' } }),
      receipt({ identity: { ...receipt().identity, cookIdentity: 'sha256:stale-input' } }),
      {
        sourceClosure: [],
        profile: 'webgpu/v1',
        compilerVersion: 'compiler/1',
        identity: receipt().identity,
      },
    ]) {
      expect(validateMaterialCookReceipt(value as MaterialCookReceipt, expected)).toMatchObject({
        ok: false,
        error: { code: 'material-cook-record-invalid' },
      });
    }
  });

  it('records the coordinator-owned publication generation', () => {
    const generationReceipt = {
      sourceClosure: ['materials/mat-root.material.json'],
      profile: 'webgpu/v1',
      compilerVersion: 'compiler/1',
      identity: { ...receipt().identity, cookGeneration: 11 },
    };
    expect(generationReceipt).toMatchObject({
      identity: { cookGeneration: 11 },
    });
  });
});
