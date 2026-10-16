#!/usr/bin/env node

// @forgeax/engine-font/src/cli-font — `forgeax asset import` plugin
// bin. Discovered by the base bin via the kubectl 4th-path
// unified `forgeax asset import` producer.
//
// `bake <ttf> <out>` reads a TrueType font and produces an MSDF atlas PNG +
// a glyph-metrics sidecar JSON (importer: 'font'). The real bake calls
// @zappar/msdf-generator (feat-20260531-world-space-msdf-text-rendering M5 /
// w28 -- replaces the M1 placeholder).
//
// Error model (FontErrorCode, structured to stderr, exit code 1):
//   - non-TTF magic (not 0x00010000 / 'true' / 'OTTO') -> 'unsupported-font-format'
//     (AC-15 / plan-strategy D-11). The check runs BEFORE the generator so a
//     bad format never reaches the wasm path.
//   - @zappar/msdf-generator throws (wasm / Worker unavailable, internal error)
//     -> 'bake-failed' (charter P3: explicit failure, never a silent exit-0
//     no-atlas). In a plain Node CI without a Web Worker the generator throws
//     'Worker is not defined' and the bake reports 'bake-failed' (exit 1) --
//     the best-effort real run requires a Worker + wasm host.

import { Buffer } from 'node:buffer';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { deflateSync } from 'node:zlib';
import { FontError, type GlyphMetric } from '@forgeax/engine-types';
import { atlasFontData } from './atlas-font-data.js';
import { NodeWorkerAdapter } from './node-worker-adapter.js';

/**
 * Minimal subset of the @zappar/msdf-generator glyph record consumed by the
 * bake. Mirrors the package's `GlyphInfo` (dist/index.d.ts) -- only the fields
 * the BMFont -> FontAsset mapping needs (toolchain wiki section 4).
 */
export interface BakeGlyph {
  readonly unicode: number;
  readonly advance: number;
  readonly xoffset: number;
  readonly yoffset: number;
  readonly atlasPosition: readonly [number, number];
  readonly atlasSize: readonly [number, number];
}

/**
 * Minimal subset of the @zappar/msdf-generator `MSDFAtlas` consumed by the
 * bake. `texture` carries the RGBA pixel buffer + dimensions (the package's
 * `ImageData`-shaped texture, but reduced to POD so the bake stays
 * environment-agnostic for testing).
 */
export interface BakeAtlas {
  readonly texture: { readonly width: number; readonly height: number; readonly data: Uint8Array };
  readonly glyphs: readonly BakeGlyph[];
  readonly metrics: { readonly lineHeight: number; readonly ascender: number };
  readonly textureSize: readonly [number, number];
  readonly fieldRange: number;
}

/**
 * The bake-time MSDF generator contract. Injected into {@link bakeFont} so
 * unit tests can supply a mock (real path: `@zappar/msdf-generator`'s `MSDF`).
 */
export interface MsdfGenerator {
  generateAtlas(ttf: Uint8Array): Promise<BakeAtlas>;
  dispose(): Promise<void>;
}

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
export interface BakeSidecar {
  readonly schemaVersion: string;
  readonly kind: 'external-asset-package';
  readonly importer: 'font';
  readonly source: string;
  readonly importSettings: { readonly colorSpace: 'linear'; readonly mipmap: 'none' };
  readonly common: {
    readonly lineHeight: number;
    readonly base: number;
    readonly distanceRange: number;
    readonly pxRange: number;
    readonly atlasWidth: number;
    readonly atlasHeight: number;
  };
  readonly glyphs: Record<number, GlyphMetric>;
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

/** CRC-32 (PNG / zlib polynomial) over a byte slice. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] ?? 0;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3),
  ]);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(body, 4);
  dv.setUint32(4 + body.length, crc32(body));
  return out;
}

/**
 * Encode an RGBA pixel buffer into a PNG (zlib deflate, no external deps).
 * The atlas texture from @zappar is RGBA8; this writes a standard 8-bit
 * RGBA PNG so any consumer (engine image importer / browser) can decode it.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  // Filter byte 0 (None) prefixes each scanline.
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(idat)),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
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
 * Real @zappar/msdf-generator factory. Dynamically imported so a non-bake
 * subcommand (or a test that injects a mock) never pays the wasm load cost,
 * and so the package builds without the browser globals the generator needs.
 */
/**
 * Shape of @zappar/msdf-generator's `MSDFAtlas` (dist/index.d.ts) that the
 * real factory adapts into the POD {@link BakeAtlas}. The package's `texture`
 * is an ImageData-shaped `{ width, height, data }`; we read those fields
 * structurally so the font package never needs the DOM `ImageData` type.
 */
interface ZapparAtlas {
  texture: { width: number; height: number; data: Uint8ClampedArray | Uint8Array };
  glyphs: ReadonlyArray<{
    unicode: number;
    advance: number;
    xoffset: number;
    yoffset: number;
    atlasPosition: [number, number];
    atlasSize: [number, number];
  }>;
  metrics: { lineHeight: number; ascender: number };
  textureSize: [number, number];
  fieldRange: number;
}

export async function realGeneratorFactory(): Promise<MsdfGenerator> {
  const mod = (await import('@zappar/msdf-generator')) as unknown as {
    MSDF: new (config?: {
      workerUrl?: URL;
      wasmUrl?: string;
    }) => {
      initialize(): Promise<void>;
      generateAtlas(opts: {
        font: Uint8Array;
        charset: string;
        textureSize: [number, number];
        fieldRange: number;
        fontSize: number;
      }): Promise<ZapparAtlas>;
      dispose(): Promise<void>;
    };
  };

  const wasmModuleUrl = import.meta.resolve('@zappar/msdf-generator/msdfgen_wasm.wasm');
  const wasmBytes = await readFile(new URL(wasmModuleUrl));
  const wasmUrl = `data:application/octet-stream;base64,${Buffer.from(wasmBytes).toString('base64')}`;
  const nodeGlobal = globalThis as unknown as { Worker?: typeof NodeWorkerAdapter };
  const previousWorker = nodeGlobal.Worker;
  nodeGlobal.Worker = NodeWorkerAdapter;
  let msdf: InstanceType<typeof mod.MSDF> | undefined;
  try {
    msdf = new mod.MSDF({
      workerUrl: new URL('./node-msdf-worker.mjs', import.meta.url),
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

function bakeHelpBody(): string {
  return [
    'forgeax asset import bake — bake MSDF font atlas from TTF',
    '',
    'Usage:',
    '  forgeax asset import bake <ttf> <out>',
    '',
    'Reads a TrueType font file and produces:',
    `  <out>/<basename>.atlas.png   — ${DEFAULT_TEXTURE_SIZE}x${DEFAULT_TEXTURE_SIZE} MSDF atlas`,
    '  <out>/<basename>.meta.json   — glyph metrics sidecar (importer: font)',
    '',
  ].join('\n');
}

function helpBody(): string {
  return [
    'forgeax asset import — MSDF font atlas baking',
    '',
    'Usage:',
    '  forgeax asset import bake <ttf> <out>',
    '',
  ].join('\n');
}

export async function runCliFont(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === '--help' || sub === '-h') {
    process.stdout.write(`${helpBody()}\n`);
    return 0;
  }
  if (sub !== 'bake') {
    process.stderr.write(`unknown subcommand: ${sub}\n`);
    return 1;
  }
  return runBake(rest);
}

async function runBake(rest: string[]): Promise<number> {
  if (rest[0] === '--help' || rest[0] === '-h') {
    process.stdout.write(`${bakeHelpBody()}\n`);
    return 0;
  }
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: rest, allowPositionals: true, strict: true });
    positionals = [...parsed.positionals];
  } catch {
    process.stderr.write('error parsing CLI args\n');
    return 1;
  }
  const ttfPath = positionals[0];
  const outDir = positionals[1];
  if (ttfPath === undefined || outDir === undefined) {
    process.stderr.write('usage: forgeax asset import bake <ttf> <out>\n');
    return 1;
  }
  try {
    const result = await bakeFont(ttfPath, outDir, realGeneratorFactory);
    process.stdout.write(`baked ${result.atlasPath} + ${result.sidecarPath}\n`);
    return 0;
  } catch (e) {
    if (e instanceof FontError) {
      process.stderr.write(
        `${JSON.stringify({ code: e.code, expected: e.expected, hint: e.hint, detail: e.detail })}\n`,
      );
      return 1;
    }
    process.stderr.write(`bake failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

const isBinEntry = await (async (): Promise<boolean> => {
  const argv1 = process.argv[1];
  if (typeof argv1 !== 'string') return false;
  const argv1Real = await realpath(argv1).catch(() => argv1);
  const selfReal = await realpath(fileURLToPath(import.meta.url)).catch(() =>
    fileURLToPath(import.meta.url),
  );
  return argv1Real === selfReal;
})();

if (isBinEntry) {
  const exitCode = await runCliFont(process.argv.slice(2));
  process.exit(exitCode);
}
