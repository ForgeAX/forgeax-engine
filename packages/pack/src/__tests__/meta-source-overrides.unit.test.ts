import { describe, expect, it } from 'vitest';
import { validateProducerContract } from '../producer-contract.js';
import { validateMeta } from '../schema-compiled.js';

const baseMeta = () => ({
  schemaVersion: '1.0.0',
  kind: 'external-asset-package',
  importer: 'fixture',
  importSettings: {},
  subAssets: [
    {
      guid: '11111111-1111-4111-8111-111111111111',
      sourceIndex: 0,
      sourceKey: 'mesh/main',
      kind: 'mesh',
    },
  ],
});

describe('Meta sourceOverrides', () => {
  it('accepts a legal optional override without narrowing its payload', () => {
    const meta = {
      ...baseMeta(),
      sourceOverrides: { 'mesh/main': { lod: 2, customProducerField: true } },
    };
    expect(validateMeta(meta)).toBe(true);
    expect(validateProducerContract(meta)).toMatchObject({ ok: true });
  });

  it('rejects unknown or duplicate source keys before publication', () => {
    const unknown = {
      ...baseMeta(),
      sourceOverrides: { 'mesh/other': { lod: 1 } },
    };
    const unknownResult = validateProducerContract(unknown);
    expect(unknownResult).toMatchObject({
      ok: false,
      error: {
        code: 'unknown-source-key',
        authority: 'pack',
      },
    });

    const duplicate = {
      ...baseMeta(),
      subAssets: [
        ...baseMeta().subAssets,
        {
          guid: '22222222-2222-4222-8222-222222222222',
          sourceIndex: 1,
          sourceKey: 'mesh/main',
          kind: 'mesh',
        },
      ],
      sourceOverrides: { 'mesh/main': { lod: 1 } },
    };
    expect(validateProducerContract(duplicate)).toMatchObject({
      ok: false,
      error: { code: 'duplicate-source-key' },
    });
  });

  it('keeps omitted and empty overrides equivalent to legacy Meta', () => {
    const legacy = baseMeta();
    const empty = { ...legacy, sourceOverrides: {} };
    expect(validateMeta(legacy)).toBe(true);
    expect(validateMeta(empty)).toBe(true);
    expect(validateProducerContract(legacy)).toMatchObject({ ok: true });
    expect(validateProducerContract(empty)).toMatchObject({ ok: true });
  });
});
