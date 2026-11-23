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
| `DejaVuSansMono.font.pack.json` | v3 source Pack containing `font/mono` and `sampler/atlas`. The Font names the atlas and sampler GUIDs alongside its glyph metrics. |

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
3. Preserve the Pack `packageId` and output keys `font/mono` and `sampler/atlas`.
   These derive the existing Font and Sampler GUIDs. Keep the atlas GUID in
   `DejaVuSansMono.atlas.png.meta.json`.
4. Replace `DejaVuSansMono.atlas.png` and update `glyphs` and `common` in
   `assets["font/mono"].payload` in `DejaVuSansMono.font.pack.json`.
5. Remove the temporary HTML driver and devDependency.

The original one-shot driver pattern is preserved in
`.forgeax-harness/forgeax-loop/tweak-20260610-hello-text-real-msdf-bake/implement-decisions.md`
under §Bake driver pattern, for future maintainers who want the literal HTML.

The atlas GUID stays in the image Meta. The Font and Sampler GUIDs derive from
one Pack identity and their stable output keys. Changing the atlas pixels or
metrics does not change those identities.

## Charset

ASCII printable: `0x20` (space) through `0x7e` (`~`), 95 codepoints. The bake
script's `CHARSET` constant (`apps/hello/text/bake-msdf.html`) is the single
source of truth.

> Non-ASCII codepoints (Latin-1 Supplement, CJK, Cyrillic, etc.) are NOT baked.
> Adding them requires a follow-on loop with charset extension + atlas re-bake.
