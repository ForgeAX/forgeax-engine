import { imageImporter } from '@forgeax/engine/image/image-importer';
import { ImporterRegistry, runImport } from '@forgeax/engine/import';
import type { Importer } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { codeOf, PNG_1X1 } from './support/fixture';

const GUID = '019f1a00-0000-7000-8000-0000000001a1';

const stub = (key: string): Importer => ({
  key,
  import: async () => ({ ok: true, value: { assets: [], sourceDependencies: [] } }),
});

function throws(body: () => void): boolean {
  try {
    body();
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
}

export default defineFeature({
  title: 'ImporterRegistry',
  catalog: 'ImporterRegistry',
  kind: 'headless',
  summary:
    'The build-time ImporterRegistry maps a Meta importer key to exactly one Importer. runImport selects by meta.importer; the registry lives in Node-only import code and never reaches a player bundle.',
  expect:
    'The real image importer registers under "image" and imports a PNG through runImport; empty key, non-function import and a duplicate key throw TypeError; the disposer releases only its own owner; an unregistered key is importer-not-registered naming the registered keys.',
  async run(checks) {
    const registry = new ImporterRegistry();
    const release = registry.register(imageImporter);
    checks.equal('image importer registers under its Meta key', imageImporter.key, 'image');
    checks.ok('get(key) returns the registered importer', registry.get('image') === imageImporter);
    checks.ok('unknown key is undefined', registry.get('gltf') === undefined);
    checks.ok(
      'empty key throws TypeError',
      throws(() => registry.register(stub(''))),
    );
    checks.ok(
      'non-function import throws TypeError',
      throws(() => registry.register({ key: 'broken', import: 1 } as unknown as Importer)),
    );
    checks.ok(
      'duplicate key throws TypeError',
      throws(() => registry.register(stub('image'))),
    );

    const meta = {
      importer: 'image',
      source: 'hero.png',
      subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'texture' }],
    };
    const fs = { readSource: async () => ({ ok: true as const, value: PNG_1X1 }) };
    const imported = await runImport(meta, registry, fs);
    checks.ok(
      'runImport selects the importer by meta.importer',
      imported.ok,
      imported.ok ? undefined : codeOf(imported.error),
    );
    if (imported.ok && !('skipped' in imported.value)) {
      checks.equal('produced row kind', imported.value.product.assets[0]?.kind, 'texture');
    }

    const missing = await runImport({ ...meta, importer: 'gltf' }, registry, fs);
    checks.equal(
      'unregistered key code',
      missing.ok ? 'ok' : codeOf(missing.error),
      'importer-not-registered',
    );
    if (!missing.ok) {
      const detail = (missing.error as { detail?: { registeredImporters?: readonly string[] } })
        .detail;
      checks.equal('error names the registered keys', detail?.registeredImporters, ['image']);
    }

    const other = stub('image');
    release();
    checks.ok('disposer revokes the key', registry.get('image') === undefined);
    const releaseOther = registry.register(other);
    release();
    checks.ok('stale disposer does not evict the new owner', registry.get('image') === other);
    releaseOther();
  },
});
