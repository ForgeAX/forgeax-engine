// Node-only font producer used by DevKit’s unified asset command and build integrations.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { encodePng } from '@forgeax/engine-image/png';
import { type FontAsset, FontError } from '@forgeax/engine-types';
import { atlasFontData, type BakeAtlas, type MsdfGenerator } from './atlas-font-data.js';
import { generateFontAtlas } from './atlas-generator.js';

export type { BakeAtlas, BakeGlyph, MsdfGenerator } from './atlas-font-data.js';

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
  generatorFactory?: () => Promise<MsdfGenerator>,
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
