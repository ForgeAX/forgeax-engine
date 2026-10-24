# @forgeax/engine-assets-runtime

## Private generated content

`adoptPreparedContent(pack, fields, beforeCommit)` consumes a single-use preparation from
`preparePublication`. It checks the captured source and runtime revisions,
validates the complete candidate closure (including keyed Scenes), and atomically
replaces runtime content under its managed identities. Optional field patches
carry current live author values into that candidate. Scene reference indices resolve
against the candidate Pack table. Optional synchronous acceptance can spawn a new
consumer before commit; rejection rolls back every sibling asset. Failure leaves the previous
content intact; source Catalog/publication evidence remains unchanged and
`sourceOf` reports modified runtime content. Ordinary Runtime Pack admission keeps
its existing collision and publication rules. App owns author preview lifetime;
this capability does not introduce editor state into game registries.

`AssetRegistry` owns runtime asset identity, content, revisions and lifetime.
Games create or load one asset, bind its handle, and edit that same asset. A
Renderer, physics world or player adopts changes at its own execution boundary.
View uses these engine operations; editing requires no tool, override component
or caller-maintained version.

## Runtime entry

Use the asset owner supplied by Engine/App. A standalone World can supply one:

```ts
import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { World } from '@forgeax/engine/ecs';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';

const assets = new AssetRegistry();
const world = new World({ assets });
const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
const material = assets.create(Materials.standard({
  baseColor: [1, 1, 1, 1], roughness: 0.5,
})).unwrap();
world.spawn(
  { component: Transform, data: {} },
  { component: MeshFilter, data: { assetHandle: mesh } },
  { component: MeshRenderer, data: { materials: [material] } },
).unwrap();
assets.update(material, { values: { roughness: 0.2 } }).unwrap();

// ECS bindings hold their own references after spawn succeeds.
assets.release(mesh).unwrap();
assets.release(material).unwrap();
```

| Operation | Contract |
|:--|:--|
| `create(content)` | Capture and validate independent runtime content; return a caller-owned handle |
| `load(guid, kind, { signal }?)` | Read the verified source closure, or retain the already loaded runtime identity |
| `read(handle)` | Return detached content, including copied arrays and buffers |
| `update(handle, patch)` | Commit a validated patch; material `values` merge named parameters |
| `replace(handle, content)` | Replace complete same-kind content under the existing handle |
| `writeRange(handle, range)` | Commit a mesh attribute, texture pixel or Terrain height range |
| `copy(handle)` | Create independently editable content and preserve its admitted domain contracts |
| `snapshot(handle)` | Retain exact content and dependency versions; dispose when finished |
| `reload(handle, { conflict })` | Explicitly adopt a current source closure without silently discarding gameplay edits |
| `source(handle)` / `sourceOf(handle)` | Read adopted provenance / adopted provenance with the modified flag |
| `retain(handle)` / `release(handle)` | Transfer reference ownership independently of rendering |

Full signatures live in [AssetRegistry](src/asset-registry.ts). Mesh geometry
factories belong to [Geometry](../geometry/README.md); there are no reserved
built-in mesh handles or additional World payload registrations.

## Source loading and Catalog

Source GUIDs identify authored outputs. Runtime handles identify admitted content
within their owner. Catalog is navigation and producer evidence; changing a
Catalog row does not overwrite game edits or rebind existing entities.
Publication generation belongs to the immutable content tuple; Runtime Pack
derives it from content, so its numeric order is not publication order.
Sequenced sources attach `revisions` to the successful `enumerate()` Result,
captured with those rows even when a root is empty, and send contiguous
`CatalogDelta.revisions` windows. The replica retains the accepted root revisions
and rejects gaps, replay and conflicting tuples. Sources without this sequence
evidence must advance their publication generations monotonically. Author
timestamps remain provenance: a dependency rebuild can leave them unchanged.

Sequence state costs one counter per producer root; incremental admission visits
only the delta's rows and roots. Enumeration and reconciliation are explicit
Catalog reads, never per-frame change detection. A composed source preserves the
captured revision metadata; a reconciliation gap requires its consumer to obtain
a fresh baseline before using subsequent deltas.
For a sequenced source, `get(guid)` returns rows already accepted through a complete
publication window, including first materialization. A partial demand response
cannot advance the root past updates to other assets: an unpublished result is
rejected while the accepted rows and stream remain unchanged and ready for later
valid windows. Sources without sequence evidence retain ordinary demand admission.

Material Cook records remain with the decoded publication and shader owners.
Mutable runtime content and its snapshots contain the material contract and
values, without another `cooked` program/ABI tree per material. Content budgets
therefore charge the accepted material data rather than duplicate publication
records. Program validation and static-selection admission still precede content
publication; numeric edits retain their accepted program projection.

```ts
assets.configurePackIndex('/pack-index.json');
const material = (await assets.load(materialGuid, 'material')).unwrap();
assets.update(material, { values: { roughness: 0.2 } }).unwrap();
const saved = assets.snapshot(material).unwrap();
try {
  const fixed = saved.read<import('@forgeax/engine/types').MaterialAsset>(material).unwrap();
  // Use fixed content while the live asset may continue changing.
} finally {
  saved.dispose();
  assets.release(material).unwrap();
}
```

A URL Catalog source binds to the first verified authoritative snapshot's scope
and generation. An explicit `configureRuntimeBinding(binding)` or
`createCatalogSource({ expectedScope })` fences that identity before the first
read. Later foreign scopes, generations and unfenced arrays are rejected.
Relative package locators resolve against the Catalog URL. A raw source file
cannot masquerade as a cooked `packageUrl`.

`createCatalogSource`, `setCatalogSource`, `enumerateCatalog`, `listCatalog` and
`subscribeCatalog` expose the existing navigation surface. Enumeration is an
explicit caller operation; runtime change adoption does not enumerate Catalog.
Producer deltas update named rows; discontinuity requires explicit reconciliation.
An injected import transport can request a declared unpublished output. Runtime
writes do not invoke Import, Cook, DDC or a filesystem save.

A source read verifies the complete Pack tuple, artifact lengths and SHA-256,
then invokes installed domain decoders. New dependencies and content become
visible together. A failed read, stale publication or decoder failure cannot
replace the previously accepted runtime closure.

## Domain preparation

Freshly parsed Pack material programs share validated immutable ABI facts. Runtime edits and decoder payloads stay detached; source publication integrity checks still run before admission.

Engine/Runtime installs the default domain contributions. A bare Registry must
install the contributions used by source loading or custom content. For example,
a Terrain closure also requires its Material, Texture and Sampler owners.
Missing preparation produces a structured failure; it does not bypass validation.
Built-in source kinds follow the [ScriptablePack matrix](../pack/README.md#scriptablepack-in-30-seconds).

`defineAssetKind<P>('kind')` binds a custom payload type. Install its
`AssetDecoderContribution` with `assetDecoderPlugin(contribution)` in a Cordis
Fiber, or own the lease from `assets.installDecoder(kind, decoder)` directly.
`assetsPlugin(assets)` supplies the same runtime owner to a host context.
During source adoption, synchronous `prepare` may read detached content and
declare dependencies. Reentrant writes, lifecycle/source replacement and
fixed-version or observer creation/reads fail with `asset-write-conflict`; void
lifecycle operations throw that structured error before changing the owner.

A decoder with only `decode` can load read-only source content; runtime creation
and writes require its synchronous `prepare` contract.

| Content | Adoption policy and detailed owner |
|:--|:--|
| Material / Sampler | [Render](../render/README.md#materialasset-render-contract) shares one accepted material per context; value edits retain compatible programs, structural edits prepare a new contract |
| Mesh / Texture | Geometry layout and image shape validate before commit; Render owns selected uploads and resource retirement |
| Terrain | [Terrain](../terrain/README.md#runtime-editing-and-adoption) derives canonical sections and handles height ranges; Render and Physics retain exact accepted versions |
| Animation / Skeleton / Skin | [Animation](../animation/README.md) adopts at sampling boundaries; binding and playback time remain instance state |
| Audio / Video | Native playback owners consume admitted source versions; playback intent and cursor remain instance state |
| VFX | [VFX](../vfx/README.md) validates effect content; [VFX Render](../vfx-render/README.md) owns GPU replacement and ordered tick intents |
| Scene / Plugin | Definitions affect later instantiation or activation; changes do not broadcast over running entities or native Fibers |
| Navigation | [Navigation](../navigation/README.md) admits bounded topology and owns query workspaces; the producer owns bake freshness |

## Scene references and failure atomicity

Native Scene creation externalizes component references using the registered
schema. Source Scene payloads retain their owning Catalog `refs` table until
instantiation. Only `asset(kind)` fields and their arrays decode asset references;
ordinary numeric and string values keep their original meaning. Nested Scenes
use their own table; instance overrides use the parent table. Wire `null` is an
empty asset reference and wire `0` selects the first table entry.

Entity references resolve within the complete instance before spawning. A
malformed reference, publication-fence mismatch or post-spawn binding failure
releases partial entities and holds. Collecting an instance follows schema
references and admitted source provenance. Runtime-created referenced content
needs an explicit publication when exporting to durable GUID-based source.

## Concurrent load and cleanup contract

Each load observes its own AbortSignal. Cancellation ends that wait; admitted
shared I/O remains available to other consumers. Owner disposal aborts pending
reads and prevents late cache refill. `invalidate`, `invalidateAll` and Catalog
reconciliation affect source reads; accepted runtime content changes through
explicit reload. `trimReadCache` drops disposable completed reads.

Verified Pack documents are held strongly through a burst of sibling reads, then
kept through weak references after two seconds without a read. When the host
reports memory pressure, `trimReadCache` demotes those documents immediately.
A live document can be reused; after collection, a later request fetches and
verifies the same complete publication tuple again. Decoded runtime content and
shared immutable material facts stay with their accepted consumers. This cache
release never invalidates a publication or retires a live asset. Hosts without
`WeakRef` retain the strong read cache.

Transient network/body failures and HTTP 408/429/500/502/503/504 retry twice,
after 250 ms and 750 ms, with `cache: 'reload'`. Aborts and permanent errors fail
without retry. Cache reuse retains descriptor identity and integrity validation.
Capture uses the exact bound source transport, with bounded stored-byte caching;
a different source never borrows an unrelated URL-only cache.

## Material publication inspection

`MaterialReady` is `{ status: 'Ready', record }`. Its validated record owns
publication identity, source closure, parameter contract and verified program
bytes. `inspectMaterialRuntime(ready)` returns detached diagnostic facts.
`inspect(guid)` observes source evidence; `sourceOf(handle)` reports the accepted
publication and whether runtime content has changed since adoption. Runtime
consumers use the program projection attached to that owned content.

Runtime selects only prepared program contexts. Root and child source materials
preserve explicit static choices; parent inheritance is flattened at admission.
Ray-hit and Card-capture programs share the same complete artifact verification.
Missing bytes or a mismatched context reject preparation; no runtime shader
compiler or guessed module name repairs the publication.

### MaterialAsset runtime recovery

`MaterialAsset` sources keep `passes`, `values`, `parent` references and per-slot
`coordinates` in one closure. Source cook prepares the program contract; runtime
recovery repairs the owning input and retries the operation. Shader binding rules
belong to [Shader](../shader/README.md#materialasset-and-shader-route).

| Code | Recovery |
|:--|:--|
| `material-specialization-not-cooked` | Cook and publish the missing program selection |
| `material-parent-not-found` | Restore the parent in the source closure |
| `material-value-type-mismatch` | Correct the parameter value before retrying the write or load |
| `material-reflection-binding-mismatch` | Correct shader parameters and re-cook the binding contract |

## Runtime image bytes decoder

`decodeImageBytes(bytes, mime, { colorSpace?, mipmap? })` decodes PNG/JPEG bytes
with browser `createImageBitmap` and `OffscreenCanvas`, returning a
`Result<TextureAsset, ImageError>`. Feed the result to `assets.create` and bind its
handle. It performs neither network I/O nor GPU upload. Missing browser
capabilities, unsupported formats and decode failures remain structured errors.
Shipped source textures use the same ordinary Catalog/Pack loading path.

`DynamicTextureStore` handles native video frames and explicit Canvas updates;
[CanvasTexture](../render/README.md#canvas-textures) remains Render's public
source API. It preserves a previous accepted view when resize/upload fails and
retires its own device resources without destroying caller-owned native content.
Canvas uploads allocate complete mip chains; video retains one level. Dirty
chains enter a queue on successful upload. After material binding records actual
consumers, the existing mip generator records only queued chains into a command
buffer submitted before scene work in the same Renderer submission. An empty
queue allocates nothing. Submission acknowledges that upload; abort retains pending work,
and scratch resources retire on either outcome. sRGB mip filtering occurs in
linear light.

## AssetEvidence SDK boundary

`inspect(guid)` and `verifyByGuid(guid)` project injected source, Catalog, Cook
receipt and package verification evidence. `configureAssetEvidence(source)`
provides that host capability. Missing evidence remains unknown, and source
readiness is distinct from actual runtime adoption or GPU completion.
Source and Cook audit vocabulary belongs to the [asset authority schema](../../schemas/asset-authority.schema.json).

## Error model and verification

Branch on the owning structured `code`, `expected`, `hint` and `detail`. Repair
invalid content, a missing decoder, source publication or native capability at
that boundary, then retry. Budget failures and write conflicts preserve the
previous content. Runtime edits, source publication, renderer adoption and GPU
completion are distinct facts.

The focused contracts are exercised by
[owned asset content](src/__tests__/asset-records.unit.test.ts),
[Catalog wire loading](src/__tests__/catalog-wire.integration.test.ts),
[source reload](src/__tests__/asset-registry-recook.integration.test.ts), and
[render publication](../render/src/publication/__tests__/publication.integration.test.ts).
Performance evidence and remaining acceptance belong to the
[managed asset measurements](../render/bench/managed-assets/README.md).

## Runtime content

`update` merges owned fields, `replace` validates complete content, and `writeRange`
updates mesh attribute or texture pixel ranges. A successful operation commits
content and automatic change evidence together; a rejected operation changes
neither. No caller-managed version or `markChanged` is required.

Public reads copy their arrays and backing buffers. Mutating an input after a
write, or mutating a returned read, cannot change current content. `snapshot`
retains fixed content and its dependency closure until disposed; `copy` creates
an independent editable identity. Callers release their references explicitly;
ECS bindings retain and release their own grants at the ordinary write barrier.
A disposed Renderer does not dispose the gameplay owner.

Repeated `load(guid, kind)` calls retain the same live identity and preserve game
edits without consulting the source. `reload(handle, { conflict: 'reject' })`
asks the configured producer for that GUID and its eager dependencies, then
prepares and adopts the complete closure under existing identities. This works
without a hot subscription and never enumerates the full Catalog. A static or
push-only source without a producer lookup uses its accepted Catalog rows. It rejects gameplay edits in
that closure. `conflict: 'overwrite'` permits replacing edits that predate the
request; neither policy overwrites changes made while I/O is pending. Unchanged
source content reuses its identity and revision when domain preparation can retain
the current content. Terrain still validates its selected candidate dependencies
when its root is unchanged. Cancellation, invalid content,
dependency conflicts, source replacement and owner disposal leave the previous
committed closure intact. New dependencies and replacement content share the
owner's asset and byte budgets; failed preparation releases all candidate holds.

`sourceOf(handle)` returns the adopted publication and whether the runtime
content has since been edited. It never labels old runtime data with the latest
Catalog publication. Source removal makes explicit reload fail; current gameplay
assets and fixed snapshots retain their content and ordinary ownership. Reload
does not grant an additional reference or save runtime edits to source files.
Source preparation walks only its requested dependency closure, never asset
consumers or World entities.

Custom kinds use `create(kind, data)` and the same `update`, `replace`, `copy`,
`read` and `snapshot` methods. Their existing `AssetDecoder` contribution can
provide synchronous `prepare(value, context): Result<P, AssetError>`; no separate
kind registry or version callback is needed. Preparation receives a detached
complete candidate, validates it, and returns the accepted data. Its input and
result are captured so retained callback aliases cannot mutate current content.
`context.reference(guidOrHandle, kind)` validates and holds each reference in the
new content; omitted old references retire automatically. `context.read(handle)`
is an explicit detached dependency read. Custom field updates prepare the complete
candidate and therefore pay for complete validation and capture; domain range
operations remain the path for large binary content. Retiring the decoder lease
prevents new custom writes while accepted content and fixed snapshots stay readable.

Material source inheritance is expanded during preparation. Runtime consumers
read complete material content without revisiting the Catalog parent chain.
A program projection is retained for compatible value/state edits and withdrawn
when its compilation contract changes. Static choices must match a prepared
program; runtime does not invoke Cook. A shared material resource is adopted by
each Renderer independently, including skin, vertex-color and sprite-instance
program contexts.

Mesh writes derive conservative bounds and invalidate source-cooked collision,
distance-field and Card products when their geometry no longer matches. Range
writes carry explicit byte evidence so upload owners can prepare the changed
region. Structural validation and resource preparation remain separate from
ordinary numeric updates.

Asset changes are retained in a bounded journal with independent consumer
cursors. Repeated writes coalesce by identity; writing does not visit entity or
consumer lists. Empty reads reuse an empty batch. Default limits are 65,536
identities, 1 GiB of owned content, 128 snapshots, 64 ranges, 32 observer
channels and 1,024 dependencies per asset. Exceeding a limit returns a structured
failure before adoption.

### Internal readers across realms

Domain owners that already reserve bytes for an exclusive content copy can
capture a revision guard through the internal records owner. The guard retains
only the exact dependency revisions and their change cursor; it cannot read
historical content and consumes no fixed-content snapshot slot. Changes to a
dependency invalidate it even when the root revision is unchanged. Dispose the
guard with the domain transaction. Public `snapshot(handle)` keeps its existing
copy ownership, capacity limit and historical read contract.

The package's `internal` entry supplies borrowed reads for engine consumers.
Their content is valid only until the next adoption boundary. This is separate
from the public copying `read` contract. A render publication owns the receiver's
accepted asset namespace without constructing a World or another writable
AssetRegistry.

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
When the Registry owns the exact selected Catalog source, capture reuses that
source's Pack reader and stored artifact cache, including zstd bodies. It verifies
the frozen descriptor's decoded length and digest again without repeating I/O.
The stored-byte cache is bounded to 64 MiB / 1024 entries, retires least recently
read bytes directly, and gives concurrent readers independent arrays. Cancellation
of one reader does not cancel another reader's source transfer. Source disposal
aborts transfers and prevents late refill. A different source uses its own bound
transport; capture does not create another persistent cache or load domain assets.
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

## Optional Mesh distance-field admission

An ordinary Mesh publication may pair a `distanceField.sectionSidedness`
descriptor with asset-local `distance-field.bin`. The existing artifact reader
checks its full digest, then the Mesh loader verifies the supported codec/profile,
current geometry digest, static triangle coverage and source sidedness digest
before exposing `MeshAsset.distanceField`. Both mesh-bin and JSON geometry use
this same admission path; JSON restores canonical typed attribute arrays first.
The loaded field retains copied `artifact.integrity` and `artifact.assetCodec`
facts, including the generation profile, through ordinary `assets.read`,
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

## Native package transport

`AssetRegistry.inspectSource()` includes `scopeId`, `generation`, the current
realm tag, and `bundleTransfers`. Take two snapshots and subtract their monotonic
counters to select one loading window in that source/realm. This is a low-frequency
inspection surface; no per-frame export or logging is installed.

| Counter | Meaning |
|:--|:--|
| `fullReads`, `rangeReads` | Completed Bundle response bodies for full or range requests |
| `requestedRangeBytes` | Sum of requested entry lengths for those range reads |
| `wholeBundleFallbacks` | A range request received HTTP 200 with more bytes than its entry |
| `responseEntityBytes` | Bytes exposed by `arrayBuffer()`, after HTTP content decoding |
| `decodedEntryBytes` | Verified entry bytes after outer artifact decoding |
| `declaredContentLengthBytes`, `declaredLengthResponses` | Sum and count of valid response `Content-Length` values |
| `verifiedReuse`, `coalescedReads`, `residentHits` | Verified extracted reuse, joined entry/Bundle reads and resident entry reads |
| `evictions`, `rereads` | Resident Bundle release by trim/budget and a released entry read after an earlier full fetch |

The snapshot keeps at most 128 per-Bundle URL/digest rows; aggregate totals
remain exact and `omittedDetailUpdates` reports missing detail. The snapshot
copies counters and never retains response bodies or decoded assets. Its
`httpCache: 'not-observable'` is deliberate: native/fetch response contracts do
not prove browser cache hits, wire transfer sizes or HTTP header overhead. Use
browser Resource Timing/HAR alongside these counters for those questions.
Range-ignoring hosts keep their existing verified full-Bundle fallback;
diagnostics do not change cache budgets, cancellation, isolation or integrity.

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

All mipmap entrypoints consume `RhiDevice` and opaque RHI resource handles. The
injected shader factory accepts that same device and returns `ShaderModule`, so
backend factories pass directly through initialization and recovery. Async
generation prewarms the pipeline and uses the synchronous submission path; errors
remain `RhiError` throughout.

The internal `encodeMipmaps` helper records into a caller encoder and returns
scratch cleanup without finishing or submitting. `prepareMipmaps` delegates to
it and retains its finish/discard transaction. Dynamic Canvas updates share the
Renderer's submission rather than opening a separate queue path.

`prepareMipmaps` and `blitMipmapsSync` accept `arrayLayerCount` for 2D array and
cube textures; omission retains the single-layer 2D path. Every layer samples
only its preceding mip and copies the result back into the same layer. All
layers share one transient 2D scratch chain, preserving sRGB conversion and the
WebGL2 feedback-loop workaround. Renderer residency supplies the layer count
from the existing texture layout. Recovery preparation still records without
submitting, and its owner finishes or discards the same transaction.

Catalog revision windows use Types’ `checkCatalogRevisionContinuity` for the same
root membership, monotonicity and single-step rules in Pack production and Runtime
replica admission. Shape validation and replica row/scope checks remain separate.
