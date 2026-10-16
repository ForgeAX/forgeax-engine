import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bakeFont, realGeneratorFactory } from '@forgeax/engine/font/cli-font';
import { errorCode } from '../../features/asset-formats/fixtures/memory-pack';
import { defineFeature } from '../../lab/feature';

/** A small OFL pixel TTF that ships inside the three.js dev dependency; no private asset submodule. */
function findTtf(): string | undefined {
  const store = fileURLToPath(new URL('../../../../../node_modules/.pnpm', import.meta.url));
  if (!existsSync(store)) return undefined;
  for (const dir of readdirSync(store).filter((name) => name.startsWith('three@'))) {
    const path = join(store, dir, 'node_modules/three/examples/fonts/ttf/kenpixel.ttf');
    if (existsSync(path)) return path;
  }
  return undefined;
}

interface Sidecar {
  readonly importer?: string;
  readonly common?: {
    readonly distanceRange?: number;
    readonly atlasWidth?: number;
    readonly atlasHeight?: number;
    readonly lineHeight?: number;
  };
  readonly glyphs?: Readonly<Record<string, { readonly advance?: number }>>;
}

export default defineFeature({
  title: 'Font MSDF bake',
  catalog: 'Font MSDF bake',
  kind: 'headless',
  summary:
    'bakeFont with the real @zappar/msdf-generator factory turns an in-repo TTF into an MSDF atlas PNG plus a font importer sidecar with glyph metrics, in plain Node.',
  expect:
    'The atlas PNG and meta.json are written, the sidecar declares importer font, a 1024x1024 atlas with distanceRange 4, and all 95 printable ASCII glyphs with advances; a non-TTF input fails with unsupported-font-format.',
  async run(checks) {
    const ttf = findTtf();
    checks.ok('in-repo TTF located', ttf !== undefined, 'three/examples/fonts/ttf/kenpixel.ttf');
    if (ttf === undefined) return;
    const out = await mkdtemp(join(tmpdir(), 'feature-lab-font-'));
    try {
      await checks.run('bakeFont completes', async () => {
        const result = await bakeFont(ttf, out, realGeneratorFactory);
        const png = await readFile(result.atlasPath);
        checks.equal('atlas is a PNG', Array.from(png.subarray(1, 4)), [0x50, 0x4e, 0x47]);
        const sidecar = JSON.parse(await readFile(result.sidecarPath, 'utf8')) as Sidecar;
        checks.equal('sidecar importer', sidecar.importer, 'font');
        checks.equal(
          'atlas common block',
          [sidecar.common?.atlasWidth, sidecar.common?.atlasHeight, sidecar.common?.distanceRange],
          [1024, 1024, 4],
        );
        const glyphs = Object.keys(sidecar.glyphs ?? {});
        checks.equal('printable ASCII glyph count', glyphs.length, 95);
        checks.ok('glyph A has an advance', (sidecar.glyphs?.['65']?.advance ?? 0) > 0);
      });
      const bogus = join(out, 'bogus.ttf');
      await writeFile(bogus, new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]));
      const rejection = await bakeFont(bogus, out, realGeneratorFactory).then(
        () => 'resolved',
        (error: unknown) => errorCode(error),
      );
      checks.equal('WOFF2 magic rejected', rejection, 'unsupported-font-format');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  },
});
