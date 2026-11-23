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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { IMAGE_ERROR_EXPECTED, IMAGE_ERROR_HINTS } from '@forgeax/engine-types';
import { type AtlasImageInput, type AtlasRegion, shelfPack } from './shelf-pack.js';

interface AssetCtx {
  readonly stdoutWrite: (line: string) => void;
  readonly stderrWrite: (line: string) => void;
  readonly cwd?: string;
}

interface ErrorEnvelope {
  readonly code: Extract<keyof typeof IMAGE_ERROR_EXPECTED, `atlas-${string}`>;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Record<string, unknown>;
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

async function loadUpng(): Promise<UpngModule> {
  const mod = (await import('upng-js')) as { default?: UpngModule } & UpngModule;
  return (mod.default ?? mod) as UpngModule;
}

interface AtlasArgs {
  readonly input: string;
  readonly name: string;
  readonly output: string;
  readonly maxAtlasSize: number;
}

type AtlasRequest = Pick<AtlasArgs, 'input' | 'name'> &
  Partial<Pick<AtlasArgs, 'output' | 'maxAtlasSize'>>;

const atlasOptions = {
  input: { type: 'string' },
  name: { type: 'string' },
  output: { type: 'string' },
  'max-atlas-size': { type: 'string' },
} as const;

function parseAtlasArgs(rest: string[] | AtlasRequest, cwd: string) {
  try {
    const parse = (args: string[]) =>
      parseArgs({ args, allowPositionals: false, strict: true, options: atlasOptions }).values;
    if (Array.isArray(rest)) {
      const { 'max-atlas-size': size, ...args } = parse(rest);
      return validateAtlasArgs(args, size, cwd);
    }
    const size = rest.maxAtlasSize === undefined ? undefined : String(rest.maxAtlasSize);
    // Preserve the existing command diagnostic for values interpreted as flags.
    for (const [flag, value] of Object.entries({
      input: rest.input,
      name: rest.name,
      output: rest.output,
      'max-atlas-size': size,
    })) {
      if (value !== undefined && value.length > 1 && value.startsWith('-'))
        parse([`--${flag}`, value]);
    }
    return validateAtlasArgs(rest, size, cwd);
  } catch (cause) {
    return { ok: false as const, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

function validateAtlasArgs(
  args: { readonly input?: string; readonly name?: string; readonly output?: string },
  size: string | undefined,
  cwd: string,
): { ok: true; value: AtlasArgs } | { ok: false; message: string } {
  const { input, name, output = cwd } = args;
  if (!input) return { ok: false, message: 'missing required --input <glob>' };
  if (!name) return { ok: false, message: 'missing required --name <prefix>' };
  const maxAtlasSize = size === undefined ? 4096 : Number.parseInt(size, 10);
  if (!Number.isFinite(maxAtlasSize) || maxAtlasSize <= 0)
    return { ok: false, message: '--max-atlas-size must be a positive integer' };
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

function atlasFailure(code: ErrorEnvelope['code'], detail: ErrorEnvelope['detail']) {
  return {
    ok: false as const,
    error: { code, expected: IMAGE_ERROR_EXPECTED[code], hint: IMAGE_ERROR_HINTS[code], detail },
  };
}

function enforceRegionsFit(
  regions: ReadonlyArray<AtlasRegion>,
  atlasWidth: number,
  atlasHeight: number,
  fallbackName: string,
) {
  let regionsTotalPixels = 0;
  for (const r of regions) regionsTotalPixels += r.w * r.h;
  const atlasPixels = atlasWidth * atlasHeight;
  if (regionsTotalPixels <= atlasPixels) return null;
  const offender =
    regions.find((r) => r.x + r.w > atlasWidth || r.y + r.h > atlasHeight) ?? regions[0];
  return atlasFailure('atlas-region-mismatch', {
    name: offender?.name ?? fallbackName,
    regionsTotalPixels,
    atlasPixels,
  });
}

async function writeAtlasArtifacts(
  args: AtlasArgs,
  cwd: string,
  images: ReadonlyArray<AtlasImageInput>,
  upng: UpngModule,
  packed: { atlasWidth: number; atlasHeight: number; regions: ReadonlyArray<AtlasRegion> },
) {
  const { atlasWidth, atlasHeight, regions } = packed;
  const imgByName = new Map<string, AtlasImageInput>();
  for (const img of images) imgByName.set(img.name, img);
  const atlasRgba = blitAtlas(atlasWidth, atlasHeight, imgByName, regions);
  const atlasPng = upng.encode([atlasRgba.buffer as ArrayBuffer], atlasWidth, atlasHeight, 0);
  const outputAbs = isAbsolute(args.output) ? args.output : resolve(cwd, args.output);
  await mkdir(outputAbs, { recursive: true });
  const image = `${args.name}.atlas.png`;
  const metadata = `${args.name}.atlas.meta.json`;
  await writeFile(resolve(outputAbs, image), Buffer.from(atlasPng));
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
  await writeFile(resolve(outputAbs, metadata), `${JSON.stringify(sidecar, null, 2)}\n`, 'utf-8');
  return [image, metadata];
}

/** Execute the atlas producer for callers that already own command output. */
export async function runAtlasCommand(rest: string[] | AtlasRequest, cwd: string) {
  const argsOutcome = parseAtlasArgs(rest, cwd);
  if (!argsOutcome.ok) {
    return {
      ok: false as const,
      error: {
        code: 'atlas-empty-input' as const,
        expected:
          'forgeax asset atlas --input <glob> --name <prefix> [--output <dir>] [--max-atlas-size <n>]',
        hint: argsOutcome.message,
        detail: { receivedCount: 0 },
      },
    };
  }
  const args = argsOutcome.value;

  const { glob } = await import('glob');
  const inputAbs = isAbsolute(args.input) ? args.input : resolve(cwd, args.input);
  // Glob patterns use forward slashes, including on Windows.
  const inputGlob = sep === '/' ? inputAbs : inputAbs.replaceAll(sep, '/');
  const matched = await glob(inputGlob, { absolute: true, nodir: true, follow: true });
  if (matched.length === 0) return atlasFailure('atlas-empty-input', { receivedCount: 0 });

  const upng = await loadUpng();
  const images = await decodePngs(matched, upng);
  const outcome = shelfPack(images, { maxAtlasSize: args.maxAtlasSize });
  if (!outcome.ok) return atlasFailure(outcome.error.code, outcome.error.detail);

  const { atlasWidth, atlasHeight, regions } = outcome.value;
  const regionErr = enforceRegionsFit(regions, atlasWidth, atlasHeight, args.name);
  if (regionErr !== null) return regionErr;

  const artifacts = await writeAtlasArtifacts(args, cwd, images, upng, outcome.value);
  return { ok: true as const, value: { name: args.name, output: args.output, artifacts } };
}

export async function runAtlas(rest: string[], ctx: AssetCtx): Promise<number> {
  const result = await runAtlasCommand(rest, ctx.cwd ?? process.cwd());
  if (result.ok) return 0;
  ctx.stderrWrite(JSON.stringify(result.error));
  return 1;
}
