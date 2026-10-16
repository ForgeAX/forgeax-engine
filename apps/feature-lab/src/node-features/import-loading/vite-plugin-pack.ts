import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine/pack/source';
import { defineFeature } from '../../lab/feature';
import { HERO_GUID, SAMPLER_PACKAGE, withPackDevServer } from './support/dev-server';

async function countFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

export default defineFeature({
  title: 'Vite Pack plugin',
  catalog: 'Vite Pack plugin',
  kind: 'headless',
  summary:
    'pluginPack scans Pack roots, cooks meta-driven external sources through injected importers into the project DDC, and projects one catalog of GUID rows with publication facts. ready() fences the first accepted catalog generation.',
  expect:
    'After ready(), catalogSnapshot() holds the cooked, current image row with a publication and the Pack sampler row whose GUID derives from packageId + sourceKey; the project DDC directory is populated; an unbound plugin reports no runtime binding.',
  async run(checks) {
    await withPackDevServer(undefined, async (server) => {
      const rows = server.plugin.catalogSnapshot();
      checks.equal('catalog rows (sampler + image)', rows.length, 2);
      const hero = rows.find((row) => row.guid === HERO_GUID);
      checks.equal('image row kind', hero?.kind, 'texture');
      checks.equal('image row subject', hero?.subject, 'imported-output');
      checks.equal('image row execution', hero?.execution, 'cooked');
      checks.equal('image row lifecycle', hero?.lifecycle, 'current');
      checks.ok('image row carries a publication envelope', hero?.publication !== undefined);

      const sampler = rows.find((row) => row.kind === 'sampler');
      const namespace = PackageId.parse(SAMPLER_PACKAGE);
      const derived = namespace.ok
        ? AssetGuid.format(AssetGuid.derive(namespace.value, 'sampler/main'))
        : 'unparsed';
      checks.equal('sampler row GUID derives from packageId + sourceKey', sampler?.guid, derived);
      checks.equal('sampler row sourceKey', sampler?.sourceKey, 'sampler/main');

      const cooked = await countFiles(join(server.root, '.forgeax', 'ddc'));
      checks.ok('project DDC populated by the image cook', cooked > 0, `${cooked} files`);
      checks.equal('no runtime binding injected', server.plugin.runtimeBinding(), undefined);
    });
  },
});
