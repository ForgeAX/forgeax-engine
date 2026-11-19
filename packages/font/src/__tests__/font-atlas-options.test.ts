import type { ImportContext } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { BakeAtlas } from '../atlas-font-data.js';
import { generateFontAtlas, resolveFontAtlasOptions } from '../atlas-generator.js';
import { fontImporter } from '../font-importer.js';

const atlas: BakeAtlas = {
  texture: { width: 1, height: 1, data: new Uint8Array(4) },
  glyphs: [],
  metrics: { lineHeight: 48, ascender: 40 },
  textureSize: [1, 1],
  fieldRange: 32,
};

it('retains printable ASCII and range four when metadata omits settings', () => {
  const options = resolveFontAtlasOptions();
  expect([...options.charset]).toHaveLength(95);
  expect(options.charset.codePointAt(0)).toBe(32);
  expect(options.charset.codePointAt(94)).toBe(126);
  expect(options.fieldRange).toBe(4);
});

it('passes deduplicated Unicode and the authored range through the importer owner', async () => {
  const generateAtlas = vi.fn(async () => atlas),
    dispose = vi.fn(async () => {});
  const context: ImportContext = {
    source: 'label.otf',
    readSource: async () => ({ ok: true, value: new Uint8Array([79, 84, 84, 79]) }),
    readSibling: async () => ({ ok: true, value: new Uint8Array() }),
    decodeImage: async () => {
      throw Error('not an image import');
    },
    subAssets: [],
    importSettings: {
      charset: '\u65e0\u71c3\u6cb9\uff01\u65e0\u{1f6a2}\u{1f6a2}',
      fieldRange: 32,
      generatorFactory: async () => ({ generateAtlas, dispose }),
    },
  };
  expect((await fontImporter.import(context)).ok).toBe(true);
  expect(generateAtlas).toHaveBeenCalledWith(new Uint8Array([79, 84, 84, 79]), {
    charset: '\u65e0\u71c3\u6cb9\uff01\u{1f6a2}',
    fieldRange: 32,
  });
  expect(dispose).toHaveBeenCalledOnce();
});

it('rejects invalid authored values before acquiring a generator', async () => {
  const factory = vi.fn();
  for (const options of [
    { charset: '' },
    { charset: '\ud800' },
    { charset: '\udfff' },
    { fieldRange: 0 },
    { fieldRange: -1 },
    { fieldRange: NaN },
    { fieldRange: Infinity },
  ]) {
    await expect(generateFontAtlas(new Uint8Array(), factory, options)).rejects.toMatchObject({
      code: 'bake-failed',
    });
  }
  for (const settings of [
    { charset: null },
    { fieldRange: null },
    { charset: 2 },
    { fieldRange: '32' },
  ])
    expect(() => resolveFontAtlasOptions(settings)).toThrow('Unicode');
  expect(factory).not.toHaveBeenCalled();
});
