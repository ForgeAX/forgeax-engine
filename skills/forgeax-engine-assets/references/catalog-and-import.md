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

**refs owns the reference graph.** AssetEnvelope.refs carries dependency GUIDs and loadByGuid traverses it without kind dispatch. Historical collectRefs kind switches, storedNameOf side tables, and assetBrand switches were replaced by envelope refs/name and the ASSET_BRAND record.

### AssetRef edge metadata

```ts
interface AssetRef {
  readonly guid: string;                              // Referenced asset GUID.
  readonly sourceField?: {
    readonly componentName?: string;                  // Such as MeshRenderer or MeshFilter.
    readonly fieldName: string;                       // Handle field: mesh, materials, parent.
    readonly arrayIndex?: number;                     // Index for array<handle<T>>.
  };
  readonly sceneEntityId?: number;                    // Scene-local entity ID for scene references.
}
```

**sourceField is structured metadata**: consume componentName/fieldName/arrayIndex through properties, not string parsing. Texture edges lack entity-field provenance and leave sourceField undefined. sceneEntityId exists only for scene handle-field references.

### Kind-independent recursive loading

loadByGuid iterates envelope.refs and recursively loads ref.guid. There are no separate material-texture/parent preload paths. Parent-material breadcrumbs inspect sourceField.fieldName === 'parent' within that shared loop.

## Mental model

GUID is asset identity; paths are not. Display names use packagePath.name through resolveName. Names are derived outside POD/Package. The pipeline has four stages:

- **Disk authoring**: sources needing conversion use source.meta.json and an importer; prepared/hand-authored payloads use name.pack.json. Prefer ui.html + matching ui.css + meta for readable UI, letting the UI importer produce UiAsset. Direct Pack UI is for intentionally prepared small final payloads.
- **CLI scan**: asset scan/verify performs fail-fast validation.
- **Build projection**: vite-plugin-pack produces pack-index.json with optional entry names.
- **Runtime payload/identity**: register/registerWithGuid handles known payloads; configurePackIndex then loadByGuid handles disk assets. resolveName derives display identity. The GUID-keyed AssetEnvelope catalog stores payload, refs, and optional name; refs owns recursive dependencies and name owns stored per-GUID naming.

### Package identity

Each imported source file is a Package shared by all its output assets. AssetRegistry tracks packageOf and derives names from explicit entry names, otherwise the package basename. Builtin/in-memory assets have null package; unnamed ones yield an empty name. When a package grows from one asset to multiple, previously unnamed assets idempotently freeze their derived names as stored names.

Package is discoverable through engine-types. packageOf(guid) returns Package, null for no package, or undefined for an unknown GUID.

### Compression pipeline

> [!NOTE]
> zstd packing and KTX2 containers are transparent to loadByGuid consumers; fetchBinary handles decoding.

PackIndexEntry.compression accepts none, zstd, basis-etc1s, basis-uastc, or basis-uastc-hdr, also reflected in image metadata/sidecars. zstd wraps binary assets; basis values identify KTX2 block encoding. Missing/none means uncompressed. Mesh binaries default to zstd; texture policy comes from compressionMode, default auto.

fetchBinary(url, { compression }) decompresses zstd through engine-codec. Basis payloads pass through to the texture loader's selectTranscodeTarget/transcodeKtx2 path. Failures become asset-fetch-failed with codec details, preserving decompression-failed/codec-init-failed inside detail.

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

AssetEnvelope is the shared shape across import, catalog registration, and recursive loading:

```ts
interface AssetEnvelope {
  readonly guid: string;
  readonly kind: string;          // Asset.kind discriminant.
  readonly name?: string;         // Stored per-GUID name consumed by resolveName.
  readonly payload: Asset;        // Closed Asset union member.
  readonly refs: readonly AssetRef[];  // Dependency GUIDs and edge metadata.
}
```

Recursive loading traverses refs without kind switches. name is the sole stored-name location, replacing storedNameOf; resolveName uses package path only as fallback.

ASSET_BRAND: Record<Asset['kind'], AssetBrand> lives beside AssetBrand in engine-types and replaces the old switch. New kinds require a record entry; TypeScript detects omissions.

## Register a custom host importer

> [!IMPORTANT]
> Hosts can import arbitrary source formats without an Engine whitelist. Built-in image/glTF/audio/font importers and host importers use the same registry. Runnable example: apps/hello/custom-importer/.

| Step | Action | Location |
|:--|:--|:--|
| Declare | Meta importer key and subAssets kind, such as reel-game-blob. Both schema fields accept open strings. | assets/source.meta.json |
| Inject importer | pluginPack({ importers: [myImporter()] }) registers it at build time. | vite.config.ts |
| Register loader | assetLoaderPlugin(myLoader()) contributes a reversible loader through app.pluginContext; loadByGuid<T> returns host payload T outside the Engine Asset union. | Host runtime |

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
> Without a registered runtime loader, loadByGuid<T> returns the raw host payload and kind; with a loader, it dispatches there. Host payloads remain outside the closed Asset union. End-to-end contract: host-custom-kind-contract.test.ts.

## Choose a sidecar by source conversion needs

> [!IMPORTANT]
> Choose by whether source conversion is required, not by image versus text.

| Aspect | source.meta.json (external-asset-package) | name.pack.json (internal-text-package) |
|:--|:--|:--|
| Use | Convert images, glTF, fonts, UI, or custom binary into POD. | Author a complete final JSON payload directly. |
| Payload producer | Build-time importer returns ImportedAsset[]. | Author writes assets[].payload. |
| Build action | Import into DDC and project index rows. | Index the self-contained payload directly. |
| Typical kind | Engine or host imported kinds. | Hand-authored data or intentionally final UI. |
| importer field | Required. | Not applicable. |

Source bytes needing programmatic conversion use meta plus importer; complete final JSON uses Pack.

## Runtime image-byte decoding

> [!IMPORTANT]
> Build-known assets use sidecar/import/loadByGuid. decodeImageBytes handles bytes first available at runtime, such as fetched URLs, embedded base64, or external decoder output. Both produce TextureAsset POD and use allocSharedRef/ensureResident downstream.

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
- No GPU upload: use the existing allocSharedRef/ensureResident path after decoding.
- Supports PNG/JPEG. GIF/WebP/SVG/AVIF/KTX2/HDR report image-format-unsupported; convert offline or use richer build-time importers.
- Static binary/KTX2 assets still use loadByGuid; this API handles runtime-only bytes.
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
const handle = world.allocSharedRef('TextureAsset', result.value);
```

### Isolation gate

decode-image-bytes.ts is the only assets-runtime file permitted to statically import engine-image. check-image-pipeline-isolation.mjs anchors that exception; other runtime/assets-runtime static imports remain forbidden.

Further contract: packages/assets-runtime/README.md, Runtime image bytes decoder.
