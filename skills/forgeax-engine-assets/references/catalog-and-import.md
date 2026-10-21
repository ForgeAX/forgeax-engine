# Asset catalog and import contracts

Use `../SKILL.md` for authority and recovery. This reference covers Catalog identity,
source sidecars, compression, custom importers, and runtime byte decode.

## CatalogSource: subscribe before enumerating

> [!IMPORTANT]
> Catalog combines enumerable rows with row-level subscriptions. CatalogDelta contains
> added, changed, and removed sets; the Vite producer does not choose consumer
> reload policy. Subscribe first, enumerate second, and merge locally by GUID.

```ts
const stop = assets.subscribeCatalog((delta) => mergeRowsByGuid(delta));
const snapshot = await assets.enumerateCatalog();
if (!snapshot.ok) {
  console.error(snapshot.error.code, snapshot.error.hint);
  // Repair source/endpoint and enumerate again; failures are not permanently cached.
} else {
  replaceOrMergeRowsByGuid(snapshot.value);
}
stop();
```

- added/changed carry complete CatalogEntry values; removed carries stable GUIDs.
  Read CatalogEntry/CatalogDelta in engine-types for the full field contract.
- setCatalogSource(source) injects the runtime source. Without it, the structured
  catalog-source-unconfigured failure provides code/hint; do not treat failure as an empty list.
- After late subscription or transport interruption, enumerate again and merge idempotently by GUID.
  Static sources subscribe with a safe no-op, without fabricated changes.
- pluginPack emits forgeax:catalog-delta. Hosts needing content refresh explicitly configure
  refresh: reloadAssetHost() in vite.config.ts; source-only byte changes do not fabricate deltas.
  Editors use the same source for incremental Content Browser updates, without Engine CRUD/reload exceptions.

Editor consumers must pin an Engine revision containing this contract; an unpinned workspace
link is not cross-repository evidence. The editor packages/engine gitlink and
CI assertions own the tested pin and composition gate.

## Verified closure and runtime identity

`AssetEnvelopeV2.refs` contains dependency GUID strings. The source owner walks
that graph once, validates complete publication tuples and artifact integrity,
and invokes installed decoders. Ordinary references are eager; a decoder may
explicitly declare deferred references, as Plugin definitions do. Runtime
admission publishes the prepared content and dependencies together.

Schema field metadata belongs to the relevant Scene/authoring projection.
Consumers must not infer reference kinds from numeric values or parse field
names. At the runtime boundary, `asset(kind)` fields hold asset handles;
ordinary numeric/string fields retain their original meaning.

The pipeline keeps four owners:

- Source plus Meta or Pack owns authored GUID identity and conversion settings.
- Import/Cook validates source and produces complete outputs and receipts.
- Catalog provides navigation and publication evidence, including `name`, `packageId`, `sourcePath`, `sourceKey` and dependency facts.
- AssetRegistry owns runtime content and handles. Use `create` for code content and `load(guid, kind)` for source content; `read(handle)` returns a detached payload.

A Catalog row change never overwrites gameplay content. Repeated `load` retains
the existing identity; use explicit `reload(handle, { conflict })` for current
source adoption. Source-backed and runtime-created assets use the same runtime
owner, while source provenance remains available through `source` / `sourceOf`.
Runtime edits do not rename source, create Catalog rows or save files.

### Compression pipeline

> [!NOTE]
> Stored compression and KTX2 containers are transparent to `assets.load(guid, kind)` consumers; the source, codec and texture owners validate their representations.

PackIndexEntry.compression accepts none, zstd, basis-etc1s, basis-uastc, or basis-uastc-hdr, also reflected in image metadata/sidecars. zstd wraps binary assets; basis values identify KTX2 block encoding. Missing/none means uncompressed. Mesh binaries default to zstd; texture policy comes from compressionMode, default auto.

Stored zstd encoding is decoded through the runtime-safe Codec path. Texture preparation preserves the admitted source representation and Render selects device residency from real capabilities. Follow the structured source/decode failure; do not fetch artifact URLs or transcode compressed textures independently in game code.

### Texture compressionMode sidecar

Texture meta supports auto/etc1s/uastc/none, default auto. Full semantics: [engine-image](../../../packages/image/README.md#compressionmode-sidecar-field).

| Mode | Behavior |
|:--|:--|
| auto | sRGB -> ETC1S; linear -> UASTC-LDR; HDR -> UASTC-HDR. |
| etc1s | Force deterministic fast-preset ETC1S. |
| uastc | Force deterministic fast-preset UASTC-LDR 4x4. |
| none | Emit raw RGBA binary without block compression. |

### Compressed mipmaps are cooked offline

Compressed formats cannot generate runtime mips because they are not render targets. Loading compressed TextureAsset with mipmap:true reports mipgen-unsupported-compressed-format; use uncompressed policy or disable runtime mip generation. importSettings.mipmap:true cooks box-filter mip chains during import. Uncompressed textures support runtime mip generation.

engine-codec exports runtime-safe decompressZstd/parseKtx2/ktx2LevelsToRGBA and build-only compressZstd through /encode. KTX2 parsing covers headers/indexes/levels/DFD/KV/SGD and reuses decompressZstd for scheme 2. See [codec README](../../../packages/codec/README.md).

The image-pipeline isolation gate forbids runtime imports of codec/encode while permitting runtime-safe decoding.

### AssetEnvelope shape

The verified decoder input is `AssetEnvelopeV2<P>`:

```ts
interface AssetEnvelopeV2<P> {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly payload: P;
  readonly refs: readonly string[];
  readonly artifacts: Readonly<Record<string, AssetRuntimeArtifactDescriptor>>;
}
```

The containing Pack owns the atomic scope, generation, digest and output-set
digest. Artifact descriptors carry lengths and integrity before a decoder may
read their bytes. A custom payload's optional `kind` property does not bypass
its token/decoder contract or select built-in preparation.

## Register a custom host importer

> [!IMPORTANT]
> Hosts can import arbitrary source formats without an Engine whitelist. Built-in image/glTF/audio/font importers and host importers use the same registry. Runnable example: apps/hello/custom-importer/.

| Step | Action | Location |
|:--|:--|:--|
| Declare | Meta importer key and subAssets kind, such as reel-game-blob. Both schema fields accept open strings. | assets/source.meta.json |
| Inject importer | pluginPack({ importers: [myImporter()] }) registers it at build time. | vite.config.ts |
| Install decoder | Share a `defineAssetKind<P>()` token through `assetDecoderPlugin({ kind, decoder, consumer })` or `assets.installDecoder(kind, decoder)`; load returns a typed handle. | Host runtime |

### Passthrough projection

Importer has key and import, with no fold method. ImportedAsset.kind directly becomes the Pack index kind.

```ts
// Passthrough host importer, without fold or binary emission.
export function reelGameBlobImporter(): Importer {
  return {
    key: 'reel-game-blob',
    async import(ctx: ImportContext): Promise<readonly ImportedAsset[]> {
      const sub = ctx.subAssets[0];                  // Meta-owned GUID and kind.
      const read = await ctx.readSource();           // Read bytes; importers never mint GUIDs.
      if (sub === undefined || !read.ok) return [];  // Runner attributes an empty result; no raw throw.
      const payload = JSON.parse(new TextDecoder().decode(read.value));
      return [{ guid: sub.guid, kind: 'reel-game-blob', payload, refs: [] }];
    },
  };
}
```

buildCatalog projects registered host importers directly into index rows; an unregistered key remains raw source. Host kinds conflicting with Engine-owned texture/mesh/material/scene/audio/font kinds fail with catalog-host-kind-conflict instead of overriding loaders.

> [!TIP]
> A source load requires the matching decoder lease; absence returns `asset-decoder-missing`. `decode` validates source input. Add synchronous `prepare` for runtime creation or writes. Host payloads remain outside the closed built-in Asset union; see [custom kinds](scene-and-custom-kinds.md#open-registration-for-host-kinds).

## Choose a sidecar by source conversion needs

> [!IMPORTANT]
> Choose by whether source conversion is required, not by image versus text.

| Aspect | source.meta.json (external-asset-package) | name.pack.json (internal-text-package) |
|:--|:--|:--|
| Use | Convert images, glTF, fonts, UI, or custom binary into POD. | Author a complete final JSON payload directly. |
| Payload producer | Build-time importer returns ImportedAsset[]. | Author writes the direct Pack `assets[sourceKey]` map. |
| Build action | Import/Cook into DDC and publish verified Pack/Catalog outputs. | Validate and Cook the declared output map, then publish Pack/Catalog outputs. |
| Typical kind | Engine or host imported kinds. | Hand-authored data or intentionally final UI. |
| importer field | Required. | Not applicable. |

Source bytes needing programmatic conversion use meta plus importer; complete final JSON uses Pack.

## Runtime image-byte decoding

> [!IMPORTANT]
> Build-known assets use sidecar/Import/Cook and `assets.load(guid, 'texture')`. `decodeImageBytes` handles bytes first available at runtime, such as fetched URLs, embedded base64, or external decoder output. Capture its Texture POD with `assets.create` and bind the returned handle; Render owns residency.

### Signature and options

```ts
import { decodeImageBytes } from '@forgeax/engine-assets-runtime';

async function decodeImageBytes(
  bytes: Uint8Array | ArrayBuffer,
  mime: string,                              // v1: 'image/png' | 'image/jpeg'
  opts?: { colorSpace?: 'srgb' | 'linear'; mipmap?: boolean },
): Promise<Result<TextureAsset, ImageError>>;
```

- colorSpace defaults to srgb, producing rgba8unorm-srgb; linear produces rgba8unorm.
- mipmap defaults true, deriving numMipLevels(width,height); false gives one mip.
- Omit options for the default path; advanced settings are optional.

### Boundaries

- No network fetch: callers supply bytes.
- No GPU upload: use `assets.create(decodedTexture)` and bind the handle; Render owns upload and retirement.
- Supports PNG/JPEG. GIF/WebP/SVG/AVIF/KTX2/HDR report image-format-unsupported; convert offline or use richer build-time importers.
- Static binary/KTX2 assets still use `assets.load(guid, 'texture')`; this API handles runtime-only bytes.
- Requires browser/Worker createImageBitmap and OffscreenCanvas, not Node decoding. Missing capabilities produce image-decode-failed.

### Image error subset

Read the complete ImageErrorCode union in engine-types. This decoder uses the following base subset, excluding atlas/HDR-specific paths:

| Code | Trigger | Detail |
|:--|:--|:--|
| image-format-unsupported | MIME is not PNG/JPEG. | actualMime, optional path/formatColorSpaceConflict |
| image-decode-failed | Decoder rejects bytes or createImageBitmap is unavailable. | reason, optional path |
| image-dimension-out-of-bounds | Reserved; not currently emitted by the decoder. | requested width/height and limit |
| image-meta-missing | Not emitted by this API. | sourcePath, expectedSidecarPath |

### Structured recovery example

```ts
import { decodeImageBytes } from '@forgeax/engine-assets-runtime';

const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
const result = await decodeImageBytes(bytes, 'image/png');
if (!result.ok) {
  const err = result.error;
  // IMAGE_ERROR_HINTS owns actionable recovery hints.
  console.error(err.code, err.hint);
  // Switch on detail.code: ImageError has separate top-level and nested discriminants.
  // TypeScript does not correlate them across nesting.
  // Switching on the nested discriminator narrows the remaining detail fields.
  // Single-discriminant error families normally switch on error.code.
  switch (err.detail.code) {  // Exhaustive, without default.
    case 'image-format-unsupported': /* Change format. */ break;
    case 'image-decode-failed':      /* Change source or inspect environment. */ break;
    case 'image-dimension-out-of-bounds': /* Reduce resolution. */ break;
    case 'image-meta-missing':       /* Not emitted by this API. */ break;
  }
  return;
}
// Bytes in, POD out; downstream behavior matches static textures.
const handle = assets.create(result.value).unwrap();
// Release this caller reference after a component/material has retained it.
```

### Isolation gate

decode-image-bytes.ts is the only assets-runtime file permitted to statically import engine-image. check-image-pipeline-isolation.mjs anchors that exception; other runtime/assets-runtime static imports remain forbidden.

Further contract: packages/assets-runtime/README.md, Runtime image bytes decoder.
