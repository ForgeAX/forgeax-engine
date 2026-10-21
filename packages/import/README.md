# @forgeax/engine-import

A registered importer may emit ordinary engine asset kinds such as `texture` or
`mesh`. Catalog projection records the declared schema and GUID; it does not grant
the importer ownership of the runtime kind. The existing domain decoder validates
the complete cooked output before runtime adoption.

## Authoring and recovery index

## 灯光资产 producer 入口

三条最短入口：

1. `RectAreaLight`、`SpotLight` 与 `LightProbe` 由 render 的 ECS schema 创作，scene producer 只外化 `shared<T>` GUID。
2. `iesImporter` 只在 build-time 接受 LM-63 Type C `TILT=NONE`，输出固定 cooked `IesProfileAsset`；runtime 不解析 `.ies` 文本。
3. `SpotLight.cookie` 走现有 `TextureAsset`/image producer；不要建立 Cookie registry 或第二条采样路径。

producer 持有 authored/source authority，Pack 产出 published 记录，Catalog 是 admitted/current 的投影；失败只返回结构化 `import-failed` 并保留原 GUID，修复 producer 后按同 GUID 重试。`lastKnownGood` 只可预览，不能冒充 verified/current。

Extended-lighting imports keep the same source key across Rect, Spot modifier,
Probe, and recovery carriers. IES is a build-time Type C `TILT=NONE` producer;
Cookie uses the existing texture producer; Probe and Sky are not new asset
registries. A failed publish is a structured producer result, and runtime must
not parse source text, invent a cooked payload, or promote LKG to current.

Concurrent equivalent sidecar publication on Windows can report `EPERM` while
replacing the destination. Import accepts that result only when the existing
file matches the complete requested body byte for byte, then removes its own
temporary file. Different bytes or other filesystem errors retain publication
failure and DDC/LKG rollback; the destination is never removed as a workaround.

The IES producer reads the complete 13-field LM-63 numeric header. Type C
horizontal tables support axial, quadrant, 0–180° bilateral, 90–270° bilateral
and full-turn distributions. Vertical tables cover 0–90°, 90–180° or 0–180°;
unmeasured hemispheres stay dark. Angle tables must increase strictly and
candela values must be finite and nonnegative. Cook folds angular symmetry
over the original measured rows and peak-normalizes the resulting grid;
author light intensity remains authoritative.

ScriptablePack sources use the public `@forgeax/engine-import` producer bridge.
The output is the same Pack v2 durable payload used by ordinary importers. The
17 `SCRIPTABLE_PACK_ASSET_KINDS` are `mesh`, `material`, `scene`, `texture`,
`equirect`, `sampler`, `font`, `render-pipeline`, `tileset`, `video`,
`skeleton`, `skin`, `animation-clip`, `animation-graph`, `audio`, and
`particle-effect`, and `ies-profile`; all are loadable by GUID, while `refs`,
`artifacts`, `mediaType`, and `programFingerprint` remain producer facts.
Particle mesh renderers retain either a static Mesh GUID or the closed
`{ source: 'player' }` selector in their immutable program artifact. Only static
Mesh GUIDs become Pack references; the Player's ordinary MeshFilter resolves
its mesh at extraction time, while renderer materials remain GUID references.
Producer or dependency failures return `code`, `expected`, `hint`, and
`detail`; inspect the owning evidence, rebuild or cold-cook, and retry.

The import contract is [`schemas/asset-authority.schema.json`](../../schemas/asset-authority.schema.json). `ImporterRegistry` and `runImport` are the build-time owner for external source plus Meta; every writable multi-output declaration uses a stable `sourceKey`, while `sourceIndex` remains diagnostic evidence only.

| Need | Entry | Boundary |
|:--|:--|:--|
| Inspect producer evidence | Pack CLI `lookup` and `verify` JSON output | Read Catalog and receipt facts; do not parse messages |
| Rebuild | Registered importer through `runImport` | Write Pack/DDC output through the shared finalizer |
| Recover failed output | Fix source or Meta, then cold cook | Never return raw source as a runtime projection |
| Preview old output | Explicit Catalog last-known-good locator | Read-only preview; not current and not publishable |

The Importer owns neither DDC lifecycle nor Editor authoring writes. Editor writes go through its asset-authoring gateway, and runtime consumes the validated projection.

Material publication retains the complete validated native cook record. The shared
Import payload projection removes inline WGSL bytes before digest and Pack JSON
normalization only when the external artifact contains exactly the same bytes.
Final Pack emission uses the same projection and verifies published descriptor
length and SHA before removing a serialized copy. Missing or inconsistent external
evidence retains the inline bytes for the existing complete record, integrity and
inline/external equality checks; compaction never repairs a malformed publication.

CookProduct digests use the same typed-array-to-JSON-array normalization as Pack
publication. A native view and its transported array therefore retain one output
digest; changed values or artifact bytes still change that digest. Normalization
does not alter source sampling, GUIDs, material programs or the emitted Pack format.
Source-package production and Vite development request product-only import;
their shared transport finalizer owns Pack projection, so import does not build
an additional Pack that those callers discard.

Imported materials use the host's registered material cooker before the complete
source package is published. `produceSourcePackage` accepts the same `cookers`
as Pack production; Vite forwards its existing registration in dev and build.
The host supplies `runImport` with the registry's `get`/`runDraft` interface,
keeping the shared browser import path free of the Node registry.
Import resolves each material's wire reference indices to GUIDs for the
cooker, then projects the result through the ordinary material output producer.
Parent, texture, sampler and coordinate data retain their identities. Shader
dependencies and native fingerprints participate in the source publication;
failure rejects the whole candidate. Import never loads a shader compiler itself.
Without a registered material cooker, an importer remains responsible for its
published payload; uncooked output is not evidence of ray-program readiness.

### ScriptablePack build generation

A `terrain` ScriptablePack output supplies a validated `TerrainSource`. The terrain producer derives subsection meshes, height/control mips and Standard material arrays as one GUID-linked closure; the existing Pack cook, Catalog and runtime loader own publication. See [the terrain contract](../terrain/README.md) for bounds and layer semantics.

`buildScriptablePack()` accepts a ScriptablePack definition, resolves the
default/inherited values, and executes `build()` once for the current subject
identity. The result is a dynamic `sourceKey -> Asset` map; the bridge derives
`AssetGuid` values from `(subjectPackageId, sourceKey)` and sends the resulting
assets through the same registered output producers and Pack v2 finalizer used
by ordinary imports.

Authored material outputs with passes use the registered `material` NativeCooker,
including Engine Standard roots. A shipped template is source ownership, not a
published per-material program: the producer must retain its admitted ray-hit and
Card derivatives as well as raster programs. Direct Pack v3 uses the same rule;
legacy Pack v2 already-published Engine materials retain their transport contract.

The same map also accepts explicit `PackCookSource` rows for custom kinds.
Their `execution: 'cooked'` and `source` fields dispatch through the existing
build-time NativeCooker registry; the closed ordinary Asset producer union is
unchanged. Cooked refs, artifacts and fingerprints participate in the same
worklist, reference validation and finalizer. Staged content reads retain the
custom author source instead of pretending its metadata is a runtime asset.

`buildScriptablePackWorklist()` is the internal clean-generation
fixed point. Subjects are evaluated in stable order, a forward `readByGuid()`
content miss waits for the subject that can materialize that GUID, and a pass
with no progress returns `pack-content-dependency-stalled`. Once all subjects
settle, the bridge validates references and incoming-reference deletions before
publication. A GUID written into a payload is only a reference dependency;
only `readByGuid()` creates a content dependency.

Development and build hosts use `createDeclaredPackAssetSnapshotSource()` to
materialize external Pack or Meta content on the first actual read. A direct v3
Pack entry cooks independently; Meta and legacy importers retain whole-source
ownership. Reading one direct entry does not cook its sibling reference targets.
One inventory invocation retains private snapshots only for the owners read in that
invocation, using the existing staged-owner concurrency and retry rules.
Unknown GUIDs remain worklist misses; known producer failures retain their
structured errors. Final Catalog publication still prepares and validates all
declared assets, including those never read by a ScriptablePack.

`produceScriptablePackProducts()` and
`materializePreparedScriptablePack()` adapt that result to the
existing DDC/Catalog/Pack v2 publication tuple. No parameter, parent, sourceKey,
or TypeScript execution contract crosses into the runtime asset reader.

Production ScriptablePack artifacts use physical paths derived from their encoded
byte SHA-256. Identical bodies share one deployed file across asset GUIDs and
packages; each asset retains its local artifact key, media type, codec, delivery
metadata and integrity descriptor. Different bytes produce different paths. The
ordinary Pack/Catalog reader continues to verify every requested decoded body.

Hosts that already discover output keys use `createScriptablePackProduction()`
for one build generation. `inspect(source)` evaluates its owner and actual
content dependencies once; `produce(source)` finalizes the retained product
without repeating generation or encoding. Source keys come from discovery,
not a second authored output manifest. The existing worklist remains the route
for sources whose output identities are not yet known.

The generation fixes definitions, parameters, source closures, external snapshots
and cookers. Start a new generation after any input change or terminal failure;
the returned products are borrowed read-only build data. Inspection does not
publish or activate plugin assets. The host still validates the complete GUID
reference/deletion graph and current source revision before atomic publication.
Local owner failures never fall through to an older external snapshot. Concurrent
content cycles return the same structured stalled-worklist failure as serial cycles.

The worklist defaults to serial admission. `maxConcurrency` refills idle lanes
without waiting for a slow earlier subject, while retaining at most twice the
lane count of admitted, unpublished products. Publication remains in source
order; errors join all started subjects before returning. Each admission reads
the published prefix snapshot. Speculative content reads superseded by an earlier
producer retry through the existing bounded dependency/stall path. Production
admits at most four Pack workers, reserving 2 GiB of host headroom and 2 GiB per
lane from both free memory and remaining Node heap.
`FORGEAX_BUILD_CONCURRENCY=1..4` can lower this memory/CPU admission limit.
Custom native cookers keep host admission serial unless they explicitly declare
`concurrency: 'parallel'` for reentrant, input-isolated cooking. The builtin
material and particle cookers declare that capability. Existing worker lifetime
and source/reference validation remain in effect.

Source path projection preserves nested imports: `assets/original/assets/ui.pack.ts`
and `assets/cloned/assets/ui.pack.ts` remain distinct in both development and build
publications. Re-projecting an already-relative path must preserve its first asset root.
`projectPackBuildCatalog` owns the cooked output rows for both paths: staged semantic
keys join by GUID, while source indices, references, package identity and producer
provenance derive from the same completed Pack product. Hosts append their own
publication receipts and revisions after this projection.

Build-time asset **import** runner + `ImporterRegistry` — the build-time half of
the engine's import/load split.

> [!IMPORTANT]
> Filesystem import, DDC and native cooking remain build-time work. The browser
> entry exposes the shared data-production kernel and opt-in runtime Pack
> producer without filesystem, DDC, TypeScript or shader compiler dependencies.
> Portable mesh distance-field product cooking and encoding share this entry,
> so browser glTF consumers use the same opt-in producer without Node adapters.

### Runtime Pack production and durable content

`RuntimePackProducer` evaluates the delivered ScriptablePack definition and uses
the existing output producers, Pack identity and Catalog publication. Runtime
evaluation does not run offline staging, receipts or DDC orchestration. Its caller owns
one realm scope, native program host/import identities and actual domain validation.
Admission checks content without executing generators or installing plugins.
`inspect().imports` reports the Host-supported module specifiers and fixed
identities needed to prepare new code; it does not expose transport URLs.

| Operation | Authority and result |
|:--|:--|
| `prepareRuntimePackContent` / `admit` | Prepare ordinary assets, or admit a runtime-capable generator and its fixed program/dependency closure. Plugin sources retain the existing module/config lowering. |
| `prepareRuntimePackAnchor` | Project an existing `resolvePackParameterInheritance` result into one complete runtime generator, using its effective values as parameter defaults. Programs and fixed dependencies are retained. |
| `generate` / `withdraw` | Produce a complete parameter-instance output set, or withdraw its publication. GUIDs derive from instance packageId and sourceKey; consumer handles remain independently owned. |
| `snapshot` / `exportSource` / `restore` | Preserve original definitions, accepted instance inputs and reachable fixed dependency recipes. Restore re-admits into the current scope; it does not install plugins. |

Durable metadata is plain lossless JSON; binary leaves use owned Uint8/16/32 or
Float32 views. Pack's `copyPackData` rejects accessors, functions, sparse arrays,
subclasses and shared mutable storage without executing caller hooks. It preserves
view offsets and backing aliases while excluding unrelated backing bytes.

The `runtime-pack-source/2` snapshot uses Pack's `encodePackData` / `decodePackData`
for its explicit little-endian binary table at snapshot and source-export boundaries:
JSON paths identify typed views, and Base64 encodes each shared backing once.
Recovery checks kinds, alignment, ranges and complete table usage before replaying
the fixed dependency graph. Version 1 snapshots are rejected explicitly. Original
source and fixed recipes remain durable; cache entries remain disposable.

`admit` and `generate` return `RuntimePackPublicationReceipt`: identity, status,
publication evidence and Catalog rows. They do not copy the full source or mesh
into every operation result. Use `snapshot` or `exportSource` for original data.
Content-derived publication generations and repeated receipts remain stable.
Each producer owns one fresh Catalog root and advances its revision only when a
publication commits; its snapshot rows and incremental windows carry that order.
Reconstructing a producer starts a new root without changing fixed publication
identities. These live counters are not saved recipes or caller-maintained versions.
App injects the actual consuming Registry for private candidate preparation.
Native Mesh publications reuse domain payloads for same-realm GUID loading;
`openPackage` encodes the ordinary mesh binary only when a transport reader asks
for it. Failed encoding can retry, concurrent encoding shares one promise, and
file readers still verify real artifact integrity. No temporary Registry or
encode/decode round trip is required for the owning Registry.

Input capture and the consuming Registry keep separate isolated data; first GUID
consumption creates a mutable copy without changing the retained version.
public registration still validates payloads. This implementation does not claim
zero copy or exactly one validation pass. Measure cold capture, warm generation,
GUID loading, explicit export and GPU completion separately. Successful program
loads are reused; failed delivery retries. Direct data needs no program host or
ServiceWorker. Authored shader programs still require build-time Cook.

Direct assets and generator outputs share the runtime plugin producer. Generated
PluginAssets retain their original module, config and inline tool declarations
from ordinary output production, together with the admitted parent program
closure. Publication uses the existing PluginAsset lowering and target-specific
tool projection. A cache entry with a different program closure is discarded;
recovery rebuilds from the saved parent and instance inputs.

Runtime instances reference an admitted generator anchor, never another live
instance. Source producers resolve authoring inheritance before preparing the
anchor. Its existing parameter defaults hold the effective base values; no second
parameter table or runtime parent chain is needed. Preparation verifies the root
identity, parameter contract and complete effective value set, using the existing
metadata projection to serialize branded GUID defaults. Copy an instance with a
new packageId and the same anchor and sparse values; omitting an override restores
that anchor's default. Saved anchors recover without the original authoring chain.

External dependencies use `assetSource.retain(versions, signal)` when assembled
with an asset owner. It captures exact publication bytes and the complete sibling
and reference closure once; unused domain payloads decode lazily. App delegates
retention to assets-runtime. A mutable transport must be captured while its
version is available. The portable `exportSource(versions, signal)` boundary
remains available to external source owners and uses the same fixed recipes. `producer.exportSource(versions)` uses the same selection. Authored recipes retain
their generation inputs. Delivered recipes retain the original Pack, complete
sibling set, raw encoded artifact bytes and portable programs. `await createFixedRuntimePackSnapshot(...)`
captures its inputs before yielding and uses native SHA-256 to join these into
the same dependency graph without inventing a packageId or
re-authoring cooked assets. Only retained runtime references require recovery;
historical content-read evidence remains intact without requiring the original
authoring files. Existing references must match the saved publication through the
entire closure, including publication generation.
Within one admission, shared dependency recipes rebuild once. Later admissions
can reuse fixed data dependencies already held by committed Packs when every
dependency, sibling publication and external evidence remains current. Code-bearing
recipes retain their normal program validation path; withdrawing all holders
removes this reuse. Cold capture and retained-dependency generation are distinct costs.
Fixed plugin publications retain program and tool attachments grouped by the
existing build target in `executions`. The producer's optional `target` selects
which group's Host imports to check; other groups remain verified durable data.
This is not a no-execution restore mode: generator recipes, including dependencies
of a fixed root, still replay through the normal generation path.
Runtime-authored plugin sources accept an inline `toolContract` with the existing
`ToolCommandContract` shape. `projectRuntimePackTools(content)` derives native
contracts from that source, resolving every executor/export against the submitted
program closure. Missing or ambiguous programs and invalid full contracts fail
before publication; module-reference contracts must first be prepared as inline
data. Snapshots retain declarations only in the original source, without a second
durable tools table. Admission and recovery never evaluate contract or executor code.

`admit`, `generate` and `restore` accept a caller `AbortSignal`. Cancellation
fences publication and prevents starting the next recovery recipe; it does not
interrupt already executing JavaScript. Cancelling an admission does not withdraw
another caller's accepted content. Recovery commits each Pack independently, so
content already committed before cancellation remains admitted and inspectable.

A `RuntimePackProgram.artifact` is the verified JavaScript execution authority.
Optional `source` preserves author text for editing; runtime checks its module
structure, not TypeScript compilation equivalence. DevKit's
`prepareRuntimePackProgram` performs real TS conversion and retains its original.
Native JavaScript uses `preparePackProgram` directly and needs no compiler.
Saved JS artifacts plus their fixed dependencies support compiler-free recovery.

The low-level producer does not provide a storage backend, automatically rebind
World/Renderer resources, or own plugin installation. App assembly projects its
Catalog and plugin definitions into the existing consumers. Host/View integration
and delivery qualification are separate from these producer contracts.

### Source-package failure propagation

`produceSourcePackage` preserves the original `ImportError` for module loading,
source reads, source validation and conversion failures. External Pack staging
propagates the same error, including source-located `detail.diagnostics`. GUID closure errors describe an actual
missing, extra or duplicate output; they must not replace a failed importer with
an empty output list. The build adapter carries `code`, `expected`, `hint` and
`detail` into both the thrown error and its printable diagnostic. In particular,
`detail.loadError` names a missing module/WASM carrier before any Pack is emitted.

## The DIP (dependency-inversion principle) shape

This is the engine's **third DIP instance** after RHI and Console. The engine
owns the contract (`Importer` / `ImportContext` / `ImportTransport` in
`@forgeax/engine-types`); concrete importers are injected by the host.

```ts
// Host assembly (vite.config.ts or build script)
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';

export default {
  plugins: [
    pluginPack({
      importers: [gltfImporter, imageImporter],
    }),
  ],
};
```

### Three iron laws (architecture invariants)

1. **GUID import-stable**. The `*.meta.json` sidecar pins every target GUID at
   declare time. Import only reproduces those GUIDs, never mints new ones.
2. **Lazy**. The runtime reads meta only to build a *catalog* (which GUIDs
   exist, with which `kind`). Only a real `AssetRegistry.load(guid, kind)` triggers import
   (when the DDC is absent) + load. No eager full-import on startup.
3. **One-way dependency**. The engine owns the `Importer` interface; concrete
   importers are injected. The engine never reverse-imports `gltfImporter` /
   `imageImporter` / etc.

## The import/load split

```mermaid
flowchart LR
  src["source\n(.gltf / .png / .ttf)"] -->|"importer.import(ctx)"| ia["ImportedAsset[]\n(Asset PODs + GUIDs)"]
  meta["*.meta.json\nimporter + subAssets[].guid"] --> ia
  ia -->|"import runner\n(GUID iron law)"| ddc["DDC\n.pack.json / .bin"]
  ddc -->|"AssetRegistry.load(guid, kind)"| runtime["runtime Loader\n(@forgeax/engine-assets-runtime)"]
```

- An **`Importer`** (`{ key, import }`) turns one external source + its
  `*.meta.json` GUID declarations into in-memory `ImportedAsset[]` PODs. It is
  pure of disk write + GUID minting — it reads the GUIDs declared in the meta
  (the **GUID import-stable iron law**) and stamps them onto the PODs.
- The **import runner** (`runImport(meta, registry, fs)`) dispatches a sidecar
  by its top-level `importer` string key to the registered `Importer`,
  validates the produced GUID set against the declared set, and folds the
  result into a DDC `.pack.json` document. The reserved key **`importer:
  'shader'`** is skipped — shader sidecars are consumed by
  `@forgeax/engine-vite-plugin-shader`'s orthogonal transform pipeline.
- **`ImportTransport`** (interface in `@forgeax/engine-types`) bridges the
  build-time importer to the runtime: the shipped form wires `null` transport
  (pre-import at build time, DDC miss -> fail-fast `asset-not-imported`); the
  studio form wires an HTTP adapter (`POST /__import/:guid`) for lazy on-demand
  import.

## Injection shape

### ScriptablePack build bridge

`buildScriptablePack` decorates a host-provided Asset snapshot source with the ordinary `AssetReader`. Each GUID is fixed to one generation/digest and cloned for the current Build. The adapter validates the exact output-key/kind closure, stamps descriptor identity, dispatches each Asset to the reusable `AssetOutputProducerRegistry`, and derives external usage from actual reads plus serialized refs. Scene output uses the source definition's neutral `sceneComponents` schema; it never consults a global ECS component registry.

| Derived usage | Input fingerprint | Runtime ref |
|:--|:--|:--|
| `content` | Asset generation and digest | No |
| `reference` | GUID only | Yes |
| `both` | Asset generation and digest | Yes |

Domain producers return structured `ImportError`; the generic bridge contains no per-kind switch. `createStandardAssetOutputProducerRegistry(sceneComponents)` composes the production Scene, Material, and Mesh owners with the definition-bound scene schema. Scene refs use the ECS externalization kernel shared with runtime save, Material refs cover parent/texture/sampler GUIDs, and Mesh emits the versioned binary artifact. The fingerprint covers canonical Meta, the definition-bound scene schema, the recursive source closure, observed external evidence, authoring contract version, and registered producer versions.

Authored, staged and file-backed snapshots share `scriptable-pack-fingerprint/3`.
A binary leaf contains its type, view byte length and SHA-256 of the selected
bytes; ordered metadata hashes those leaves without concatenating large buffers.
Synchronous and native asynchronous hashing emit identical digests. Only one
immutable candidate scope may reuse leaf hashes. The version change intentionally
invalidates prior derived fingerprints; GUIDs and mesh wire formats are unchanged.
Native Mesh output identity hashes canonical attributes, indices, normalized bounds
and other domain fields. Interleaved vertices are a derived projection, checked
byte-for-byte before publication, and do not require a duplicate content hash.
Actual encoded artifacts retain independent byte-integrity SHA-256 digests.

When the host supplies `buildCacheRoot`, the ScriptablePack worklist checks a
Pack-product DDC entry before evaluating `build()`. Its key includes the current
source closure, package/parameter identity, output
producer versions, Node V8 serialization version, and registered native cooker
identities. The material cooker includes the verified executing Native fingerprint
even when its JavaScript and WGSL remain unchanged. Native provenance failure
leaves its identity unavailable and prevents reuse. Source bytes and entry
integrity are checked on read. A hit reuses the complete staged product, then
passes through the same current-generation
GUID/reference-closure validation as a cold build. Material CookedRecords keep
their publication fence in the stored product; the current generation is rebound
on reuse without recompiling the immutable material program. Products with observed
external content reads or a native cooker without `cacheIdentity` bypass this
cache; a miss or damaged entry rebuilds normally. These entries are disposable
derived data, not Pack or Catalog authority.

> [!NOTE]
> Pack-product entries store Brotli-compressed V8 bytes. A verified gzip entry
> migrates on demand without rebuilding the Pack; older uncompressed entries remain
> disposable DDC data. No product-size cutoff controls
> reuse: serialization, decompression, or cache I/O failure falls back to normal
> Pack production.

Before V8 encoding, equal immutable plain-data subtrees and byte bodies are shared
within the disposable product representation. Caller-owned publications are not
mutated; sparse arrays, special scalar values and cyclic/non-POD graphs keep their
semantics. This reduces repeated program metadata without changing source identity,
runtime schemas or borrowed Worker-buffer ownership. Progress diagnostics include
serialized/stored byte counts and main-process peak RSS samples at Pack completion.

Production emission of ScriptablePacks places cooked material WGSL at
`assets/shared/materials/programs/<sha256>.wgsl`. Pack descriptors keep their
asset-local artifact keys and point to that shared file. The emitter verifies
the path digest against every body before omitting duplicate writes, including
duplicates across Pack roots; mismatched bytes fail the build. Development
transport and non-material artifacts retain their existing paths.

`createScriptablePackStagedAssetSnapshotSource()` owns clean-build content reads. It resolves a GUID to its local source owner, lazily builds that owner inside one fixed generation, memoizes private clones and digests, and reports `pack-content-dependency-stalled` for a cycle without consulting an older fallback generation. A fallback is only an explicit prebuilt authority for GUIDs with no local owner.

`createStandardAssetOutputProducerRegistry(sceneComponents)` registers the production
Material, Mesh, and Scene producers. Material output derives
parent/texture/sampler refs. Material texture references serialize as
`{ texture: refsIndex, sampler?: refsIndex }`, including GUID string shorthand;
bare numeric values remain scalars in children without a local parameter schema.
Mesh output derives default-material refs. Its `mesh-binary/7` producer emits
the `mesh-binary/5` body and admitted distance-field sidecars; the alternative
data producer is `mesh-data/2`. These producer versions invalidate cached
publications when the output contract changes, without changing the Mesh
body codec. The binary body owns geometry; its JSON payload carries only kind
and optional distance-field metadata. Scene output uses the definition-bound neutral schema
through the shared ECS externalization contract. A specialized host may instead
register only the admitted kinds:

```ts
const outputs = new AssetOutputProducerRegistry();
outputs.register(materialAssetOutputProducer);
outputs.register(meshAssetOutputProducer);
```

### Mesh binary producer contract

The Mesh producer calls [`packMeshBin`](src/mesh-bin.ts), which delegates
projection facts to geometry and records one stable digest, mask, stride,
cardinality, and payload length in the artifact header. Material defaults are
references into the producer refs table; GUID strings are not duplicated in the
binary metadata. V5 writes morph targets as contiguous float32 streams; only
target/channel masks and weights remain in JSON. Published v4 artifacts remain
readable. `packMeshBin` is the encoder; the former version-suffixed export is removed.

> [!IMPORTANT]
> A producer Result error contains `subject`, `sourceKey`, `expected`,
> `actual`, and a re-cook recovery hint. Failed validation returns no artifact,
> so the importer cannot publish a partial mesh product. v2/v3 mesh binaries
> are not compatibility inputs.

For prebuilt ordinary Pack dependencies, use
`createScriptablePackFileAssetSnapshotSource({ assetRoots })` from the same
package. It recursively indexes validated `.pack.json` assets by GUID and
returns private `ScriptablePackAssetSnapshot` clones with deterministic
generation/digest evidence; missing, malformed, unreadable, and colliding
inputs remain structured `Result` errors.

At the low-level `buildScriptablePack` boundary, `assetSource` is optional only
when `build` never calls `reader.readByGuid`. The first attempted content read
without a source returns structured `asset-not-found`; no empty snapshot or
stale content is invented. Production Vite hosts provide the staged generation
source described above.

`ImporterRegistry` owns build-time producer dispatch: `register(importer)` (fail-fast on a malformed importer, idempotent
on a repeated key) + `get(key)` (returns `undefined`, which the runner maps to a
structured `ImportError(code='importer-not-registered')`).

```ts
import { ImporterRegistry, runImport } from '@forgeax/engine-import';
import { readFile } from 'node:fs/promises';

const registry = new ImporterRegistry();
registry.register(gltfImporter);

const fs = {
  async readSource(path: string) {
    try {
      const buf = await readFile(path);
      return { ok: true, value: new Uint8Array(buf) };
    } catch (e) {
      return { ok: false, error: e };
    }
  },
};

const result = await runImport(
  { importer: 'gltf', source: 'assets/box.gltf', subAssets: [...] },
  registry,
  fs,
);
if (result.ok) {
  console.log('DDC .pack.json:', result.value.pack);
}
```

## Error model

`ImportErrorCode` is a closed 5-member union (exhaustive `switch (err.code)`,
no `default:`). `ImportError` carries the four-field structured surface
(`.code` / `.expected` / `.hint` / `.detail`); SSOT lives in
`@forgeax/engine-types`.

| code | trigger |
|:--|:--|
| `importer-not-registered` | `meta.importer` has no registered importer |
| `source-read-failed` | `meta.source` could not be read |
| `import-produced-no-assets` | importer produced nothing, or omitted a declared GUID |
| `guid-mismatch` | importer produced a GUID not declared in `meta.subAssets[]` |
| `import-internal-error` | importer conversion or finalization failed; the runner wraps it in the existing structured Result. Finalization/digest failures carry a `detail.reason` prefixed with `finalization/digest`, and no CookProduct or Pack is returned for the failed attempt |

## Dual-form transport (M4)

| Form | `ImportTransport` | DDC source | DDC miss behavior |
|:--|:--|:--|:--|
| **studio** (dev server) | HTTP adapter `POST /__import/:guid` | lazily imported on demand | `transport.fetchPack(guid)` -> import -> load |
| **shipped** (player bundle) | `undefined` (null transport) | build-time pre-import via `generateBundle` | `asset-not-imported` fail-fast (never downgrades to runtime import) |

The runtime load path is **identical** in both forms — `ddcLoad` has zero
branches on transport. The only difference is whether `transportOrFail` is
reached on DDC miss (studio: it calls the transport; shipped: it returns the
error immediately).

## Indexed source-package lifecycle

Use this sequence when an import or Pack consumer reports a missing product:

1. **Inspect** the source Meta, declared GUID closure, Catalog row, DDC head,
   and producer receipt. Read the closed error union's `code` and `detail`.
2. **Repair** the source, Meta, or registered importer named by the detail.
   `ImporterRegistry` owns dispatch, while the source plus Meta remains the
   author authority.
3. **Rebuild** when the existing DDC entry can be replaced safely; **cold-cook**
   when integrity, receipt, or lifecycle state says the derived entry is
   invalid. Both paths use `runImport` and the shared finalizer.
4. **Verify** GUID closure, receipt freshness, DDC integrity, Pack artifacts,
   and the projected Catalog row.
5. **Retry** the same GUID after verification. Never parse an error message or
   turn an unverified source file into a runtime payload.

`runImport` keeps conversion and finalization failures inside its structured
Result boundary. A digest-capability refusal during CookProduct finalization
does not publish a partial product; repair that capability and retry the same
Meta/GUID through the same `ImporterRegistry`.

Successful source-package publication projects Catalog revisions from the head
accepted by its DDC commit. It does not reread a later writer's head or repeat
the complete entry validation; stale-owner recovery and transport rollback
retain their existing fences.

### Source-format LOD adapters

FBX and glTF producers pass the retained sidecar plus next `MeshLodMetaEntry` values
directly to `reconcileMeshLodMeta(previous, next)`. That owner preserves source-key/GUID
identity, prior authored coverage and shared first-import defaults; both formats
use `meshGuid` throughout this projection.

Format adapters project producer facts into the same `MeshAsset.lods` and Pack
closure. The adapter owns interpretation; the sidecar owns retained author
facts and the importer only produces validated derived output.

| Source fact | Normalized result | Required closure |
|:--|:--|:--|
| glTF `MSFT_lod` node relation | ordered root and lower mesh GUIDs | root `refs[]` contains every lower mesh |
| FBX `FbxLODGroup` level relation | ordered root and lower mesh GUIDs | root `refs[]` contains every lower mesh |
| sidecar `sourceOverrides.mesh.lods` | retained `screenCoverage` and source keys | every GUID resolves in the same package |

On first import the helper derives lower-level coverage with

$$c_i = round6(0.5 \times 0.4^{i-1})$$

for `i = 1 .. n`, where `n` is the number of lower levels. This yields
`0.5` for two total LODs, `0.5, 0.2` for three, and `0.5, 0.2, 0.08`
for four. Existing legal sidecar values always win; only a newly appended
suffix receives defaults. A changed middle source key or mesh GUID is rejected
and the previous sidecar plus last-known-good product remains authoritative.

The import package stops at build-time source conversion and product
publication. It does not write authoring state, own Editor operations, or add
runtime transport branches. A dev `ImportTransport` is an explicit host
adapter; a shipped bundle must carry its build-time product and keeps
`asset-not-imported` fail-fast semantics.

## Mesh LOD normalization and recovery

`reconcileMeshLodMeta` reads the retained sidecar value directly. Both glTF and FBX use its admission policy: non-array values and entries without string source keys/GUIDs contribute no retained fact; numeric coverage still passes through the existing LOD contract validation.

The shared helper in `src/mesh-lod.ts` owns validation, default coverage, and
prefix-stable reimport. For `n` lower levels, first-import defaults are derived
once with:

$$c_i = round6(0.5 * 0.4^{i-1}), 1 <= i <= n$$

Thus two levels produce `0.5`, three produce `0.5, 0.2`, and four produce
`0.5, 0.2, 0.08`. Existing legal sidecar values win; newly appended suffix
levels receive defaults. A middle sourceKey or GUID change is a structured
topology/authority error, so the previous sidecar and LKG remain intact.

```mermaid
flowchart LR
  A["source plus Meta"] --> B["validate LOD facts"]
  B -->|"valid"| C["reconcile prefix and defaults"]
  C --> D["publish Pack and Catalog"]
  B -->|"invalid"| E["restore old sidecar and LKG"]
```

## Lightmap UV validation

`validateLightmapUvs(levels, uvSet = 'uv1')` checks the lightmap UV set of a
mesh that will receive baked lighting, LOD0 first. It is the prerequisite gate
for a baker; no baker consumes it yet. Every level must carry `uvSet`, every UV
must be finite and inside `[0, 1]`, and LOD0 charts must not overlap (shared
edges and vertices are allowed).

The result chooses lightmap storage. `shared` means every lower LOD samples the
LOD0 lightmap, because each lower-LOD triangle (its vertices, edge midpoints,
and centroid) lies inside LOD0 chart coverage. Otherwise the result is
`per-lod`, and each level is baked on its own. It carries a
`lod-lightmap-uv-mismatch` diagnostic naming the first drifting level and
triangle, and each level must then be overlap-free on its own. Hard failures use
the closed `LightmapUvErrorCode` union: `lightmap-uv-missing`,
`lightmap-uv-out-of-range`, and `lightmap-uv-overlap`. Its `detail` always names
`lodIndex` and `uvSet`.

## Plugin output producer

`pluginAssetOutputProducer` validates module/config source, resolves a portable program locator and lowers `$asset` configuration markers into GUID strings plus derived refs. It emits only a definition; compilation and native activation stay with DevKit and Cordis. Bootstrap source discovery and ordinary cooking must agree on the definition before publication.

## Optional mesh distance-field cooking

`createMeshDistanceFieldCooker()` registers the explicit `mesh-distance-field`
operation with the existing `NativeCookerRegistry`. Input is the source mesh GUID,
indexed positions and one explicit recipe: geometric `resolution`/`twoSided`, or
`policy: 'sampled-visibility'` with source-unit `voxelSize` and one
`triangleSidedness` flag per triangle. The draft keeps that GUID and one
`distance-field.bin` artifact; its fingerprint includes geometry, settings and
producer version. The current recipe fingerprints version 5 and publishes the
Geometry version-4 brick artifact; older dense artifacts require a producer
rebuild. There is no second authored SDF asset or registry.

`cookMeshDistanceFieldProduct(mesh, guid, voxelSize, sectionSidedness)` enriches
an ordinary Mesh publication with this artifact. The glTF producer invokes it
only for `importSettings.meshDistanceField`; generated or previously loaded Mesh
assets use the existing Mesh output producers, including the JSON data producer.
No runtime path invokes the field builder.

For collision, `cookMeshDistanceFieldProduct(mesh, guid, { resolution },
sectionSidedness)` requests the geometric recipe. Homogeneous `0` section flags
select signed solid; homogeneous `1` selects explicit two-sided surface distance.
Mixed sections fail rather than inventing a sign policy. The ordinary Mesh
descriptor retains only section sidedness and the artifact uses
`MESH_GEOMETRIC_DISTANCE_FIELD_CODEC`. Numeric sampling continues to select the
sampled-visibility recipe. Re-publication derives the codec and descriptor from
the field's policy and validates current geometry/sidedness before encoding.
Neither recipe adds a field GUID or an authored asset kind.

| Product fact | Authority |
|:--|:--|
| Geometry and GUID | Ordinary mesh body or JSON payload and existing Catalog row |
| Source material sidedness | Small `distanceField.sectionSidedness` publication payload |
| Field samples and geometry/source digests | Asset-local `distance-field.bin`, using Geometry's checked codec |
| Builder revision | Existing artifact `assetCodec.profile`, derived from Geometry's generation revision |

The complete producer strips decoded field data before calling geometry-only
`packMeshBin`; direct binary encoding of a Mesh with `distanceField` fails
explicitly. The JSON route retains its geometry even when it also has a field
artifact. Publication and RuntimePack save/restore preserve the same descriptor
and artifact; there is no separate field GUID, registry, or runtime cooking.
Re-export removes loaded `distanceField.artifact` provenance before encoding pure
field data and derives the new descriptor from actual encoded bytes. An unchanged
loaded field therefore reproduces the same artifact bytes and digest.
Atomic publication retains its existing last-known-good behavior, and supported
Catalog invalidation reloads replacement geometry and field bytes together.

Omitted settings produce no field data or artifact. Build-time changes to geometry,
source sidedness, voxel size or builder revision change the completed product
identity. Warm DDC publication reuse is distinct from field cooking: this slice
does not add a per-field cook cache or Renderer subscription.
Codec profiles version ordinary published artifacts. Externally authored decoded
POD remains caller-owned data: re-export checks structure, current geometry and
sidedness, but does not authenticate which builder produced external samples.

## Optional mesh card layout cooking

`createMeshCardCooker()` registers `mesh-card-layout` in the existing
`NativeCookerRegistry`. It consumes indexed geometry under the original mesh
GUID and publishes `mesh-cards.json`. Geometry digest, algorithm version,
sampling resolution, card budget and two-sided policy determine the input
fingerprint. Material capture and its texture revision remain separate from
this geometry layout. Rejected builds or publication preserve the existing
transaction's lastKnownGood generation; retry uses the same GUID. There is no
new authored asset kind or automatic per-frame construction.

## Static mesh interchange producers

`obj`, `stl`, and `svg` are Engine-owned standard importer keys whose canonical
`mesh` outputs are admitted by the same Catalog policy as glTF/FBX. Their source
admission, bounded conversion and mesh-bin artifacts belong to
[`packages/mesh-io`](../mesh-io/README.md). DevKit registers all three by default;
custom hosts inject those producers through the existing importer registry.
Source plus Meta retains GUID/sourceKey authority; these adapters add neither
runtime source parsing nor a second Catalog.

## Automatic Mesh LOD production

`generateMeshLods(mesh, options)` from `@forgeax/engine/import/mesh-lod-generator`
is an explicit source-production operation. It uses meshoptimizer 1.1.1 before
publication; neither the runtime loader nor Renderer imports the simplifier.
The input is the canonical `MeshAsset` produced by glTF, FBX, mesh-io, or a
geometry factory. An existing authored LOD chain is rejected rather than replaced.

```ts
import { generateMeshLods } from '@forgeax/engine/import/mesh-lod-generator';

const generated = (await generateMeshLods(sourceMesh, {
  maxError: 0.02,
  levels: [
    { mesh: lod1Guid, triangleRatio: 0.5, screenCoverage: 0.5 },
    { mesh: lod2Guid, triangleRatio: 0.25, screenCoverage: 0.2 },
  ],
})).unwrap();
// Publish generated.root under the original GUID and generated.meshes[i]
// under levels[i].mesh with the ordinary Mesh output producer.
```

The caller supplies stable GUIDs through the existing source-key identity route.
Publish the root and all generated siblings atomically through the ordinary
Pack production path. The Mesh producer emits the root's lower-level refs and
mesh-binary v5 artifacts; Catalog and `assets.load(guid, 'mesh')` consume them.
For ScriptablePack, declare the same output keys and return the root and siblings
from `build`. Generation never allocates GUIDs, writes source, or changes the input.

| Contract | Behavior |
|:--|:--|
| Levels | One to seven, strictly decreasing triangle ratios and screen coverage |
| Error | `maxError` in `[0, 1]`, relative to source extent, including weighted attributes; each level simplifies the original independently |
| Sections | Triangle lists with a complete ordered partition; original material slots and section identities survive |
| Appearance | Attribute-aware normals/tangents (weight 0.5), all UV sets and color (weight 1), topology-preserving seams |
| Open edges | Locked by default; `lockBorder: false` permits boundary simplification |
| Deformation | Edges whose skin or morph streams differ are locked; surviving streams are copied byte for byte, including tangent W |
| Storage | Unused vertices are removed across every attribute/morph stream; the source index width is retained across the chain and bounds are regenerated; a nonindexed source is indexed once |
| Derived geometry | Lower meshes omit source cards/distance fields; regenerate those products for the new geometry if needed |
| Unreachable target | Overall mesh triangle ratio determines `reports[i].targetReached`; if false, the error budget and protected topology remain intact, and a level may retain the original triangle count |
| Failures | Closed `MeshLodGenerationError` codes carry expected/hint/detail; repair source/options or the WASM build host |

> [!IMPORTANT]
> Deformation protection is conservative. Highly varying skin weights or morph
> deltas can prevent reduction. The error value is the simplifier's metric, not
> a proof of pixel equivalence or animation quality; validate the produced asset
> at its intended viewing distances. General animated-mesh simplification with
> a pose-sampled error metric is outside this operation's contract.

Reproduce production cost with `node scripts/bench/mesh-lod-generation.mjs` after
`pnpm build:engine`. Real HTTP/Catalog, Standard rendering, lower-level selection,
foreground pixel error, and fresh RHI Debug replay are exercised by
`packages/runtime/src/__tests__/generated-lod.{browser,dawn}.test.ts`.

Set `MESH_LOD_PERF=1` for `generated-lod-performance.dawn.test.ts`: 64 instances,
ABBA windows with 60 warmup and 60 measured frames, without a recorder. The
report retains GPU interval sum, union, overlap, and envelope separately.

## G6 production and validation evidence

The `render-27` gap is addressed by the explicit build-time
[`generateMeshLods`](src/mesh-lod-generator.ts) operation.
It produces ordinary Mesh assets and links them through the existing authored
LOD contract. The loader and Renderer do not acquire a simplifier dependency.
The [Import contract](#automatic-mesh-lod-production)
defines options, error protection, publication and reproduction commands.

```mermaid
flowchart LR
  S["Canonical MeshAsset"] --> G["Error-budgeted generation"]
  G --> P["Ordinary Mesh output producer"]
  P --> C["HTTP and Catalog"]
  C --> R["Existing Renderer LOD selection"]
  R --> D["RHI Debug capture and fresh-device replay"]
```

### Source comparison

| Reference | Applied decision |
|:--|:--|
| [Godot `ImporterMesh::generate_lods`, audit pin](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/scene/resources/3d/importer_mesh.cpp#L570) | Attribute-aware meshoptimizer simplification per triangle section; lock geometric boundaries by default. Each requested level starts from the original mesh under its own error budget. |
| [Three.js `SimplifyModifier`, local reference pin](https://github.com/mrdoob/three.js/blob/d3b629c0c2097cec664ad16369bb6eae3b10e335/examples/jsm/modifiers/SimplifyModifier.js) | Keep source production separate from rendering. Preserve all canonical streams during compaction rather than projecting only a modifier's supported attributes. |
| Unreal `ReduceMeshDescription`, audit pin | Make reduction targets and error constraints explicit, preserve material sections, and report an unreachable target. |
| [meshoptimizer JavaScript API](https://github.com/zeux/meshoptimizer/blob/v1.1/js/README.md) | Pin 1.1.1; use `simplifyWithAttributes` and `compactMesh` at source-production time. |

### Quality and regression evidence

The fixture publishes source and generated meshes through the real MeshBinary
v5 producer, Pack/Catalog HTTP transport and GUID loading. It also cooks and
publishes the actual Standard material. Source, two generated levels and
automatic GPU-driven selection each complete 60 frames. Foreground comparison
requires more than 100 non-background pixels; the limits remain 0.05 for visual
error and 0.005 for fresh-device replay.

| Observation | Browser WebGPU | Dawn / Metal |
|:--|--:|--:|
| Source / generated triangles | 3,968 / 1,984 / 992 | 3,968 / 1,984 / 992 |
| First level mean foreground error | 0.000645 | 0.000592 |
| Second level mean foreground error | 0.002103 | 0.002139 |
| Fresh replay error, all four captures | 0 | 0 |
| Native replay validation errors | 0 | 0 |
| Automatic selection | Level 2 | Level 2 |

The deeper native inspection reads the indirect commands at color work 17:
level 2 submits **2,976 indices for one instance**; source and intermediate
commands submit zero instances. Pipeline, binding and index-buffer facts are
inspected on a fresh replay device. Every fresh device is explicitly destroyed.
The ordinary Browser configuration also passed the additional indirect assertion:
363.90 seconds in the case and 483.40 seconds for Vitest including startup.

The real automatic-selection reproducer exposed the chain's shared index-format
invariant: compacting a Uint32 source into Uint16 siblings made residency fail.
Generation now retains the source index format across every level. A nonindexed
source is indexed once. Unit regression covers both widths and nonindexed input.
Import's complete local suite passed **35 files / 210 tests**, including material
partitions, UV seams, open borders, byte-preserved skin/morph streams and blocked
reduction under a zero error budget.
The single-triangle regression first failed, then passed after reporting the
requested ratio rather than the minimum valid triangle count as the target.
A second red regression confirms that target achievement derives from the whole
mesh count, even when one tiny material section retains its source triangle.

> [!IMPORTANT]
> Varying skin weights or morph deltas lock candidate edge endpoints. This is
> conservative protection, not a pose-sampled animated simplifier. Such inputs
> may retain their source triangle count and report `targetReached: false`.

### Measured production and rendering cost

Production uses one warmup and 20 samples on an Apple M4 Pro / Node 26.4.0.
These CPU measurements were taken on a machine running other work.

| Source triangles | Median production | p95 | Coarsest triangles | Coarsest geometry bytes / source |
|--:|--:|--:|--:|--:|
| 3,968 | 8.98 ms | 57.08 ms | 992 | 43,152 / 150,576 |
| 16,128 | 53.41 ms | 192.21 ms | 4,032 | 160,272 / 596,016 |
| 65,024 | 298.12 ms | 523.57 ms | 16,256 | 615,696 / 2,371,632 |

All requested ratios were reached within `maxError: 0.02`. Coarsest reported
errors were 0.005390, 0.001241 and 0.000311 respectively.

The final native rendering measurement held an exclusive physical GPU lease.
It uses 64 instances at 128 x 128, ABBA order, 60 warmup and 60 measured frames
per window, with no recorder. GPU interval sum, union, overlap and envelope are
retained separately; the table reports the envelope, not summed nested passes.

| Window | Submitted triangles | GPU median / p95 | CPU draw median |
|:--|--:|--:|--:|
| A: source | 253,952 | 0.590 / 0.655 ms | 2.073 ms |
| B: coarse | 63,488 | 0.328 / 0.393 ms | 1.855 ms |
| B: coarse | 63,488 | 0.328 / 0.393 ms | 1.816 ms |
| A: source | 253,952 | 0.590 / 0.655 ms | 1.778 ms |

This scene has a lower GPU interval envelope; CPU windows do not show a stable
gain. Timestamp results are quantized on this adapter. These are scene-specific
measurements, not a general FPS guarantee or exclusive geometry-pass cost.

### Delivery checks

- [x] Source build, runtime dependency closure, Import unit suite and strict types.
- [x] Browser and Dawn capture/replay, native indirect-command inspection.
- [x] Production benchmark and final exclusive native ABBA measurement.
- [x] AC-08 exact fixture admission and browser scheduling contracts (68 tests).
- [ ] Final complete Browser, Dawn and 60-frame hello / learn-render smoke fleet.

Local full-gate failures are retained: Preview Pack preparation encountered
`ENOSPC`; an inherited production environment made the framebuffers development
page request the absent `/pack-index.json`; Browser HDR startup and Dawn clipping planes exceeded their
existing deadlines. Preview and entity visibility subsequently passed. Full
gates remain required; these partial results do not establish full acceptance.
An additional Node 22 Browser run reached its original 630-second process
deadline. The ordinary Node 26 Browser and native G6 runs above passed; this
extra timeout remains negative evidence pending complete CI on the final commit.

## Static navigation production

The Node-only `@forgeax/engine/import/navigation-bake` subpath exposes
`bakeNavigationMesh`: selected indexed MeshAsset/world placement plus finite agent
settings produce portable `navigation-mesh` POD. Return that result from the
ordinary Pack build; source closure/parameters govern input freshness, while the
asset digest includes transformed geometry, settings and cooker version.

The pinned MIT Recast 0.43.1 implementation and its 338,824-byte WASM payload
remain on this production route. Player queries use the
[Navigation contract](../navigation/README.md#static-navigation-assets-and-physical-characters).

## Streamed audio import

Audio Meta `importSettings.playback` selects `buffer` (default) or `stream`. The audio producer owns the PCM16 index and codec admission. `ImportedArtifactBody.delivery` is retained in the product descriptor and package finalizer, so Cook/Catalog/GUID loading can defer the complete artifact body. Authored Pack audio keeps its artifact-owned bytes; a runtime HTTP locator cannot be serialized as authored source. See [the format and delivery contract](../audio-webaudio/README.md#long-audio-through-source-meta-and-guid).

## Mesh collision cooking

`cookMeshCollision(mesh, setting)` is the format-neutral opt-in producer.
`undefined` or `false` leaves geometry unchanged; `true` attaches Geometry's
validated, seam-welded collision triangles; every other value fails with the
existing structured `AssetError`. glTF and FBX use
`importSettings.meshCollision` before mesh-bin encoding, retaining the original
mesh GUID and dependency closure. Scriptable Packs can invoke this kernel or
`buildMeshCollision` directly and publish the same MeshAsset contract.

> [!IMPORTANT]
> Source skinning/morphs and non-triangle topology are rejected. This produces
> static mesh facts; native convex hull construction belongs to the physics
> backend. It does not perform convex decomposition or invent another asset GUID.

Binary16 output uses the Math codec, including rounded mantissa carry into the
next exponent. Source parsing, LUT channel order, IES normalization and GUIDs
remain owned by their existing producers.

Producer payload typing derives unchanged kinds from the Asset union and lists
only serialized overrides explicitly. Product payload, reference and artifact
fields derive from ImportedAsset; runtime Assets still never carry ref indices.

### Small mesh transport chunks

`FORGEAX_BUNDLE_SMALL_MESHES` opts a production build into physical mesh
bundling. Unset, empty, or `0` disables it; `1` selects all source publications;
any other nonempty value selects a project-relative source-path prefix. Prefer
a measured source family over a global opt-in: unrelated consumers can have
different read orders and transfer costs. Asset GUIDs, payloads, refs, codecs and individual
integrity facts remain unchanged.

| Constraint | Value |
| :-- | --: |
| Eligible identity-encoded mesh artifact | At most 8 KiB |
| Stored container | At most 64 KiB |
| Minimum members per container | 4 |
| Private runtime container cache | 4 MiB, at most 256 entries |

Chunks follow the producer's asset order. A loader should read in that order to
avoid redundant transfers when its working set exceeds the cache. Each range
retains individual integrity and declares a complete container digest. Runtime
admission verifies the container once, verifies each logical artifact, and gives
each decoder a private window. Memory pressure and source disposal release
completed chunk bytes. Fixed publication capture retains complete containers
for portable replay.
