// font-importer.ts - the build-time fontImporter (feat-20260603-asset-import-loader-injection M3 / w24).
//
// The `{ key: 'font', import }` Importer the @forgeax/engine-import runner
// dispatches a `*.meta.json` with `importer: 'font'` to. It absorbs the MSDF
// bake that previously lived only behind the `forgeax asset import
// bake` CLI: read the `.ttf` source -> @zappar/msdf-generator atlas ->
// (a) one atlas `TextureAsset` ImportedAsset (the RGBA MSDF atlas, kind
// 'texture') under the declared `kind: 'texture'` sub-asset GUID, (b) one
// sampler ImportedAsset under the declared `kind: 'sampler'` sub-asset GUID,
// and (c) one font glyph-metrics ImportedAsset (kind 'font') under the
// declared `kind: 'font'` sub-asset GUID. The font carries the BMFont ->
// FontAsset glyph map + the common block + atlas/sampler GUID refs.
//
// Build-time-only boundary (AC-18 / requirements callout): @zappar/msdf-generator
// is a generator dependency that MUST stay out of the runtime bundle. The
// runtime today statically imports ZERO @forgeax/engine-font and ZERO @zappar
// symbols (research Finding 7); this importer keeps that invariant. fontImporter
// is a NODE-ONLY sub-export (`@forgeax/engine-font/font-importer`,
// `default: null` under browser conditions); the generator is dynamically
// imported (cli-font realGeneratorFactory) so even the build-time graph only
// pays the wasm load cost when a font is actually baked. The runtime fontLoader
// (M1 w6) reads an already-baked atlas DDC and has no bake dependency.
//
// GUID import-stable iron law: produced GUIDs come from `ctx.subAssets[]`. The
// font sidecar declares `texture`, `sampler`, and `font` sub-assets; this
// importer maps the bake output onto those declared GUIDs and stamps nothing
// of its own.
//
// `ctx.importSettings` may inject a test `generatorFactory` (an
// `() => Promise<MsdfGenerator>`) so unit tests drive the bake with a mock
// instead of the real wasm generator; production import calls fall through to
// the real @zappar factory.

import type {
  FontAsset,
  ImportContext,
  ImportedAsset,
  Importer,
  ImportResult,
  SamplerAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import { atlasFontData } from './atlas-font-data.js';
import type { BakeAtlas, MsdfGenerator } from './cli-font.js';
import { realGeneratorFactory } from './cli-font.js';

/** Stable semantic identities for the three writable font outputs. */
export function sourceKeyForFontOutput(kind: string): string | undefined {
  const normalizedKind = kind.trim();
  return normalizedKind.length === 0 ? undefined : `font:${normalizedKind}`;
}

export function fontOutputSourceKeys(): readonly string[] {
  return ['texture', 'sampler', 'font'].map((kind) => sourceKeyForFontOutput(kind) as string);
}

function makeAtlasTexture(atlas: BakeAtlas): TextureAsset {
  return {
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width: atlas.texture.width, height: atlas.texture.height },
    },
    // MSDF atlas is linear-space RGBA8 (signed-distance channels, never gamma).
    format: 'rgba8unorm',
    data: atlas.texture.data,
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
}

function makeAtlasSampler(): SamplerAsset {
  return {
    kind: 'sampler',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'nearest',
  };
}

async function importFont(ctx: ImportContext): Promise<ImportResult> {
  const read = await ctx.readSource();
  if (!read.ok) {
    throw new Error(
      `fontImporter: readSource failed: ${read.error instanceof Error ? read.error.message : String(read.error)}`,
    );
  }

  const factory =
    (ctx.importSettings.generatorFactory as (() => Promise<MsdfGenerator>) | undefined) ??
    realGeneratorFactory;
  const generator = await factory();
  let atlas: BakeAtlas;
  try {
    atlas = await generator.generateAtlas(read.value);
  } finally {
    await generator.dispose().catch(() => undefined);
  }

  const atlasSub = ctx.subAssets.find((s) => s.kind === 'texture');
  const samplerSub = ctx.subAssets.find((s) => s.kind === 'sampler');
  const fontSub = ctx.subAssets.find((s) => s.kind === 'font');
  const out: ImportedAsset[] = [];
  if (atlasSub !== undefined) {
    out.push({
      guid: atlasSub.guid,
      kind: 'texture',
      payload: makeAtlasTexture(atlas),
      refs: [],
      artifacts: {
        atlas: {
          // Pack v2's runtime texture loader consumes non-Basis artifacts as
          // raw pixels. Keep the baked RGBA8 MSDF atlas in that form here;
          // the CLI still emits a PNG for standalone bake output.
          mediaType: 'application/octet-stream',
          bytes: atlas.texture.data,
        },
      },
    });
  }
  if (samplerSub !== undefined) {
    out.push({
      guid: samplerSub.guid,
      kind: 'sampler',
      payload: makeAtlasSampler(),
      refs: [],
      artifacts: {},
    });
  }
  if (fontSub !== undefined) {
    // The runtime font loader reads atlasGuid / samplerGuid / glyphs / common
    // off the DDC payload (asset-registry loadFontAsset); the produced payload
    // mirrors that shape. atlas Handle / sampler Handle are runtime-resolved
    // from the GUID refs, so the build-time payload carries the GUID strings
    // (cast through FontAsset for the ImportedAsset.payload Asset slot, same
    // build-time POD-vs-Handle bridge the gltfImporter scene arm uses).
    const fontPayload = {
      kind: 'font',
      atlasGuid: atlasSub?.guid ?? '',
      samplerGuid: samplerSub?.guid ?? '',
      ...atlasFontData(atlas),
    } as unknown as FontAsset;
    out.push({
      guid: fontSub.guid,
      kind: 'font',
      payload: fontPayload,
      refs: [
        ...(atlasSub !== undefined ? [{ guid: atlasSub.guid }] : []),
        ...(samplerSub !== undefined ? [{ guid: samplerSub.guid }] : []),
      ],
      artifacts: {},
    });
  }
  return { ok: true, value: { assets: out, sourceDependencies: [] } };
}

/**
 * The font {@link Importer}. Register it into an `ImporterRegistry` so the
 * import runner dispatches `meta.importer === 'font'` sidecars here.
 *
 * @example
 * ```ts
 * import { ImporterRegistry } from '@forgeax/engine-import';
 * import { fontImporter } from '@forgeax/engine-font/font-importer';
 * const importers = new ImporterRegistry();
 * importers.register(fontImporter);
 * ```
 */
export const fontImporter: Importer = {
  key: 'font',
  import: importFont,
};
