# @forgeax/engine-codec

> `@forgeax/engine-codec` provides zstd decode/encode, KTX2 container parse,
> Basis transcode, and build-time Basis encode --
> a single package covering the full runtime codec surface for the forgeax
> asset pipeline.

> [!IMPORTANT]
> This package uses **subpath-level encode/decode separation** (D-1). The main entry
(`@forgeax/engine-codec`) exports runtime-safe decode + transcode functions;
texture block math belongs to the `@forgeax/engine-types` texture layout contract.
The `/encode` subpath (`@forgeax/engine-codec/encode`) exports build-time encode (zstd + Basis). Runtime code must never import from `/encode` --
this is enforced by `check-image-pipeline-isolation.mjs` path d (AC-09).

Runtime imports do not construct text decoders. Native hosts may load shared
chunks before installing their standard interfaces; document and KTX2 readers
create their cached decoders on first use, after host initialization.

## WASM provisioning

> [!IMPORTANT]
> `pkg/` is an Emscripten build artifact and is **not committed to git**. It
> contains the runtime transcoder and build-time encoder bundles, so a fresh
> checkout must hydrate it before using Basis KTX2 paths.

| Path | Command | Use |
|:--|:--|:--|
| Pre-built release | `pnpm -F @forgeax/engine-codec fetch-wasm` | Fast setup without Emscripten |
| Local build | `pnpm -F @forgeax/engine-codec build:wasm` | Rebuild with the Emscripten toolchain |
| Opt out | `FORGEAX_SKIP_CODEC_WASM_FETCH=1 pnpm install` | Toolchain owners provisioning separately |

<details>
<summary>Release selection, fallback, and recovery</summary>

The pre-built bundle is published under the `wasm-artifacts` GitHub Release tag
as `basis-wasm-pkg-{sha8}.tar.gz`. The content key is the first eight characters
of `SHA256(fetch-basis.mjs + build-wasm.mjs)`, shared by the consumer and the CI
publisher. The tarball contains the whole `pkg/` tree:

- `basis_transcoder.mjs` + `basis_transcoder.wasm` for runtime transcode;
- `encode/basis_encoder.mjs` + `encode/basis_encoder.wasm` for build-time encode.

The runtime transcoder uses Embind AOT invokers (`DYNAMIC_EXECUTION=0`,
`EMBIND_AOT=1`), so its glue initializes without `eval` or `new Function` in
hosts that restrict dynamic code execution. A host-specific WASM loader must
still pass the imports supplied by the generated glue.

Native path-based targets select the `forgeax-native` bundler condition and call
`await initBasisTranscoder(host)` through `@forgeax/engine/codec` before loading
compressed textures. `BasisWasmHost.readWasm()` supplies decoded bytes;
`instantiate(imports)` binds the same immutable published transcoder path and
returns `{ instance, module? }`. The native factory checks length and SHA-256
against its embedded canonical WASM/glue identity before instantiation. On WeChat, the
existing `createWechatWasmHost` supplies this contract and uses
`WXWebAssembly.instantiate`; copy `pkg/basis_transcoder.wasm` into the target's
package. The package build projects `pkg/basis_transcoder.mjs` into
`dist/basis-native-factory.mjs`: only generated environment detection is fixed at
build time and browser module-URL discovery is disabled. The complete factory,
import table, memory views, Embind registration and runtime initialization remain.
The native entry requires the explicit Host callback; Node imports cannot enter
the deployable bundle. Its adjacent provenance records original glue, unchanged
WASM, projected JavaScript, producer and substrate content identity. No global
WebAssembly replacement or partial protocol reimplementation is used.

The ordinary `initBasisTranscoder()`/`transcodeKtx2()`/`transcodeBasis()` path shares
one initialized module per realm. Concurrent first calls share the same promise.
Failed Host instantiation or factory initialization rejects with
`Error('codec-init-failed', { cause })` and clears the attempt for an explicit retry;
the asynchronous Emscripten success callback cannot leave the owning caller hung.
The first successful initialization fixes that realm's module. With the default
condition and no Host, browser/Node URL loading remains lazy.

After `pnpm -C packages/codec build`, run
`node --test scripts/forgeax/__tests__/basis-native.test.mjs` from the repository
root. The test encodes a real 16×16 source, transcodes all five mips to RGBA8 and
BC7, and requires byte-identical output from default and native paths. The native
child has no global WebAssembly, process, dynamic Function or browser fetch; it
also exercises rejection, retry and concurrent initialization. Actual WeChat
simulator/device startup is qualified separately by the target.

`node packages/codec/scripts/verify-transcoder.mjs` initializes the actual
transcoder with dynamic `Function` construction unavailable. The WASM smoke
test and SDK producer share this gate; SDK packaging rejects stale or broken
runtime payloads before copying them into npm packages or the source archive.
An optional `pkg/` directory argument checks an already delivered payload.

The shared downloader tries Node `fetch` first, then authenticated `gh` and
platform-native `curl` (`curl.exe` on Windows) when the Node TLS/network
handshake fails. All paths remain pinned to the current repository, the
`wasm-artifacts` tag, and the exact content-keyed asset. Authentication uses
`GITHUB_TOKEN`/`GH_TOKEN` or `gh auth login`.

`postinstall` uses the same fetch path on a best-effort basis: an unavailable
release does not fail a bare install, while a later build or typecheck reports
that `pkg/` still needs provisioning. Use `build:wasm` when no matching release
exists; it runs `fetch-basis.mjs` and `build-wasm.mjs` and requires `emcc`.

</details>

## API

### Runtime-safe decode (main entry)

| Export | Signature | Description |
|:--|:--|:--|
| `decompressZstd` | `(bytes: Uint8Array) => Promise<CodecResult<Uint8Array>>` | Decompress a zstd-compressed byte buffer. Lazy-init singleton using the pinned WASM Zstd decoder, with the existing fzstd decoder if native initialization fails; concurrent first calls share the same init promise (AC-12). Returns `CodecOk<Uint8Array>` on success, `CodecError` on failure. |
| `parseKtx2` | `(bytes: Uint8Array) => CodecResult<Ktx2Parsed>` | Parse a KTX2 2.0 container (12B magic validation). Returns header, index, level index, DFD, KV metadata, and SGD descriptor -- all five parts per AC-03. Does **not** interpret block-compressed payload content (OOS-6, Loop 2). Pure synchronous parsing; no codec initialization. |
| `ktx2LevelsToRGBA` | `(parsed: Ktx2Parsed, level?: number) => Promise<CodecResult<Uint8Array>>` | Extract RGBA bytes from a parsed KTX2 container. Handles scheme=0 (uncompressed, pass-through) and scheme=2 (zstd supercompression, reuses `decompressZstd` per AC-04). The optional `level` parameter selects a mip level (default: 0). Returns the level's RGBA bytes as a flat `Uint8Array`. |
| `selectTranscodeTarget` | `(dfdModel: number, srgb: boolean, channels: number, caps: TranscodeCaps) => GPUTextureFormat \| null` | Pure-function priority chain (node-safe, zero DOM): given a DFD color model, srgb flag, channel count, and device caps, returns the best native block format. The chain is LDR RGBA: `ASTC4x4 -> BC7 -> ETC2 -> RGBA8` (with srgb variants); single-channel R: `BC4 -> EAC-R11 -> R8`; two-channel RG: `BC5 -> EAC-RG11 -> RG8`; HDR: `BC6H -> rgba16float`. BC-first rule: when BC and ETC2/ASTC coexist, the chain selects BC (D-4 Mesa guard). Input `TranscodeCaps { bc, etc2, astc }` is a local struct -- codec never imports from rhi. Returns non-null (no-cap fallback to rgba8unorm/rgba16float). |
| `initBasisTranscoder` | `(host?: BasisWasmHost) => Promise<BasisTranscoderModule>` | Lazy-init singleton per realm. First call loads the complete Emscripten factory and initializes Basis; native Hosts supply path-based instantiation before first texture use. Subsequent calls return the cached instance; rejected attempts can retry. |
| `transcodeKtx2` | `(parsed: Ktx2Parsed, targetFormat: GPUTextureFormat) => Promise<CodecResult<TranscodedMips>>` | Transcode a scheme=1 (BasisLZ) KTX2 payload to a native block format. Iterates every mip level through the transcoder, returning `TranscodedMips { format, mips: { data, width, height }[] }`. Calls init on first use. |

Zstd decoding uses one synchronous streaming session per call and verifies frame
completion before returning owned output bytes. Native scratch space does not
allocate the entire decoded output; its capacity still depends on input and the
encoded window. Sessions never overlap within one realm.

**Priority chain rules** (D-4 BC-first, D-8 local TranscodeCaps):

| Source (channels, color, srgb) | BC cap | ETC2 cap | ASTC cap | Target format |
|:--|:--|:--|:--|:--|
| RGBA, LDR, srgb | yes | yes | yes | `bc7-rgba-unorm-srgb` |
| RGBA, LDR, srgb | no | yes | -- | `etc2-rgba8unorm-srgb` |
| RGBA, LDR, srgb | no | no | yes | `astc-4x4-unorm-srgb` |
| RGBA, LDR, srgb | no | no | no | `rgba8unorm-srgb` |
| R, LDR | yes | -- | -- | `bc4-r-unorm` |
| R, LDR | no | yes | -- | `eac-r11unorm` |
| R, LDR | no | no | -- | `r8unorm` |
| RG, LDR | yes | -- | -- | `bc5-rg-unorm` |
| RG, LDR | no | yes | -- | `eac-rg11unorm` |
| RG, LDR | no | no | -- | `rg8unorm` |
| HDR | yes | -- | -- | `bc6h-rgb-ufloat` |
| HDR | no | -- | -- | `rgba16float` |

**Scheme support** (extended in Loop 2):

| Scheme | Name | Supported | Path |
|:--|:--|:--|:--|
| 0 | None (uncompressed) | yes | `ktx2LevelsToRGBA` pass-through |
| 1 | BasisLZ | yes | `parseKtx2` -> `transcodeKtx2` |
| 2 | Zstandard | yes | `ktx2LevelsToRGBA` + `decompressZstd` |
| 3 | ZLIB / DEFLATE | no | returns `ktx2-unsupported-scheme` |

Usage example:

```ts
import { decompressZstd, parseKtx2, ktx2LevelsToRGBA, codecError }
  from '@forgeax/engine-codec';

// Decompress zstd bytes
const res = await decompressZstd(compressedBytes);
if (res.ok) {
  const original = res.value; // Uint8Array
} else {
  switch (res.error.code) {
    case 'decompression-failed':  // res.error.detail: { reason }
    case 'codec-init-failed':     // res.error.detail: { stage }
    case 'ktx2-parse-failed':     // res.error.detail: { reason }
    case 'ktx2-unsupported-scheme': // res.error.detail: { scheme }
  }
}

// Parse KTX2 container and extract RGBA
const k = await parseKtx2(ktx2Bytes);
if (k.ok) {
  const rgba = await ktx2LevelsToRGBA(k.value, 0);
}
```

### Build-time encode (`/encode` subpath)

| Export | Signature | Description |
|:--|:--|:--|
| `compressZstd` | `(bytes: Uint8Array) => Promise<CodecResult<Uint8Array>>` | Compress bytes with zstd (pinned WASM, fixed level, no dictionary, no timestamp -- deterministic per AC-07). Build-time only; gated from runtime import by `check-image-pipeline-isolation.mjs` path d. |

Import path:

```ts
import { compressZstd } from '@forgeax/engine-codec/encode';
//                                       ^^^^^^^^^^^^^^^
//                                       build-time only, blocked from runtime
```

### Type exports

| Export | Description |
|:--|:--|
| `CodecErrorCode` | Closed union: `'decompression-failed' \| 'codec-init-failed' \| 'ktx2-parse-failed' \| 'ktx2-unsupported-scheme' \| 'transcode-failed' \| 'ktx2-encode-failed'` (order-locked, add-only-minor) |
| `CodecError` | Structured error: `{ ok: false, error: { code, expected, hint, detail } }` with per-code narrowed `detail` |
| `CodecOk<T>` | Success branch: `{ ok: true, value: T }` |
| `CodecResult<T>` | Discriminated union: `CodecOk<T> \| CodecError` |
| `Ktx2Header` | Parsed KTX2 header (9 u32 fields + supercompressionScheme) |
| `Ktx2Index` | Parsed KTX2 index (dfd/kvd/sgd byte offsets and lengths) |
| `Ktx2LevelEntry` | Per-level byte offset, byte length, uncompressed byte length |
| `Ktx2Dfd` / `Ktx2DfdSample` | Parsed DFD (data format descriptor) block |
| `Ktx2KvEntry` | Key-value metadata entry (key string + raw value bytes) |
| `Ktx2Parsed` | Fully parsed KTX2 container: `{ header, index, levelIndex, dfd, kvEntries, sgd }` |

## Error codes

All codec errors use the `CodecErrorCode` closed union. Consume with exhaustive
`switch (err.code)` -- no `default` branch, TypeScript guards completeness.

| Code | Trigger condition | `.hint` (executable recovery) | `.detail` payload |
|:--|:--|:--|:--|
| `decompression-failed` | Corrupted/malformed zstd input, or encode failure surfaced as decompression error | "Check catalog row compression field and asset binary consistency; re-run asset import." | `{ reason: string }` -- failure cause |
| `codec-init-failed` | Dynamic import of fzstd decode module failed (network / bundling) | "Uncompressed assets are still loadable. Verify the codec module is installed correctly." | `{ stage: string }` -- failed initialization stage |
| `ktx2-parse-failed` | KTX2 magic mismatch, header truncation, level index out of bounds (E5) | "Check that the KTX2 file is valid and not truncated. Re-import the texture asset." | `{ reason: string }` -- parse failure location |
| `ktx2-unsupported-scheme` | KTX2 supercompression scheme is ZLIB (=3) or other unsupported scheme. Scheme 1 (BasisLZ) and 2 (Zstd) are accepted. | "This supercompression scheme requires a future codec upgrade. Check the codec README Loop 2 extension points." | `{ scheme: number }` -- the unsupported scheme value |
| `transcode-failed` | Basis transcoder returned 0 bytes or threw an error during transcode. The payload may be corrupt or the target format incompatible with the DFD model. | "Verify the KTX2/Basis asset payload is valid. Check that selectTranscodeTarget returned a compatible format." | `{ sourceFormat: GPUTextureFormat, targetFormat: GPUTextureFormat }` -- the source + requested target |
| `ktx2-encode-failed` | Basis encoder returned 0 bytes or threw. May indicate invalid dimensions, incompatible pixel format, or encoder-side memory exhaustion. | "Check input texture dimensions and pixel format. Verify the Basis encoder WASM was built correctly (pnpm --filter @forgeax/engine-codec build:wasm)." | `{ mode: string, reason: string }` -- the encode mode + failure reason |

### Error propagation

Codec errors are consumed in two contexts:

1. **Direct consumption** -- AI users calling `decompressZstd` / `parseKtx2` directly
   get the full `CodecError` with per-code narrowed `detail`.

2. **Runtime transparent pass-through** -- in the runtime's `fetchBinary` gate,
   codec errors are nested in the existing `asset-fetch-failed` error's `.detail`
   field. The types-shared `ErrorCode` union is NOT extended (D-8). AI users
   calling `assets.load(guid, kind)` never see `CodecErrorCode` directly; they see the standard
   asset error surface.

## Loop 2 extension points

> [!NOTE]
> This section documents the 3 frozen contract seams that Loop 2
> ("texture block-compression") consumes without re-designing (AC-13).
> Do not delete or rearrange these sections -- they are the hand-off interface.

### Contract seam 1: `compression` sidecar field

The `AssetCompression` union (`packages/types/src/index.ts`) currently has:

```ts
type AssetCompression = 'none' | 'zstd';
```

**Loop 2 extension**: May add combination literal members such as `'zstd+bc7'`,
`'zstd+astc'`, or `'basis-uastc'` to represent block-compressed payloads wrapped
in zstd supercompression. The field is consumed in `PackIndexEntry.compression?`,
`ImageMetadata.compression?`, `LoaderEntry.compression?`, `listCatalog()` return
rows, and `importSettings`. Loop 2 adds members here; runtime `fetchBinary`
gate branches on the string value.

### Contract seam 2: runtime single decompression gate

The runtime decompression happens in exactly one place:
`fetchBinary(url, { compression })` in `asset-registry.ts`. The gate currently
branches on `compression === 'zstd'` to call `decompressZstd`. Raw bytes are
returned to loaders unchanged in all other cases.

**Loop 2 extension**: After zstd decompression returns raw bytes, Loop 2 adds a
second gate for block-compressed payloads: `basis_transcoder.wasm` transcode from
the universal intermediate format to the platform's native block format.
The transcoder hangs **after** the zstd gate -- same `fetchBinary` entry point,
no second decompression point (contract seam 2 constraint).

### Contract seam 3: KTX2 container parser

`parseKtx2(bytes)` returns `Ktx2Parsed` with `header.supercompressionScheme`,
`levelIndex` (per-level `byteOffset` / `byteLength` / `uncompressedByteLength`),
`dfd.colorModel`, and `sgd`. `ktx2LevelsToRGBA` handles scheme=0 (uncompressed)
and scheme=2 (zstd) only.

**Loop 2 extension**: For scheme=1 (BasisLZ), `parseKtx2` already provides:
- `levelIndex[].byteOffset` and `levelIndex[].byteLength` -- the block payload
  bytes to feed into `basis_transcoder.wasm`
- `dfd.colorModel` and `dfd.colorPrimaries` -- color space metadata for upload
- `sgd` (supercompression global data) -- the BasisLZ codebook

Loop 2 adds a third arm to `ktx2LevelsToRGBA` for scheme=1 that calls the
transcoder instead of `decompressZstd`. The container parser itself does NOT
change -- Loop 2 reuses the same `parseKtx2` export (contract seam 3 constraint).

### Compression ratio baseline (AC-05)

zstd compression on representative mesh `.bin` data achieves approximately 30-60%
size reduction (f32 vertex data). The AC-05 assertion floor is `>= 30%` on the
compression ratio (compressed / original <= 0.70). Loop 2 may establish separate
ratios for block-compressed textures.

## Package metrics (AC-11)

The codec package declares all 5 `MetricKind` entries in
`package.json#forgeax.metrics`:

| Metric | Status | Reason |
|:--|:--|:--|
| `bundle-size` | enabled | Measures decode entry dist bundle (`dist/index.mjs` gzip). Runtime decode dependencies include the embedded WASM payload and the pure-JS initialization fallback. |
| `fps` | disabled | Pure-function library, no render-loop impact |
| `bench` | disabled | No performance-sensitive hot paths to benchmark in isolation |
| `gate` | disabled | No codec-specific gates beyond metric declaration itself |
| `spike-report` | disabled | No spiking concerns for a deterministic pure-function library |

## Build-time encode subpath

The `/encode` subpath (`@forgeax/engine-codec/encode`) exports `compressZstd`
for build-time use only. It is consumed by `vite-plugin-pack`'s
`compress-artifact.ts` SSOT function. Runtime code must never import from this
subpath -- enforced by `check-image-pipeline-isolation.mjs` path d (AC-09).

## Related documentation

- `packages/runtime/README.md` -- `fetchBinary` automatic decompression gate
- `packages/pack/README.md` -- `compression` field in pack-index row schema
- `skills/forgeax-engine-assets/SKILL.md` -- AI user-facing asset pipeline
- `docs/superpowers/specs/2026-07-06-asset-compression-pipeline-roadmap-design.md` -- two-loop roadmap

The target selector returns `TranscodeTargetFormat`, derived from the codec's
supported Basis target inventory. Both raw Basis and KTX2 return `TranscodedTexture`;
its mip bytes match the declared GPU format. EAC R/RG targets use the native Basis
EAC enums, and uncompressed R8/RG8 fallbacks compact RGBA32 inside Codec. Consumers
upload those bytes directly and do not apply another channel conversion.

KTX2 metadata parsers receive only their indexed byte section. Descriptor samples
are bounded again by their DFD block; integer reads cannot escape a supplied
Uint8Array view into neighboring metadata or pixel payloads.
