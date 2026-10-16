import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineFeature } from '../../lab/feature';
import { code, emptyProject, forgeax } from './_shared/cli';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5e2bb3a0000000049454e44ae426082',
  'hex',
);

interface Imported {
  readonly guid?: string;
  readonly reused?: boolean;
  readonly metaPath?: string;
}

function first(value: Record<string, unknown> | undefined): Imported | undefined {
  return (value?.assets as Imported[] | undefined)?.[0];
}

export default defineFeature({
  title: 'Asset authoring commands',
  catalog: 'Asset authoring commands',
  kind: 'headless',
  summary:
    'asset import --path creates or reuses an external source sidecar (<file>.meta.json) with a stable GUID; --dry-run reports the same shape without writing. There is no asset add command.',
  expect:
    'dry-run returns a GUID and writes no meta; a real import writes the meta; re-import reuses the same GUID; asset add is tool-command-not-found; a missing path fails structurally.',
  async run(checks) {
    const fixture = emptyProject();
    try {
      writeFileSync(join(fixture.root, 'assets', 'dot.png'), PNG);
      const meta = join(fixture.root, 'assets', 'dot.png.meta.json');
      const dry = await forgeax([
        'asset',
        'import',
        '--root',
        fixture.root,
        '--path',
        'assets/dot.png',
        '--dry-run',
      ]);
      checks.ok(
        'dry-run guid without write',
        typeof first(dry.value)?.guid === 'string' && !existsSync(meta),
        code(dry),
      );
      const real = await forgeax([
        'asset',
        'import',
        '--root',
        fixture.root,
        '--path',
        'assets/dot.png',
      ]);
      const guid = first(real.value)?.guid;
      checks.ok('import writes meta', real.ok === true && existsSync(meta), code(real));
      const again = await forgeax([
        'asset',
        'import',
        '--root',
        fixture.root,
        '--path',
        'assets/dot.png',
      ]);
      checks.ok(
        're-import reuses guid',
        first(again.value)?.reused === true && first(again.value)?.guid === guid,
        JSON.stringify(first(again.value)),
      );
      const missing = await forgeax([
        'asset',
        'import',
        '--root',
        fixture.root,
        '--path',
        'assets/none.png',
      ]);
      checks.ok(
        'missing source is structured',
        missing.ok === false && code(missing) !== 'no-code',
        code(missing),
      );
      checks.equal(
        'asset add does not exist',
        code(await forgeax(['asset', 'add'])),
        'tool-command-not-found',
      );
    } finally {
      fixture.dispose();
    }
  },
});
