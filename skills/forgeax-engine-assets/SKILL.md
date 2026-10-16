---
name: forgeax-engine-assets
description: >-
  ForgeaX authoring-to-runtime asset route with GUID identity and producer-owned recovery.
  Use when authoring, importing, cooking, loading, validating, or repairing any game asset.
---

# forgeax-engine-assets

## Lighting asset route

Use these entry points:

1. Author `RectAreaLight` and `LightProbe` through the existing render ECS schemas.
2. Bind `SpotLight.iesProfile` to a build-time cooked `IesProfileAsset` and `SpotLight.cookie` / `RectAreaLight.sourceTexture` to a regular `TextureAsset` (one shared light-texture slice per handle; uncompressed sources are projected on the CPU, BC/ETC2/ASTC KTX2 sources are resampled on the GPU from level 0 when the device enables the matching compression feature); `rollDeg` expresses orientation only.
3. Use `inspect` to read `subject`, `execution`, `lifecycle`, `lastKnownGood`, and `sourceKey`, then invoke the owner's `rebuild`/`cold-cook`.

IES has no runtime source parser; cookies use the existing texture registry. Catalog is a projection, DDC is cache evidence, and Pack/Meta retain authored authority. Do not claim readiness without `accepted` or `verified` evidence.

> [!IMPORTANT]
> Material assets follow one route inside the catalog: authored `MaterialAsset` with `passes` and `values` -> cook record and artifact -> `loadByGuid` -> World handle. Keep `parent` references, texture references, module identifiers, and per-slot `coordinates` transforms in the same package graph. The recovery route repairs the producer or cook output and retries the same GUID.

## M5 asset authority index

Start with [`schemas/asset-authority.schema.json`](../../schemas/asset-authority.schema.json) and its gate [`check-asset-authority-audit.mjs`](../../scripts/forgeax/check-asset-authority-audit.mjs). Pack or external source plus Meta is author authority. Import and native cook produce validated outputs. DDC is disposable cache evidence, Catalog is a projection, and runtime only reads the validated projection. Editor writes go through the asset-authoring gateway.

For any category, inspect the `subject`, `execution`, `lifecycle`, `lastKnownGood`, and `sourceKey` fields before choosing recovery. The AI path is `inspect` -> `rebuild` or `cold-cook`; `preview-LKG` is read-only, while `override`, `promote`, and `stop-publish` are explicit gateway or publication operations. Do not infer identity from a suffix, path, cache hit, or message text.

### Transmission/refraction

For transmission/refraction, preserve the same Standard values through GLTF parse, Pack cook, GUID
catalogue, and runtime inspection. Keep `sourceKey` as producer identity (not a file path), and repair
stale or invalid material output by rebuilding the producer or cold-cooking the same GUID.

### Mental model

The recovery route is producer-owned: validate the `MaterialAsset`, cook the
specialization, publish the record and artifact, then load by GUID. A Catalog
row is evidence and DDC is cache evidence; neither replaces author authority.

### Display-name projection

`deriveAssetName` is the single display-name projection used by Catalog build
and runtime `resolveName`. A producer-supplied `storedName` is authoritative for
an authored entry regardless of whether its package currently has one member or
many. When no stored name is available, a packaged asset falls back to the
package path basename; an asset without a package resolves to the empty string.
Keep this projection in the Pack owner and do not reimplement cardinality rules
in Editor or other consumers.

### Catalog source and evidence

`CatalogSource` is the runtime boundary for catalog navigation. The source
emits `CatalogDelta` rows (`added`, `changed`, and `removed`); it does not prove
that a payload is cooked or current. Register the source, call
`subscribeCatalog`, and only then call `enumerateCatalog` so the editor pinned consumer
cannot miss an update between its initial snapshot and its live subscription.
Merge both snapshots and deltas by GUID, and dispose the
subscription with the host.

```ts
const stop = assets.subscribeCatalog((delta) => mergeRowsByGuid(delta));
const snapshot = await assets.enumerateCatalog();
mergeRowsByGuid(snapshot);
```

Vite's dev transport uses `reloadAssetHost()` to refresh the source after an
import or HMR change; a static build still navigates the same Pack v2 rows.
When the source is not configured, keep the structured failure instead of
inventing a fallback row.

The Vite boundary has one producer and one Catalog projection. `pluginPack`
publishes the scoped dev/build result; `createCatalogClient` subscribes to the
dev delta stream and enumerates the initial snapshot without moving Vite into the
runtime. `runtimeBinding` carries the active scope and `generation`, so a late
publication from an old host is rejected. Preserve `sourceKey` as the semantic
source identity in Catalog facts; it is not a URL, filename, or GUID fallback.

`AssetEvidence` is the read-only join of source declaration, the catalog's
`packageUrl`/`cookReceiptUrl`, producer receipt freshness, and Pack artifact
verification. Use `lookup/verify --guid --project --catalog --json` (or the
injected runtime inspection surface) to distinguish `notCooked`, `ready/current`,
`ready/stale`, and `unknown`; `unknown` is not a pass. Repair the producer or
recook for `notCooked`/`stale`, then rerun the probe. A catalog locator alone
cannot upgrade missing or failed evidence to ready.

## Indexed producer recovery playbook

Use the same five-step loop for images, cubemaps, glTF, fonts, materials, and
native cooked assets:

1. **Inspect** source plus Meta, Catalog, DDC lifecycle, receipt, and artifact
   verification. Read `.code`, `.detail`, `.expected`, and `.hint` as data.
2. **Repair** the named importer, native cooker, source, or Meta declaration.
   The source package plus Meta is author authority; the producer owns output.
3. **Rebuild or cold-cook** through the producer. Remove invalid DDC evidence
   only as part of that producer-owned recovery, never by editing a generated
   Pack product into a substitute.
4. **Verify** GUID closure, receipt freshness, DDC integrity, Pack artifacts,
   and the Catalog lifecycle.
5. **Retry** the same GUID after verification. `lastKnownGood` is a read-only
   preview, and `unknown` is not a pass.

Producer readiness is a host concern. `before-consume` needs all required
importers/cookers registered before the consumer load; `on-demand` needs both
the producer route and the explicit dev transport. Runtime does not import
source files, write DDC, parse log strings, or replace a missing engine asset
with a custom mesh/material workaround.

## ScriptablePack authoring route

For delivery acceptance, use [forgeax-scriptable-pack-review](../forgeax-scriptable-pack-review/SKILL.md): classify fixed assets versus public generators and check provenance, dependency closure, formal consumption, parameters, and runtime recovery.

Keep the two authoring entities distinct. `ScriptablePack` is executable
`*.pack.ts` source: import `definePack` from `@forgeax/engine/pack/source`, keep
one stable `packageId`, optionally declare a non-empty `parameters` capability,
and return a complete `sourceKey -> Asset` map from `build(context)`. `Pack` is
editable `*.pack.json` source: a direct document stores `assets[sourceKey]`,
while an instance stores its own `packageId`, `parent`, and sparse `values`.
Neither source declares per-output GUIDs or `externalAssets`; the build boundary
derives GUIDs from `(packageId, sourceKey)`. Build-time instances resolve their
parent chain through the source producer. Runtime readers consume validated Pack
v2 through `loadByGuid`; opt-in runtime generation belongs to the existing Import
producer, outside asset loading and the ECS frame.

| Action | Command or owner |
|:--|:--|
| Inspect identity and topology | `forgeax asset inspect <source.pack.ts> --json` |
| Read external content | `context.readByGuid(guid)` inside `build` |
| Serialize or cook an output kind | Registered `AssetOutputProducerRegistry` producer |
| Rebuild | Vite or CLI producer lifecycle |
| Load at runtime | Existing Catalog plus `loadByGuid<T>(guid)` |
| Admit data or generate after launch | App `runtimePacks` and Import `RuntimePackProducer`; [runtime production contract](../../packages/import/README.md#runtime-pack-production-and-durable-content) |
| Prepare JS / TS programs | `preparePackProgram` parses and seals JS without evaluation or conversion; `prepareRuntimePackProgram` from `@forgeax/engine/devkit/plugin-build` converts TS and preserves its source |
| Preserve resolved inheritance | `resolvePackParameterInheritance` then `prepareRuntimePackAnchor`; effective values become defaults, instances keep one anchor and sparse values |
| Save and recover runtime content | Host stores `snapshot()` or versioned `exportSource()` results; `restore()` re-admits fixed content into the new scope |

> [!IMPORTANT]
> `build` must not create GUIDs, write source, publish packages, or mutate a live World. A missing or extra output key, undeclared read/ref GUID, unused external declaration, or kind mismatch is a structured failure; repair the source contract and rebuild the same identity.

> [!NOTE]
> The filesystem Pack gateway's `asset.inspect` with a source path returns
> identity and revision. Add `sourceKey` to inspect one direct `.pack.json`
> output's authored `payload`; verify its returned GUID against the Catalog
> GUID before presenting the fields. A Pack instance returns inherited
> `effectiveValues` for that output. ScriptablePack source inspection never
> executes `build` to derive a payload.

Runtime-capable generators declare their complete `runtime.dependencies`, including
non-default parameter branches. Admission preserves verified JS artifacts and
fixed asset dependencies without evaluating the generator. Persist the original
Pack/program/instance closure before clearing derived caches; DDC is not a save
store. Recovery may replay generators and does not install plugin Fibers. View
uses the same Engine operations; writing project source still requires the
authoring gateway. Browser static program archive delivery remains a separate
qualification from runtime-authored program recovery.

Material producer caching also requires the Naga/WASM owner's verified executing
compiler fingerprint; JavaScript or WGSL bytes alone do not establish that identity.
Missing or invalid Native provenance must not reuse a previously compiled product.

For generated `material` and `mesh` outputs, register
`materialAssetOutputProducer` and `meshAssetOutputProducer` from
`@forgeax/engine/import` at the Vite host. Omit `assetSource` when the build is
self-contained; provide the host snapshot source before using
`reader.loadByGuid`.

For ordinary prebuilt `.pack.json` dependencies, create the source in the
build-time owner with `createScriptablePackFileAssetSnapshotSource({
assetRoots })` from `@forgeax/engine-import`. It validates and indexes GUIDs
once, returns private Asset snapshots with deterministic generation/digest
evidence, and keeps missing, malformed, unreadable, and colliding files as
structured `Result` errors.

## MaterialAsset catalog recovery

Use `configurePackIndex('/pack-index.json')` and `loadByGuid<MaterialAsset>` for
both root and derived materials. A ready result must have an effective pass,
resolved `passes`, `values`, `parent`, and `coordinates`, complete references, a cooked artifact, and a receipt. On a
failure, switch on `.code`, read `.detail` and `.hint`, repair the producer or
cook output, and retry. Do not substitute a custom mesh or app-local shader
artifact when an engine resource is missing.

## Contract routing

| Task | Load |
|:--|:--|
| Catalog subscription, refs, package identity, compression | [`catalog-and-import.md`](references/catalog-and-import.md#catalogsource-subscribe-before-enumerating) |
| Custom importers, sidecars, source resolution, byte decode | [`catalog-and-import.md`](references/catalog-and-import.md#register-a-custom-host-importer) |
| Mesh UV contracts and structured recovery | [`runtime-and-mesh.md`](references/runtime-and-mesh.md#multi-uv-import-gltf-and-fbx-texcoord_0-through-7) |
| Lightmap UV validation across LODs, baked-data identity and staleness | [import lightmap UVs](../../packages/import/README.md#lightmap-uv-validation) and [render bake data](../../packages/render/README.md#baked-lighting-identity-and-staleness) |
| Runtime load, VFX, handles, video, nested scenes | [`runtime-and-mesh.md`](references/runtime-and-mesh.md#runtime-api-quick-reference) |
| Scene writeback, new kinds, custom loaders, evidence | [`scene-and-custom-kinds.md`](references/scene-and-custom-kinds.md#scene-save-and-writeback) |

## Plugin assets

Start with the feature Pack. Use named Plugin exports in `.pack.ts` for small behaviors and
ordinary TypeScript modules for larger implementations. Read the [plugin contract](../../packages/plugin/README.md),
then discover `asset plugin create`, `asset plugin inspect`, and `project root set` through CLI help.
Pack owns configuration; project roots select execution. Reading a definition does not activate it.
New runtime plugins use the same module/config lowering and `startPluginAsset`
native Fiber lifecycle. Inline `toolContract` uses the existing declaration format;
its executor closure must be supplied. Complete fixed publications preserve all
siblings with program/tool attachments per existing build target. Each Context
only installs its target's qualified definitions; an empty tool contract still
records installation eligibility. Every plugin sibling needs at least one
prepared target for complete capture. Restore may expose a foreign definition
as metadata; mounting it without membership in the current target's tools map fails.

### Runtime Pack validation route

Run `pnpm --filter @forgeax/engine-devkit test:runtime-browser` under an owned
Xvfb display for the real Worker JS/TS x dev/build paths. The same gate belongs
to `pnpm test:browser` and Actions browser shard 1. Keep the full hello/learn
300-frame smoke and Dawn rosters; Node producer tests alone do not prove browser
module delivery or native plugin execution.
