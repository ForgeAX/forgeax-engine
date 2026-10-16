// `forgeax asset atlas` region-mismatch safety-net test
// (feat-20260521-sprite-atlas-animation M5' T-29 / requirements AC-10 (c)).
//
// The shelfPack pure function never produces regions whose summed area
// exceeds the atlas footprint -- that would be a packer regression. We
// still keep an `atlas-region-mismatch` invariant in runAtlas so a future
// algorithm swap (D-4 MaxRects / rectpack2D) cannot silently drop
// pixels. To exercise that branch we replace shelfPack with a vi.mock
// factory that fabricates an over-large region map; runAtlas must then
// project the failure to ImageError code='atlas-region-mismatch' with
// detail.{name, regionsTotalPixels, atlasPixels}.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../atlas/shelf-pack.js', async () => {
  return {
    shelfPack: () => ({
      ok: true,
      value: {
        atlasWidth: 64,
        atlasHeight: 64,
        regions: [
          { name: 'walk-0', x: 0, y: 0, w: 64, h: 64 },
          { name: 'walk-1', x: 0, y: 0, w: 64, h: 64 },
          { name: 'walk-2', x: 0, y: 0, w: 64, h: 64 },
        ],
      },
    }),
  };
});

import { runCliAsset } from '../cli-asset.js';

interface CapturedIO {
  stdout: string[];
  stderr: string[];
}

function makeIO(): CapturedIO {
  return { stdout: [], stderr: [] };
}

function ctxFor(io: CapturedIO) {
  return {
    stdoutWrite: (line: string): void => {
      io.stdout.push(line);
    },
    stderrWrite: (line: string): void => {
      io.stderr.push(line);
    },
  };
}

interface UpngEncode {
  encode: (imgs: ArrayBuffer[], w: number, h: number, cnum: number) => ArrayBuffer;
}

async function loadUpng(): Promise<UpngEncode> {
  const mod = (await import('upng-js')) as { default?: UpngEncode } & UpngEncode;
  return (mod.default ?? mod) as UpngEncode;
}

async function writeSolidPng(
  path: string,
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Promise<void> {
  const upng = await loadUpng();
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4 + 0] = rgba[0];
    pixels[i * 4 + 1] = rgba[1];
    pixels[i * 4 + 2] = rgba[2];
    pixels[i * 4 + 3] = rgba[3];
  }
  const buf = upng.encode([pixels.buffer as ArrayBuffer], width, height, 0);
  await writeFile(path, Buffer.from(buf));
}

describe('atlas CLI region-mismatch safety net (T-29 / AC-10 c)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'atlas-cli-region-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('exits 1 with atlas-region-mismatch + detail name/regionsTotalPixels/atlasPixels', async () => {
    await writeSolidPng(join(tmp, 'walk-0.png'), 32, 32, [255, 0, 0, 255]);
    await writeSolidPng(join(tmp, 'walk-1.png'), 32, 32, [0, 255, 0, 255]);
    await writeSolidPng(join(tmp, 'walk-2.png'), 32, 32, [0, 0, 255, 255]);

    const io = makeIO();
    const code = await runCliAsset(
      [
        'atlas',
        '--input',
        `${tmp}/*.png`,
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
    const parsed = JSON.parse(io.stderr[0] as string) as {
      code: string;
      expected: string;
      hint: string;
      detail?: { name?: string; regionsTotalPixels?: number; atlasPixels?: number };
    };
    expect(parsed.code).toBe('atlas-region-mismatch');
    expect(typeof parsed.expected).toBe('string');
    expect(parsed.expected.length).toBeGreaterThan(0);
    expect(typeof parsed.hint).toBe('string');
    expect(parsed.hint.length).toBeGreaterThan(0);
    expect(typeof parsed.detail?.name).toBe('string');
    expect(typeof parsed.detail?.regionsTotalPixels).toBe('number');
    expect(typeof parsed.detail?.atlasPixels).toBe('number');
    expect(parsed.detail?.regionsTotalPixels ?? 0).toBeGreaterThan(parsed.detail?.atlasPixels ?? 0);
  });
});
