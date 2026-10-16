# @forgeax/engine-assets-runtime

Catalog/Pack reads accept the shared `PackageFetcher` and `PackageRequest` contracts
from Types. Bounded retries use `cache: 'reload'` after transient HTTP failure;
native adapters preserve this cache-bypass intent. Transport and disk checksums
do not replace the loader's artifact length/digest verification. See the concrete
[WeChat resource reader](../platform-wechat/README.md#remote-publications-and-disposable-disk-cache)
for download, cancellation and disposable persistent storage semantics.

## MaterialAsset 唯一成功路径

Runtime 负责 `paramSchema -> derive -> compile/reflect -> cook/load -> extract/record`
中的 load 与 extract/record 消费：按 GUID 读取 producer 已 cook 的 artifact、
receipt、`coordinateSet` 与 `physicalUvScale`，验证 `layoutIdentity` 后交给
render owner。缺失或 stale 时 inspect、修复 producer 并 recook；不会在 runtime
编译 WGSL 或补写 app 侧坐标。

> [!CAUTION]
> 只按结构化 `code`、`detail`、`hint` 恢复；不要复制 source-owned error union，
> 也不要从 URL 或数组顺序重建 asset identity。

## Authoring and recovery index

## 灯光资产 runtime 入口

三条最短入口：

1. 场景 payload 通过 `refs` 往返 `SpotLight.iesProfile` 与 `SpotLight.cookie`；零 handle 表示字段缺席。
2. `IesProfileAsset` 由默认 loader 读取 cooked bytes；runtime 只消费 payload，不读取 `.ies` 源文本。
3. Cookie 通过普通 `TextureAsset` loader/load 状态进入 render；Catalog 不创建旁路 registry。

runtime 只读 producer 已发布并验证的 projection。失败读取 `code`、`detail`、`expected`、`hint`；修复 source/producer 后以同一 authored GUID 重建并重试。`current`、`stale`、`lastKnownGood`、`verified` 各自保留证据边界。

For extended lighting, runtime consumes the same GUID-addressed published
projection for IES and Cookie and passes Probe `irradiance`/`radius` facts to
the renderer owner. It does not own a probe grid, capture, bake, visibility
kernel, Sky contributor, or specular path. `accepted`, `lastKnownGood`,
`recovered`, and `verified` remain separate receipt states; unavailable GPU
resources stay explicitly unavailable.

## Material contract index

The runtime loader reads the Pack publication by GUID and exposes a read-only
projection to render. Root and child material loading preserve validated explicit
`staticSwitches`, including `false`, so extraction consumes the published feature
selection rather than restoring Standard defaults. Runtime values and module slots
are data, while compiler context is a closed input; no material macro, feature define, cook, or DDC
write belongs here. Preserve the layered identities
`materialContractDigest`, `sourceClosureDigest`, `layoutIdentity`,
`programIdentity`, `cookIdentity`, and `materialPublicationIdentity`, and
compare `current` with `generation` before sending the first producer
divergence back through cold-cook and receipt/artifact verification.

The shortest static consumer path is `configurePackIndex(url)` followed by
`loadByGuid<ConcreteAsset>(guid)`. The public barrel exposes the concrete
17-kind types and returns durable payloads, dependency `refs`, and local
`artifacts`; it does not mint a generic GUID-to-handle materializer. Animation,
tileset, render, audio, and VFX owners perform their own World or Host
projection after load.

Catalog source is selected once per host mode: `configureRuntimeBinding(binding)`
owns the scope/generation-bound catalog. Vite production bindings point to the
emitted static `pack-index.json` snapshot with the same scope and generation;
they retain no development import transport. `configurePackIndex(url)` also
accepts that snapshot for an isolated static consumer without an expected scope.
A supplied expected scope remains strict; bare row arrays cannot satisfy it.
After `configureRuntimeBinding`, selecting a production catalog URL with
`configurePackIndex` retains that scope/generation fence, including absolute URLs.
They are alternatives, not a sequence. App demos can use the shared
`configureRuntimeAssetCatalog` helper from `@forgeax/apps-shared` to keep this
selection as one SSOT and avoid overwriting a scoped development URL with
`/pack-index.json`.

Catalog `packageUrl` identifies a cooked package; raw source locations belong to
`sourcePath`. An imported output with a producer-declared `missing` projection
requests the injected ImportTransport before reading a body. Without that
transport it returns `asset-not-imported`. A raw source in `packageUrl` is malformed:
its original `asset-parse-failed` survives GUID lookup, with no raw fetch or import.

When an existing host supplies both surfaces for the same explicit URL, the
registry accepts one `CatalogReplica` baseline and shares it with GUID loads.
Different URLs remain separate per-registry authorities; no process-wide URL
cache is introduced. A source carrying `expectedRevision` or `expectedScope`
is a stricter admission boundary: the registry re-runs that source's
enumeration instead of seeding it from an unscoped URL cache, so a rejected
revision or scope can never appear as an accepted catalog row.

Read structured errors by `code` and use `hint`/`detail` to inspect, rebuild or
cold-cook, refresh LKG, or attach a capability. Host capability loss affects
install/play/execute only; descriptor loading stays available.

The runtime matrix is the same 17 durable kinds as `SCRIPTABLE_PACK_ASSET_KINDS`:
`mesh`, `material`, `scene`, `texture`, `equirect`, `sampler`, `font`,
`render-pipeline`, `tileset`, `video`, `skeleton`, `skin`, `animation-clip`,
`animation-graph`, `audio`, `particle-effect`, and `ies-profile`.

The authority map is [`schemas/asset-authority.schema.json`](../../schemas/asset-authority.schema.json). Runtime reads Catalog decisions and validated Pack/DDC projections by GUID; it never writes Pack, Meta, DDC, or authoring state.

## Transient Mesh geometry reads

`AssetRegistry.readMeshGeometry(guid)` reads the existing published Mesh root for
source processing. It returns `MeshGeometrySource`: independently owned vertices,
attributes, optional indices, submeshes and AABB. The same Pack decoder verifies
artifact lengths, digests and geometry metadata; invalidation fences late reads.
The registry retains package metadata and ordinary read caches, but does not
admit the decoded Mesh root or recursively load its render dependencies.

| Consumer intent | API | Result authority |
| --- | --- | --- |
| Process base geometry and discard the source | `readMeshGeometry` | Owned geometry data |
| Render a Mesh with its published dependencies | `loadByGuid<MeshAsset>` | Complete Asset closure |
| Rebuild missing or stale source output | Existing producer/import workflow | Published replacement |

> [!IMPORTANT]
> Geometry data has no Asset `kind`, material slots, LOD dependencies or Ready
> receipt. Submesh slot indices remain intact for an explicit caller-owned
> material mapping. Render or mode-switch consumers must separately load their
> required dependencies through the ordinary readiness path. This read neither
> imports missing source nor invalidates existing assets to reclaim memory.

## Material publication inspection

`inspectMaterialRuntime(ready)` is the read-only, GUID-addressed inspection
projection after the `MaterialReady` gate. Its first-level identity is
`materialGuid`, `publicationGeneration`, `specializationKey`,
`artifactDigest`, and `readiness`. Expand `sourceClosure`,
`parameterContract`, `refs`, and `receipt` only when owner debugging requires
them. The returned `status: 'Ready'` is retained for compatibility with the
runtime result; `readiness: 'ready'` is the machine-readable state field.

`AssetRegistry.getMaterialReadiness(guid)` retains this byte-free `MaterialRuntimeInfo`
or the current `MaterialLoadError`. It is the synchronous status/inspection path;
it does not allocate shader bytes during renderer observation. Complete record
reads use `loadMaterialReadyByGuid`, whose returned program bytes belong to that
caller and cannot mutate another read or the installed program. The existing
material artifact registry retains canonical programs by their validated
specialization key, byte content, parameter schema and ABI; GUID readiness does
not retain another copy of those programs.

Fixed publication capture also reuses that existing program owner's bytes when
the disposable raw read cache has retired. The frozen artifact digest selects
the installed program, and the ordinary artifact reader still checks each
descriptor's length and integrity before export. Cold programs retain their
bounded source reads; encoded artifacts retain their original transport bytes.

For a built-in Standard material the same snapshot also exposes
`standard.mode`, `standard.layers`, `standard.passFamily`,
`standard.passNames`, and `standard.layerPlanIdentity`. A declared layer stays
in `standard.layers` even when its factor is `0`; an absent layer is missing
from that list. Read `parameterContract.values` for the authored factor and
`receipt.derivedInterface`/`receipt.identity` for the derived interface and
artifact identity. This keeps the physical admission and `forward` versus
`forward + deferred + shadow` decision inspectable without a second registry.

```ts
const info = inspectMaterialRuntime(ready);
const physical = info.standard;
if (physical?.mode === 'physical') {
  console.log(physical.layers, physical.passFamily, info.parameterContract.values);
}
```

Material failure consumers branch on stable kebab-case codes:
`shader-module-not-found`, `material-reflection-binding-mismatch`,
`material-specialization-not-cooked`, `material-parent-not-found`,
`material-value-type-mismatch`, `asset-artifact-missing`,
`asset-artifact-integrity-mismatch`, and `material-cook-record-invalid`.

| Failure | Producer-owned recovery |
|:--|:--|
| `material-parent-not-found` | Inspect the referenced material parent GUID and restore its author source before rebuilding the Pack. |
| `material-value-type-mismatch` | Inspect the selected shader parameter schema, correct the authored value type, then rebuild the owning material. |
| `material-specialization-not-cooked` | Cook the selected shader/material specialization and republish its complete manifest. |
| `material-reflection-binding-mismatch` | Inspect the cooked shader reflection and material bindings, then rebuild the inconsistent producer output. |

Ray-hit and Card-capture programs use the same complete publication, byte-integrity
gate and ShaderRegistry installation. Select the authored pass with its closed
`pipeline: ray` context: `ray-hit` selects `cs_surface`, and `card-capture` selects
`vs_card` with the fixed `fs_card` fragment entry. Neither carries the ordinary
raster submission ABI. Missing, corrupt or stale bytes from either published
derivative reject the whole candidate publication; the previous accepted set stays
intact. An omitted context does not resolve to another program. Installing the
projection creates no GPU module and enables no GI or Card work.
`programs[]` exposes each published program's `specializationKey`, `artifactDigest`,
`byteLength` and `selections[]` (authored pass, exact context, entry and raster
address when applicable). Use it to distinguish an absent ray derivative from
a present program that does not match the requested context. It contains no
shader source or GPU objects. In a last-known-good result the list belongs to
`lastKnownGood` and its generation; the failed replacement remains explicit.

Read `expected`, `actual`, `hint`, `retryable`, and `recoveryActions` when
present. Do not infer readiness from a transport URL, a shader manifest, a
natural-language message, or a fallback material.

The same inspection seam accepts producer lifecycle observations for a
material that is pending, failed, or being held as last-known-good. These
projections preserve the material GUID, generation, structured failure and
recovery hint without copying producer state into the renderer. A pending
observation means the cook/resident work has not completed; a failed
observation points back to the producer error; a last-known-good observation
is explicit and still carries the failed current generation. Follow
`inspect -> rebuild/recook or refresh LKG -> loadByGuid` through the producer
owner. Runtime never guesses from URLs, silently repairs a stale artifact, or
creates a parallel readiness ledger.

## Plugin-owned loader registrations

`assetsPlugin(registry)` provides the renderer-owned registry to a Cordis
realm. `assetLoaderPlugin(loader)` and `packLoaderPlugin(loader)` register one
loader as a reversible Fiber effect, so removing a feature cannot leave a stale
kind handler behind. GUID, Catalog, Pack, and payload identity remain owned by
`AssetRegistry`; the plugin controls only the registration lifetime.

```ts
const feature = await app.pluginContext.plugin(assetLoaderPlugin(dialogueLoader));
const dialogue = await app.renderer.assets.loadByGuid<Dialogue>(guid);
await feature.dispose();
```

Use `registry.loaders.register(...)` directly only in a lower-level host that
owns the matching disposer itself. App/game capability composition should use
the plugin helpers so registration and teardown share one Cordis lifecycle.

| Lifecycle | Runtime action | Recovery |
|:--|:--|:--|
| `current` | Load the validated projection | Inspect evidence if a dependency fails |
| `missing` / `cooking` | Return structured not-ready failure | Rebuild in the studio/build host |
| `stale` / `failed` | Do not use raw source | Cold cook, or explicitly preview last-known-good |

Use [`check-asset-authority-audit.mjs`](../../scripts/forgeax/check-asset-authority-audit.mjs) to inspect the owner and runtime-source conclusion before changing a producer.

## External provider cold-load (custom kinds)

Custom provider kinds stay outside the built-in `Asset` union, but they still
use the same producer and runtime authorities. The smallest executable example
is [`voxel-provider-cold-load.integration.test.ts`](src/__tests__/voxel-provider-cold-load.integration.test.ts).

> [!IMPORTANT]
> The provider owns source discovery and `NativeCookerRegistry`; the runtime
> only consumes the verified Pack/Catalog projection. It never invents a typed
> Pack or Preview kind, mints a GUID, or treats a transport URL as identity.

```mermaid
flowchart LR
    provider["provider source + GUID"] --> cook["NativeCookerRegistry.run"]
    cook --> artifact["payload + refs + artifact bytes"]
    artifact --> pack["Pack v2 publication tuple"]
    pack --> catalog["Catalog GUID row"]
    catalog --> load["AssetRegistry.load + integrity + decoder"]
```

| Boundary | Owner fact | Fixture proof |
|:--|:--|:--|
| Provider/Cook | source key, GUID, payload, refs, artifact bytes | `NativeCookerRegistry.runDraft/run` |
| Publication | one scope/generation/digest/output-set tuple | `createRuntimePackPublication` + `projectRuntimePack` |
| Catalog | producer projection and dependency relation | `projectExternalCatalogEntries` |
| Runtime | GUID lookup, byte length/SHA-256, decoder result | `AssetRegistry` + `AssetArtifactReader.read` |
| Recovery | decoder lease revocation and uncached reload | dispose lease, observe `asset-decoder-missing`, reinstall and reload |

Run the complete provider-to-runtime path with:

```bash
pnpm exec vitest run --project='@forgeax/engine-assets-runtime' \
  packages/assets-runtime/src/__tests__/voxel-provider-cold-load.integration.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

The fixture deliberately uses a custom `voxel-shape` decoder only; it is an
asset-runtime/provider contract probe, not the Wave 2 Voxel product or a
replacement for the standard 17 built-in asset kinds.

> [!IMPORTANT]
> Runtime material consumption is `configurePackIndex` -> `loadByGuid<MaterialAsset>` -> cooked readiness -> `world.internSharedRef`. The registry returns the loaded payload and follows its dependency graph; it does not create an app-owned shader artifact or a parallel material authoring surface. Interning preserves one handle per catalogued payload identity inside a World; explicit `world.allocSharedRef` calls remain independent resources.

Different GUIDs with the same validated, resolved artifact URL and SHA-256
transfer descriptor reuse one physical transfer, including across packages.
Media type, encoding, decoded length and integrity remain part of its identity;
URL equality alone never admits reuse.
Each GUID still decodes and verifies its own bytes and retains its own load state.
Failed reads are retryable through the existing bounded package reader, and GUID
invalidation or registry clearing discards shared transfers as well as the
affected GUID cache. An old pending transfer cannot replace a newer read.

## MaterialAsset runtime recovery

Load a root and any inherited child through the same GUID catalog. A ready material must have its effective `passes`, `values`, `parent` chain, per-slot `coordinates`, references, artifact, and receipt. For a failure, switch on the structured code, read `detail` and `hint`, repair the package or cook output, and retry the same GUID. A missing cook is not a valid fallback to runtime compilation.

A values-only child reuses the cooked program projection of its parent-chain
owner. Program lookup follows the same catalogued parent payloads as contract
resolution; it does not substitute the authored module name for the installed
specialization identity. Child values remain governed by the root contract.

The runtime asset layer: catalogue an asset by GUID, load its payload + all
transitively-referenced sub-assets, resolve a `Handle` back to its payload, and
wire the default loader set. Tier 2.1 package extracted from
`@forgeax/engine-runtime` (feat-20260705-runtime-tier2-decomposition M1) so an AI
user loads only the asset-cluster concept surface — not the whole renderer — when
the task is "get an asset into the World".

## AssetEvidence SDK boundary

`AssetRegistry.inspect(guid)` and `verifyByGuid(guid)` expose the injected SDK side of the same `AssetEvidence` chain: source declaration, catalog `packageUrl`/`cookReceiptUrl`, producer `CookReceipt`, Pack v2 artifact verification, and optional runtime state. The registry does not import the Node CLI, Vite, or filesystem policy. Call `configureAssetEvidence(source)` in a host that can supply those facts; without it the result is explicit `unknown`/capability-missing evidence.

Cook states are not interchangeable: `notCooked`, `ready/current`, `ready/stale`, and `unknown` each describe a different recovery action. Package/artifact verification separately reports `notChecked`, `passed`, or `failed`. Follow `.code` and `.hint`, repair the producer or package, and rerun the probe; never convert a missing capability into passed evidence.

## 30-second self-introduction

- **`AssetRegistry`** — instance-per-engine GUID -> payload catalogue. `catalog` /
  `loadByGuid` / `lookup` / `parseGuid` / `inspect` / `resolveName` / `packageOf` /
  `rename` / `invalidate` / `invalidateAll` / `instantiate`. Post-D-17 it stores
  the PAYLOAD and mints no handles (scene GUID resolution interns column handles
  through `world.sharedRefs.acquire('Kind', payload)`). Each Scene resolution
  releases its temporary grants after instantiation or rollback; repeated
  instances still share the same payload handle. `Renderer.assets` is an `AssetRegistry`
  assembled by `createRenderer` (which injects the post-spawn hook and concrete
  Web Audio loader; video is a default loader — see D-1 / D-2).
- **`HANDLE_CUBE` / `HANDLE_TRIANGLE` / `HANDLE_QUAD` / `HANDLE_SPHERE` /
  `HANDLE_CYLINDER` / `HANDLE_NINESLICE_QUAD`** — process-static builtin mesh
  handles (reserved ids 1-6, `< BUILTIN_BASE`), resolved through
  `BuiltinAssetRegistry` (never reference-counted). Pair with `MeshFilter`.
- **`resolveAssetHandle(world, handle)`** — two-tier (builtin / user-tier
  `world.sharedRefs`) handle -> payload resolution; returns a closed-union error
  (`shared-ref-stale` / `shared-ref-released` / `asset-not-found`) so callers
  distinguish "re-acquire handle" from "re-load asset" from "check GUID".
- **`LoaderRegistry` + `wireDefaultLoaders(registry, extraLoaders?)` +
  `createDefaultLoaderRegistry(extraLoaders?)`** — the default set covers the
  complete 17-kind durable `Asset` union, including both inline and artifact
  forms. `createRenderer` may replace the durable audio descriptor loader with
  its concrete Web Audio catalog-entry loader; the registry still has one
  owner per kind.

### 30s hands-on example

```ts
import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

// A builtin mesh handle needs no registration ceremony:
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
).unwrap();

// Imported meshes normally use an empty override vector. AssetRegistry
// recursively loads MeshAsset.materialSlots defaults; Render inherits them.
world.spawn(
  { component: Transform, data: {} },
  { component: MeshFilter, data: { assetHandle: importedMeshHandle } },
  { component: MeshRenderer, data: { materials: [] } },
).unwrap();

// Catalogue + load a GUID-addressed asset (dev / inline path):
const guid = assets.parseGuid('cbe42beb-8975-5096-b3a1-3dda4cb4c077');
const res = await assets.loadByGuid(guid); // -> Result<payload> (D-17: payload, not handle)
```

## API surface

| Symbol | Kind | One-line |
|:--|:--|:--|
| `AssetRegistry` | class | GUID -> payload catalogue + loader dispatch + scene instantiate |
| `HANDLE_CUBE` / `HANDLE_TRIANGLE` / `HANDLE_QUAD` / `HANDLE_SPHERE` / `HANDLE_CYLINDER` / `HANDLE_NINESLICE_QUAD` | const | builtin mesh handles (ids 1-6) |
| `BuiltinAssetRegistry` / `BUILTIN_*` / `BUILTIN_BASE` | const | process-static builtin payloads and reserved slot boundary; the shared vertex-layout SSOT is `PROCEDURAL_FLOATS_PER_VERTEX` from `@forgeax/engine-geometry` |
| `resolveAssetHandle` / `walkMaterialPassesOverSharedRefs` | fn | two-tier handle -> payload resolution |
| `LoaderRegistry` | class | kind -> loader dispatch table |
| `wireDefaultLoaders` / `createDefaultLoaderRegistry` | fn | wire all 17 durable Asset loaders + caller `extraLoaders` |
| `assetsPlugin` / `assetLoaderPlugin` / `packLoaderPlugin` | fn | Provide a registry and bind loader registrations to a Cordis Fiber lifetime |
| `DynamicTextureStore` / `DynamicTextureDevice` | class/type | per-frame dynamic texture upload store; replacement devices invalidate stale transient textures before the next upload |
| `unpackMeshBin` / `UnpackedMeshBin` | fn/type | strict mesh-binary v4/v5 sidecar decode with geometry projection verification |
| `validateTilesetPayload` / `TilesetValidateOptions` | fn/type | register-time tileset payload gate |
| `PostSpawnHook` / `SkinJointResolver` | type | post-spawn hook contract (D-1; runtime injects `postSpawnResolveJoints`) |
| `Asset` / `MeshAsset` | type | re-exported asset union shapes (SSOT `@forgeax/engine-types`) |

Full `AssetRegistry` surface + signatures: source SSOT
`packages/assets-runtime/src/asset-registry.ts`. The load + DDC / pack-fetch
pipeline lives in `packages/assets-runtime/src/registry/load-by-guid.ts`; the
instantiate cluster + hook types in `registry/instantiate.ts`; material
validation in `registry/validate-material.ts`. Pass and sprite-slice validation read the MaterialAsset directly: its first parameter declaration owns each name, and no ShaderRegistry or registry instance participates in these pure checks.

`AssetRegistry.releaseReadCaches()` releases completed raw artifact reads and
returns the number of removed entries. Pending reads keep their shared request
identity and may finish normally. It does not invalidate Catalog rows, payloads,
World handles or GPU resources. Pack bodies also retain adopted publication
metadata and deferred plugin definitions, so this operation retains them. A Host
can call it under memory pressure even while its App is paused.

## Mesh binary v4 loading

[`loaders/mesh-bin.ts`](src/loaders/mesh-bin.ts) is the sole runtime decoder.
It rebuilds the geometry projection from the wire mask, compares schema version,
stride, and digest, validates every byte/cardinality bound, then publishes the
mesh and metadata as one result. Inline-pack loading uses the same loader.

| Failure | Runtime behavior | Next action |
|:--|:--|:--|
| v2/v3 or malformed bytes | closed `MeshBinAssetError` with sourceKey, expected/actual, and recovery hint | Re-cook through the owning importer |
| invalid refs or metadata | no MeshAsset publication | Repair producer refs/Meta and retry |
| failed replacement after a prior load | retain the catalogued last-known-good payload | Inspect evidence, cold-cook, then publish atomically |

> [!WARNING]
> Runtime has no legacy decoder and no re-cook fallback. A white/default mesh
> is not a valid recovery for a malformed artifact.

### Scene instantiation failure atomicity

> [!IMPORTANT]
> `assets.instantiate` and `assets.instantiateFlat` run the renderer-injected
> post-spawn hook as part of one transaction. If joint wiring returns the
> existing `skin-joint-path-unresolved` or `skin-asset-unresolved` result, the
> method returns that exact structured error and removes only the entities,
> hierarchy, mount state, joint publication, and shared-reference grants
> created by that call. Repair the catalogued asset or joint path, then retry
> with the same registry and World; no process or World reconstruction is
> required.

Both instantiation forms preserve the public `Result` helpers on post-spawn
failure: `unwrap()` throws the original structured failure and `unwrapOr()`
returns the caller's fallback. Transaction cleanup precedes that result.
`SceneInstantiateError` is the shared return union for anchor, flat and both
publication-fenced methods. Its Skin members come from the Skinning owner's
closed `SkinError` union, so checking `.code` narrows the matching `.detail`.
The injected `PostSpawnHook` returns that same owned Skin error vocabulary;
it does not transport an untyped error or introduce another Result API.

## Catalog source: enumerate first-class asset rows, then observe row changes

> [!IMPORTANT]
> A catalog is an enumerable complete row set plus subscribable row changes.
> Wire the source, **subscribe before enumerating**, then keep the local view
> keyed by GUID. `CatalogDelta` reports facts only; it never chooses a page
> reload or an editor update policy.

`CatalogSource` is the runtime boundary between `AssetRegistry` and a concrete
catalog transport. Navigation uses `enumerate()` and `subscribe()`;
the public row and delta shapes are `CatalogEntry` and `CatalogDelta` from
`@forgeax/engine-types`. Read those exported types for their complete fields
instead of copying a second schema into a consumer.

Scoped build catalogs retain their identity and authority around the Pack
publication-table wire. Runtime admission checks the expected scope/generation
and authoritative status before the shared Pack decoder restores complete rows
and shared publication envelopes; it never treats wire indices as domain rows.

`CatalogSession` accepts an explicit `lifecycle: 'missing'` row without a
publication as navigation only. A current row, or any row carrying publication
evidence, still requires the complete validated runtime tuple. Loading a declared
GUID calls the source's optional `get(guid)` before reading its Pack. For
`createCatalogSource`, inject the existing `ImportTransport` explicitly: the
producer imports that GUID and returns its published siblings through the same
scope-bound route. Fresh rows retain the source's `expectedRevision` validation;
the Session alone admits them. Enumeration never cooks unused declarations.

Eager decoder closures request their dependencies before package reads; native
plugin definitions retain `references: 'deferred'` and do not cook every declared
reference during installation. Pending reads share one GUID request and retain
source, scope, revision and retirement fences. Newer sibling HMR publications,
removed/re-added GUIDs and disposal reject old settlements. Independent GUID
publication does not cancel an unrelated in-flight graph read; affected roots
and their dependent closures retain the existing invalidation boundary. A custom
source rejection becomes a structured load failure rather than a rejected
Registry promise.

Native GUID resolution returns a `Result`: only an accepted Catalog can produce
`ok(undefined)` for a genuinely absent GUID. Catalog enumeration, scope,
authority, revision and parse failures retain their original error through
`loadByGuid` and native plugin definition reads, including when an earlier
cache exists. Failed admission never becomes `asset-not-found` or triggers an
Import transport fallback. Material publication reads propagate the same source
failure through their existing rejecting Promise boundary. Inspect that original
error before diagnosing a missing declaration or attempting producer recovery.

A source without a URL that provides `openPackage()` also owns payload delivery. Its rows remain the
load authority when a Registry already has a development runtime binding; the
old catalog URL must not redirect admitted publications to the disk importer.
An explicitly different URL catalog retains its separate navigation authority.

### Producer fact parity

> [!IMPORTANT]
> Static entries and URL/fetch entries have the same neutral `CatalogEntry`
> shape. `parseCatalog()` preserves `packageId`, `provenance`, `revision`,
> `sourceKey`, `sourceIndex`, `relations`, and `diagnostics`; it never derives
> them from `relativeUrl`, `sourcePath`, or array position.

| Runtime input | What is checked | What is not done |
|:--|:--|:--|
| Static `entries` | Optional expected revision continuity | No payload decode or re-import |
| URL `fetch` | JSON shape, required locator, and optional expected revision | No identity reconstruction from the URL |
| Malformed row | Structured `asset-parse-failed` with `expected` and `hint` | Never converted into an empty successful catalog |
| Revision mismatch | Structured failure with expected and actual revisions | Never applied over the last verified snapshot |

The source is a neutral facts boundary, not an asset decoder. Decode, upload,
and GPU work remain in their existing loader paths; the catalog parser only
enumerates facts and locators.

`assets.sourceKeyOf(guid)` reads the accepted source key through the existing
GUID index without fetching or copying the Catalog. Unknown GUIDs and inline
assets without producer metadata return `undefined`; Catalog changes and
retirement are visible on the next read.

```ts
const unsubscribe = assets.subscribeCatalog((delta) => {
  // Delete first, then replace added/changed rows by their stable GUID.
  for (const guid of delta.removed) rowsByGuid.delete(guid.toLowerCase());
  for (const row of [...delta.added, ...delta.changed]) {
    rowsByGuid.set(row.guid.toLowerCase(), row);
  }
});

const snapshot = await assets.enumerateCatalog();
if (!snapshot.ok) {
  console.error(snapshot.error.code, snapshot.error.hint);
  // Fix the source configuration or catalog endpoint, then call enumerateCatalog() again.
} else {
  for (const row of snapshot.value) rowsByGuid.set(row.guid.toLowerCase(), row);
}

// Safe to call more than once.
unsubscribe();
unsubscribe();
```

For a same-GUID authored Surface recook, subscribe before the first
`enumerateCatalog()` call. Treat only an authoritative `changed` row as a
cutover request: call `assets.invalidate(row.guid)`, await
`assets.loadByGuid(row.guid)`, and replace the live `MeshRenderer` material
handle only after that complete load succeeds. A degraded or incomplete
publication keeps the previous handle and its cooked programs alive.

The material cook receipt carries the same Pack publication generation as the
Catalog row. After a Surface `dynamicInput` schema change, create a new
`ReadonlyDynamicInputPage` from the freshly loaded declaration and revalidate
its records before drawing. A page derived from the previous declaration is
not compatible merely because its byte stride happens to match. Completed
frame observations remain bound to their original frame, device, graph,
texture, readback, program, and publication identities; a late observation is
evidence for that old submission, never permission to overwrite the live
material. Dispose the Catalog subscription and clear the source when the host
stops.

### Delta and refresh ownership

| Delta set | Carries | Consumer action |
|:--|:--|:--|
| `added` | complete new `CatalogEntry` rows | insert/replace by lowercase GUID |
| `changed` | complete replacement `CatalogEntry` rows | replace by lowercase GUID |
| `removed` | stable GUID strings | remove by lowercase GUID |

The producer emits no delta when its final catalog projection is unchanged.
Source-only byte changes likewise are not forged into a row change. A browser
host that needs those bytes to refresh explicitly selects its own policy (for
the Vite adapter, `reloadAssetHost()`); an editor can instead merge the delta
without recreating its realm. The registry does not import Vite or infer either
policy.

### Recovery and static sources

Call `setCatalogSource(source)` before enumeration. Replacing a source disposes the
previous producer subscription; call `clearCatalogSource()` during host teardown
to remove the active transport and replica listeners without clearing payload caches.
Without a source,
`enumerateCatalog()` returns the structured `catalog-source-unconfigured`
error; endpoint and parse failures remain structured results as well. Inspect
`.code` and `.hint`, repair the external condition, then enumerate again — a
failed enumeration is not a permanent result.

When a source returns `asset-parse-failed`, branch on `.expected`, `.hint`, and
`.detail` rather than `.message`. For a stale revision, keep the last verified
catalog, repair or re-fetch the producer revision, and enumerate again.

Subscribe before the first enumeration to avoid the consumer-side missed-event
window. If a consumer subscribed late or needs to resynchronise after a
transport interruption, enumerate again and merge the returned complete rows
by GUID. A static source may safely return an idempotent no-op unsubscribe: it
has no continuing change transport and must not manufacture deltas.

## Error model

`AssetRuntimeErrorCode` is the package's closed error-code SSOT (exhaustive
`switch (err.code)` without `default`; TS guards completeness). Read the source,
don't duplicate the member list — `packages/assets-runtime/src/errors/asset.ts`
(grep `export type AssetRuntimeErrorCode`). Each error object carries
`.code` / `.expected` / `.hint` / `.detail`. `RendererError` (in
`@forgeax/engine-runtime`) composes `AssetRuntimeError` into its onError fan-out
union, so a dropped arm is a compile error.

## Dependencies

`@forgeax/engine-{codec, ecs, geometry, graphics-extras, image, pack, rhi, shader, types}`.
Never imports `@forgeax/engine-runtime` or an audio backend: runtime injects the
post-spawn hook and concrete audio catalog-entry loader at `createRenderer`.

## Runtime image bytes decoder (`decodeImageBytes`)

`decodeImageBytes(bytes, mime, opts?)` is the runtime SDK entry for AI users
who already hold image bytes in memory (fetched from a URL, embedded as
base64, produced by an out-of-tree decoder, etc.) and want to feed them into
`world.allocSharedRef('TextureAsset', pod)` + `GpuResourceStore.ensureResident`
without the disk-side importer / pack build pipeline in the loop. It is the
runtime counterpart to the build-time `.bin` / `.ktx2` texture loaders --
those stay authoritative for shipped assets; `decodeImageBytes` covers the
"bytes only exist at runtime" case that static loaders cannot serve
(tweak-20260714).

### Signature

```ts
export async function decodeImageBytes(
  bytes: Uint8Array | ArrayBuffer,
  mime: string,
  opts?: { colorSpace?: 'srgb' | 'linear'; mipmap?: boolean },
): Promise<Result<TextureAsset, ImageError>>;
```

- `bytes` -- encoded image byte stream (PNG or JPEG). Both `Uint8Array` and
  `ArrayBuffer` accepted; the function does not take ownership.
- `mime` -- byte-stream mime type. v1 whitelist: `'image/png' | 'image/jpeg'`
  (see boundaries below).
- `opts.colorSpace` -- `'srgb'` (default) or `'linear'`. Derives POD `format`:
  `srgb -> 'rgba8unorm-srgb'`, `linear -> 'rgba8unorm'` (mirrors the
  build-time `packages/image/src/image-importer.ts` `colorSpaceToFormat`
  rule -- one SSOT, no drift).
- `opts.mipmap` -- `true` (default) or `false`. When `true`, `mipLevelCount`
  is computed by the existing `numMipLevels({ width, height })`; when
  `false`, `mipLevelCount === 1`.

### v1 boundaries (explicit non-goals)

The function is intentionally a thin bridge from bytes to a `TextureAsset`
POD. What it does NOT do:

- **No network I/O.** `decodeImageBytes` never `fetch`es; the caller supplies
  bytes.
- **No GPU upload.** The POD is fed into the existing
  `world.allocSharedRef('TextureAsset', pod)` +
  `GpuResourceStore.ensureResident` path -- the upload primitives are not
  duplicated or replaced.
- **v1 supports PNG / JPEG only.** GIF / WebP / SVG / AVIF / KTX2 / HDR
  (`.hdr`) fall to `image-format-unsupported`; convert offline (or
  reach for the build-time importer, which handles a wider set) rather
  than expanding this API's mime table.
- **Not a replacement for the static texture loader.** Shipped `.bin` /
  `.ktx2` continue to flow through the pack pipeline (`loadByGuid`); this
  API only covers the runtime-only-bytes case (progressive disclosure --
  AI user sees the smaller, more focused surface).
- **Not a Node / server-side decoder.** Requires an environment with
  `createImageBitmap` + `OffscreenCanvas` (browser main thread or Worker).
  Missing capability surfaces as a structured `image-decode-failed` error
  (never a silent broken POD).

### Error codes (closed union subset)

`decodeImageBytes` only ever produces the four base `ImageErrorCode` members
listed here; the other atlas / HDR members of the union are not reachable
from this API. Every error object carries `.code` / `.expected` /
`.hint` / `.detail`; `.detail` narrows per `.code` (discriminated union).
Read the source, do not duplicate the member list --
`packages/types/src/index.ts` (grep `export type ImageErrorCode`).

| code | trigger | `.detail` narrows to |
|:--|:--|:--|
| `image-format-unsupported` | mime not in `['image/png', 'image/jpeg']` | `{ actualMime, path?, formatColorSpaceConflict? }` |
| `image-decode-failed` | decoder rejected bytes, or env lacks `createImageBitmap` | `{ reason, path? }` |
| `image-dimension-out-of-bounds` | reserved; transparent pass-through if the underlying decoder ever surfaces it | `{ requested: {width,height}, limit }` |
| `image-meta-missing` | reserved; not raised by this API in v1 (kept in the union for a single grep-discoverable SSOT) | `{ sourcePath, expectedSidecarPath }` |

### Error self-recovery paradigm

Structured errors with copy-pastable hints -- AI users consume via property
access, never by parsing `.message` (charter P3 explicit failure + P4
consistent abstraction; AGENTS.md Error model). Exhaustive `switch
(err.code)` needs no `default` -- TypeScript guards union completeness at
compile time, so future minor adds to `ImageErrorCode` surface as a
localised type error rather than a silent miss.

```ts
import { decodeImageBytes } from '@forgeax/engine-assets-runtime';

const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
const result = await decodeImageBytes(bytes, 'image/png');
if (!result.ok) {
  const err = result.error;
  // .hint carries an executable recovery instruction (see IMAGE_ERROR_HINTS
  // SSOT in packages/types/src/index.ts); no string parsing needed.
  console.error(err.code, err.hint);
  // ImageError correlates the envelope code with its detail shape, so one
  // discriminant drives both recovery routing and IDE narrowing.
  switch (err.code) {
    case 'image-format-unsupported':
      // err.detail.actualMime -- rejected mime; convert offline
      console.error('bad mime:', err.detail.actualMime);
      break;
    case 'image-decode-failed':
      // err.detail.reason -- underlying decoder message (or "env lacks
      // createImageBitmap" when the platform capability is missing)
      console.error('decode reason:', err.detail.reason);
      break;
    case 'image-dimension-out-of-bounds':
      console.error('too big:', err.detail.requested, err.detail.limit);
      break;
    case 'image-meta-missing':
      console.error('missing sidecar:', err.detail.expectedSidecarPath);
      break;
  }
  return;
}

// Bytes in, POD out -- charter P4 one abstraction, same POD shape as the
// build-time texture loader emits, so downstream does not care about the
// byte source (progressive disclosure: allocSharedRef + ensureResident is
// the same call site as static assets).
const handle = world.allocSharedRef('TextureAsset', result.value);
```

### Isolation gate boundary

`decode-image-bytes.ts` is the SINGLE file in `@forgeax/engine-assets-runtime`
allowed to statically import `@forgeax/engine-image`. The
`scripts/check-image-pipeline-isolation.mjs` (a.2-anti) rule pins this
exact path as its whitelist; the wider runtime and the rest of
assets-runtime remain gated so a future accidental static import falls
loud, not silent.

## Route map

- Import images / glTF / fonts, wire `loadByGuid`, author sidecars: skill
  `forgeax-engine-assets`.
- Full asset-chain narrative (sidecar -> import -> pack-index -> loadByGuid):
  `packages/pack/README.md` + `forgeax-engine-assets/README.md`.
- Runtime image bytes decoding (this package, runtime-only-bytes case):
  see the `decodeImageBytes` section above.
# Static asset evidence

> [!IMPORTANT]
> Static assets load from Pack v2 through `packageUrl`. Runtime-only bytes are the separate exception.

`AssetEvidence` joins `packageUrl`, cook freshness, artifact verification, and optional runtime state. Use `lookup/verify --guid --project --catalog --json` or the SDK `inspect(guid)` / `verifyByGuid(guid)` surface. `notCooked`, `stale`, and `unknown` are distinct recovery states; `unknown` is not verification success.

## Indexed consumer recovery

The runtime consumer follows a read-only handoff:

1. **Inspect** with `assets.inspect(guid)` or `assets.verifyByGuid(guid)` and
   branch on the structured result's `code`, `detail`, and evidence states.
2. **Repair and rebuild or cold-cook** in the producer host. The runtime never
   writes source Meta, Pack, DDC, receipts, or Catalog authority.
3. **Verify** source freshness, receipt, package integrity, and artifact
   status through the injected evidence source or Pack CLI.
4. **Retry** the same GUID after a verified Catalog projection is available.
   Do not parse log strings, compile raw source in the player, or substitute a
   custom mesh/material for a missing engine product.

`AssetRegistry` consumes a producer projection and exposes structured not-ready
errors. It does not register importers, run `runImport`, own DDC lifecycle, or
expand the runtime transport surface. `unknown` means that required evidence
was unavailable; it is never a successful verification result.

## Surface load and recovery

Runtime treats a Standard Surface as published data: `moduleSlots.surface`,
parameters, values, closure identity, and generation are read from the Pack
record. It does not parse WGSL, infer a layer plan, or create a fallback pass.

```text
inspect -> producer rebuild or cold-cook -> atomic publication
        -> verify artifact/receipt/generation -> loadByGuid -> render
```

`programIdentity` and `cookIdentity` describe the compiled program and cook;
`materialPublicationIdentity` describes the published Pack generation; device
generation describes GPU resources only. Device loss therefore rebuilds GPU
state without pretending that a stale source artifact is valid.

## Plugin definitions

The built-in plugin decoder returns a `PluginAsset` without evaluating its program or installing a Fiber. Its reference-consumption policy is deferred; references remain catalog/closure evidence until a plugin explicitly loads them. `readPluginDefinition(guid)` reads definition and publication evidence atomically for the compiled-program fence. Native activation belongs to `@forgeax/engine/plugin`.

`captureAssetPublication` fixes a Catalog row, its complete sibling set and the
source's `openPackage` transport before reading bytes. It preserves raw artifact
bodies, including zstd encoding, while `readArtifact` verifies decoded length and
integrity. Pack's shared `validateFixedPackPublication` checks the portable
envelope and program closure; capture never executes plugins. Domain readiness
still requires `validateAssetPublication` and the normal loaders. URL-backed
Catalog sources and capture share the ordinary Catalog locator resolution.
Artifact reads overlap in batches of at most eight, preserving descriptor error
order and checking every attachment. Shared paths join one byte request; failed
requests remain retryable through the existing transport policy.
Completed resident identity-encoded artifacts reuse the ordinary loader's byte cache and
undergo the frozen descriptor's length and integrity checks again. Encoded bodies
still use the bound transport, preserving their original compressed bytes.
Capture never awaits or populates domain-loader reads: an unfinished or collected
cache hint falls back to the frozen source transport, and capture owns its byte lease.
For plugin siblings, capture freezes each supplied target projection's program
export functions, pure tool contracts and definition evidence before awaiting
transport. After verifying the Pack it invokes only the required `exportSource()`
functions, once per program and target, and immediately clones each result.
Unrelated program exporters are not called.
Source or publication evidence must match the saved Pack. Every plugin requires
explicit execution coverage in at least one target, including an empty contract
when it has no tools; each declared executor needs an artifact in that same group.
The same GUID and program key may have different artifacts across targets.
Neither plugins nor executors are evaluated to fill missing archive content.

## Runtime content

Shared references identify immutable base assets. Managed ECS content entities
publish dynamic values through normal World mutation and block revisions.

| Component | One entity owns | Write |
|:--|:--|:--|
| `RuntimeMaterialValue` | One parameter of one shared material | `asset`, `parameter`, `kind` (number=0, boolean=1, vector=2), numeric `value` array |
| `RuntimeMeshVertices` | One shared mesh's numeric buffers | `asset`, `vertices`, optional `indices`; empty indices retain the base topology |

```ts
const content = world.spawn({ component: RuntimeMaterialValue, data: {
  asset: materialHandle, parameter: 'roughness', value: [0.5],
} }).unwrap();
world.set(content, RuntimeMaterialValue, { value: [0.25] }).unwrap();
world.despawn(content).unwrap(); // Restores the base parameter.
```

> [!IMPORTANT]
> An App Worker bootstrap compiled separately from the Engine must resolve the
> World-owned token before spawning or updating runtime content.

```ts
const materialValue = world.components.resolve(RuntimeMaterialValue.name) as
  | typeof RuntimeMaterialValue
  | undefined;
if (materialValue === undefined) throw new Error('Render profile is missing runtime content');
const content = world.spawn({ component: materialValue, data: {
  asset: materialHandle, parameter: 'roughness', value: [0.5],
} }).unwrap();
```

Keep the content entity handle for updates. Input arrays are copied by managed
storage; resolved asset payloads are read-only consumer data. Mesh projection
rebuilds canonical attributes and bounds from the base vertex layout, removing
offline `distanceField` and `cardLayout` attachments while vertex content is
active. Removing that content restores the original base and its attachments.
Duplicate
material parameters or duplicate mesh content return `asset-invalid-value`;
invalid vertex stride returns `mesh-vertex-stride-mismatch`. Repair the same
content entity and resolve again. Removing or rebinding content invalidates the
old asset as well as the new one. Multiple Renderers observe writes independently.

Mesh registration preserves a finite producer-authored deformation envelope by
unioning it with the position-derived AABB. Smaller authored bounds cannot hide
actual vertices; missing geometry keeps the existing conservative bounds policy.

### Asset readers across realms

`AssetReader` exposes stable `identity` and typed `resolveAsset(handle)` without
a World. `AssetReadSource` accepts a World or reader; `resolveAssetHandle` uses
the same Result contract for both. Render publication owns the receiver's
accepted asset namespace; this seam does not replicate an AssetRegistry or ECS.

## Concurrent load and cleanup contract

| Boundary | Ownership rule |
|:--|:--|
| `AssetRegistry.loadByGuid` | The renderer's catalog, provisional closure and Ready publication share one owner. `invalidate` and `invalidateAll` revoke old publication work before any later write, promotion or rollback. |
| `createAssetRegistry(...).load` | A realm owns its CatalogSession, AssetGraph, Pack reader and decoder leases. Each call observes its own AbortSignal; cancelling it ends only that wait. |
| Shared reads | The realm continues an admitted read even if all current waits cancel, retaining the result for reuse. `dispose` aborts owner I/O, settles queued waits and revokes cache writes. |
| HTTP Pack admission | Malformed JSON/envelopes return a structured parse/package error with a field and locator; they never enter the verified cache. Network failures retain their separate fetch error. |
| Package reads | Catalog, Pack, artifact and loader-binary GETs share one bounded recovery: an interrupted transfer (including a body reset mid-stream) or HTTP 408/429/500/502/503/504 is retried twice, after 250 ms and 750 ms, with `cache: 'reload'`. Aborts and permanent statuses fail on the first request. `asset-fetch-failed.hint` names the last observation and request count; a shipped registry without an import transport still reports `asset-not-imported` for a cooked-package miss, carrying that read evidence in its hint and detail. |
| Cache clearing | Clearing a key or owner prevents pending old reads from filling it again or replacing a newer result. |

Completed artifact reads weakly reference decoder-owned bytes. Concurrent reads
still join one pending result, and a live decoder retains its private writable
view. Collection becomes an ordinary cache miss; invalidation still clears the
GUID read and shared transport hints. This applies to every artifact codec,
without making mutable loader buffers shared between GUIDs.
Realms without `WeakRef` share only in-flight requests and discard completed
read/transfer hints; they do not retain a strong-reference replacement cache.
`releaseReadCaches()` also drops completed weak read and transfer hints on native
memory pressure; active requests and adopted publication/payload identity survive.

The two Registry APIs serve the renderer and the standalone decoder realm
respectively. Choose the owner already supplied by the host; do not create a second
Registry to load the same assets. Their cancellation and invalidation behavior is
covered by `registry-http-contracts.integration.test.ts` and
`asset-request-lifecycle.unit.test.ts`; real-socket read recovery by
`package-read.integration.test.ts`.

Owner-parsed HTTP Pack trees retain object shapes and dense-array lengths for
plugin-definition reads. Numeric mesh/texture arrays do not retain a second set
of index strings or enter the traversal queue one scalar at a time. Every reuse
still checks the current keys, data descriptors, prototypes and unique node
ownership; mutated or custom-reader values keep whole-Pack clone semantics.

With no subscribers, ready-cache hits invalidate only the cached observation.
The sorted ready list is rebuilt when `snapshot()` or a subscriber actually needs it.

### Asset identity lookup

The registry derives object-to-GUID identity once per catalog epoch. Current
catalog identity wins over retained provenance; replacement, invalidation,
and failed-load removal invalidate the projection. Repeated rendering and
scene collection queries reuse the derived index. Mutate catalog content
through the registry's publication operations so identity and catalog epoch
advance together.

### Dynamic image uploads

`DynamicTextureStore` owns GPU residency for video frames and versioned Canvas
material sources. Video keeps per-frame uploads; Canvas supplies a source key,
version, lifetime signal and immutable UV orientation. Uploads default to vertical
flipping; Canvas sources can explicitly preserve top-left UVs. A successful upload publishes its view, while a
failed initial upload publishes nothing and a failed resize retains the previous
view. Source disposal, renderer teardown and device replacement invalidate the
corresponding GPU entries and remove their lifetime listeners. This transient
store remains separate from static TextureAsset residency. Public Canvas authoring
is [`CanvasTexture` in Render](../render/README.md#canvas-textures).

## Runtime publication preparation

The consuming Registry prepares candidate Pack payloads privately with its actual
loaders and services. Candidate rows and bytes are isolated before asynchronous
work; shared mutable buffers and accessor-bearing payloads are rejected. Preparation
does not expose a Ready asset or change the live Catalog. Returned retained readers
clone on demand, and first GUID consumption copies the private prepared payload,
so runtime edits cannot change a fixed version.

Commit consumes an owner-specific candidate once, checks source identity and global
and per-GUID generations, and repeats those checks after provider notification.
App restores its previous plugin provider if that notification invalidates the
candidate. Prepared CPU payloads enter the existing load state; normal GUID loading
still handles dependency readiness and World binding. Public `catalog` never gains
a validation bypass based on a caller-visible object's identity.

Normal Catalog deltas parse only changed rows. Existing load records derive reverse
reference edges for invalidating the affected loaded closure; unrelated records
and accepted Catalog rows survive. Full reconciliation remains the recovery path
for missing revisions. `retainAssetPublications` fixes original transport bytes
and publication/program evidence before decoding requested domain inputs. Retaining
a definition never activates a PluginAsset. World handles and GPU resources remain
owned by their respective consumers.

Material program selection derives vertex-color availability from the mesh and
uses the published ABI vertex inputs to prefer its color program. A shader that
does not consume color can still use a colored mesh; a program requiring color
cannot use a mesh without it. Selection remains unique per Pass, context, address
and consumed color input. Runtime lookup compares the current primitive context
axes directly, independent of field order, without retaining a second key or
selection index for caller-owned projections. Cook identities and diagnostic
context strings keep the existing canonical serialization.

## Optional Mesh distance-field admission

An ordinary Mesh publication may pair a `distanceField.sectionSidedness`
descriptor with asset-local `distance-field.bin`. The existing artifact reader
checks its full digest, then the Mesh loader verifies the supported codec/profile,
current geometry digest, static triangle coverage and source sidedness digest
before exposing `MeshAsset.distanceField`. Both mesh-bin and JSON geometry use
this same admission path; JSON restores canonical typed attribute arrays first.
The loaded field retains copied `artifact.integrity` and `artifact.assetCodec`
facts, including the generation profile, through ordinary AssetReader resolution,
native publication, JSON restore and RenderPublication copying. Generated fields
may lack this identity before admission; runtime consumers must not treat a
geometry digest as evidence of an admitted artifact. Re-export derives fresh
descriptors from the encoded bytes, excluding the loaded identity from those bytes.

| Load case | Result |
|:--|:--|
| Descriptor and artifact omitted | Ordinary Mesh, without field decode or extra request |
| Complete valid attachment | Decoded field and verified artifact identity retained on the loaded Mesh |
| Missing, corrupt, old-policy or mismatched attachment | Structured asset failure with recook recovery |
| Supported Catalog replacement/invalidation | Fresh mesh and asset-local artifact generation |

A bare payload loader cannot assemble an attachment; submit a complete Mesh
product. There is no second field cache. This is asset preparation and loading,
not Renderer field placement, streaming, GPU lifetime management or GI acceptance.

## Terrain publication admission

The ordinary `terrain` loader restores finite height/weight arrays from Pack JSON and validates the subsection roster and declared GUID references. A root pins one complete derived closure: canonical grid vertices/attributes/indices, author-derived height/normal and control mips, conservative bounds and section height/control material bindings. Private publication preparation validates the same closure before adoption. A partial dependency rewrite makes the old root unavailable; it cannot silently repin that object to the new bytes. See [Terrain](../terrain/README.md).

`navigation-mesh` is an ordinary default-loaded POD asset. Its producer owns bake
freshness; [Navigation](../navigation/README.md) validates topology when creating
a realm-local query workspace. Assets Runtime owns no navigation compiler or motor.

## Material loader result

`MaterialReady` contains `{ status: 'Ready', record }`. The validated cooked
record is the sole owner of material identity, generation, source closure,
parameter contract and verified programs. These fields are required on a Ready
record; read them through `ready.record`. Inspection continues to project the
existing detached material lifecycle POD. Program bytes and parameter metadata
are copied before publication, so mutation of the load input does not change
the admitted record.

## Deferred stream artifacts

For `ArtifactDescriptor.delivery: 'stream'`, the GUID Pack loader passes a validated descriptor/HTTP locator in `streams`, while the decoder registry exposes `AssetArtifactReader.locate`. Neither route reads/caches the full body. The native consumer owns media loading: range decoders validate their manifests and fetched windows; UI images and fonts use browser loading through finalized HTML/CSS URLs. UI readiness does not imply that the browser verified the descriptor's SHA-256. Explicit artifact reads still verify complete bodies, and `verifyByGuid` retains its injected evidence contract. Source publication, invalidation and GUID identity retain their ordinary Catalog authority; a locator is a runtime projection. See [audio format and hosting requirements](../audio-webaudio/README.md#long-audio-through-source-meta-and-guid) and [UI companion delivery](../ui/README.md).

## Runtime collision attachment invalidation

Managed `RuntimeMeshVertices` edits publish geometry without source-cooked
`MeshAsset.collision`, just as other geometry-derived attachments are removed.
Physics admission consequently rejects an uncooked edited source before
replacing the committed collider. The producer must recook and publish a fresh
immutable MeshAsset through the ordinary Catalog/shared-reference route.

Completed shared transfers are held weakly: retaining an asset does not also pin
another raw copy of every unique texture, mesh or audio payload. In-flight reads
remain shared; collection is a normal cache miss and refetches through the same
bounded reader and per-GUID validation. Decoder-owned bytes remain independent.

## Native package transport

`PackageFetcher` and `PackageResponse` in `@forgeax/engine/types` describe the
read operations actually consumed by Catalog, Pack, and binary artifact loaders.
Browser `fetch` satisfies the same contract. Native readers return package responses;
they do not install global Fetch or simulate a DOM `Response`. Locators are strings.
`createPackageResponse` in `@forgeax/engine/pack/runtime` owns a copy of retained
bytes, supports one body consumption, and preserves the declared media type.

Supply the reader through `AssetRegistry.setCatalogSource(source, fetcher)` or
`AssetRuntimeAssemblyOptions.fetcher`. A bound Catalog source can override reads
for one retained package. Publication validation, cancellation, bounded retries,
byte length and SHA-256 remain in their existing owners. Artifact integrity uses
WebCrypto when present and the maintained SHA-256 implementation otherwise;
absence of WebCrypto never disables verification.

## GPU mip generation

`prepareMipmaps` and `blitMipmapsSync` accept `arrayLayerCount` for 2D array and
cube textures; omission retains the single-layer 2D path. Every layer samples
only its preceding mip and copies the result back into the same layer. All
layers share one transient 2D scratch chain, preserving sRGB conversion and the
WebGL2 feedback-loop workaround. Renderer residency supplies the layer count
from the existing texture layout. Recovery preparation still records without
submitting, and its owner finishes or discards the same transaction.
