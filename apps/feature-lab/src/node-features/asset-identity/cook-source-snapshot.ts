import { realpath, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createScriptablePackSourceSnapshot } from '@forgeax/engine/pack/source-node';
import { defineFeature } from '../../lab/feature';
import { errorCode, withFixture } from './support/fixture';

const FILES = {
  'asset.pack.ts': "export { shape } from './shape.js';",
  'shape.js': 'export const shape = 1;',
};

export default defineFeature({
  title: 'Cook source snapshot',
  catalog: 'Cook source snapshot',
  kind: 'headless',
  summary:
    'One build generation shares captured source bytes, digests and resolution probes; verify() refuses a stale candidate before publication.',
  expect:
    'Repeated reads reuse captured bytes even after an mtime-preserving edit; verify reports pack-source-revision-conflict; a fresh snapshot sees the edit.',
  async run(checks) {
    await withFixture(FILES, async (dir) => {
      const root = await realpath(dir);
      const source = join(root, 'asset.pack.ts');
      const dependency = join(root, 'shape.js');

      const snapshot = createScriptablePackSourceSnapshot();
      const first = await snapshot.inventory(source);
      checks.ok(
        'inventory covers the relative dependency',
        first.some((entry) => entry.path === dependency),
        JSON.stringify(first.map((entry) => entry.path)),
      );
      checks.ok('unchanged sources verify', (await snapshot.verify()).ok);

      const before = await stat(dependency);
      await writeFile(dependency, 'export const shape = 2;');
      await utimes(dependency, before.atime, before.mtime);
      checks.equal(
        'same generation reuses captured inventory',
        await snapshot.inventory(source),
        first,
      );
      checks.equal(
        'same generation reads captured bytes',
        await snapshot.readText(dependency),
        'export const shape = 1;',
      );
      checks.equal(
        'equal-size, same-mtime edit is still caught',
        errorCode(await snapshot.verify()),
        'pack-source-revision-conflict',
      );
      const fresh = createScriptablePackSourceSnapshot();
      checks.ok(
        'fresh generation observes the edit',
        JSON.stringify(await fresh.inventory(source)) !== JSON.stringify(first),
      );

      await writeFile(join(root, 'shape.ts'), 'export const shape = 3;');
      checks.equal(
        'new preferred resolution candidate is caught',
        errorCode(await fresh.verify()),
        'pack-source-revision-conflict',
      );

      await unlink(join(root, 'shape.ts'));
      const captured = createScriptablePackSourceSnapshot();
      const { sources: modules } = await captured.moduleSources(source);
      await unlink(dependency);
      checks.ok(
        'captured module text survives source deletion',
        modules[dependency] === 'export const shape = 2;',
      );
      for (const key of Object.keys(modules)) modules[key] = 'corrupted consumer copy';
      const again = await captured.moduleSources(source);
      checks.ok(
        'returned records are isolated copies',
        !Object.values(again.sources).includes('corrupted consumer copy'),
      );
      checks.equal(
        'deletion fails verification',
        errorCode(await captured.verify()),
        'pack-source-revision-conflict',
      );
    });
  },
});
