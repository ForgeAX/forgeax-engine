import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import type { PackIndexEntry } from '@forgeax/engine-types';
import { build as viteBuild } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pluginPack } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const worktreeRoot = join(here, '..', '..', '..', '..');
const fixtureHdr = join(
  worktreeRoot,
  'forgeax-engine-assets',
  'learn-opengl',
  'textures',
  'newport_loft.hdr',
);
const hdrGuid = '019e4a26-3c29-7420-af5d-20f2724a16b0';

let originalCwd: string;
let tmpRoot: string;
let assetsDir: string;
let distDir: string;
let packIndex: PackIndexEntry[] | undefined;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-hdr-'));
  assetsDir = join(tmpRoot, 'assets');
  distDir = join(tmpRoot, 'dist');
  process.chdir(tmpRoot);
  await writeFile(join(tmpRoot, 'main.js'), "console.log('hdr-equirect-import-test entry');\n");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(assetsDir, 'newport_loft.hdr'), await readFile(fixtureHdr));
  await writeFile(
    join(assetsDir, 'newport_loft.hdr.meta.json'),
    JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: 'newport_loft.hdr',
      importSettings: {
        colorSpace: 'linear',
        mipmap: 'auto',
        addressMode: 'clamp-to-edge',
        filterMode: 'linear',
      },
      subAssets: [{ guid: hdrGuid, sourceIndex: 0, kind: 'equirect' }],
    }),
  );
  await viteBuild({
    root: tmpRoot,
    logLevel: 'silent',
    configFile: false,
    build: {
      outDir: distDir,
      emptyOutDir: true,
      write: true,
      rollupOptions: { input: { main: 'main.js' } },
    },
    plugins: [pluginPack({ roots: [assetsDir], importers: [imageImporter] })],
  });
  packIndex = decodeCatalogWire(
    JSON.parse(await readFile(join(distDir, 'pack-index.json'), 'utf8')),
  ).unwrap() as PackIndexEntry[];
});

afterAll(async () => {
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

function importedRow(): PackIndexEntry {
  const row = packIndex?.find((entry) => entry.guid.toLowerCase() === hdrGuid);
  if (!row) throw new Error('HDR imported-output row was not published');
  return row;
}

describe('production imported-output identity', () => {
  it('keeps the authored source name after texture package emission', () => {
    expect(importedRow()).toMatchObject({
      name: 'newport_loft.hdr',
    });
  });

  it('keeps the current cooked projection after texture package emission', () => {
    expect(importedRow()).toMatchObject({
      subject: 'imported-output',
      execution: 'cooked',
      lifecycle: 'current',
      projection: expect.objectContaining({ lifecycle: 'current' }),
    });
  });

  it('keeps source and package locators on the published row', () => {
    const row = importedRow();
    expect(row.sourcePath).toMatch(/assets\/newport_loft\.hdr$/);
    expect(row.packageUrl).toMatch(/\.pack(?:-[^/]+)?\.json$/);
  });
});
