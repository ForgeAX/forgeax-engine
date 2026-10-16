import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAtlas } from '@forgeax/engine/pack/cli-asset';
// @ts-expect-error pngjs ships no type declarations in this workspace.
import { PNG } from 'pngjs';
import { defineFeature } from '../../lab/feature';

interface PngImage {
  width: number;
  height: number;
  data: Uint8Array;
}

function solidPng(
  width: number,
  height: number,
  rgba: readonly [number, number, number, number],
): Buffer {
  const png = new PNG({ width, height }) as PngImage;
  for (let i = 0; i < width * height; i++) png.data.set(rgba, i * 4);
  return PNG.sync.write(png) as Buffer;
}

interface Region {
  readonly name: string;
  readonly uMin: number;
  readonly vMin: number;
  readonly uW: number;
  readonly vH: number;
}

async function atlas(argv: string[], cwd: string): Promise<{ code: number; stderr: string[] }> {
  const stderr: string[] = [];
  const code = await runAtlas(argv, {
    stdoutWrite: () => undefined,
    stderrWrite: (line) => stderr.push(line),
    cwd,
  });
  return { code, stderr };
}

export default defineFeature({
  title: 'Sprite atlas CLI',
  catalog: 'Sprite Atlas',
  kind: 'headless',
  summary:
    'forgeax asset atlas packs a glob of PNGs into <name>.atlas.png plus <name>.atlas.meta.json with normalized uMin/vMin/uW/vH regions that feed SpriteRegionOverride.',
  expect:
    'Three PNGs (32x32 red, 16x16 green, 48x16 blue) pack into one atlas whose regions reproduce each source pixel; an empty glob exits 1 with a JSON atlas-empty-input error; an oversized image exits 1 with atlas-size-exceeded.',
  async run(checks) {
    const dir = await mkdtemp(join(tmpdir(), 'fl-atlas-'));
    try {
      const sources = {
        red: [32, 32, [255, 0, 0, 255]],
        green: [16, 16, [0, 255, 0, 255]],
        blue: [48, 16, [0, 0, 255, 255]],
      } as const;
      for (const [name, [w, h, rgba]] of Object.entries(sources))
        await writeFile(join(dir, `${name}.png`), solidPng(w, h, rgba));

      const ok = await atlas(['--input', '*.png', '--name', 'hero', '--output', 'out'], dir);
      checks.equal('atlas exits 0', ok.code, 0);
      checks.equal('no stderr on success', ok.stderr, []);
      const meta = JSON.parse(
        await readFile(join(dir, 'out', 'hero.atlas.meta.json'), 'utf-8'),
      ) as {
        name: string;
        atlasWidth: number;
        atlasHeight: number;
        regions: Region[];
      };
      checks.equal('sidecar name', meta.name, 'hero');
      checks.equal('one region per source', meta.regions.map((r) => r.name).sort(), [
        'blue',
        'green',
        'red',
      ]);
      const image = PNG.sync.read(await readFile(join(dir, 'out', 'hero.atlas.png'))) as PngImage;
      checks.equal(
        'png matches sidecar dimensions',
        [image.width, image.height],
        [meta.atlasWidth, meta.atlasHeight],
      );
      for (const region of meta.regions) {
        const [w, h, rgba] = sources[region.name as keyof typeof sources];
        checks.near(`${region.name} region width`, region.uW * meta.atlasWidth, w, 1e-6);
        checks.near(`${region.name} region height`, region.vH * meta.atlasHeight, h, 1e-6);
        const x = Math.round(region.uMin * meta.atlasWidth + w / 2);
        const y = Math.round(region.vMin * meta.atlasHeight + h / 2);
        const o = (y * image.width + x) * 4;
        checks.equal(`${region.name} center pixel`, Array.from(image.data.subarray(o, o + 4)), [
          ...rgba,
        ]);
      }

      const empty = await atlas(['--input', 'missing/*.png', '--name', 'none'], dir);
      checks.equal('empty glob exits 1', empty.code, 1);
      const emptyError = JSON.parse(empty.stderr[0] ?? '{}') as {
        code?: string;
        detail?: { receivedCount?: number };
        hint?: string;
      };
      checks.equal('empty glob reports atlas-empty-input', emptyError.code, 'atlas-empty-input');
      checks.equal('empty glob detail', emptyError.detail?.receivedCount, 0);
      checks.ok(
        'error carries a hint',
        typeof emptyError.hint === 'string' && emptyError.hint.length > 0,
      );

      const tooBig = await atlas(
        ['--input', '*.png', '--name', 'big', '--output', 'big', '--max-atlas-size', '32'],
        dir,
      );
      checks.equal('oversized input exits 1', tooBig.code, 1);
      checks.equal(
        'oversized input reports atlas-size-exceeded',
        (JSON.parse(tooBig.stderr[0] ?? '{}') as { code?: string }).code,
        'atlas-size-exceeded',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
});
