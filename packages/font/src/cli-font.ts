// Node-only font producer used by DevKit’s unified asset command and build integrations.

import { Buffer } from 'node:buffer';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '@forgeax/engine-image/png';
import { type FontAsset, FontError } from '@forgeax/engine-types';
import { atlasFontData, type BakeAtlas, type MsdfGenerator } from './atlas-font-data.js';
import { NodeWorkerAdapter } from './node-worker-adapter.js';

export type { BakeAtlas, BakeGlyph, MsdfGenerator } from './atlas-font-data.js';

/** Default charset baked into the atlas (printable ASCII). */
const DEFAULT_CHARSET = (() => {
  let s = '';
  for (let c = 0x20; c <= 0x7e; c++) s += String.fromCharCode(c);
  return s;
})();

const DEFAULT_TEXTURE_SIZE = 1024;
const DEFAULT_FIELD_RANGE = 4;
const DEFAULT_FONT_SIZE = 48;

/**
 * Bake-time sidecar JSON shape (importer: 'font'). Carries the glyph metrics
 * (BMFont -> FontAsset mapping, toolchain wiki section 4) + the common block
 * (distanceRange / atlas dimensions). Parsed by the runtime font load path.
 */
export interface BakeSidecar extends Pick<FontAsset, 'common' | 'glyphs'> {
  readonly schemaVersion: string;
  readonly kind: 'external-asset-package';
  readonly importer: 'font';
  readonly source: string;
  readonly importSettings: { readonly colorSpace: 'linear'; readonly mipmap: 'none' };
}

/** TTF / OTF magic numbers (first 4 bytes). Per the OpenType spec. */
function isSupportedFontMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  const b2 = bytes[2] ?? 0;
  const b3 = bytes[3] ?? 0;
  // 0x00010000 = TrueType outlines; 'true' (0x74727565) = legacy Apple TTF;
  // 'OTTO' (0x4f54544f) = OpenType with CFF outlines. WOFF/WOFF2 ('wOFF' /
  // 'wOF2') are rejected as non-TTF per AC-15.
  const isTrueType = b0 === 0x00 && b1 === 0x01 && b2 === 0x00 && b3 === 0x00;
  const isTrue = b0 === 0x74 && b1 === 0x72 && b2 === 0x75 && b3 === 0x65;
  const isOtto = b0 === 0x4f && b1 === 0x54 && b2 === 0x54 && b3 === 0x4f;
  return isTrueType || isTrue || isOtto;
}

/** Map a @zappar atlas into the FontAsset glyph-metrics sidecar shape. */
export function atlasToSidecar(atlas: BakeAtlas, sourcePng: string): BakeSidecar {
  return {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'font',
    source: sourcePng,
    importSettings: { colorSpace: 'linear', mipmap: 'none' },
    ...atlasFontData(atlas),
  };
}

/** Result of a successful bake -- the written artefact paths. */
export interface BakeResult {
  readonly atlasPath: string;
  readonly sidecarPath: string;
}

/**
 * Bake an MSDF atlas + glyph-metrics sidecar from a TTF.
 *
 * @param ttfPath path to the TrueType source.
 * @param outDir output directory (created if missing).
 * @param generatorFactory yields the MSDF generator (real: @zappar; tests: mock).
 * @returns `Result`-style: throws a {@link FontError} on every failure mode
 *   (unsupported-font-format before the generator runs; bake-failed when the
 *   generator throws). The CLI layer maps the thrown FontError to a structured
 *   stderr line + exit code 1 -- never a silent exit 0 without artefacts
 *   (charter P3).
 */
export async function bakeFont(
  ttfPath: string,
  outDir: string,
  generatorFactory: () => Promise<MsdfGenerator>,
): Promise<BakeResult> {
  const ttf = await readFile(ttfPath);
  const ttfBytes = new Uint8Array(ttf.buffer, ttf.byteOffset, ttf.byteLength);
  if (!isSupportedFontMagic(ttfBytes)) {
    throw new FontError({
      code: 'unsupported-font-format',
      expected: 'ttf',
      hint: 'bake accepts TrueType (.ttf / 0x00010000 / "true") or OpenType-TTF ("OTTO") sources; WOFF / WOFF2 / other formats are not supported -- convert to TTF first',
      detail: { path: ttfPath },
    });
  }

  let atlas: BakeAtlas;
  let generator: MsdfGenerator | undefined;
  try {
    generator = await generatorFactory();
    atlas = await generator.generateAtlas(ttfBytes);
  } catch (e) {
    throw new FontError({
      code: 'bake-failed',
      expected: '@zappar/msdf-generator to produce an MSDF atlas',
      hint: 'the MSDF generator threw -- a Web Worker + wasm host is required (a plain Node process reports "Worker is not defined"); run the bake in a Worker-capable environment',
      detail: { cause: e instanceof Error ? e.message : String(e) },
    });
  } finally {
    if (generator !== undefined) {
      await generator.dispose().catch(() => undefined);
    }
  }

  await mkdir(outDir, { recursive: true });
  const base = basename(ttfPath, extname(ttfPath));
  const atlasName = `${base}.atlas.png`;
  const atlasPath = join(outDir, atlasName);
  const sidecarPath = join(outDir, `${base}.meta.json`);
  const png = encodePng(atlas.texture.width, atlas.texture.height, atlas.texture.data);
  await writeFile(atlasPath, png);
  const sidecar = atlasToSidecar(atlas, atlasName);
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  return { atlasPath, sidecarPath };
}

/**
 * Real @zappar/msdf-generator factory. Dynamically imported so callers using
 * an injected generator never pay the wasm load cost,
 * and so the package builds without the browser globals the generator needs.
 */
export async function realGeneratorFactory(): Promise<MsdfGenerator> {
  const mod = await import('@zappar/msdf-generator');

  const wasmModuleUrl = import.meta.resolve('@zappar/msdf-generator/msdfgen_wasm.wasm');
  const wasmBytes = await readFile(new URL(wasmModuleUrl));
  const wasmUrl = `data:application/octet-stream;base64,${Buffer.from(wasmBytes).toString('base64')}`;
  const nodeGlobal = globalThis as unknown as { Worker?: typeof NodeWorkerAdapter };
  const previousWorker = nodeGlobal.Worker;
  nodeGlobal.Worker = NodeWorkerAdapter;
  let msdf: InstanceType<typeof mod.MSDF> | undefined;
  try {
    msdf = new mod.MSDF({
      workerUrl: fileURLToPath(new URL('./node-msdf-worker.mjs', import.meta.url)),
      wasmUrl,
    });
    await msdf.initialize();
  } finally {
    if (previousWorker === undefined) {
      delete nodeGlobal.Worker;
    } else {
      nodeGlobal.Worker = previousWorker;
    }
  }
  if (msdf === undefined) {
    throw new Error('the MSDF generator did not initialize');
  }
  return {
    async generateAtlas(ttf: Uint8Array): Promise<BakeAtlas> {
      const a = await msdf.generateAtlas({
        font: ttf,
        charset: DEFAULT_CHARSET,
        textureSize: [DEFAULT_TEXTURE_SIZE, DEFAULT_TEXTURE_SIZE],
        fieldRange: DEFAULT_FIELD_RANGE,
        fontSize: DEFAULT_FONT_SIZE,
      });
      return {
        texture: {
          width: a.texture.width,
          height: a.texture.height,
          data: new Uint8Array(a.texture.data),
        },
        glyphs: a.glyphs.map((g) => ({
          unicode: g.unicode,
          advance: g.advance,
          xoffset: g.xoffset,
          yoffset: g.yoffset,
          atlasPosition: [g.atlasPosition[0], g.atlasPosition[1]],
          atlasSize: [g.atlasSize[0], g.atlasSize[1]],
        })),
        metrics: { lineHeight: a.metrics.lineHeight, ascender: a.metrics.ascender },
        textureSize: [a.textureSize[0], a.textureSize[1]],
        fieldRange: a.fieldRange,
      };
    },
    async dispose(): Promise<void> {
      await msdf.dispose();
    },
  };
}
