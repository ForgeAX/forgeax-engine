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

### video (from `video-player.ts` + `video-player-system.ts` + `video-source-provider.ts` + `video-loader.ts` + `video-dom-provider.ts` + `video-frame-worker.ts` + `video-frame-host.ts` + `video-importer.ts`)

| Symbol | Kind | Notes |
|:--|:--|:--|
| `VideoPlayer` | component | `defineComponent('VideoPlayer', ...)`; clip / playing / loop / `currentTime` (field-level `transient: true`, feat-20260709 -- per-frame playback head derived from the `HTMLVideoElement`, excluded from scene collect/serialization) |
| `VIDEO_SOURCE_PROVIDER_KEY` | const | World Resource key for the host bridge |
| `VideoSourceProvider` | interface | `getSource(entity, clip)` returns an `HTMLVideoElement` or decoded `VideoFrame`; the provider retains the source lifetime |
| `videoContribution` | const | Runtime-owned Video decoder contribution; resolves a URL descriptor or an imported clip's streamed artifact URL |
| `installDomVideoSourceProvider(world, options?)` | function | DOM-realm provider: one muted inline `<video>` per (renderable, clip) from the VideoAsset URL, driven by that entity's `VideoPlayer` (`playing`/`loop`; absent means playing and looped); `release(entity)` / `dispose()`; refuses a Worker or DOM-less realm with `video-dom-unavailable` |
| `installWorkerVideoSourceProvider(world, endpoint)` | function | Engine Worker provider: announces each (renderable, clip) consumer to the page over `createVideoFrameEndpoint(port)`, follows `VideoPlayer`, keeps the newest transferred `VideoFrame`; `status(entity, clip)` / `resume()` / `release(entity)` / `dispose()`; refuses a realm without `VideoFrame` with `video-frame-unsupported` |
| `createVideoFrameHost(port, options?)` | function | Page half of the Worker bridge: one muted inline `<video>` per Worker consumer, paced by `requestVideoFrameCallback` (rAF fallback), one frame in flight per consumer, `resume()` on a user gesture; App wires it for you |
| `videoImporter` (`@forgeax/engine-graphics-extras/video-importer`) | importer | Build-time `.mp4`/`.m4v`/`.webm`/`.ogv` producer registered by DevKit; emits one `video` asset whose container is a `delivery: 'stream'` `source` artifact |
| `probeVideoHighPerfUpload(device)` | function | Zero-copy probe; reads only `caps.externalTexture` (RHI owns the media-realm and `importExternalTexture` detection) |

`videoContribution` accepts a non-empty browser-resolvable URL descriptor without
normalizing it: root-relative (`/cutscene.webm`), path-relative
(`cutscene.webm`), and absolute `http:` / `https:` URLs are preserved exactly.
The policy rejects whitespace, C0/DEL control characters, protocol-relative
URLs, non-string values, empty values, and every other URL scheme. Relative
values are checked with a sentinel `https:` origin only for browser URL
grammar; that origin is never published or fetched.

An imported clip carries `{ kind: 'video', mediaType }` and one streamed
`source` artifact. The decoder asks the artifact reader to `locate` that
artifact and returns `{ kind: 'video', url }` without reading the body, so the
material and provider see the same shape as a runtime URL descriptor. The
browser element downloads the body itself with `Range: bytes=N-` requests,
which the DevKit artifact server answers with `206`.

```ts
import { installDomVideoSourceProvider, VideoPlayer } from '@forgeax/engine/graphics-extras';

const provider = installDomVideoSourceProvider(world).unwrap();
const clip = (await assets.load(BILLBOARD_VIDEO_GUID, 'video')).unwrap();
world.spawn(
  { component: MeshFilter, data: { mesh: quad } },
  { component: MeshRenderer, data: { materials: [videoMaterial] } }, // emissive = clip
  { component: VideoPlayer, data: { clip, playing: true, loop: true } },
);
// later: provider.dispose();
```

The Engine Worker realm has no `HTMLVideoElement`, so App bridges page video
into it by default. `startEngineWorker` opens a dedicated `MessageChannel`: the
page end runs `createVideoFrameHost`, the Worker end installs
`installWorkerVideoSourceProvider` on every World. Game code is the same as in
a DOM realm minus the install call, which the Worker refuses with
`video-dom-unavailable`:

```ts
// Engine Worker: the provider is already installed; read it for status.
const provider = world.getResource(VIDEO_SOURCE_PROVIDER_KEY) as WorkerVideoSourceProvider;
const status = provider.status(screen, clip); // Result<{ hasFrame, received, dropped } | undefined>
if (!status.ok && status.error.code === 'video-autoplay-blocked') provider.resume();
```

The page plays one muted inline `<video>` per (renderable, clip) and follows
the Worker's `VideoPlayer.playing` / `loop`. Each presented frame
(`requestVideoFrameCallback`, rAF where that is missing) is captured as a
WebCodecs `VideoFrame` (`createImageBitmap` where `VideoFrame` is missing on the
page) and transferred. Only one frame is in flight per consumer: until the
Worker acknowledges it, newer presentations just mark the consumer dirty, so a
slow Worker samples the newest frame and nothing queues. The Worker keeps the
bound frame and at most one newer frame, closing each exactly once (replaced,
released, despawned, World disposed or Worker terminated).

Page failures arrive as `status` errors with `code`, `expected` and `hint`:
`video-autoplay-blocked` (the page retries on the next pointer, key or touch
gesture, or call `provider.resume()`), `video-load-failed`,
`video-frame-capture-failed` (usually a cross-origin clip without CORS) and
`video-frame-unsupported`. Without `MessageChannel` or `document` (tests, SSR)
App opens no bridge and the Worker keeps no provider.

A `VideoPlayer` frame bound to a material parameter declared `texture_external`
is imported zero-copy every frame when the probe is true; ordinary 2D slots and
devices with `caps.externalTexture === false` copy the frame instead. Arbitrary
caller video or GPU textures use the Renderer's `importTexture` external-source
entry (`packages/render/README.md` §External textures), not this component.
