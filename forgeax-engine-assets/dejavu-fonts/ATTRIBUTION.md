# DejaVu Fonts — Attribution

This `dejavu-fonts/` vendor namespace contains a baked MSDF atlas + glyph metrics
derived from the upstream **DejaVu Sans Mono** TrueType font.

## Provenance

| Field | Value |
|:--|:--|
| Upstream | [dejavu-fonts/dejavu-fonts](https://github.com/dejavu-fonts/dejavu-fonts) |
| Release | [version_2_37](https://github.com/dejavu-fonts/dejavu-fonts/releases/tag/version_2_37) |
| Tarball | `dejavu-fonts-ttf-2.37.tar.bz2` |
| TTF SHA-256 | (regenerate locally: `shasum -a 256 DejaVuSansMono.ttf`) |
| Vendor date | 2026-06-10 |
| Vendor commit | tweak-20260610-hello-text-real-msdf-bake |

## License

The DejaVu fonts are licensed under the **Bitstream Vera license + Arev license**
extension (a permissive, OFL-1.1-compatible style; see `LICENSE`). DejaVu does
not formally use OFL 1.1, but the license terms are functionally equivalent for
our purposes (free redistribution, modification, embedding in software products
without restriction). This is a vendor carve-out from the
`forgeax-engine-assets/` top-level Apache-2.0 license; see
`forgeax-engine-assets/README.md §License`.

## Scope

| File | Purpose |
|:--|:--|
| `DejaVuSansMono.ttf` | Source-of-truth TrueType font, retained so future re-bakes are reproducible. |
| `DejaVuSansMono.atlas.png` | 512×512 RGBA8 MSDF atlas baked offline via `@zappar/msdf-generator@1.2.4`. ASCII printable charset (0x20–0x7e, 94 codepoints + space). Color space **linear** (the R/G/B channels carry signed-distance fields, never gamma). |
| `DejaVuSansMono.atlas.png.meta.json` | image-arm sidecar (`importer: 'image'`). |
| `DejaVuSansMono.font.pack.json` | legacy `internal-text-package` arm; carries the FontAsset payload (`atlasGuid` / `samplerGuid` / `glyphs` / `common`) consumed directly by `loadFontAsset`. |

## Bake reproducibility

These artifacts were baked **once** through `@zappar/msdf-generator@1.2.4` in a
chromium browser (the generator requires a Web Worker host; node has none).
The bake driver used for this initial bake (`apps/hello/text/bake-msdf.html`)
was a one-shot scaffold and was **not committed** — it is not recoverable from
git history. **Re-bake is only needed when the charset or font version changes**;
the artifacts in this directory are the SSOT for the runtime.

To re-bake from scratch (development machine, requires chromium browser):

1. Author a small ESM HTML page that:
   - imports `MSDF` from `@zappar/msdf-generator@1.2.4`,
   - fetches the source TTF as `Uint8Array`,
   - calls `msdf.generateAtlas({ font, charset: <ASCII 0x20–0x7e>, textureSize: [512, 512], fieldRange: 4, fontSize: 48 })`,
   - PNG-encodes `atlas.texture` (RGBA8 width×height) via canvas `toBlob`,
   - serialises the glyph metrics through the same `BMFont → FontAsset` mapping
     that `packages/font/src/cli-font.ts:atlasToSidecar` performs (compute
     `glyphs[unicode] = { advance, bearingX, bearingY, size, region }` from
     each `atlas.glyphs[i]`).
2. Add `@zappar/msdf-generator@1.2.4` as a temporary devDependency to whatever
   workspace serves the HTML, run the page in vite dev (or `playwright-cli` /
   any chromium driver) to capture the atlas PNG bytes + glyph metrics JSON.
3. Open this directory's `DejaVuSansMono.font.pack.json` and `.atlas.png.meta.json`
   to reuse the existing GUIDs (idempotency: GUIDs in sidecars are the SSOT,
   re-bakes preserve them so demo / smoke `FONT_GUID` / `ATLAS_GUID` /
   `SAMPLER_GUID` literals don't need updating).
4. Overwrite `DejaVuSansMono.atlas.png` with the new PNG bytes; rewrite
   `glyphs` and `common` blocks inside `DejaVuSansMono.font.pack.json`
   `assets[0].payload` (preserve `atlasGuid` / `samplerGuid`).
5. Remove the temporary HTML driver and devDependency.

The original one-shot driver pattern is preserved in
`.forgeax-harness/forgeax-loop/tweak-20260610-hello-text-real-msdf-bake/implement-decisions.md`
under §Bake driver pattern, for future maintainers who want the literal HTML.

Three GUIDs (`FONT_GUID` / `ATLAS_GUID` / `SAMPLER_GUID`) live in
`DejaVuSansMono.font.pack.json` + `.atlas.png.meta.json`. They MUST be preserved
across re-bakes (the demo + smoke hard-code them; rotating GUIDs would be a
breaking change requiring updates in `apps/hello/text/src/text-scenes.ts` and
`apps/hello/text/scripts/smoke-dawn.mjs`).

## Charset

ASCII printable: `0x20` (space) through `0x7e` (`~`), 95 codepoints. The bake
script's `CHARSET` constant (`apps/hello/text/bake-msdf.html`) is the single
source of truth.

> Non-ASCII codepoints (Latin-1 Supplement, CJK, Cyrillic, etc.) are NOT baked.
> Adding them requires a follow-on loop with charset extension + atlas re-bake.
