# @forgeax/engine-font

Build-time MSDF atlas baking and the runtime Font decoder. A game binds one managed Font to `GlyphText`; the Renderer consumes the Font's current metrics and atlas without creating extra World components or derived assets.

## Runtime use

```ts
import { GlyphText } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';

const font = (await engine.assets.load(fontGuid, 'font')).unwrap();
world.spawn(
  { component: Transform, data: { pos: [0, 2, 0] } },
  { component: GlyphText, data: {
    fontHandle: font, text: 'PLAYER 1', fontSize: 0.05, color: [1, 1, 1, 1],
  } },
).unwrap();
```

`fontSize` scales the Font's metric units. Text faces the camera around its world-space anchor. `color` is linear RGBA and accepts HDR values for Bloom. Newlines advance by `lineHeight`; missing codepoints use `notdef` when supplied.

Font `atlas` and `sampler` are source GUIDs in Pack data and managed references after runtime admission. Their lifetime belongs to the Font's asset closure. Use `assets.update(font, patch)` or the managed edit API to change metrics, atlas binding or layout defaults; the owner validates and publishes one automatic content change. Updating the atlas Texture alone changes its next rendering without rebuilding glyph positions.

## Runtime ownership and performance

- The World retains only `GlyphText` and ordinary Scene transforms. The Renderer never attaches `MeshFilter` or `MeshRenderer` to a label.
- Asset adoption visits changed Font roots, independent of label count. It has no Font-to-label index, per-label publication or full-World dirty scan.
- Actual view consumption lays out text against a fixed Font version. Equal Font/text/size layouts share geometry; tint edits retain it. Each Font's layout cache is bounded by 16 MiB, and renderer GPU layout residency retains up to 256 current entries.
- Text uses the ordinary MSDF material pipeline and render-local numeric projection. It creates no Material asset identities. Old layouts and current layouts may coexist in one GPU submission; eviction retires buffers behind that submission's fence.
- Worker publications carry the label facts and Font dependency closure. The receiving Renderer derives local layout. A Font-only edit sends no label upserts.
- AABB, triangle and vertex picking use the same layout kernel and current Font content. Exact queries apply the rendered billboard basis. Layouts exceeding 16,384 glyphs select 32-bit indices.

There is no arbitrary simultaneous-Font cap. Runtime failures use `TextError`; invalid asset references and metric data fail at asset admission.

## Bake (build-time)

The bake pipeline reads a TTF and produces a `1024x1024` MSDF atlas PNG + a glyph-metrics sidecar (per-glyph uv / size / bearing / advance + a `distanceRange`).

```bash
# The unified asset producer selects the font importer by extension.
forgeax asset import <font.ttf> --root ./game --json
```

| Stage | Detail |
|:--|:--|
| Input | A `.ttf` file. Non-TTF input (OTF / WOFF2) fail-fasts with `FontError('unsupported-font-format')`, `.expected: 'ttf'` (AC-15). |
| Generator | `@zappar/msdf-generator@1.2.4` (MIT; bundled msdfgen WASM). **Build-time-only dependency** -- never imported by the runtime `export` surface, so it stays out of the runtime bundle (AC-18). |
| Output | Atlas PNG + sidecar JSON. The sidecar carries `distanceRange` + per-glyph metrics (1:1 BMFont char-block mapping: `advance <- xadvance`, `bearingX <- xoffset`, `bearingY <- yoffset`, `size <- width/height`, `region <- x/y/w/h`). |
| Failure | A generator throw surfaces as `FontError('bake-failed')` (charter P3: no silent fake-success). The default generator uses the package-owned Node Worker adapter; initialization and bake failures retain structured diagnostics and dispose the acquired generator. |

Build-time helpers (`bakeFont` / `atlasToSidecar`) are exported from the Node-only `@forgeax/engine/font/cli-font` module so consumers + tests can drive the bake with an optional injected `MsdfGenerator`. Both producers use the same generator acquisition, atlas production and disposal owner; callers normally omit the factory. The Node Worker substitution is restored immediately after initialization starts, before awaiting it.

## Source and decode boundary

The sidecar dispatches this importer through `meta.importer: 'font'`.
The font importer publishes atlas Texture, Sampler and Font metrics through the ordinary Cook/Catalog chain. The runtime `fontContribution` decoder accepts source GUIDs and validated POD; assets-runtime links and retains their managed references. The importer stores the Pack atlas as raw RGBA8; the standalone CLI may additionally write PNG for inspection.
Loading, edits and source evidence follow the [managed asset contract](../assets-runtime/README.md).

`@zappar/msdf-generator` is reached only through the build-time `cli-font` and `font-importer` entries. Runtime assembly imports the decoder without bringing the generator into the player.

`apps/hello/text` demonstrates labels, multiline text, HDR tint and depth occlusion. Its Dawn smoke requires 60 completed frames and visible glyph pixels; `FALSIFY=atlas-empty` must remove those pixels. Managed runtime tests additionally cover Font-only Worker updates, fixed old/new geometry, GPU eviction and picking.

Atlas PNG output uses Image’s `encodePng`; font baking owns glyph/atlas semantics.
