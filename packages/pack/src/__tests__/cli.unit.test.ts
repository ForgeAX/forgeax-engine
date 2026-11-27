// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=4 — NOT 5, atlas-cli-region-mismatch.test.ts excluded: its
// vi.mock('../atlas/shelf-pack.js') is hoisted to file-top and conflicts with
// atlas-cli-happy-path.test.ts which needs the real shelf-pack):
//   - packages/pack/src/__tests__/atlas-cli-empty-input.test.ts
//   - packages/pack/src/__tests__/atlas-cli-happy-path.test.ts
//   - packages/pack/src/__tests__/atlas-cli-size-exceeded.test.ts
//   - packages/pack/src/__tests__/cli-asset.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAtlas } from '../cli-asset.js';
import { createFileSystemPackAuthoringGateway } from '../pack-authoring-node.js';
import { scanInventory } from '../scanner.js';
import { ctxFor, makeIO, writeSolidPng } from './support/atlas-cli-fixture.js';
import { metaFixture } from './support/direct-pack-fixture.js';

{
  // ─── from atlas-cli-empty-input.test.ts ───

  describe('atlas-cli-empty-input.test.ts', () => {
    let tmp: string;

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'atlas-cli-empty-'));
    });

    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    describe('atlas CLI empty-input fail-fast (T-27 / AC-10 a)', () => {
      it('exits 1 with atlas-empty-input + receivedCount=0', async () => {
        const io = makeIO();
        const code = await runAtlas(
          [
            '--input',
            `${tmp}/nonexistent-*.png`,
            '--name',
            'walk',
            '--output',
            tmp,
            '--max-atlas-size',
            '4096',
          ],
          ctxFor(io),
        );

        expect(code).toBe(1);
        expect(io.stderr.length).toBe(1);
        const line = io.stderr[0] as string;
        expect(line.includes('\n')).toBe(false);
        const parsed = JSON.parse(line) as {
          code: string;
          expected: string;
          hint: string;
          detail?: { receivedCount?: number };
        };
        expect(parsed.code).toBe('atlas-empty-input');
        expect(typeof parsed.expected).toBe('string');
        expect(parsed.expected.length).toBeGreaterThan(0);
        expect(typeof parsed.hint).toBe('string');
        expect(parsed.hint.length).toBeGreaterThan(0);
        expect(parsed.detail?.receivedCount).toBe(0);
      });
    });
  });
}

{
  // ─── from atlas-cli-happy-path.test.ts ───

  describe('atlas-cli-happy-path.test.ts', () => {
    let tmp: string;

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'atlas-cli-happy-'));
    });

    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    describe('atlas CLI happy path (T-26 / AC-06)', () => {
      it.each([
        '*.png',
        '@(walk-*).png',
      ])('packs 3 PNGs into atlas artifacts through %s', async (pattern) => {
        await writeSolidPng(join(tmp, 'walk-0.png'), 64, 64, [255, 0, 0, 255]);
        await writeSolidPng(join(tmp, 'walk-1.png'), 64, 64, [0, 255, 0, 255]);
        await writeSolidPng(join(tmp, 'walk-2.png'), 64, 64, [0, 0, 255, 255]);
        await mkdir(join(tmp, 'walk-directory.png'));

        const io = makeIO();
        const code = await runAtlas(
          [
            '--input',
            `${tmp}/${pattern}`,
            '--name',
            'walk',
            '--output',
            tmp,
            '--max-atlas-size',
            '4096',
          ],
          ctxFor(io),
        );

        expect(code).toBe(0);
        expect(io.stderr).toEqual([]);

        const atlasBytes = await readFile(join(tmp, 'walk.atlas.png'));
        expect(atlasBytes.length).toBeGreaterThan(0);
        expect(atlasBytes[0]).toBe(0x89);
        expect(atlasBytes[1]).toBe(0x50);
        expect(atlasBytes[2]).toBe(0x4e);
        expect(atlasBytes[3]).toBe(0x47);

        const metaText = await readFile(join(tmp, 'walk.atlas.meta.json'), 'utf-8');
        const meta = JSON.parse(metaText) as {
          name: string;
          atlasWidth: number;
          atlasHeight: number;
          regions: Array<{ name: string; uMin: number; vMin: number; uW: number; vH: number }>;
        };
        expect(meta.name).toBe('walk');
        expect(meta.atlasWidth).toBeGreaterThan(0);
        expect(meta.atlasHeight).toBeGreaterThan(0);
        expect(meta.atlasWidth).toBeLessThanOrEqual(4096);
        expect(meta.atlasHeight).toBeLessThanOrEqual(4096);
        expect(meta.regions).toHaveLength(3);
        const regionNames = meta.regions.map((r) => r.name).sort();
        expect(regionNames).toEqual(['walk-0', 'walk-1', 'walk-2']);
        for (const r of meta.regions) {
          expect(r.uMin).toBeGreaterThanOrEqual(0);
          expect(r.uMin).toBeLessThanOrEqual(1);
          expect(r.vMin).toBeGreaterThanOrEqual(0);
          expect(r.vMin).toBeLessThanOrEqual(1);
          expect(r.uW).toBeGreaterThan(0);
          expect(r.uW).toBeLessThanOrEqual(1);
          expect(r.vH).toBeGreaterThan(0);
          expect(r.vH).toBeLessThanOrEqual(1);
          expect(r.uMin + r.uW).toBeLessThanOrEqual(1 + 1e-9);
          expect(r.vMin + r.vH).toBeLessThanOrEqual(1 + 1e-9);
        }
      });
    });
  });
}

{
  // ─── from atlas-cli-size-exceeded.test.ts ───

  describe('atlas-cli-size-exceeded.test.ts', () => {
    let tmp: string;

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'atlas-cli-size-'));
    });

    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    describe('atlas CLI size-exceeded fail-fast (T-28 / AC-10 b)', () => {
      it('exits 1 with atlas-size-exceeded + detail name/width/height/maxAtlasSize', async () => {
        await writeSolidPng(join(tmp, 'giant.png'), 256, 256, [255, 200, 100, 255]);

        const io = makeIO();
        const code = await runAtlas(
          ['--input', `${tmp}/*.png`, '--name', 'walk', '--output', tmp, '--max-atlas-size', '64'],
          ctxFor(io),
        );

        expect(code).toBe(1);
        expect(io.stderr.length).toBe(1);
        const parsed = JSON.parse(io.stderr[0] as string) as {
          code: string;
          expected: string;
          hint: string;
          detail?: { name?: string; width?: number; height?: number; maxAtlasSize?: number };
        };
        expect(parsed.code).toBe('atlas-size-exceeded');
        expect(typeof parsed.expected).toBe('string');
        expect(parsed.expected.length).toBeGreaterThan(0);
        expect(typeof parsed.hint).toBe('string');
        expect(parsed.hint.length).toBeGreaterThan(0);
        expect(parsed.detail?.name).toBe('giant');
        expect(parsed.detail?.width).toBe(256);
        expect(parsed.detail?.height).toBe(256);
        expect(parsed.detail?.maxAtlasSize).toBe(64);
      });
    });
  });
}

{
  // ─── from cli-asset.test.ts ───

  describe('cli-asset.test.ts', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'pack-cli-asset-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    describe('cli-asset (forgeax asset plugin bin)', () => {
      describe('PackError stderr JSON Lines (b)', () => {
        it('emits code / expected / hint as a single JSON line on pack-orphan-meta', async () => {
          const orphanDir = join(tempDir, 'orphan');
          await mkdir(orphanDir, { recursive: true });
          await writeFile(
            join(orphanDir, 'foo.png.meta.json'),
            metaFixture('foo.png', 'image', [
              { guid: '01234567-89ab-7def-8123-456789abcdef', sourceIndex: 0, kind: 'texture' },
            ]),
            'utf-8',
          );
          expect(await scanInventory([orphanDir])).toMatchObject({
            ok: false,
            error: {
              code: 'pack-orphan-meta',
              expected: expect.any(String),
              hint: expect.any(String),
            },
          });
        });
      });

      describe('image sidecar enumeration (T-2.B1)', () => {
        const IMAGE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';

        it('scan enumerates *.meta.json subAssets', async () => {
          const sidecarDir = join(tempDir, 'wood');
          await mkdir(sidecarDir, { recursive: true });
          await writeFile(join(sidecarDir, 'wood-container.jpg'), 'placeholder', 'utf-8');
          await writeFile(
            join(sidecarDir, 'wood-container.jpg.meta.json'),
            metaFixture(
              'wood-container.jpg',
              'image',
              [{ guid: IMAGE_GUID, sourceIndex: 0, kind: 'texture' }],
              {
                colorSpace: 'srgb',
                mipmap: 'auto',
                addressMode: 'repeat',
                filterMode: 'linear',
              },
            ),
            'utf-8',
          );
          const scanned = await scanInventory([sidecarDir]);
          if (!scanned.ok) throw scanned.error;
          const parsed = scanned.value.inventory;
          expect(parsed).toHaveLength(1);
          expect(parsed[0].guid).toBe(IMAGE_GUID);
          expect(parsed[0].kind).toBe('texture');
          expect(parsed[0].sourcePath).toContain('wood-container.jpg.meta.json');
        });
      });

      describe('verification inventory', () => {
        it('accepts empty roots', async () => {
          expect((await scanInventory([tempDir])).ok).toBe(true);
        });

        it('rejects invalid sources', async () => {
          const subDir = join(tempDir, 'bad');
          await mkdir(subDir, { recursive: true });
          await writeFile(
            join(subDir, 'broken.pack.json'),
            '{"this is not": "schema-valid"}',
            'utf-8',
          );
          expect((await scanInventory([subDir])).ok).toBe(false);
        });

        it('verify emits one structured source/output report', async () => {
          const guid = '019e2cc6-0c86-79da-aa76-b0984c86d45d';
          await writeFile(join(tempDir, 'hero.png'), 'source', 'utf-8');
          await writeFile(
            join(tempDir, 'hero.png.meta.json'),
            metaFixture('hero.png', 'image', [{ guid, sourceIndex: 0, kind: 'texture' }]),
            'utf-8',
          );
          const gateway = createFileSystemPackAuthoringGateway({ gameRoot: tempDir });
          const report = (
            await gateway.execute({ operation: 'asset.verify', requestId: 'verify' })
          ).unwrap();
          expect(report.schemaVersion).toBe('asset-verification-v1');
          expect(report.assets?.[0]).toMatchObject({
            guid,
            type: 'texture',
            source: { role: 'author' },
            output: { status: 'unproduced', availability: 'unknown', freshness: 'unknown' },
            producer: { state: 'not-run' },
          });
          expect(report.scope).toMatchObject({
            sourceCount: 1,
            assetLimit: 256,
            truncated: false,
            scriptablePackSourceCount: 0,
          });
          expect(report.summary).toMatchObject({
            assetCount: 1,
            emittedAssetCount: 1,
            materialCount: 0,
            unproducedAssetCount: 1,
            unknownAssetCount: 0,
            unmaterializedScriptablePackCount: 0,
          });
        });

        it('reports author declarations and dependencies before publication', async () => {
          const guid = '105d046f-ff1b-5fe7-82b4-2baef3461cd9';
          const dependency = '019e2cc6-0c86-79da-aa76-b0984c86d45f';
          await writeFile(
            join(tempDir, 'published.pack.json'),
            JSON.stringify({
              schemaVersion: '3.0.0',
              packageId: '019e2cc6-0c86-79da-aa76-b0984c86d450',
              assets: {
                output: {
                  kind: 'scene',
                  payload: {},
                  refs: [dependency],
                  artifacts: {
                    scene: { path: 'artifacts/scene.bin', mediaType: 'application/octet-stream' },
                  },
                },
              },
            }),
            'utf-8',
          );
          const gateway = createFileSystemPackAuthoringGateway({
            gameRoot: tempDir,
            catalog: () => [
              {
                guid: dependency,
                kind: 'texture',
                lifecycle: 'current',
                publication: { current: { packageUrl: '/assets/texture.runtime-pack.json' } },
              },
            ],
          });
          const report = (
            await gateway.execute({ operation: 'asset.verify', requestId: 'verify' })
          ).unwrap();
          expect(report.assets?.[0]).toMatchObject({
            guid,
            dependencies: [dependency],
            output: {
              status: 'unproduced',
              availability: 'unknown',
              freshness: 'unknown',
            },
            producer: { state: 'not-run' },
          });
          expect(report.summary).toMatchObject({ assetCount: 1, emittedAssetCount: 1 });
        });
      });
    });
  });

  void chmod;
}
