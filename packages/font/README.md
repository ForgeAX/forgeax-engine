# @forgeax/engine-font

> Build-time MSDF font atlas baking + runtime `FontAsset` plumbing for world-space text. Bake a TTF into an MSDF atlas + glyph-metrics sidecar with `forgeax asset import`; at runtime an AI user spawns a single `GlyphText` authoring component and the engine's `glyphTextLayoutSystem` lays out, bakes a one-mesh-per-segment `MeshAsset`, and attaches `MeshFilter` + `MeshRenderer` so the text rides the standard forward mesh path.

## Evidence and recovery

Font baking is a producer step. Its source meta and bake `CookReceipt` are joined with the catalog `packageUrl`/`cookReceiptUrl` and Pack v2 atlas/metrics artifacts as `AssetEvidence`; runtime text only consumes the resulting payload.

`notCooked` identifies a source declaration without a successful bake. A matching fingerprint is `ready/current`, a changed fingerprint is `ready/stale`, and unavailable evidence is `unknown`; package/artifact checks remain `notChecked`, `passed`, or `failed`. On a failure, follow the structured hint, fix the TTF or bake settings, recook, and rerun `lookup/verify --guid --project --catalog --json` before debugging world-space text.

## One-line spawn = visible (P1)

The whole point of the feature: an AI user never touches a layout asset, a glyph mesh, or a text pipeline. Spawn `GlyphText` + `Transform` and the auto-wired `glyphTextLayoutSystem` (loaded by `createRenderer` / `createApp`) does the rest.

```ts
import { GlyphText } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { FontAsset } from '@forgeax/engine-types';

// 1. DefineComponent already makes components globally usable (no per-World
//    register step). Spawn is direct.
// 2. Load a baked FontAsset (atlas texture + sampler + glyph metrics).
const font = (await engine.assets.loadByGuid<FontAsset>(fontGuid)).unwrap();

// 2. Spawn a world-space label. No mesh, no material, no pipeline -- the
//    glyphTextLayoutSystem bakes a single mesh and attaches MeshFilter +
//    MeshRenderer on the next frame (AC-06 / AC-07). fontSize is in WORLD
//    UNITS (0.05 = a ~5cm-tall cap height at unit scale), not pixels.
world.spawn(
  { component: Transform, data: { pos: [0, 2, 0], quat: [0, 0, 0, 1] } },
  {
    component: GlyphText,
    data: { fontHandle: font, text: 'PLAYER 1', fontSize: 0.05,
            color: [1, 1, 1, 1] },
  },
);
```

`GlyphText` is an **authoring source component** (it does not drive rendering directly). One text entity bakes into exactly **one** `MeshAsset` -> **one** draw call (AC-09); the glyph quads are the mesh vertices, not per-glyph instances. Mutating `text` / `fontSize` / `color` re-bakes the mesh **in place** (`updateMesh`, the registry size stays constant -- AC-08). Multi-line text uses `\n` (AC-21); a missing codepoint renders the `notdef` TOFU glyph (AC-14).

Runnable exemplar: `apps/hello/text` (four scenes -- HUD label, multi-line, HDR-bright/bloom, depth-occluded).

> [!NOTE]
> **How rendering wires up.** `glyphTextLayoutSystem` bakes the glyph mesh and attaches a `MeshRenderer` bound to a per-`(font, tintColor)` cached `forgeax::msdf-text` `MaterialAsset` (atlas texture + sampler + `tintColor` + `distanceRange`; `cullMode: 'none'` because the quad is a camera-facing billboard whose winding flips with view direction). `tintColor` passes HDR values straight through so bright text feeds bloom. The `apps/hello/text` dawn smoke (`scripts/smoke-dawn.mjs`) asserts visible world-space text via a whole-frame text-pixel count behind `TEXT_SMOKE_REQUIRE_VISIBLE`, kept falsifiable by `FALSIFY=atlas-empty` (no atlas -> zero text pixels).

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
| Failure | A generator throw surfaces as `FontError('bake-failed')` (charter P3: no silent fake-success). `@zappar/msdf-generator` runs in a browser Worker (comlink); a Node-only run with no Worker host reports `bake-failed` honestly rather than emitting a placeholder atlas. |

Pure helpers (`bakeFont` / `encodePng` / `atlasToSidecar`) are exported so consumers + tests can drive the bake with an injected `MsdfGenerator` (real `@zappar`; mock in tests).

## Sidecar dispatch + load (build-time -> runtime)

The baked `<font>.meta.json` carries `meta.importer: 'font'` as its top-level `importer` field. The `@forgeax/engine-vite-plugin-pack` build-catalog dispatches the `importer` key to the `'font'` arm, folding the atlas texture row (with `distanceRange` / atlas-size metadata) + glyph rows into `pack-index.json` (AC-03). At runtime:

```ts
const font = (await engine.assets.loadByGuid<FontAsset>(fontGuid)).unwrap();
```

`loadByGuid` fetches the font pack file, recursively resolves the atlas `TextureAsset` + `SamplerAsset` handles, constructs the `FontAsset` POD, and registers it (AC-05). The returned `Handle<'FontAsset','unmanaged'>` narrows to `FontAsset` under `assets.get(handle)` with no `as` cast (AC-17).

The importer keeps the Pack v2 atlas artifact in raw RGBA8 form (`application/octet-stream`), matching the runtime texture loader's non-Basis artifact contract. The standalone CLI still writes a PNG for inspection or external tooling; that PNG is not silently treated as GPU pixel bytes by the Pack v2 runtime path.

## Layout (runtime)

`glyphTextLayoutSystem` (in `@forgeax/engine-runtime`) runs once per frame before the render record:

- left-aligned advance per glyph; baseline at local `y = 0`; `\n` drops the pen by `lineHeight * fontSize` (AC-21).
- bakes a single 12-float-stride `MeshAsset` (`N` chars -> `4N` vertices / `6N` indices) + a conservative orientation-independent cube AABB so `pick()` catches the billboarded text for free (AC-13; `pick.ts` is unchanged).
- D-8 soft ceiling: at most 8 distinct `FontAsset` handles active per frame; the 9th surfaces `TextError('font-concurrency-exceeded')`, `.expected: 8` -- never a silent LRU eviction (AC-20).
- the text material rides the existing `materialShaderId = 'forgeax::msdf-text'` path (transparent bucket + premultiplied blend); no new `pipelineTag` (C3).

## Error model

Two closed unions split by phase (build/load vs runtime layout). **The source files are the SSOT for the member lists** -- read them; this table maps which union owns which phase (F1: no member-list duplication).

| Union | Phase | Source (SSOT) |
|:--|:--|:--|
| `FontErrorCode` | build-time bake + load-time atlas/sampler resolution | `packages/types/src/index.ts` |
| `TextErrorCode` | runtime glyph layout + text rendering | `packages/types/src/index.ts` |

Both surface via the `FontError` / `TextError` classes (four-field `.code` / `.expected` / `.hint` / `.detail`). Consume by `switch (err.code)` -- never by parsing `.message`.

## Dependency boundary

`@zappar/msdf-generator` is a `dependencies` entry but reached only through the CLI / build-time entry (`cli-font.ts`), mirroring `@forgeax/engine-gltf`'s `cli-gltf.ts`. `@forgeax/engine-runtime` does not depend on `@forgeax/engine-font` -- the `FontAsset` POD lives in `@forgeax/engine-types` and the runtime only knows the `Asset` union -- so the generator never enters the runtime bundle (AC-18, D-9).
