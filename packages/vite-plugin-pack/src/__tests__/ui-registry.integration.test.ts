import { decodeCatalogWire } from '@forgeax/engine-pack';
// @perf-budget-skip: intentional real Vite UI registry integration gate.

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { build as viteBuild } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pluginPack } from '../index.js';

const UI_GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
let originalCwd: string;
let root: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  root = await mkdtemp(join(tmpdir(), 'forgeax-ui-registry-'));
  process.chdir(root);
  await writeFile(join(root, 'main.js'), 'export default 1;\n');
  await writeFile(join(root, 'hud.ui.html'), '<div class="hud">HUD</div>\n');
  await writeFile(join(root, 'hud.ui.css'), '.hud { color: white; }\n');
  await writeFile(
    join(root, 'hud.ui.html.meta.json'),
    JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'ui',
      source: 'hud.ui.html',
      importSettings: {},
      subAssets: [{ guid: UI_GUID, sourceIndex: 0, kind: 'ui' }],
    }),
  );
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
});

describe('pluginPack UI importer registration', () => {
  it('emits finalized build payload for an explicitly registered owner importer', async () => {
    const dist = join(root, 'dist');
    await viteBuild({
      root,
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir: dist,
        emptyOutDir: true,
        rollupOptions: { input: { main: join(root, 'main.js') } },
      },
      plugins: [pluginPack({ roots: [root], importers: [createUiImporter()] })],
    });

    const files = await readdir(dist, { recursive: true });
    const uiFile = files.find((file) => file.includes(UI_GUID));
    expect(uiFile).toBeDefined();
    const pack = JSON.parse(await readFile(join(dist, uiFile as string), 'utf8')) as {
      schemaVersion: string;
      assets: Array<{
        payload: { html: string; css: string };
        artifacts: Record<string, { path: string }>;
      }>;
    };
    expect(pack.schemaVersion).toBe('2.0.0');
    expect(pack.assets[0]?.payload.html).toContain('HUD');
    expect(pack.assets[0]?.payload.css).toContain('.hud');
    expect(pack.assets[0]?.payload.html).not.toContain('ui-token:');
    expect(pack.assets[0]?.artifacts).toEqual({});

    const catalog = decodeCatalogWire(
      JSON.parse(await readFile(join(dist, 'pack-index.json'), 'utf8')),
    ).unwrap();
    expect(catalog.find((entry) => entry.guid === UI_GUID)?.packageUrl).toContain('.pack');
  });
});
