import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineFeature } from '../../lab/feature';
import { code, emptyProject, forgeax } from './_shared/cli';

const ENGINE_ROOT = '0c5bf4c1-bbd0-58e6-8ac9-1347fd716b81';

export default defineFeature({
  title: 'Plugin asset authoring',
  catalog: 'Plugin asset authoring',
  kind: 'headless',
  summary:
    'asset plugin create/inspect author and query PluginAssets, and project root set binds a realm root in forge.json to one plugin GUID after resolving its definition.',
  expect:
    'plugin create --dry-run returns a GUID and generated source without writing; plugin inspect lists the engine root program sceneOwner with lifecycle definition; root set --realm host writes forge.json; an unknown GUID fails as plugin-root-update-failed and leaves forge.json untouched.',
  async run(checks) {
    const fixture = emptyProject();
    try {
      const created = await forgeax([
        'asset',
        'plugin',
        'create',
        '--root',
        fixture.root,
        '--path',
        'assets/lab.pack.ts',
        '--dry-run',
      ]);
      checks.ok(
        'create dry-run',
        created.ok === true && JSON.stringify(created.value).includes('guid'),
        code(created),
      );

      const inspect = await forgeax(['asset', 'plugin', 'inspect', '--root', fixture.root]);
      const text = JSON.stringify(inspect.value);
      checks.ok('engine root listed', text.includes(ENGINE_ROOT), code(inspect));
      checks.ok(
        'program identity',
        text.includes('#sceneOwner') && text.includes('"definition"'),
        text.slice(0, 200),
      );

      const forge = join(fixture.root, 'forge.json');
      const set = await forgeax([
        'project',
        'root',
        'set',
        '--root',
        fixture.root,
        '--realm',
        'host',
        '--guid',
        ENGINE_ROOT,
      ]);
      const roots = (JSON.parse(readFileSync(forge, 'utf8')) as { roots?: Record<string, string> })
        .roots;
      checks.ok(
        'host root written',
        set.ok === true && roots?.host === ENGINE_ROOT,
        `${code(set)} ${JSON.stringify(roots)}`,
      );

      const before = readFileSync(forge, 'utf8');
      const unknown = await forgeax([
        'project',
        'root',
        'set',
        '--root',
        fixture.root,
        '--realm',
        'build',
        '--guid',
        '00000000-0000-4000-8000-000000000000',
      ]);
      checks.equal('unknown plugin guid', code(unknown), 'plugin-root-update-failed');
      checks.ok('forge.json unchanged after refusal', readFileSync(forge, 'utf8') === before);
    } finally {
      fixture.dispose();
    }
  },
});
