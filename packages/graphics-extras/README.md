# @forgeax/engine-graphics-extras

Pure glyph layout, tile-bit encoding and runtime video primitives. Rendering and resource ownership stay in Render; this package never imports the Renderer or Runtime.

## Glyph layout

```ts
import { layoutGlyphText, buildGlyphMeshAsset } from '@forgeax/engine-graphics-extras';
const mesh = buildGlyphMeshAsset(layoutGlyphText(font, text, fontSize));
```

`layoutGlyphText` returns `GlyphLayoutResult` directly: canonical attribute arrays, triangle indices and a conservative anchor radius. The pure kernel uses current Font metrics, newline advance and optional `notdef`. It selects 32-bit indices when glyph vertices exceed the 16-bit range. `buildGlyphMeshAsset` packs those arrays through Geometry and supplies submesh metadata and a conservative cube AABB; it performs no asset registration.

Render's native Glyph source uses this kernel during actual view layout. Picking uses it during actual queries. Font publication does not enumerate labels, maintain a global Font cap, or bake World-owned Mesh/Material assets.

| Symbol | Purpose |
|:--|:--|
| `layoutGlyphText(font, text, fontSize)` | Pure geometry layout |
| `buildGlyphMeshAsset(layout)` | Canonical Mesh POD projection |
| `conservativeCubeAabb(radius)` | Billboard-safe local bounds |
| `GlyphLayoutResult` | Vertices, indices and radius |

### tile-bits (from `tile-bits.ts`)

| Symbol | Kind | Notes |
|:--|:--|:--|
| `encodeTileBits(tileId, flipH, flipV, flipDiagonal, ...)` | function | packs a tile cell into a `u32` |
| `decodeTileBits(packed)` | function | `{ tileId, flipH, flipV, flipDiagonal }` |

### video (from `video-player.ts` + `video-player-system.ts` + `video-source-provider.ts` + `video-loader.ts`)

| Symbol | Kind | Notes |
|:--|:--|:--|
| `VideoPlayer` | component | `defineComponent('VideoPlayer', ...)`; clip / playing / loop / `currentTime` (field-level `transient: true`, feat-20260709 -- per-frame playback head derived from the `HTMLVideoElement`, excluded from scene collect/serialization) |
| `VIDEO_SOURCE_PROVIDER_KEY` | const | World Resource key for the host bridge |
| `VideoSourceProvider` | interface | `getSource(entity, clip)` returns an `HTMLVideoElement` or decoded `VideoFrame`; the provider retains the source lifetime |
| `videoContribution` | const | Runtime-owned Video decoder contribution |
| `probeVideoHighPerfUpload(device)` | function | Zero-copy probe; reads only `caps.externalTexture` (RHI owns the media-realm and `importExternalTexture` detection) |

`videoContribution` accepts a non-empty browser-resolvable URL descriptor without
normalizing it: root-relative (`/cutscene.webm`), path-relative
(`cutscene.webm`), and absolute `http:` / `https:` URLs are preserved exactly.
The policy rejects whitespace, C0/DEL control characters, protocol-relative
URLs, non-string values, empty values, and every other URL scheme. Relative
values are checked with a sentinel `https:` origin only for browser URL
grammar; that origin is never published or fetched.

A `VideoPlayer` frame bound to a material parameter declared `texture_external`
is imported zero-copy every frame when the probe is true; ordinary 2D slots and
devices with `caps.externalTexture === false` copy the frame instead. Arbitrary
caller video or GPU textures use the Renderer's `importTexture` external-source
entry (`packages/render/README.md` §External textures), not this component.
