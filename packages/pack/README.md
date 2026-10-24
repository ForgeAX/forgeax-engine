# @forgeax/engine-pack

## Shared material program transport

Published packages with repeated cooked material programs or selection ABIs use
the `pack-material-programs/2` envelope: one complete Pack plus package-local
`programs` and `abis` tables. The transport replaces `material-cook/4` program
records with bounded integer references, and each table program's
`selections[].abi` with a reference into `abis`, since many specializations share
one reflected ABI. Decode restores readonly sharing before normal
Pack, publication, artifact and material validation. Material parameters, GUIDs,
receipts, references and specialization facts remain in their original records.
Plain packages without repeated programs keep their existing envelope.
Malformed references, non-object table records, unknown envelope fields and
unused table entries fail closed. There is no process-wide intern pool.

`encodeMaterialProgramWire` and `decodeMaterialProgramWire` are available through
`@forgeax/engine-pack/runtime`. Source authoring remains ordinary Pack; the table
is a delivery representation. Browser/native resource reads, current publication
reads and CLI Pack parsing restore it through this same codec. Fresh platform
JSON is decoded before the existing immutable material-fact retention, which
visits each shared program once; custom response readers retain clone semantics.

`encodeAnimationClipSamples` / `decodeAnimationClipSamples` (also on
`@forgeax/engine-pack/runtime`) move an animation clip's numeric sampler arrays
into the f32 `animation-clip/samples.bin` artifact and resolve its
`{ offset, count }` windows; a window outside the artifact fails decode.

Catalog row operations live only in `projection.operations`. Successful producer
rows retain the three public projection axes but no longer duplicate the entire
operation matrix as an undeclared row extension.

## Optional live parameters and author drafts

Authoring recipe: [expose a field in View](../../skills/forgeax-engine-assets/SKILL.md#view-pack-parameters).
`asset inspect <source.pack.ts> --parameters-only --json` uses the same literal
reader as drafts and reports generation/runtime modes, default locations and
binding declarations. The gateway's `asset.inspect` accepts `parametersOnly: true`
for this file-only query. It never requests an inventory or Catalog, imports the
module, or generates; `status: identity` is not target or runtime validation.
Descriptor failures carry the source path and 1-based line/column. Ordinary
inspection remains unchanged. File-local constant package IDs are supported by
the literal reader, including the standard source scaffold's shorthand property.

Existing `parameters` arrays, `default`, `build(context.values)`, zero-parameter
Packs and instance `values` retain their behavior. A descriptor may add
`apply: 'build'` (the default) or `apply: { asset: 'material/body', path:
['values', 'baseColor'] }`. Live parameters are withheld from generation inputs;
the producer fills their otherwise absent output leaves after `build`. Duplicate
bindings and independent assignments to a bound leaf fail validation.

The build entry exports `readPackAuthoringDeclaration`, `readPackDraftSource`
and `createFileSystemPackDrafts`. Declaration reads parse literal descriptors
without evaluating user modules. Dynamic TS stays supported by ordinary builds
but is not automatically rewritten. Opted-in Worker builds remove live metadata
from the execution closure and reject ambient source/reflection bypasses.
Named Scene, light/sky, physics and Skin schemas used by Game3D are admitted as
generation vocabulary; runtime service and plugin imports remain unavailable.

A draft owns sparse edits, at most 256 undo steps and one reusable generation.
Live edits return a field delta; Generate alone runs the Worker; Save alone
atomically updates TS defaults, direct JSON fields or instance overrides.
Revisions derive from file bytes. Refresh performs field-level three-way merging;
conflicts and write failures preserve edits. Managers retain at most 32 documents,
confine real source paths and serialize saves to the same physical file.
Initial open and refresh re-read a source that changes during parsing within a
bounded number of rounds, including a coalesced truncate/write notification.
An unchanged unsupported declaration remains an error; a continuously changing
opening fails with a source revision conflict instead of admitting stale bytes.

## Runtime schema validation

Scanner and CLI declarations select their shared identity fields from `PackIndexEntry`; cooked and runtime catalog projections preserve their own required and optional fields. Scanner executor options use `LoadScriptablePackOptions`, and offline evidence selects the portable evidence inputs while retaining its Node-owned package verification.

Meta and Pack validators are generated from `schema/` by
`scripts/generate-validators.mjs` during the package build. The runtime `./schema`
and `./runtime` entries perform no dynamic code generation. `./schema-build` is
the explicit Node-only entry for Scene and Material validator factories. Generated
source is checked in; `--check` verifies schema/generator freshness. The package's
native-host regression imports both source and built runtime entries with Node's
`--disallow-code-generation-from-strings` flag.

## Producer output

Pack owns the shared asset CLI output contract used by Pack, glTF and FBX.
The Node-only `./build` entry exposes `AssetCliContext` and
`emitAssetCliError`; errors retain `code`, `expected`, `hint` and optional
`detail`. The pure `serializeMetaJson` helper is available from the root and
`./build` entries and emits recursively sorted keys, two-space JSON and one
trailing LF. Source producers share these rules while retaining their own
parsers, sidecar identity checks and filesystem writes.

## MaterialAsset 唯一成功路径

Pack 承载 `paramSchema -> derive -> compile/reflect -> cook/load -> extract/record`
中的 cook/load 边界：producer 先发布含 `coordinateSet`、transform、
`physicalUvScale`、artifact 与 `layoutIdentity` 的 receipt，再由 catalog 按 GUID
提供给 runtime。identity 或 receipt 过期时 inspect producer evidence，修复后
recook 并重新验证，不手改 cooked payload。

> [!IMPORTANT]
> Pack 是发布与证据边界，不是第二份 schema；恢复动作依赖结构化状态与 receipt，
> 并沿 producer owner 回到源输入。

## Authoring and recovery index

## Procedural plugin capability

A ScriptablePack that can produce plugins declares `plugins: true` beside
`schemaVersion` and `packageId`. Ordinary resource Packs omit it. Plugin discovery
still validates fresh source metadata but executes only declared plugin producers;
map meshes, materials and equipment are produced by the normal asset worklist.
Direct Pack JSON plugin outputs remain explicit in their existing source entries.

Both cold production and verified cache hits reject plugin outputs from an
undeclared producer. Parameters, instances, isolated worker lifetimes, deferred
content reads and complete final reference validation keep their existing owners.
When migrating an older procedural plugin Pack, add `plugins: true`; do not add
it to ordinary resource Packs to restore the former duplicate execution.

## ScriptablePack 与 Pack authoring

A `terrain` ScriptablePack output supplies a validated `TerrainSource`. The terrain producer derives subsection meshes, height/control mips and Standard material arrays as one GUID-linked closure; the existing Pack cook, Catalog and runtime loader own publication. See [the terrain contract](../terrain/README.md) for bounds and layer semantics.

> [!IMPORTANT]
> 这里有两个一等 source 实体，且必须保持可见区别：`ScriptablePack` 是可执行的
> `*.pack.ts` TypeScript source；`Pack` 是可编辑、可持久化的 `*.pack.json` JSON
> source。参数化只是 ScriptablePack/Pack instance 的可选能力，不是第三种实体。
> 构建后的 Pack v2 是 transport 产物；runtime 只按 GUID 加载产物。

The current authoring contract keeps one Pack identity and derives every output
identity from the author-owned pair `(packageId, sourceKey)`:

```ts
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';

const packageId = definePackageId('01900000-0000-7000-8000-000000000001');

export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  build: ({ packageId: subjectId }) =>
    ok({
      'mesh/main': { kind: 'mesh', materialSlots: [] },
      'scene/hero': {
        kind: 'scene',
        entities: { body: { components: {} } },
      },
      'scene/main': {
        kind: 'scene',
        entities: {
          root: { components: {} },
          hero: {
            components: {},
            instance: {
              source: AssetGuid.format(AssetGuid.derive(subjectId, 'scene/hero')),
              overrides: [{ target: ['body'], components: {} }],
            },
          },
        },
      },
    }),
});
```

`definePack` omits `parameters` for the default zero-parameter path; its build
context then has `packageId` and `readByGuid()` only. A non-empty `parameters`
array opts into typed `values`, defaults, numeric bounds, enum choices, vectors,
colors, and asset-GUID kind constraints. The build return object is the whole
current output topology: there is no output manifest, `output.add()`,
`externalAssets`, or per-output GUID field.

`Pack` authoring (`*.pack.json`) uses schema `3.0.0`. A direct document stores
`assets[sourceKey]`; an instance stores only its own `packageId`, `parent`, and
sparse `values`. These branches are mutually exclusive. Every instance has an
independent package identity, while the parent chain is resolved through the
current Source Index. The authoring form is lowered to the ordinary Pack v2
transport before runtime; player code still calls `assets.load(guid, kind)` and never
executes TypeScript or understands parameters.

`@forgeax/engine-pack/build` exposes the filesystem gateway
`createFileSystemPackAuthoringGateway()`. Its read operations are
`asset.list`, `asset.inspect`, `asset.resolve`, and `asset.verify`; mutations
are `asset.source.create`, `asset.source.clone`,
`asset.source.instance.create`, `asset.source.values.apply`,
`asset.source.rebuild`, and `asset.source.cold-cook`. Every operation carries a
caller-minted `requestId`; source mutations are confined to the game root,
atomic, and CAS-protected by `expectedRevision`.

| `asset.inspect` subject | Authored result |
|:--|:--|
| Pack source path | Source revision and output identities; no output payloads |
| Pack source path with `sourceKey` | The selected direct Pack output's `payload`, GUID and source revision |
| Pack instance path with `sourceKey` | The derived output GUID and inherited `effectiveValues` |

Consumers comparing a selected output with a live Catalog row must require the
returned GUID to match. A ScriptablePack source inspection does not execute
`build` to synthesize an authored payload.

`listPackSources(projectRoot, limit, assetRoots)` from the Node-only `build` entry lists up
to 200 project-relative `.pack.json` / `.pack.ts` paths with a source SHA-256
revision. Optional project-relative `assetRoots` restrict traversal before either
bound is applied; omitted roots scan the project, while `[]` scans nothing.
Overlapping roots are visited once, and symlinked directories are not followed.
It records diagnostics per source so malformed JSON does not hide
healthy siblings. A v3 direct or instance Pack exposes its parsed `packageId`;
an instance has no authored output until its parent is resolved. Scriptable
sources are listed as unmaterialized without executing their module. `hasMore`
marks the source or 10,000-entry traversal bound. Use explicit `asset.inspect`
to resolve one trusted scriptable source under a caller-owned execution budget.

`scanInventory` remains strict by default. Editor admission may provide
`onSourceFailure` to retain healthy siblings and receive each malformed JSON,
schema or ScriptablePack load failure before declaration admission. Failed
sources do not enter the returned paths or publication inventory. Global
identity collisions, dependency failures and changed source snapshots remain
fatal. The serving owner applies the same failed-source filter to publication;
View keeps the authored file visible through `listPackSources` diagnostics.

The file-system authoring gateway uses partial admission for `asset.list`,
`asset.inspect` and `asset.resolve`. Listing retains source failures in
`diagnostics`; inspecting a failed source returns its original owner error.
Healthy source and GUID queries remain available. `asset.verify` and mutations
keep strict whole-project admission, including global identity checks.

`AssetGuid.derive(packageId, sourceKey)` is the browser-safe UUIDv5 projection.
`PackageId` and `AssetGuid` are distinct brands, and a derived identity alone
reports only `identity`; `present` and `ready` require current materialization
and validated Pack/artifact evidence respectively.

## 灯光 Pack/Catalog 入口

三条最短入口：

1. scene Pack 只保存 `RectAreaLight`、`SpotLight`、`LightProbe` 的 authored 字段，并把 `iesProfile`/`cookie` 写入 `refs`。
2. `IesProfileAsset` 由 `iesImporter` 在 build-time 生成 fixed cooked payload；`SpotLight.cookie` 仍是普通 `TextureAsset`。
3. runtime 按 GUID 读取 Catalog/Pack 记录；`current`、`accepted`、`lastKnownGood`、`verified` 分层检查，缺失时回到 producer 重建。

Pack 是 published 边界，不是 author authority、runtime registry 或 GPU owner。源文件与 Meta 保留 authored identity，DDC/Catalog 是可丢弃或可重建的 projection；`sourceKey` 只表达 producer 语义，不是 URL 替身。

## Material contract index

Pack is the single material-cook and publication boundary. It publishes one
GUID-addressed receipt and artifact for the resolved contract; it does not
redefine `paramSchema` or mint runtime feature macros. Keep
`materialContractDigest`, `sourceClosureDigest`, `layoutIdentity`,
`programIdentity`, `cookIdentity`, and `materialPublicationIdentity` together
as layered identity. Inspect `current` versus `generation`, repair the owning
producer at the first divergence, cold-cook the same GUID, and verify receipt,
artifact, and provenance.

Material canonical JSON, context keys, and program-set digests order strings by
UTF-16 code units, independent of the producer or player's locale and ICU support.
An older publication whose digest used locale collation must be regenerated by
its producer; runtime integrity validation never accepts a second digest policy.

A raster ABI without `sceneIndexEntry` publishes a direct selection only. When
that entry exists, the validator requires both direct and scene-index selections
for the same pass/context/color inputs. A scene address without its matching ABI
entry is invalid; direct-only publications do not fabricate a paired program.

`MaterialCookRasterContext.visibleSurface` is an optional `true` capability
axis, orthogonal to `pipeline: forward | deferred`. Absence is the only off
representation. `materialProgramContextForPass` preserves it for color entries
and strips it for shadow/depth entries; the cooker and runtime share that
projection. It selects an additional output ABI from the same authored Surface,
not a second material definition.

`MaterialCookRasterContext.geometry` distinguishes `sprite-instances` from
ordinary `mesh`/`sprite` layouts. This is a derived program selection within
the same material GUID; it does not add a second authoring asset.

`MaterialCookProgramContext` is the closed union of raster and Surface-derivative
contexts. Derivatives use `pipeline: ray`, `profile: forgeax-material-ray-v1` and
mesh/storage inputs: `pass: ray-hit` selects `cs_surface`, while `pass: card-capture`
selects `vs_card` with the fixed `fs_card` fragment entry. Both select an existing
authored pass without a raster address pair or submission ABI. Card cooking
validates its four `rgba16float` outputs. The executable validator and JSON schema
admit both contexts; `raster-probe` remains a build-time diagnostic. The complete
program-set digest covers both derivatives and raster programs. Neither derivative
satisfies the requirement to publish the authored raster pass.

## Mesh binary boundary

Mesh artifacts use one canonical `geometry` projection and one strict wire
contract. The pack package owns the header facts and digest implementation in
[`src/mesh-bin-contract.ts`](src/mesh-bin-contract.ts); consumers must not
recreate that table.

| Fact | Owner | Recovery |
|:--|:--|:--|
| projection mask, schema version, stride, digest | `@forgeax/engine-geometry` + pack contract | Re-cook from source and Meta |
| vertex/index cardinality and payload bounds | build-time import producer | Repair source payload, then cold-cook |
| malformed or legacy mesh binary | strict runtime loader | Keep LKG; publish only a fully validated replacement |

> [!WARNING]
> Producers emit v5; readers accept published v4 and v5. v2/v3 remain
> closed load errors. Runtime never re-cooks an artifact.

## ScriptablePack in 30 seconds

The public happy path is: declare one stable `packageId` and return a complete
`sourceKey -> Asset` topology from `definePack`, run the Vite Pack producer,
publish Pack v2 plus the Catalog, then call `assets.load(guid, kind)` and bind the
returned asset handle. Use `assets.read(handle)` when a detached payload snapshot
is needed.
The durable consumer matrix is the exported
`SCRIPTABLE_PACK_ASSET_KINDS` list: mesh, material, scene, texture, equirect,
sampler, font, render-pipeline, tileset, video, skeleton, skin,
animation-clip, animation-graph, audio, particle-effect, and ies-profile.

Every successful row keeps its `sourceKey` identity, dependency `refs`, and
producer-owned `artifacts`. Audio keeps `mediaType` and bytes; particle effects
keep `programFingerprint` and the cooked program. Animation and tile components
consume the loaded handles through the World's asset registry.

For failure, switch on `code`, inspect `expected`, `hint`, and narrowed `detail`:
repair the definition or producer, rebuild/cold-cook, refresh the Catalog LKG,
or attach the missing Host capability. A missing audio/video/VFX capability is
an install/play/execute error, not a durable-load error. The machine contract
lives in [`pack.schema.json`](schema/pack.schema.json) and
[`meta.schema.json`](schema/meta.schema.json); this section is guidance, not a
second manifest.

The machine contract is [`schemas/asset-authority.schema.json`](../../schemas/asset-authority.schema.json). The audit gate is [`check-asset-authority-audit.mjs`](../../scripts/forgeax/check-asset-authority-audit.mjs); it reports subject, execution, author authority, runtime source, lifecycle, owner, producer, and sourceKey evidence for every named category.

The staged route is explicit: `author-validation` -> `external-declaration` ->
`import` -> `native-cook` -> `ddc-validation` -> `runtime-parse` ->
`editor-capability`. Each stage keeps its own evidence; a cache hit does not
replace author authority, and an Editor capability does not become a runtime
source.

| Need | Entry | Safe action |
|:--|:--|:--|
| Inspect one asset | `forgeax asset inspect --subject <guid> --root <project> --json` | Read structured evidence and diagnostics |
| Verify a result | `forgeax asset verify --root <project> --json` | Repair the producer or package, then retry |
| Rebuild a cooked result | Pack/import runner and the declared producer | Cold cook after discarding invalid DDC |
| Preview old output | Catalog evidence with explicit last-known-good state | Preview only; never publish it as current |

Pack or external source plus Meta owns author facts. DDC and Catalog are derived projections; they are not author databases or write authorities.

## Engine Content library

Engine-native assets are ordinary `*.pack.ts` sources in
[`@forgeax/engine-content`](../content/README.md), mounted explicitly through
forge.json `assetLibraries`. Their GUIDs derive from the library Pack namespaces
like any project Pack; there is no separate builtin namespace, token payload or
generated descriptor file.

> [!IMPORTANT]
> The pack contract has one material authoring shape: a `MaterialAsset` payload. The cook stage resolves inheritance, values, texture coordinates, module references, artifact bytes, and a receipt into one record. Runtime consumers use the GUID and catalog locator; they do not author a second shader resource.

## MaterialAsset cook contract

Put the material payload in the package `assets[]` row and keep its `refs[]` graph complete. The `passes`, `values`, `parent`, and texture `coordinates` remain one authored route. A valid cooked material record contains `resolved`, `refs`, `artifact`, and `receipt`. If any part is absent, recover by fixing the producer payload or re-running the cook; this is the recovery route. Then repeat `lookup/verify --guid --project --catalog --json`.

当 `parameters` 将字段声明为 `texture` 时，`values` 可保留纹理 GUID 字符串简写；省略
`parameters` 的默认材质也只对 `MATERIAL_TEXTURE_SLOTS` 中的纹理槽启用该简写。只有
sampler、强度或非默认坐标等附加元数据才使用结构化纹理对象。坐标字段的省略由运行时
统一解析为 identity，但 cook/load 不得把 identity 坐标自动展开并写回创作 payload。

> [!IMPORTANT]
> The producer publishes facts; the consumer does not guess. `packageId`,
> `provenance`, `revision`, `sourceKey`, relations, and diagnostics survive
> package moves and DDC relocation. Paths and array positions are locators,
> not identities.

Disk schema, GUID tools (`AssetGuid` brand + UUIDv7/v5), mesh-binary wire facts, and scanner fail-fast chain (13-member `PackErrorCode`) for the ForgeaX asset package system. The unified `asset list`, `asset inspect`, and `asset verify` commands call this owner in filesystem mode; they are offline and require no WS connection.

> Package name vs directory: this package is published as `@forgeax/engine-pack` but lives at `packages/pack` on disk. The `@forgeax/engine-` prefix is the IDE-autocomplete entrypoint AI users discover the package family by; the directory drops the prefix to keep tree depth flat (mirrors the `packages/runtime` / `@forgeax/engine-runtime` pair). All other packages in the engine family follow the same convention.

## AssetEvidence: the offline proof chain

Pack owns the offline half of the GUID evidence chain: `source inventory -> catalog packageUrl/cookReceiptUrl -> producer CookReceipt -> Pack v2 package and artifact verification -> AssetEvidence`.

`check:no-assets-load` guards Pack production sources against runtime loading and
Runtime/Assets imports through either physical packages or public SDK paths.
Games and tools use the runtime `AssetRegistry.load` API; their code is outside
this offline boundary. The gate's executable fixtures cover both accepted game
loading and rejected Pack dependencies.

The catalog is a locator, not proof. `lookup/verify --guid --project --catalog --json` joins the source meta or authored pack, the catalog row, the receipt, and the package descriptors. Both commands emit one JSON record on stdout or one structured `{code, expected, hint, detail}` record on stderr; there is no runtime or WebSocket dependency.

## Native code-package programs

Code-package hosts may use `createStaticPackProgramHost(entries, imports)` from
`pack/runtime`. Admission verifies the ordinary program graph and exact import
identities; publication accepts only module texts present in the immutable
package. Its `importModule` capability loads the existing native module namespace
instead of requiring a browser URL loader. Unknown or changed code fails through
`pack-program-load-failed`; RuntimePackProducer admission, generation, dependency
retention and publication remain unchanged. Author modules can import a local
text file with `?raw`; the Node author compiler and source snapshot preserve the
same bytes consumed by the browser bundler.

## VFX Program v3 in Pack v2

VFX source v3 is cooked in one atomic producer step and stored in the ordinary
Pack v2 envelope. The executable contract is
`scripts/asset-cook-contract.mjs`; a package-local scripts path is not valid.
The cook publishes the Pack payload and
`particle-effect/program.json` with the same source fingerprint. Runtime loads
the GUID-indexed artifact and never compiles author WGSL.

When adding a Batch B renderer, update the source declaration, explicit material
or mesh refs, native-cook catalog, and receipt together. Re-run `lookup` and
`verify`; stale output is repaired by the owning importer or native cooker, not
by a demo-side mesh substitute.

`notCooked` means a source declaration has no successful receipt. `ready/current` means the receipt fingerprint matches the source; `ready/stale` means it does not. `unknown` is reserved for missing evidence. Artifact and package status remain `notChecked`, `passed`, or `failed`; a historical receipt never upgrades an unchecked package.

Build-time importers write source meta and producer receipts; the Vite plugin publishes the locator. Runtime packages consume the resulting Pack v2 bytes and must not import this Node-only evidence adapter. See [`packages/types/src/asset-evidence.ts`](../types/src/asset-evidence.ts) for the exact schema and closed errors.

Browser runtime code uses the focused Pack subpaths instead of the Node-oriented
root barrel. The root entry remains the build-time scanner/evidence surface.

| Runtime need | Browser-safe entry |
|:--|:--|
| Pack v2 validation and parsing | `@forgeax/engine-pack/runtime` |
| Artifact locator validation | `@forgeax/engine-pack/artifact-path` |
| Cooked material records | `@forgeax/engine-pack/material-cook` |
| Mesh wire facts | `@forgeax/engine-pack/mesh-bin-contract` |

## Quick start

### ScriptablePack source (`*.pack.ts`)

Use `@forgeax/engine-pack/source` when one trusted TypeScript source declares
and builds a multi-asset package. The definition owns one stable `packageId`;
each build returns ordinary typed Assets keyed by author-owned `sourceKey`.
The Pack boundary derives every output GUID as
`AssetGuid.derive(packageId, sourceKey)`, so the source does not contain a
per-output GUID table, `externalAssets`, or an output writer.

```ts
import { AssetGuid, definePackageId, definePack } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';

const packageId = definePackageId('01900000-0000-7000-8000-000000000001');

export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  build: ({ packageId: subjectId }) =>
    ok({
      'mesh/main': { kind: 'mesh', payload: {}, refs: [] },
      'scene/main': {
        kind: 'scene',
        payload: { mesh: AssetGuid.derive(subjectId, 'mesh/main') },
        refs: [],
      },
    }),
});
```

Omitting `parameters` selects the zero-parameter path; a non-empty
`parameters` array adds typed `values`, defaults, ranges, enum choices,
vectors, colors, and asset-GUID constraints. The isolated Pack worker passes
only serializable authoring data to the build and never exposes filesystem or
runtime state.

Custom build-only content uses `PackCookSource` in the same output map:

```ts
{ 'volume/main': { kind: 'game-volume', execution: 'cooked', source: { size: values.size } } }
```

Register the matching `NativeCooker` in the build host. The host supplies the
derived GUID, source key/path and source data; the cooker returns matching-kind
metadata, references and artifact bytes. Missing cookers, rewritten GUIDs and
invalid products fail before publication. Custom sources can coexist with
ordinary Assets and inherit normal Pack parameters and instance identities.
They cannot override the closed ordinary Asset kinds. Authoring `readByGuid`
can explicitly request a `PackCookSource` from the current build generation;
that is source data, not a decoded runtime asset. Runtime custom kinds still
need their normal Registry loader/decoder. No cooker enters the player.

`forgeax asset inspect --subject <source.pack.ts> --root <project> --json` executes module initialization, validates the default export, and projects canonical Meta without calling `build`. `@forgeax/engine-pack/source-node` accepts a host executor with `load` and optional `dispose`; `timeoutMs` bounds module initialization and `buildTimeoutMs` bounds one `build(context)` call. A build timeout returns one structured `pack-source-load-failed` Result with `detail.phase: 'build'`, the configured `timeoutMs`, and deterministic cleanup of the isolated worker and compile root.

Build workers execute the complete relative TypeScript module closure on the supported Node floor, including Node 22 hosts that do not load `.ts` files directly. It transpiles that closure into a disposable ESM directory, resolves bare imports through the source project's nearest `node_modules`, and removes the directory when the worker is disposed. Bulk producers can use the internal `createScriptablePackModuleExecutorPool()` with two recyclable workers; a pooled lease is released after metadata projection or one build.

Disposable metadata workers compile the static import closure. If module
initialization touches a deferred dynamic import, they load the complete closure.
Builds compile the full captured closure and can add derived-text cache entries
while retaining the exact earlier entries. Source inventory still captures literal
dynamic dependencies; cache identity follows filenames and digests, independently
of transport ordering. Module instances remain local to each execution realm.

Captured JSON is canonicalized into data files in that same disposable directory.
Small ESM wrappers parse those captured files, so bulk payloads do not remain in
JavaScript source strings during Pack generation. This preserves existing JSON
canonicalization and own `__proto__` keys; delayed imports never reopen author files.

Once module loading settles, the Worker releases its captured source and transpile
text, including the initial `workerData` payload. Successful loading first returns
derived text to the host snapshot; builds and delayed literal imports use the
compiled closure on disk. The executor retains its existing 256 MiB
old-generation limit.

Path-only scans and explicit `metadataOnly` inventories read at most four ScriptablePack modules concurrently, each in its own isolated worker. They settle all started reads before reporting failure and publish declarations in source order. Inventories retaining build closures and scans using a caller-owned executor remain serial; metadata parallelism never shares or recycles those live leases.

The filesystem authoring gateway requests metadata-only inventories: authoring operations consume declarations and source parameters, never retained Pack build closures. Their workers are released after metadata reads, and the same four-worker bound applies to gateway queries and edits. Caller-supplied inventories retain their own execution policy.

| Standalone project stage | Worker ownership |
|:--|:--|
| Inventory | Metadata workers release before the inventory returns |
| Plugin bootstrap | One recyclable execution lease, acquired when each source or instance builds |
| Formal production | One recyclable execution lease per worklist attempt; the pool closes on success or failure |

`createLazyScriptablePackDefinition()` reloads from the inventory's captured
`ScriptablePackSourceSnapshot`, preserving its module bytes, parameters and source
evidence without keeping an idle worker per declaration. It retains the default
module/build deadlines, package identity fence and reader context. Later author
edits do not replace the captured body; existing publication source fences still
own whether the candidate can publish. The lazy path adds no per-build disk
verification. A direct producer lacking the inventory snapshot captures and
compares its source closure before executing, so a new body cannot use old evidence.
Caller-supplied metadata inventories must carry their captured snapshot;
inventories without a snapshot consume their caller-owned retained definitions
only while the captured declaration and closure bytes remain current. A changed
source rejects before consuming that lease; its caller still owns retirement.

`inventoryScriptablePackSource(path, initialSourceText?, resolveImport?)` inventories
bytes without evaluation. Its default resolver follows these authoring rules;
runtime delivery may inject its bundler resolver for each literal dependency,
so published JavaScript keeps its actual file and package resolution semantics.

`createScriptablePackSourceSnapshot()` shares file bytes, content digests and
resolution observations within one build. Its `inputs` and `paths` expose borrowed
read-only digest and observation projections. `observeFile(path)` records both absence
and existing bytes and returns whether the candidate is a file. `observePaths(subject,
enumerate)` captures producer-owned discovery membership and re-enumerates it during
verification without reevaluating authored code. JSON declarations and
Scriptable Packs share this byte owner; their revisions use original bytes, including
UTF-8 BOMs. `listPackSourcePaths(roots, options)` enumerates the same declaration
membership as the scanner without parsing JSON or executing modules.

Pass the snapshot through scanner/loader
`sourceSnapshot` options or the inventory helper's fourth argument. Captured
successful metadata evaluation is also reused across scans of that same
snapshot, even when callers choose different timeouts; failures are retried
under the next caller's policy. Each scan still discovers current directory
entries, and publication remains fenced by `verify()`.
Relative modules execute from those captured bytes in the standard Worker. `moduleSources()`
returns the captured canonical `entry` together with its `sources`; the loader uses
that entry for relative resolution, including a symlinked project path. Alias changes
remain publication conflicts rather than a second module identity. Bare packages
remain the host's pinned dependency context. A surviving runtime import that
cannot resolve fails as `pack-module-not-found` before temporary module execution.
`detail.sourcePath` identifies the original importer and `detail.specifier` retains
the authored import, including for re-exports and literal dynamic imports. The
scanner and CLI preserve this code and recovery hint instead of reporting invalid
Meta/GUID data. Erased type imports require no executable module.

Compiled `forgeax-scriptable-pack-*` directories are disposable Worker outputs.
A single executor removes its directory after metadata, build completion, failure
or timeout. A pooled executor retains output only for its bounded native lifetime
and removes it on retirement. Windows directory removal retries transient handle
errors after Worker termination; a missing idle directory is recreated from current
source on the next task. Source revision conflicts still reject publication. `verify()` rereads contents and
resolution probes, including newly preferred candidates and symlink changes.
Compiler/loader callbacks are borrowed: their owner verifies while the resolver is
live, then calls `releaseResolvers()` before disposal. This retires custom callbacks
while retaining captured bytes, aliases and negative candidates for later publication
checks; a closed compiler is never queried as current resolution evidence.
The build owner must verify again immediately before publication and discard a
stale candidate. A fresh build creates a fresh snapshot; only content-keyed
syntax parsing and, when the owner passes one, a `createScriptablePackMetadataCache()`
survive across generations. That owner-lifetime cache keys successful metadata by
source path plus the new snapshot's freshly read and digested relative closure, so
an edited entry or transitive import re-executes only its Pack; bare package
imports remain the host's pinned context. It evicts least-recently-used closures
beyond its bound and the owner clears it on disposal. No caller maintains an
invalidation list.
The syntax cache bounds retained digest/import text, array slots and entry count,
not source body size, so large data modules reuse their parsed imports without
retaining a second copy of their bytes. Source digests and publication verification
remain unchanged.

> [!IMPORTANT]
> Source authoring is an explicit Node contract. Every gateway call carries a
> caller-minted `requestId`; mutations may carry `expectedRevision` for
> SHA-256 CAS. The filesystem port confines paths to one game root and only
> writes constrained generated source or structured v3 JSON. Arbitrary valid
> TypeScript remains inspectable and rebuildable, but unsupported structural
> edits fail closed with stable `pack-source-*` errors.

`PACK_AUTHORING_OPERATION_DESCRIPTORS` is the producer-owned structured capability manifest for tools. The existing `asset.preflight` operation returns the current revision, canonical Meta, incoming references, and shape-derived mutation capabilities before any write.

```typescript
import { AssetGuid } from "@forgeax/engine/pack/guid";
import { scan, scanInventory } from "@forgeax/engine/pack/scanner";

// Runtime: resolve a known GUID at build time
const result = AssetGuid.parse("cbe42beb-8975-5096-b3a1-3dda4cb4c077");
if (!result.ok) throw result.error; // PackError with .code 'pack-guid-malformed'
const guid = result.value;

// Build / CI: validate an asset directory
const scanResult = await scan(["apps/hello/room/assets"]);
if (!scanResult.ok) throw scanResult.error; // PackError with .code/.hint/.detail
console.log(scanResult.value); // PackEntry[]

// Build hosts can retain one validated inventory and project paths from it.
const inventory = await scanInventory(["apps/hello/room/assets"]);
if (!inventory.ok) throw inventory.error;
console.log(inventory.value.paths, inventory.value.declarations);
```

## Schema shapes

External imports and authored Packs have different identity owners. An external
source keeps importer-owned sub-asset GUIDs in its `.meta.json`; an authored
Pack keeps one `packageId` and names outputs with `sourceKey`.

### `.meta.json` -- external-asset-package

```json
{
  "schemaVersion": "1.0.0",
  "kind": "external-asset-package",
    "importer": "gltf",
  "source": "<source-filename>",
  "importSettings": {},
  "subAssets": [
    { "guid": "<UUIDv7-or-UUIDv5>", "sourceIndex": 0, "kind": "mesh", "compression": "zstd" }
  ]
}
```

> [!NOTE]
> `compression?: 'none' | 'zstd'` on `PackIndexEntry` (and `subAssets[].compression`)
> indicates whether the asset's `.bin` is zstd-compressed. See
> `@forgeax/engine-codec` README for the full codec API and error codes.
> Runtime `fetchBinary` transparently decompresses when this field is `'zstd'`.
>
> **Declaring compression intent (AC-01):** set `importSettings.compression`
> (`'none' | 'zstd'`) to override the build-time default strategy for this asset
> (default: mesh -> `zstd`, texture -> `none`; `.pack.json` never compressed).
> The importer honors the override and writes the resulting `compression` onto
> the output catalog row. Omit it to accept the kind-keyed default.

### `.pack.json` -- authored Pack v3

Direct authoring names its outputs by `sourceKey`; it never stores output GUIDs:

```json
{
  "schemaVersion": "3.0.0",
  "packageId": "01900000-0000-7000-8000-000000000010",
  "assets": {
    "mesh/main": { "kind": "mesh", "payload": {}, "refs": [] }
  }
}
```

An instance uses the same extension and schema version, but has only its own
identity, parent, and sparse parameter values:

```json
{
  "schemaVersion": "3.0.0",
  "packageId": "01900000-0000-7000-8000-000000000011",
  "parent": "01900000-0000-7000-8000-000000000010",
  "values": { "count": 4 }
}
```

The two v3 branches are mutually exclusive. The build lowers them to the
runtime Pack v2 projection, whose rows contain derived GUIDs and `kind:
"internal-text-package"`; runtime still loads only that cooked projection.

### Producer provenance and topology

Authored and cooked Pack projections carry producer-owned `packageId`,
`provenance`, `revision`, and structured `diagnostics`. Asset/output rows may
declare a stable `sourceKey`; `sourceIndex` is positional evidence only. The
runtime function `diffTopology(previous, next)` preserves GUIDs by `sourceKey`,
reports additions, removals, and kind changes, and marks multi-output
source-index-only matching as ambiguous.

| Fact | Published by | Consumer rule |
|:--|:--|:--|
| `packageId` | Producer declaration | Keep stable across path or URL relocation |
| `provenance` | Producer declaration | Copy without replacing it with importer guesses |
| `revision` | Producer/DDC | Use to detect stale updates; do not silently overwrite a verified snapshot |
| `sourceKey` | Imported-output producer | Match topology only when the producer supplies a stable semantic key |
| `sourceIndex` | Imported-output producer | Display or inspect position; never use it as identity |
| `relations` / `diagnostics` | Producer facts | Preserve the complete structured values |

> [!WARNING]
> A missing `sourceKey` in a multi-output declaration is evidence insufficiency,
> not permission to hash a path or promote `sourceIndex`. Keep the result
> ambiguous and expose the repair hint.

The DDC path is also lossless: the import runner copies package-level facts to
the `.pack.json` envelope and copies each declared output's `sourceKey`,
`sourceIndex`, and relations onto the matching GUID row. The catalog builder
then projects those rows into `PackIndexEntry`; it does not create a second
authoritative fact store.

### MaterialAsset shape -- pass-based material in `.pack.json`

When `kind: 'material'`, the `payload` object carries `passes[]` + `values` (feat-20260527-material-registration-unification M3).

```json
{
  "guid": "<UUIDv7>",
  "kind": "material",
  "payload": {
    "kind": "material",
    "passes": [
      {
        "name": "Forward",
        "program": { "module": "forgeax::default-standard-pbr" }
      }
    ],
    "values": {
      "baseColor": [1.0, 0.8, 0.2],
      "metallic": 0.3
    }
  },
  "refs": []
}
```

**MaterialAsset fields in pack.json**:

| Field | Type | Description |
|:--|:--|:--|
| `passes` | `MaterialPass[]` | Root pass descriptors; each pass names a `program.module`. |
| `parameters` | `MaterialParameter[]` | Root parameter contract used by cook and reflection. |
| `values` | `Record<string, unknown>` | Child-owned values, including per-slot texture coordinates. |
| `parent` | `AssetGuid` | Optional serialized parent edge. |

**Validation** is performed by the material schema and build-time cook. The cook resolves the parent chain, validates values and pass programs, and emits a `material-cook/4` record, artifact, references, and receipt. The receipt keeps material, source, layout, program, pipeline, publication, and cook identities together with compiler/WASM provenance and generation counters. Runtime reports a structured missing-cook error instead of compiling a material; stale generations are recooked by the producer.

Raster program contexts distinguish `storage-buffer-minimum`,
`storage-buffer-projector`, `storage-buffer`, `storage-buffer-atmosphere` and
`uniform-fallback`. These name complete View binding topologies; storage-buffer
support alone does not prove a sampled-texture budget. Every selection is validated
and included in the program-set identity; the producer must recook incomplete generations.

## `AssetGuid` API

| Function | Signature | Description |
|:--|:--|:--|
| `AssetGuid.parse` | `(input: string) => Result<AssetGuid, PackError>` | Parse dash-separated UUID string; returns `Ok(AssetGuid)` on success or `Err(PackError{code:'pack-guid-malformed'})` on failure. Never throws. |
| `AssetGuid.format` | `(guid: AssetGuid) => string` | Format as lowercase dash-separated UUID string |
| `AssetGuid.equals` | `(a: AssetGuid, b: AssetGuid) => boolean` | Constant-time equality |
| `AssetGuid.random` | `() => AssetGuid` | Generate a random UUIDv7 GUID |

## `PackErrorCode` -- 13-member closed union

Exhaustive `switch (err.code)` without `default` -- TS guards completeness.

| Code | `err.detail` shape |
|:--|:--|
| `pack-malformed-meta` | `{ path: string; ajvErrors: string[] }` |
| `pack-malformed-pack` | `{ path: string; ajvErrors: string[] }` |
| `pack-guid-malformed` | `{ raw: string; reason: string }` |
| `pack-orphan-meta` | `{ metaPath: string; expectedFile: string }` |
| `pack-meta-missing` | `{ sourcePath: string; expectedMetaPath: string }` |
| `pack-guid-collision` | `{ guid: string; paths: [string, string] }` |
| `pack-cyclic-reference` | `{ code; kind: 'childof' \| 'mount-asset'; cycle: string[] }` -- first and last element repeated; `kind` distinguishes runtime ChildOf cycle from build-time mount-asset cycle (R10) |
| `pack-subasset-index-out-of-range` | `{ metaPath: string; sourceIndex: number; maxIndex: number }` |
| `payload-schema-mismatch` | `{ guid: string; errors: { instancePath: string; message: string }[] }` -- material payload failed `buildMaterialAssetValidator` check (scanner step-7) |
| `pack-mount-localid-overlap` | `{ overlapping: number[]; sources: string[] }` -- mount memberFirst windows collide |
| `pack-mount-count-mismatch` | `{ mountLocalId; declared; actual }` -- mount.memberCount disagrees with referenced child SceneAsset.entities.length |
| `pack-mount-override-localid-out-of-range` | `{ overrideLocalId; mountLocalId; memberCount }` -- override.localId outside mount window |
| `pack-mount-override-unknown-field` | `{ comp; field; mountLocalId }` -- override.comp / override.field unknown to schema vocab |

Access `err.detail.<field>` directly after narrowing via `switch (err.code)` -- full IDE autocomplete.

## Unified asset commands

DevKit loads the Pack producer behind the unified `forgeax asset` command;
this package does not publish an independent executable.

| Subcommand | Description | Exit code |
|:--|:--|:--|
| `forgeax asset list --root <project> --json` | Print a bounded page (default `limit=100`, maximum 256); add `--type` and `--cursor` to continue | 0 on valid roots |
| `forgeax asset inspect --subject <guid> --root <project> --json` | Print matching asset evidence | 0 found / 1 not found |
| `forgeax asset verify --root <project> --json` | Run the fail-fast scanner; the CLI prints the report's `summary`, scope counts and `attention` (assets not yet produced and available, at most 20). `--detail` prints the full bounded `asset-verification-v1` source/output report | 0 clean / 1 error |

```bash
# Direct invocation (after pnpm -F @forgeax/engine-pack build)
forgeax asset list --root ./game --json
forgeax asset inspect --subject 01935f3b-aaaa-7000-8000-000000000001 --root ./game --json
forgeax asset verify --root ./game --json
```

## Scanner 7-step validation chain

The `verify` subcommand runs a fail-fast 7-step chain:

| Step | Check | Error code on failure |
|:--|:--|:--|
| 1 | Schema validation (`.meta.json` / `.pack.json` ajv) | `pack-malformed-meta` / `pack-malformed-pack` |
| 2 | GUID format check (UUIDv5/v7 dash format) | `pack-guid-malformed` |
| 3 | GUID collision detection (cross-file duplicate) | `pack-guid-collision` |
| 4 | Orphan `.meta.json` check (`.meta.json` without source file) | `pack-orphan-meta` |
| 5 | Missing `.meta.json` check (source file without sidecar) | `pack-meta-missing` |
| 6 | Subasset index bounds check (`.meta.json` subAssets[].sourceIndex) | `pack-subasset-index-out-of-range` |
| 7 | Material payload schema check (`buildMaterialAssetValidator(MATERIAL_PARAM_TYPES_V1)` for `kind: 'material'`) | `payload-schema-mismatch` |

## Mesh-binary artifact contract

`MESH_BIN_VERSION` and `MESH_BIN_HEADER_BYTES` are the Pack-owned facts for
the v5 `<guid>.bin` mesh artifact. The header carries the geometry projection
version, attribute mask, stride, digest, cardinality, and payload byte lengths;
the import encoder and assets-runtime decoder consume those facts from the
package root. Independent test fixtures may keep literal header values only as
wire-format oracles, never as a second layout table.

The 80-byte header stores `morphBytes` at offset 40; offset 44 remains zero.
Payload order is header, interleaved vertices, morph streams, indices, JSON.
V5 metadata stores `morphTargetMasks` (one to eight targets): bits 1/2/4 select
position/normal/tangent with 3/3/4 little-endian float32 components per vertex.
Bits 8/16/32 mark present channels containing only positive zero; those lanes
occupy no bytes and decode to private zero arrays. Negative zero remains in the
binary stream. Streams are target-major, then position/normal/tangent; offsets
derive from cardinality and the mask. Morph weights remain small JSON metadata. Readers reject unknown
masks, inconsistent sizes, and non-finite morph values. V4 keeps its existing
inline numeric morph metadata and has no morph byte section.

> [!WARNING]
> Producers emit v5 and readers retain v4 support. A v2/v3 artifact is
> a closed load error, not a compatibility input. Preserve the last-known-good
> catalog row, repair the source plus its `.meta.json` sidecar, then re-run the
> owning build-time importer/native cooker and `lookup/verify --guid --project
> --catalog --json` before publishing the replacement.

## Owner product and inventory contract

`scanInventory(...)` is the Pack-owned source inventory boundary. It preserves
GUID identity, source revision, source key, and source index before importer
work begins.

`finalizePackageProduct(...)` accepts the terminal producer product, validates
one receipt per GUID, validates asset-local artifact paths and bytes, and emits
the deterministic package URL and digest. Producers provide policy through the
finalizer sink; Pack owns package serialization and publication facts.

Transport finalization reuses each artifact's content hash for the source revision
and integrity descriptor within that invocation. The package digest still hashes
its canonical metadata and binary stream. No cache survives finalization: changing
input bytes before the next call must change the appropriate digests. All existing
digest and file formats are preserved; callers need no caching policy.
Canonical serialization retains portable scalar arrays instead of cloning large
mesh arrays. Objects within arrays still sort recursively, typed byte values keep
their existing encoding, and neither input order nor payload values are mutated.
Transport finalization returns the Pack document and artifact bytes without retaining
an unused serialized document. A supplied sink receives canonical publication bytes;
build producers that emit the document themselves omit the sink rather than serialize
and discard a second copy.

Source inventory reuses only TypeScript import syntax by the freshly computed
source-content digest. Its internal LRU is bounded by 512 entries and 16 MiB of
source bytes. Every inventory still reads and hashes files and resolves imports
again, so equal-size edits, new resolution candidates, and custom resolvers stay
authoritative. No timestamp-based freshness or caller invalidation is introduced.

## Mesh LOD relation closure

LOD is a relation inside the root mesh payload, not an independent runtime
asset kind. A valid Pack row contains the lower MeshAsset GUID in both the
payload and root `refs[]`, and the lower row is present in the same package:

```json
{
  "kind": "mesh",
  "payload": { "lods": [{ "mesh": "<lod-guid>", "screenCoverage": 0.5 }] },
  "refs": ["<lod-guid>"]
}
```

The finalizer preserves this relation while sorting rows deterministically.
Missing closure, duplicate GUIDs, invalid artifacts, or incomplete receipts
fail before publication; repair the producer and retry the same source Meta.

## Runtime program artifacts

`@forgeax/engine/pack/runtime` validates and links native JS ESM closures through
`preparePackProgram`, `verifyPackProgram`, `linkPackProgram` and `loadPackProgram`.
Preparation checks source bytes and literal module imports without executing
implementation modules. A program records an entry, selected export, module
sources, fixed Host import identities and a content digest. TypeScript conversion
belongs to the DevKit producer, before this compiler-free contract.

Browser HTTP module delivery uses the separate `@forgeax/engine/pack/runtime-browser`
entry (`prepareBrowserPackProgramScope`, `createBrowserPackProgramHost`, and
`PACK_PROGRAM_WORKER_SOURCE`). The general runtime entry remains usable by source
consumers without DOM globals.
`PackProgramHostFactory` borrows recorded imports and a lazy resolver for the
executing realm's actual namespaces. Native embeddings use the existing
`PackProgramHost` publication/import interface; they must preserve module graph
state across entries, shared Engine identities and their owner lifetime.

`FixedPackPublication` keeps complete Pack/Catalog/receipt evidence and original
artifact bytes. `PackBlob` writes canonical base64 strings and reads both those
strings and previously saved numeric byte arrays. Types `encodeBase64` / Pack `decodePackBlob`
are the shared JSON boundary; artifact format, compression and integrity are unchanged.
Its optional `executions[target]` groups portable programs and
explicit tool contracts; each plugin must be covered by at least one prepared
target. A contract's GUID grants membership in that group, even with no commands.
Same GUIDs and program keys may have different artifacts across targets. Missing
coverage, unknown targets and mismatched tool realms are invalid archives.

`packProgramModuleIdentity` derives native module URLs from the complete module
graph and its declared Host bindings. Selecting another entry/export or adding
an unrelated Host capability preserves shared module state. Changing module
bytes or a declared binding creates a different module identity. The artifact
digest still covers the selected entry/export for integrity checking.
Host bindings use absolute module locators, including native application schemes
such as `tauri:`. Pack validates their scheme syntax and recorded identity; the
executing Host owns protocol support and access. Linking and static publication
retain the exact binding URL, and changing it creates a different module identity.

For browser delivery, the page calls `prepareBrowserPackProgramScope(workerUrl)`
and passes the returned absolute application scope to
`createBrowserPackProgramHost(scope)`. The latter works in either main or a
Dedicated Worker and writes the complete linked closure before returning its
native entry URL. Registration and page control have one bounded preparation
period; failed or late preparation cannot claim success. Host imports must use
the current realm's exact modules so component tokens and Cordis retain identity.
A Fiber disposal withdraws effects, not ESM modules; CacheStorage is not the
unique copy of authored program content.

## Entry subpaths

| Subpath | Exports |
|:--|:--|
| `.` | Re-exports from all subpaths |
| `./schema` | Compiled ajv validators for `.meta.json` and `.pack.json` |
| `./guid` | `AssetGuid` and `PackageId` brands; UUID parse/format utilities and synchronous `AssetGuid.derive(packageId, sourceKey)` |
| `./errors` | `PackError` class + `PackErrorCode` closed union + `PackErrorDetail` discriminated union |
| `./bridge` | `AssetRegistry` GUID bridge helpers |
| `./scanner` | File tree scanner with fail-fast 7-step validation chain |

## Plugin authoring and source transfer

`kind: 'plugin'` is a Pack output. A TypeScript source returns `{ kind, module, config?, toolContract? }`; a direct JSON Pack places these fields beneath its existing `payload`. Module locators are literal relative paths or declared npm specifiers with an optional explicit export (default is `default`). Same-file Pack plugins require named exports.

| Input | Published definition |
|:--|:--|
| packageId + sourceKey | Stable GUID |
| module specifier + export | Portable `project:...#export` or `npm:...#export` program key |
| JSON configuration | Fresh configuration per native installation |
| `toolContract` module reference or inline `ToolCommandContract` | Pure tool declarations with executor references lowered to existing program keys |
| `{ "$asset": "canonical-guid" }` | GUID string and producer-derived dependency reference |

Plugin references are derived, never hand-authored in `refs`. Configuration rejects non-finite numbers, nested undefined, functions, class instances and cycles before JSON transport. The asset decoder defers reference loading so a plugin can install a loader before consuming that loader's content.

Inline tool declarations use the same contract as a referenced declaration module.
Their executor paths are relative to the declaring Pack; a referenced contract's
executors remain relative to that module. `lowerPluginToolContract` validates and
copies declaration data, resolves executor/export pairs, and removes `exportName`
after the program key selects it. It never evaluates a module. Runtime-authored
plugins use inline declarations; module-reference contracts require producer preparation.

The build subpath exposes `collectAuthorPackClosure(projectRoot, sourcePath, assetRoots)`: author Pack, statically declared modules/resources, Meta sidecars (including the required `.ui.html` / `.ui.css` pair) and referenced output owners, plus project WGSL module identities and transitive imports, with file digests and declared npm dependencies. Computed source-discoverable outputs are evaluated by the existing isolated Pack executor. A source that requires cooked reads is rejected for transfer with its owning path. The Pack authoring gateway delegates import/clone to DevKit's project transaction, which validates the dependency lock, complete candidate source closure, and candidate compilation. File-only cloning has been removed.

### Runtime binary data capture

`copyPackData` captures lossless metadata and owned binary views without invoking
accessors or caller serialization hooks. SharedArrayBuffer storage and typed-array
subclasses are rejected. Views retain byte offsets, lengths and backing aliases;
unreferenced backing bytes are cleared. Runtime publication uses this same capture
contract at the consuming owner boundary. Encoded Pack artifacts remain the portable
storage and transport representation, with real integrity descriptors produced only
when their bytes exist. Pack's `encodePackData` / `decodePackData` own the shared
binary transport table and the same typed-array allowlist as capture. They accept
captured plain-object snapshot roots; root arrays and binary views are rejected.
Encoding reserves the root `binary` field and rejects collisions before data can
be overwritten. Nested author objects need no reserved fields. See Import's
`runtime-pack-source/2` snapshot contract for portable source archives.

Material publication uniqueness and direct/scene-index completeness include the
color input derived from each ABI receipt. Plain and colored programs may share
a Pass/context, but each color choice must retain its own complete address pair.

The `navigation-mesh` Scriptable Pack kind carries portable baked navigation
polygons. Its explicit build-time producer is `@forgeax/engine/import/navigation-bake`;
ordinary Cook/Catalog delivery preserves the GUID and producer freshness digest.
Player loading carries no Recast compiler dependency.

## Deferred artifact delivery

An artifact may declare `delivery: 'stream'`. Finalization retains it and includes it in transport/publication identity; it still emits the complete artifact with length and integrity facts as part of the build closure. Native consumers own loading: range media validates its manifest and fetched windows; [UI companions](../ui/README.md) load through browser HTML/CSS URLs without asserting byte-level integrity at mount. Explicit artifact verification remains independent of runtime loading. Pack owns no native decoder or request scheduler. [Audio streaming](../audio-webaudio/README.md#long-audio-through-source-meta-and-guid) requires Range-capable HTTP hosting.

### Immutable build catalog transport

`pack-index.json` keeps the array when its rows have no repeated complete
publication or projection. Repeated values use `pack-index-tables/1`: `entries`
carry a `publicationIndex` into `publications` and a `projectionIndex` into
`projections`. The latter shares the complete producer operation matrix, reasons
and last-known-good locators; it never regenerates policy from a row's kind.
`encodeCatalogWire` preserves every row and every field; `decodeCatalogWire`
restores ordinary Catalog rows before existing identity, revision and scene-fence
checks. Different receipts, output sets, source revisions or projection values
remain separate table entries. Equal values regain shared readonly identity after
JSON transport. Encoder scratch indices are released after that one catalog.
Encoding retains one serialized key per distinct publication or projection and only a numeric
table index per object. Independently restored equal envelopes do not
retain repeated serialized output rosters; the bounded-heap regression exercises
this path with 4,096 rows and complete 512-output publications.
The decoder returns `Result<readonly CatalogEntry[], AssetError>`; invalid
references, inline conflicts and unused table entries return the existing
`asset-parse-failed` code with the failing field and index. The previous compact
schema is retired: rebuild catalogs with this Engine before loading them. Plain
Catalog arrays and the outer runtime scope protocol remain unchanged.
Scoped snapshots retain their existing schema and publication authority. Bound
production and development catalogs encode `entries` with the same array-or-compact transport;
the outer scope, generation, authority and diagnostics remain intact. Pack's
`RuntimeCatalogWire` describes this transport; `RuntimeCatalogSnapshot` remains
the domain value with decoded rows. The public
decoder consumes authoritative scoped snapshots without dropping their complete
publication receipts and rejects malformed, degraded or nested snapshots. It projects
rows only: runtime binding still owns the expected scope/generation check.
Use the public decoder when inspecting emitted build catalogs; the compact wire
is a transport projection, and does not grant asset readiness or skip artifact
integrity checks.

Meta inventory and importers consume the Types-owned `ImportSubAsset` declaration.
Format-specific GUID reuse and source-key matching remain with each producer;
the shared declaration does not prescribe a matching algorithm.

Catalog revision windows use Types’ `checkCatalogRevisionContinuity` for the same
root membership, monotonicity and single-step rules in Pack production and Runtime
replica admission. Shape validation and replica row/scope checks remain separate.

Runtime Pack publication derives the complete protocol tuple through Types `createAssetPublication`, shared with DDC-backed producers. Pack retains its binary-aware content digest and source-key projection; scope rebinding does not change immutable content.

UUID string admission uses `isValidAssetGuidString` from `@forgeax/engine-types`.
Pack owns byte parsing/formatting, generation and source-key derivation, and
reuses the Types `AssetGuid` brand.

Package product and finalized document envelopes derive GUID, kind, name and ref
fields from the runtime envelope contract. Finalization replaces artifact bodies
with descriptors while retaining the product receipt and source identity types.

Standalone ScriptablePack loads and pooled loads use one worker executor and
revision-tagged load/build protocol. A standalone executor retires after one
task; the pool supplies its bounded reuse policy. Both routes retain worker
resource limits, source snapshots, build timeouts and retirement cleanup.
Retirement remains terminal even when captured sources arrive after a module
timeout. Cleanup waits for in-flight directory preparation before removing it;
only a completed reusable lease clears the executor's disposal state.
Directory allocation failures retain the structured module-load error and
still retire the Worker, including when no temporary output was created.

Author-closure transfer uses the same relative source candidate order as scriptable execution, including `.js` to `.ts`, `.mjs` to `.mts`, `.cjs` to `.cts` and extensionless index resolution.

The module executor pool derives capacity from its retained Worker set. Its cache preparation resolves path and ownership together, and concurrent pool disposals await the same Worker retirements before removing an owned cache.

`NativeCookerRegistry.runTransaction` returns the accepted `{ draft, generation }` snapshot with `status: 'committed' | 'recovered'`; only recovery carries `recoveryHint`. A failed candidate retains the previous snapshot without parallel draft or generation fields. Draft admission is shared by `runDraft`, `run` and transactions; malformed producer output and throwing transaction validation return structured failures. Publication callbacks remain responsible for atomic publication.
