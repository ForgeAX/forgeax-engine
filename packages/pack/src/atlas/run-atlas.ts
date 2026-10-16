// `forgeax asset atlas` subcommand backend
// (feat-20260521-sprite-atlas-animation M5' T-32). Replaces the v1 vite-
// plugin idiom (PR #190 deleted `@forgeax/engine-vite-plugin-image`) with
// a one-shot Node CLI that reads a glob of PNGs, runs the pure shelf
// packer, blits the decoded RGBA into a single atlas buffer and writes
// `<output>/<name>.atlas.png` + `<output>/<name>.atlas.meta.json` sidecar.
//
// Why CLI not Vite plugin (PR #190 architectural pivot):
//   - asset importing is producer-side disk work; v2 routes the producer
//     through the unified `forgeax asset atlas` producer so the
//     same surface composes with `scan` / `lookup` / `verify` (charter P5
//     producer/consumer split).
//   - vite plugins reach for runtime-coupled hooks (buildStart / emitFile);
//     a one-shot CLI keeps the producer free of bundler lifecycle deps and
//     can be invoked from any build system (vite / rolldown / esbuild /
//     plain pnpm script) without rewiring.
//
// Error taxonomy (plan-strategy section 2 D-2 + ImageErrorCode union SSOT
// in `@forgeax/engine-types`):
//   - 'atlas-empty-input'    -> { receivedCount }
//   - 'atlas-size-exceeded'  -> { name, width, height, maxAtlasSize }
//   - 'atlas-region-mismatch'-> { name, regionsTotalPixels, atlasPixels }
//
// We compose the structured error envelope locally (3 expected literals
// hard-coded) instead of reaching for `ImageErrorImpl` from
// `@forgeax/engine-image` because that package already depends on
// `@forgeax/engine-pack` (creating a circular dep would block both
// builds). The hint copy comes from `IMAGE_ERROR_HINTS` in
// `@forgeax/engine-types` so the AI-user copy stays single-sourced.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { IMAGE_ERROR_HINTS } from '@forgeax/engine-types';
import {
  type AtlasImageInput,
  type AtlasRegion,
  type ShelfPackOutcome,
  shelfPack,
} from './shelf-pack.js';

interface AssetCtx {
  readonly stdoutWrite: (line: string) => void;
  readonly stderrWrite: (line: string) => void;
  readonly cwd?: string;
}

const ATLAS_EXPECTED = {
  'atlas-empty-input': 'images.length >= 1',
  'atlas-size-exceeded':
    'image width x height <= maxAtlasSize^2 and each image fits in the atlas footprint',
  'atlas-region-mismatch': 'sum(regions[i].w x regions[i].h) <= atlasWidth x atlasHeight',
} as const;

interface ErrorEnvelope {
  readonly code: keyof typeof ATLAS_EXPECTED;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Record<string, unknown>;
}

function emitError(ctx: AssetCtx, env: ErrorEnvelope): number {
  ctx.stderrWrite(
    JSON.stringify({
      code: env.code,
      expected: env.expected,
      hint: env.hint,
      detail: env.detail,
    }),
  );
  return 1;
}

interface UpngDecoded {
  width: number;
  height: number;
  depth: number;
  ctype: number;
  data: Uint8Array;
  frames?: unknown[];
}

interface UpngModule {
  decode: (bytes: Uint8Array | ArrayBuffer) => UpngDecoded;
  toRGBA8: (img: UpngDecoded) => ArrayBuffer[];
  encode: (imgs: ArrayBuffer[], w: number, h: number, cnum: number) => ArrayBuffer;
}

type FastGlobFn = (
  patterns: string | readonly string[],
  options?: { absolute?: boolean; cwd?: string },
) => Promise<string[]>;

async function loadUpng(): Promise<UpngModule> {
  const mod = (await import('upng-js')) as { default?: UpngModule } & UpngModule;
  return (mod.default ?? mod) as UpngModule;
}

async function loadFastGlob(): Promise<FastGlobFn> {
  const mod = (await import('fast-glob')) as unknown as { default: FastGlobFn };
  return mod.default;
}

interface AtlasArgs {
  readonly input: string;
  readonly name: string;
  readonly output: string;
  readonly maxAtlasSize: number;
}

function parseAtlasArgs(
  rest: string[],
  cwd: string,
):
  | { ok: true; value: AtlasArgs }
  | {
      ok: false;
      message: string;
    } {
  let parsed:
    | {
        values: {
          input?: string;
          name?: string;
          output?: string;
          'max-atlas-size'?: string;
        };
      }
    | undefined;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        input: { type: 'string' },
        name: { type: 'string' },
        output: { type: 'string' },
        'max-atlas-size': { type: 'string' },
      },
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  const input = parsed.values.input;
  const name = parsed.values.name;
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, message: 'missing required --input <glob>' };
  }
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, message: 'missing required --name <prefix>' };
  }
  const output = typeof parsed.values.output === 'string' ? parsed.values.output : cwd;
  const maxRaw = parsed.values['max-atlas-size'];
  const maxAtlasSize = typeof maxRaw === 'string' ? Number.parseInt(maxRaw, 10) : 4096;
  if (!Number.isFinite(maxAtlasSize) || maxAtlasSize <= 0) {
    return { ok: false, message: '--max-atlas-size must be a positive integer' };
  }
  return { ok: true, value: { input, name, output, maxAtlasSize } };
}

function nameFromPath(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  return ext.length > 0 ? base.slice(0, -ext.length) : base;
}

async function decodePngs(paths: readonly string[], upng: UpngModule): Promise<AtlasImageInput[]> {
  const out: AtlasImageInput[] = [];
  for (const p of paths) {
    const bytes = await readFile(p);
    const decoded = upng.decode(bytes);
    const rgbaFrames = upng.toRGBA8(decoded);
    const first = rgbaFrames[0];
    if (first === undefined) {
      throw new Error(`upng-js produced no RGBA frame for ${p}`);
    }
    out.push({
      name: nameFromPath(p),
      width: decoded.width,
      height: decoded.height,
      pixels: new Uint8Array(first),
    });
  }
  return out;
}

function blitAtlas(
  atlasWidth: number,
  atlasHeight: number,
  images: ReadonlyMap<string, AtlasImageInput>,
  regions: ReadonlyArray<AtlasRegion>,
): Uint8Array {
  const out = new Uint8Array(atlasWidth * atlasHeight * 4);
  for (const r of regions) {
    const src = images.get(r.name);
    if (src === undefined) continue;
    for (let row = 0; row < r.h; row++) {
      const srcOff = row * src.width * 4;
      const dstOff = ((r.y + row) * atlasWidth + r.x) * 4;
      out.set(src.pixels.subarray(srcOff, srcOff + r.w * 4), dstOff);
    }
  }
  return out;
}

function emitSizeExceeded(
  ctx: AssetCtx,
  detail: { name: string; width: number; height: number; maxAtlasSize: number },
): number {
  return emitError(ctx, {
    code: 'atlas-size-exceeded',
    expected: ATLAS_EXPECTED['atlas-size-exceeded'],
    hint: IMAGE_ERROR_HINTS['atlas-size-exceeded'],
    detail,
  });
}

function emitEmptyInput(ctx: AssetCtx, receivedCount: number): number {
  return emitError(ctx, {
    code: 'atlas-empty-input',
    expected: ATLAS_EXPECTED['atlas-empty-input'],
    hint: IMAGE_ERROR_HINTS['atlas-empty-input'],
    detail: { receivedCount },
  });
}

function enforceMaxSize(
  images: ReadonlyArray<AtlasImageInput>,
  maxAtlasSize: number,
  ctx: AssetCtx,
): number | null {
  for (const img of images) {
    if (img.width > maxAtlasSize || img.height > maxAtlasSize) {
      return emitSizeExceeded(ctx, {
        name: img.name,
        width: img.width,
        height: img.height,
        maxAtlasSize,
      });
    }
  }
  return null;
}

type ShelfPackErrorValue = Extract<ShelfPackOutcome, { ok: false }>['error'];

function emitFromShelfPackError(
  error: ShelfPackErrorValue,
  fallbackMax: number,
  ctx: AssetCtx,
): number {
  if (error.code === 'atlas-empty-input') {
    return emitEmptyInput(ctx, error.detail.receivedCount ?? 0);
  }
  return emitSizeExceeded(ctx, {
    name: error.detail.name ?? '',
    width: error.detail.width ?? 0,
    height: error.detail.height ?? 0,
    maxAtlasSize: error.detail.maxAtlasSize ?? fallbackMax,
  });
}

function enforceRegionsFit(
  regions: ReadonlyArray<AtlasRegion>,
  atlasWidth: number,
  atlasHeight: number,
  fallbackName: string,
  ctx: AssetCtx,
): number | null {
  let regionsTotalPixels = 0;
  for (const r of regions) regionsTotalPixels += r.w * r.h;
  const atlasPixels = atlasWidth * atlasHeight;
  if (regionsTotalPixels <= atlasPixels) return null;
  const offender =
    regions.find((r) => r.x + r.w > atlasWidth || r.y + r.h > atlasHeight) ?? regions[0];
  return emitError(ctx, {
    code: 'atlas-region-mismatch',
    expected: ATLAS_EXPECTED['atlas-region-mismatch'],
    hint: IMAGE_ERROR_HINTS['atlas-region-mismatch'],
    detail: {
      name: offender?.name ?? fallbackName,
      regionsTotalPixels,
      atlasPixels,
    },
  });
}

async function writeAtlasArtifacts(
  args: AtlasArgs,
  cwd: string,
  images: ReadonlyArray<AtlasImageInput>,
  upng: UpngModule,
  packed: { atlasWidth: number; atlasHeight: number; regions: ReadonlyArray<AtlasRegion> },
): Promise<void> {
  const { atlasWidth, atlasHeight, regions } = packed;
  const imgByName = new Map<string, AtlasImageInput>();
  for (const img of images) imgByName.set(img.name, img);
  const atlasRgba = blitAtlas(atlasWidth, atlasHeight, imgByName, regions);
  const atlasPng = upng.encode([atlasRgba.buffer as ArrayBuffer], atlasWidth, atlasHeight, 0);
  const outputAbs = isAbsolute(args.output) ? args.output : resolve(cwd, args.output);
  await mkdir(outputAbs, { recursive: true });
  await writeFile(resolve(outputAbs, `${args.name}.atlas.png`), Buffer.from(atlasPng));
  const sidecar = {
    name: args.name,
    atlasWidth,
    atlasHeight,
    regions: regions.map((r) => ({
      name: r.name,
      uMin: r.x / atlasWidth,
      vMin: r.y / atlasHeight,
      uW: r.w / atlasWidth,
      vH: r.h / atlasHeight,
    })),
  };
  await writeFile(
    resolve(outputAbs, `${args.name}.atlas.meta.json`),
    `${JSON.stringify(sidecar, null, 2)}\n`,
    'utf-8',
  );
}

export async function runAtlas(rest: string[], ctx: AssetCtx): Promise<number> {
  const cwd = ctx.cwd ?? process.cwd();
  const argsOutcome = parseAtlasArgs(rest, cwd);
  if (!argsOutcome.ok) {
    return emitError(ctx, {
      code: 'atlas-empty-input',
      expected:
        'forgeax asset atlas --input <glob> --name <prefix> [--output <dir>] [--max-atlas-size <n>]',
      hint: argsOutcome.message,
      detail: { receivedCount: 0 },
    });
  }
  const args = argsOutcome.value;

  const fastGlob = await loadFastGlob();
  const inputAbs = isAbsolute(args.input) ? args.input : resolve(cwd, args.input);
  // Normalize to forward slashes for fast-glob (it requires POSIX-style paths).
  const inputGlob = sep === '/' ? inputAbs : inputAbs.replaceAll(sep, '/');
  const matched = await fastGlob(inputGlob, { absolute: true });
  if (matched.length === 0) return emitEmptyInput(ctx, 0);

  const upng = await loadUpng();
  const images = await decodePngs(matched, upng);
  const sizeErr = enforceMaxSize(images, args.maxAtlasSize, ctx);
  if (sizeErr !== null) return sizeErr;

  const outcome = shelfPack(images, { maxAtlasSize: args.maxAtlasSize });
  if (!outcome.ok) return emitFromShelfPackError(outcome.error, args.maxAtlasSize, ctx);

  const { atlasWidth, atlasHeight, regions } = outcome.value;
  const regionErr = enforceRegionsFit(regions, atlasWidth, atlasHeight, args.name, ctx);
  if (regionErr !== null) return regionErr;

  await writeAtlasArtifacts(args, cwd, images, upng, { atlasWidth, atlasHeight, regions });
  return 0;
}
