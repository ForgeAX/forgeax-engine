import { describe, expect, it } from 'vitest';
import { validateMeta } from '../schema-compiled.js';
import { SCRIPTABLE_PACK_ASSET_KINDS } from '../scriptable-pack.js';

describe('meta.schema.json source optional (w8 / AC-4)', () => {
  const minimalMeta = {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    importSettings: {},
    subAssets: [{ guid: '00000000-0000-4000-8000-000000000001', sourceIndex: 0, kind: 'texture' }],
  };

  it('meta without source key passes ajv validation (AC-4)', () => {
    const valid = validateMeta(minimalMeta);
    expect(valid).toBe(true);
  });

  it('meta with explicit source passes ajv validation (AC-1 back-compat)', () => {
    const metaWithSource = { ...minimalMeta, source: 'foo.png' };
    const valid = validateMeta(metaWithSource);
    expect(valid).toBe(true);
  });

  it('meta missing required field importer fails validation', () => {
    const { importer: _, ...withoutImporter } = minimalMeta;
    const valid = validateMeta(withoutImporter);
    expect(valid).toBe(false);
  });

  it('ajv reinstantiation idempotent — same validator returns same result', () => {
    const valid1 = validateMeta(minimalMeta);
    const valid2 = validateMeta(minimalMeta);
    expect(valid1).toBe(valid2);
  });
});

describe('meta.schema.json subAssets[].kind open-string (w6 / D-1 scheme A)', () => {
  const metaWithSubKind = (kind: string) => ({
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    importSettings: {},
    subAssets: [{ guid: '00000000-0000-4000-8000-000000000001', sourceIndex: 0, kind }],
  });

  // (a) Host custom kind passes validation — RED against current closed enum,
  //     GREEN after schema enum is dropped to open string with minLength: 1.
  //     When this test is red it proves the enum wall exists; when it turns
  //     green it proves D-1 scheme A is effective.
  it('(a) host custom kind passes validation (red→green)', () => {
    const valid = validateMeta(metaWithSubKind('reel-game-blob'));
    expect(valid).toBe(true);
  });

  // (b) Zero-regression: all 12 known kind values from the prior closed enum
  //     still pass validation.  'image' is included here because the schema
  //     layer does NOT decommission it — the fold layer (M4) handles that.
  const knownKinds = [
    'mesh',
    'material',
    'scene',
    'texture',
    'image',
    'cube-texture',
    'material-shader',
    'skeleton',
    'skin',
    'animation-clip',
    'audio',
    'font',
  ];

  for (const kind of knownKinds) {
    it(`(b) known kind '${kind}' passes validation (zero-regression)`, () => {
      const valid = validateMeta(metaWithSubKind(kind));
      expect(valid).toBe(true);
    });
  }

  for (const kind of SCRIPTABLE_PACK_ASSET_KINDS) {
    it(`published durable kind '${kind}' remains valid in open Meta schema`, () => {
      expect(validateMeta(metaWithSubKind(kind))).toBe(true);
    });
  }

  // (c) Empty string rejected by minLength: 1 (schema layer gate).
  it('(c) empty-string kind fails validation (minLength: 1)', () => {
    const valid = validateMeta(metaWithSubKind(''));
    expect(valid).toBe(false);
  });

  // (d) subAssets[].kind field still exists in the schema and is typed as
  //     string (AC-06 + OOS-2: field not deleted, only enum removed).
  it('(d) subAssets[].kind field is string-typed and required', () => {
    // Verify kind field is required — missing it fails.
    const withoutKind = {
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      importSettings: {},
      subAssets: [{ guid: '00000000-0000-4000-8000-000000000001', sourceIndex: 0 }],
    };
    expect(validateMeta(withoutKind)).toBe(false);

    // Verify kind with non-string value (number) fails type check.
    const numberKind = {
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      importSettings: {},
      subAssets: [{ guid: '00000000-0000-4000-8000-000000000001', sourceIndex: 0, kind: 42 }],
    };
    expect(validateMeta(numberKind)).toBe(false);
  });
});
