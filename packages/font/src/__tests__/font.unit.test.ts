// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=3):
//   - packages/font/src/__tests__/bake-real.test.ts
//   - packages/font/src/__tests__/font-importer.test.ts
//   - packages/font/src/__tests__/plugin-discoverable.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImporterRegistry } from '@forgeax/engine-import';
import type { ImportContext, ImportedAsset, ImportSubAsset } from '@forgeax/engine-types';
import { FontError } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type BakeAtlas,
  bakeFont,
  type MsdfGenerator,
  realGeneratorFactory,
  runCliFont,
} from '../cli-font.js';
import { fontImporter, fontOutputSourceKeys, sourceKeyForFontOutput } from '../font-importer.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-font-bake-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const TTF_MAGIC = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const WOFF2_MAGIC = new Uint8Array([0x77, 0x4f, 0x46, 0x32]);

const REAL_TTF_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
];

async function findRealTtf(): Promise<string | undefined> {
  for (const p of REAL_TTF_CANDIDATES) {
    try {
      await stat(p);
      return p;
    } catch {
      // not present -- try next
    }
  }
  return undefined;
}

{
  // ─── from bake-real.test.ts ───

  describe('bake-real.test.ts', () => {
    describe('real bake pipeline (w29)', () => {
      it('(a) best-effort real run produces a valid atlas + sidecar (skips when Worker / TTF unavailable)', async () => {
        const hasWorker = typeof (globalThis as { Worker?: unknown }).Worker !== 'undefined';
        const ttfPath = await findRealTtf();
        if (!hasWorker || ttfPath === undefined) {
          const reason = !hasWorker ? 'zappar-worker-unavailable' : 'no-real-ttf-fixture';
          expect(['zappar-worker-unavailable', 'no-real-ttf-fixture']).toContain(reason);
          return;
        }
        const ttf = await readFile(ttfPath);
        const ttfBytes = new Uint8Array(ttf.buffer, ttf.byteOffset, ttf.byteLength);
        const charset = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) =>
          String.fromCharCode(0x20 + i),
        ).join('');
        const factory = async (): Promise<MsdfGenerator> => {
          const mod = (await import('@zappar/msdf-generator')) as unknown as {
            MSDF: new () => {
              initialize(): Promise<void>;
              generateAtlas(opts: unknown): Promise<BakeAtlas>;
              dispose(): Promise<void>;
            };
          };
          const msdf = new mod.MSDF();
          await msdf.initialize();
          return {
            generateAtlas: (bytes: Uint8Array) =>
              msdf.generateAtlas({
                font: bytes,
                charset,
                textureSize: [1024, 1024],
                fieldRange: 4,
                fontSize: 48,
              }),
            dispose: () => msdf.dispose(),
          };
        };
        const localTtf = join(tmpRoot, 'Real.ttf');
        await writeFile(localTtf, ttfBytes);
        const result = await bakeFont(localTtf, tmpRoot, factory);
        const png = await readFile(result.atlasPath);
        expect(png.length).toBeGreaterThan(0);
        expect(png[0]).toBe(0x89);
        const sidecar = JSON.parse(await readFile(result.sidecarPath, 'utf8')) as {
          common: { distanceRange: number; atlasWidth: number };
          glyphs: Record<string, unknown>;
        };
        expect(sidecar.common.distanceRange).toBeGreaterThan(0);
        expect(sidecar.common.atlasWidth).toBe(1024);
        expect(Object.keys(sidecar.glyphs).length).toBeGreaterThan(0);
      });

      it('(a2) plain Node real run uses the Worker-capable host and writes artefacts', async () => {
        const ttfPath = resolve(
          dirname(fileURLToPath(import.meta.url)),
          '../../../../forgeax-engine-assets/dejavu-fonts/DejaVuSansMono.ttf',
        );
        const result = await bakeFont(ttfPath, tmpRoot, realGeneratorFactory);
        const png = await readFile(result.atlasPath);
        const sidecar = JSON.parse(await readFile(result.sidecarPath, 'utf8')) as {
          common: { distanceRange: number; atlasWidth: number; atlasHeight: number };
          glyphs: Record<string, unknown>;
        };
        expect(png[0]).toBe(0x89);
        expect(sidecar.common).toMatchObject({
          distanceRange: 4,
          atlasWidth: 1024,
          atlasHeight: 1024,
        });
        expect(Object.keys(sidecar.glyphs).length).toBeGreaterThan(90);
      });

      it('(b) non-TTF input throws unsupported-font-format; valid TTF magic does not', async () => {
        const woffPath = join(tmpRoot, 'X.woff2');
        await writeFile(woffPath, WOFF2_MAGIC);
        const neverGen = async (): Promise<MsdfGenerator> => {
          throw new Error('generator must not be reached for a non-TTF input');
        };
        await expect(bakeFont(woffPath, tmpRoot, neverGen)).rejects.toMatchObject({
          code: 'unsupported-font-format',
          expected: 'ttf',
        });
        const err = await bakeFont(woffPath, tmpRoot, neverGen).catch((e) => e);
        expect(err).toBeInstanceOf(FontError);

        const ttfPath = join(tmpRoot, 'Valid.ttf');
        await writeFile(ttfPath, TTF_MAGIC);
        const boomGen = async (): Promise<MsdfGenerator> => ({
          generateAtlas: async () => {
            throw new Error('reached generator');
          },
          dispose: async () => undefined,
        });
        const passErr = await bakeFont(ttfPath, tmpRoot, boomGen).catch((e) => e);
        expect(passErr).toBeInstanceOf(FontError);
        expect((passErr as FontError).code).not.toBe('unsupported-font-format');
      });

      it('(c) mock generator failure yields bake-failed (no silent success)', async () => {
        const ttfPath = join(tmpRoot, 'Valid.ttf');
        await writeFile(ttfPath, TTF_MAGIC);
        const failGen = async (): Promise<MsdfGenerator> => ({
          generateAtlas: async () => {
            throw new Error('wasm boom');
          },
          dispose: async () => undefined,
        });
        const err = await bakeFont(ttfPath, tmpRoot, failGen).catch((e) => e);
        expect(err).toBeInstanceOf(FontError);
        expect((err as FontError).code).toBe('bake-failed');
        expect((err as FontError).detail?.cause).toBe('wasm boom');
      });
    });
  });
}

describe('font producer sourceKey', () => {
  it('assigns unique stable keys to atlas, sampler, and font outputs', () => {
    const keys = fontOutputSourceKeys();
    expect(keys).toEqual(['font:texture', 'font:sampler', 'font:font']);
    expect(new Set(keys).size).toBe(keys.length);
    expect(sourceKeyForFontOutput('texture')).toBe('font:texture');
    expect(sourceKeyForFontOutput('')).toBeUndefined();
  });
});

describe('font package root surface', () => {
  it('keeps the version authority in package metadata, not a root mirror', async () => {
    const mod = await import('../index.js');
    expect('FONT_PACKAGE_VERSION' in mod).toBe(false);
    expect(typeof mod.fontContribution).toBe('object');
    expect('bakeFont' in mod).toBe(false);
    expect('encodePng' in mod).toBe(false);
    expect('atlasToSidecar' in mod).toBe(false);
    expect('runCliFont' in mod).toBe(false);
  });
});

{
  // ─── from font-importer.test.ts ───

  const ATLAS_GUID = '019e3969-1d43-7610-8810-e80dbd491d90';
  const FONT_GUID = '019e3969-1d43-7610-8810-e80dbd491d91';
  const SAMPLER_GUID = '019e3969-1d43-7610-8810-e80dbd491d92';

  function mockAtlas(): BakeAtlas {
    return {
      texture: { width: 16, height: 16, data: new Uint8Array(16 * 16 * 4) },
      glyphs: [
        {
          unicode: 65,
          advance: 10,
          xoffset: 1,
          yoffset: 2,
          atlasPosition: [0, 0],
          atlasSize: [8, 8],
        },
      ],
      metrics: { lineHeight: 20, ascender: 16 },
      textureSize: [16, 16],
      fieldRange: 4,
    };
  }

  function mockGeneratorFactory(): () => Promise<MsdfGenerator> {
    return async () => ({
      generateAtlas: async () => mockAtlas(),
      dispose: async () => undefined,
    });
  }

  function makeCtx(subAssets: readonly ImportSubAsset[]): ImportContext {
    return {
      source: 'roboto.ttf',
      readSource: async () => ({ ok: true, value: new Uint8Array([0x00, 0x01, 0x00, 0x00]) }),
      readSibling: async () => ({ ok: true, value: new Uint8Array() }),
      decodeImage: async () => {
        throw new Error('decodeImage not used by fontImporter');
      },
      subAssets,
      importSettings: { generatorFactory: mockGeneratorFactory() },
    };
  }

  describe('font-importer.test.ts', () => {
    describe('fontImporter dispatch (AC-18)', () => {
      it('an ImporterRegistry resolves meta.importer="font" to fontImporter', () => {
        const registry = new ImporterRegistry();
        registry.register(fontImporter);
        const resolved = registry.get('font');
        expect(resolved).toBe(fontImporter);
        expect(resolved?.key).toBe('font');
        expect(typeof resolved?.import).toBe('function');
      });
    });

    describe('fontImporter bake mapping (AC-18)', () => {
      it('maps the mock atlas onto declared atlas, sampler, and font sub-asset GUIDs', async () => {
        const ctx = makeCtx([
          { guid: ATLAS_GUID, sourceIndex: 0, kind: 'texture' },
          { guid: SAMPLER_GUID, sourceIndex: 1, kind: 'sampler' },
          { guid: FONT_GUID, sourceIndex: 0, kind: 'font' },
        ]);
        const result = await fontImporter.import(ctx);
        expect(result.ok).toBe(true);
        const produced: readonly ImportedAsset[] = result.ok ? result.value.assets : [];

        const atlas = produced.find((a) => a.guid === ATLAS_GUID);
        expect(atlas?.kind).toBe('texture');

        const font = produced.find((a) => a.guid === FONT_GUID);
        expect(font?.kind).toBe('font');
        expect(font?.refs.map((r) => r.guid)).toEqual([ATLAS_GUID, SAMPLER_GUID]);
        expect(font?.payload).toMatchObject({
          atlasGuid: ATLAS_GUID,
          samplerGuid: SAMPLER_GUID,
        });

        expect(produced).toContainEqual({
          guid: SAMPLER_GUID,
          kind: 'sampler',
          payload: {
            kind: 'sampler',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            addressModeW: 'clamp-to-edge',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'nearest',
          },
          refs: [],
          artifacts: {},
        });
      });

      // P1: fontImporter atlas lookup uses s.kind === 'texture' instead of 'image'.
      it('P1: uses s.kind === "texture" to find atlas sub-asset', async () => {
        const ctx = makeCtx([
          { guid: ATLAS_GUID, sourceIndex: 0, kind: 'texture' },
          { guid: SAMPLER_GUID, sourceIndex: 1, kind: 'sampler' },
          { guid: FONT_GUID, sourceIndex: 0, kind: 'font' },
        ]);
        const result = await fontImporter.import(ctx);
        expect(result.ok).toBe(true);
        const produced: readonly ImportedAsset[] = result.ok ? result.value.assets : [];

        const atlas = produced.find((a) => a.guid === ATLAS_GUID);
        expect(atlas?.kind).toBe('texture');

        const font = produced.find((a) => a.guid === FONT_GUID);
        expect(font?.kind).toBe('font');
        expect(font?.refs.map((r) => r.guid)).toEqual([ATLAS_GUID, SAMPLER_GUID]);
      });
    });
  });
}

{
  // ─── from plugin-discoverable.test.ts ───

  const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

  describe('plugin-discoverable.test.ts', () => {
    describe('plugin-discoverable (forgeax asset import)', () => {
      describe('bake subcommand routing (a)', () => {
        it('--help on root exits 0 and prints usage', async () => {
          const code = await runCliFont(['--help']);
          expect(code).toBe(0);
        });

        it('bake --help exits 0 and prints bake usage', async () => {
          const code = await runCliFont(['bake', '--help']);
          expect(code).toBe(0);
        });

        it('bake with two positionals routes to the real bake (exits 1 on a missing source)', async () => {
          const code = await runCliFont(['bake', 'font.ttf', 'out/']);
          expect(code).toBe(1);
        });

        it('unknown subcommand exits 1', async () => {
          const code = await runCliFont(['unknown-cmd']);
          expect(code).toBe(1);
        });

        it('no subcommand with empty argv exits 0 (prints help)', async () => {
          const code = await runCliFont([]);
          expect(code).toBe(0);
        });
      });

      describe('unified command ownership (b)', () => {
        it('does not publish a standalone bin', async () => {
          const pkgPath = join(PKG_DIR, 'package.json');
          const raw = await readFile(pkgPath, 'utf-8');
          const pkg = JSON.parse(raw) as Record<string, unknown>;
          expect(pkg.bin).toBeUndefined();
        });
      });

      describe('package.json bin contract (c)', () => {
        it('package name is @forgeax/engine-font', async () => {
          const pkgPath = join(PKG_DIR, 'package.json');
          const raw = await readFile(pkgPath, 'utf-8');
          const pkg = JSON.parse(raw) as Record<string, unknown>;
          expect(pkg.name).toBe('@forgeax/engine-font');
        });

        it('package exports ./dist/index.mjs as main', async () => {
          const pkgPath = join(PKG_DIR, 'package.json');
          const raw = await readFile(pkgPath, 'utf-8');
          const pkg = JSON.parse(raw) as Record<string, unknown>;
          expect(pkg.main).toBe('./dist/index.mjs');
        });
      });
    });
  });
}
