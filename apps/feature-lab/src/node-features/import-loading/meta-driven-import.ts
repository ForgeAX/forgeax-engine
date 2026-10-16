import { imageImporter } from '@forgeax/engine/image/image-importer';
import { ImporterRegistry, runImport } from '@forgeax/engine/import';
import type { Importer } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { codeOf, PNG_1X1 } from './support/fixture';

const GUID = '019f1a00-0000-7000-8000-0000000001b1';
const OTHER = '019f1a00-0000-7000-8000-0000000001b2';
const UNDECLARED = '019f1a00-0000-7000-8000-0000000001b3';

const MESH = {
  kind: 'mesh',
  vertices: new Float32Array(),
  indices: new Uint16Array(),
  attributes: {},
} as never;

function producing(guids: readonly string[]): ImporterRegistry {
  const registry = new ImporterRegistry();
  const importer: Importer = {
    key: 'lab',
    import: async () => ({
      ok: true,
      value: {
        assets: guids.map((guid) => ({
          guid,
          kind: 'mesh',
          payload: MESH,
          refs: [],
          artifacts: {},
        })),
        sourceDependencies: [],
      },
    }),
  };
  registry.register(importer);
  return registry;
}

const meta = (
  importer: string,
  guids: readonly string[],
  kind = importer === 'image' ? 'texture' : 'mesh',
) => ({
  importer,
  source: 'hero.png',
  subAssets: guids.map((guid, sourceIndex) => ({ guid, sourceIndex, kind })),
});

const readable = { readSource: async () => ({ ok: true as const, value: PNG_1X1 }) };
const unreadable = {
  readSource: async () => ({ ok: false as const, error: new Error('ENOENT hero.png') }),
};

export default defineFeature({
  title: 'Meta-driven import',
  catalog: 'Meta-driven import',
  kind: 'headless',
  summary:
    'runImport reads a source through the injected fs, runs the importer named by the Meta, validates the produced GUID set against Meta subAssets, and emits a DDC Pack (or product-only output for a downstream finalizer).',
  expect:
    'A real PNG import emits an internal-text-package with the declared GUID; multiple outputs need a producer sourceKey each (source-validation-failed otherwise); the declared GUID set must match exactly (guid-mismatch / import-produced-no-assets); an unreadable source is source-read-failed; buildPack:false leaves publication to the finalizer; the reserved shader key is skipped.',
  async run(checks) {
    const images = new ImporterRegistry();
    images.register(imageImporter);
    const real = await runImport(meta('image', [GUID]), images, readable);
    checks.ok('PNG + Meta imports', real.ok, real.ok ? undefined : codeOf(real.error));
    if (real.ok && !('skipped' in real.value) && 'pack' in real.value) {
      checks.equal('DDC Pack kind', real.value.pack.kind, 'internal-text-package');
      checks.equal(
        'Pack rows carry the Meta GUID',
        real.value.pack.assets.map((row) => row.guid),
        [GUID],
      );
    }

    const keyless = await runImport(meta('lab', [GUID, OTHER]), producing([GUID, OTHER]), readable);
    checks.equal(
      'multi-output without sourceKey code',
      keyless.ok ? 'ok' : codeOf(keyless.error),
      'source-validation-failed',
    );
    const keyed = meta('lab', [GUID, OTHER]);
    const twoRows = await runImport(
      {
        ...keyed,
        subAssets: keyed.subAssets.map((row) => ({
          ...row,
          sourceKey: `lab:mesh:${row.sourceIndex}`,
        })),
      },
      producing([GUID, OTHER]),
      readable,
    );
    checks.ok(
      'multi-output with sourceKeys imports',
      twoRows.ok,
      twoRows.ok ? undefined : codeOf(twoRows.error),
    );

    const productOnly = await runImport(
      { ...meta('lab', [GUID]), buildPack: false },
      producing([GUID]),
      readable,
    );
    checks.ok(
      'buildPack:false returns a product without a Pack',
      productOnly.ok &&
        !('skipped' in productOnly.value) &&
        !('pack' in productOnly.value) &&
        productOnly.value.product.assets.length === 1,
    );

    const undeclared = await runImport(meta('lab', [GUID]), producing([UNDECLARED]), readable);
    checks.equal(
      'undeclared GUID code',
      undeclared.ok ? 'ok' : codeOf(undeclared.error),
      'guid-mismatch',
    );
    const empty = await runImport(meta('lab', [GUID]), producing([]), readable);
    checks.equal(
      'no produced assets code',
      empty.ok ? 'ok' : codeOf(empty.error),
      'import-produced-no-assets',
    );
    const unread = await runImport(meta('image', [GUID]), images, unreadable);
    checks.equal(
      'unreadable source code',
      unread.ok ? 'ok' : codeOf(unread.error),
      'source-read-failed',
    );
    const shader = await runImport(meta('shader', [GUID]), images, readable);
    checks.ok(
      'reserved shader Meta is skipped',
      shader.ok && 'skipped' in shader.value && shader.value.skipped === 'shader',
    );
  },
});
