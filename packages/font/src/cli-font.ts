// Node-only font producer used by DevKit’s unified asset command and build integrations.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { encodePng } from '@forgeax/engine-image/png';
import { type FontAsset, FontError } from '@forgeax/engine-types';
import { atlasFontData, type BakeAtlas, type MsdfGenerator } from './atlas-font-data.js';
import { generateFontAtlas } from './atlas-generator.js';

export type { BakeAtlas, BakeGlyph, FontAtlasOptions, MsdfGenerator } from './atlas-font-data.js';

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

/** Machine font folders searched for a system font, per platform, in priority order. */
export function systemFontDirs(platform: NodeJS.Platform = process.platform): readonly string[] {
  if (platform === 'darwin')
    return [
      '/System/Library/Fonts/Supplemental',
      '/System/Library/Fonts',
      '/Library/Fonts',
      join(homedir(), 'Library', 'Fonts'),
    ];
  if (platform === 'win32') {
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    const local = process.env.LOCALAPPDATA;
    return local === undefined
      ? [join(root, 'Fonts')]
      : [join(root, 'Fonts'), join(local, 'Microsoft', 'Windows', 'Fonts')];
  }
  return [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    join(homedir(), '.local', 'share', 'fonts'),
    join(homedir(), '.fonts'),
  ];
}

const normalizeFontName = (name: string) =>
  name
    .replace(/\.ttf$/i, '')
    .replace(/[\s_-]+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * Resolve a machine-installed font by its name (`DIN Condensed Bold`, with or
 * without the `.ttf` suffix) to a TrueType file path. Returns undefined when no
 * installed file matches. Node-only: reads the standard system font folders.
 */
export async function resolveSystemFont(
  name: string,
  dirs: readonly string[] = systemFontDirs(),
): Promise<string | undefined> {
  const wanted = normalizeFontName(name);
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of await readdir(dir)) {
      if (!/\.ttf$/i.test(file)) continue;
      if (normalizeFontName(file) === wanted) return join(dir, file);
    }
  }
  return undefined;
}

/** Run a command and return its trimmed stdout, or undefined on any failure. */
function runQuery(
  file: string,
  args: readonly string[],
  timeout = 120_000,
): Promise<string | undefined> {
  return new Promise((resolve) =>
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : stdout.trim() || undefined),
    ),
  );
}

/** macOS: CoreText's system UI font (SF) via a tiny Swift script in a temp folder. */
async function darwinDefaultFont(): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'forgeax-default-font-'));
  const script = join(dir, 'default-font.swift');
  try {
    await writeFile(
      script,
      'import CoreText\nimport Foundation\nlet f = CTFontCreateUIFontForLanguage(.system, 13, nil)!\nprint((CTFontCopyAttribute(f, kCTFontURLAttribute) as? URL)?.path ?? "")\n',
    );
    return await runQuery('swift', [script]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Linux: fontconfig's default sans-serif match (`fc-match`). */
async function linuxDefaultFont(): Promise<string | undefined> {
  return runQuery('fc-match', ['-f', '%{file}', 'sans-serif']);
}

/** Windows: the Segoe UI face that the shell uses for UI text. */
function windowsDefaultFont(): string | undefined {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  return join(root, 'Fonts', 'segoeui.ttf');
}

/**
 * The machine's default UI font file, asked of the OS on each platform
 * (macOS: CoreText system font; Linux: fontconfig sans-serif; Windows: Segoe UI).
 * Nothing is hard-coded per game. Returns undefined when the query fails or
 * yields no existing TrueType file; callers then pass an explicit path or name.
 */
export async function resolveDefaultSystemFont(
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  let path: string | undefined;
  if (platform === 'darwin') path = await darwinDefaultFont();
  else if (platform === 'win32') path = windowsDefaultFont();
  else if (platform === 'linux') path = await linuxDefaultFont();
  return path !== undefined && existsSync(path) && /\.ttf$/i.test(path) ? path : undefined;
}

/** Resolve a bake source: an existing file path first, then an installed font name. */
export async function resolveFontSource(source: string): Promise<string> {
  if (existsSync(source)) return source;
  const found = await resolveSystemFont(source);
  if (found !== undefined) return found;
  throw new FontError({
    code: 'unsupported-font-format',
    expected: 'a .ttf path or an installed font name',
    hint: `no file at "${source}" and no installed TrueType font with that name; pass a .ttf path or an installed font name`,
    detail: { source },
  });
}

/**
 * Bake an MSDF atlas + glyph-metrics sidecar from a TTF.
 *
 * @param source TrueType path, or an installed font name (see resolveFontSource).
 * @param outDir output directory (created if missing).
 * @param generatorFactory yields the MSDF generator (real: @zappar; tests: mock).
 * @returns `Result`-style: throws a {@link FontError} on every failure mode
 *   (unsupported-font-format before the generator runs; bake-failed when the
 *   generator throws). The CLI layer maps the thrown FontError to a structured
 *   stderr line + exit code 1 -- never a silent exit 0 without artefacts
 *   (charter P3).
 */
export async function bakeFont(
  source: string,
  outDir: string,
  generatorFactory?: () => Promise<MsdfGenerator>,
): Promise<BakeResult> {
  const ttfPath = await resolveFontSource(source);
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

  const atlas = await generateFontAtlas(ttfBytes, generatorFactory);

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
