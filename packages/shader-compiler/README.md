# @forgeax/engine-shader-compiler

Custom raster programs author `program.bindings` and, for a depth interface,
`program.sceneDepth` using the [shared material contract](../types/README.md).
Cook validates these declarations against compiler reflection and publishes
them in the immutable ABI receipt. Runtime consumes that receipt without
inspecting WGSL names or declarations to infer intent. Specialization identity
includes both the binding interface and depth version, so identical shader
bytes with different declared resource semantics cannot alias one selection.
Unused reflected resources may disappear; declarations remain authoritative.

Build-time consumers use `getShaderCompilerFingerprint()` for the public compiler,
native adapter code and verified native payload identity. It returns a structured
failure when identity cannot be verified. Consumers do not need a direct Naga
production dependency to version their derived products.

## Engine material shorthand publication

`createMaterialPackCooker` completes an Engine-owned Standard root that omits
`parameters` and has no parent or project Surface. Its authored value names select
the existing Standard schema; a selected physical scalar layer adds its complete
parameter group, including schema defaults. The cooker publishes these same
parameters in the material payload and cooked record before composing raster,
ray-hit and Card programs. Explicit parameter declarations remain authoritative:
an incomplete declared layer is rejected rather than repaired implicitly.

An Engine-owned Unlit root with the same omitted-schema contract uses
`unlitMaterialParameters`, including its color-space policy. Custom schemas are
preserved. Every compiled direct pass publishes reflected vertex and skin palette
facts, including custom programs beside the Engine shadow wrapper. An empty
parameter region is recorded as zero bytes rather than a fabricated uniform row.
Only a separately compiled scene-index entry declares that address; direct-only
and uniform-fallback programs retain complete direct ABI facts.
Generic direct streams retain their reflected names whether or not they declare
optional particle lanes. Core color/center inputs never become mesh joints merely
by occupying location 4. Standard/scene-index specializations keep their
geometry-owned canonical mapping and real palette requirements.

Cooked Standard receipts also use the selected schema and reflected entry inputs;
the fixed-layout Engine Standard factory is not their ABI. An explicit
`alphaClipping: false`, `alphaHash: false`, `displacement: false` combination on
the known default Standard shadow Surface selects the existing opaque Surface.
Its position-only shadow entry retains LOD and view/local clipping, while color
retains its authored maps. Custom Surface and shadow overrides are preserved.
The selected schema derives alpha-clipping availability for Standard and temporal
programs; absent cutoffs become zero without a runtime early-return branch.

## Sampled-texture capability publications

The cooker publishes storage-backed minimum, projector, extended-lighting and atmosphere
View programs alongside uniform fallback, preserving each authored Surface and parameter schema.
The receiver selects the immutable program against its actual texture limit; a minimum WebGPU
device can support storage buffers while lacking the extended View bindings. Producer input
identity changes with this publication roster, invalidating older incomplete DDC records.

## MaterialAsset 唯一成功路径

编译器位于 `paramSchema -> derive -> compile/reflect -> cook/load -> extract/record`
主线的 compile/reflect 阶段：它校验 WGSL producer 与派生 schema，产出可供
cook 使用的 reflection 与 artifact 输入。`coordinateSet`、transform 和
`physicalUvScale` 是 schema/data contract 的字段，不是 app 侧补写的偏移。

> [!CAUTION]
> 失败时按结构化 error `code`、`detail`、`hint` 修复 WGSL 或 schema 输入，
> 然后 recook；不要复制 source-owned error union。

> **build-time WGSL compilation core with naga_oil 0.23 composition + 7-member error taxonomy + cross-file HMR propagation support.** AI users call a single pure-function entry; errors are machine-readable `Result.err(ShaderError)` with typed `.detail` discriminated union; no `err.message.match()` anywhere downstream (charter proposition 3 + AC-15).

---

## Layer 1 — API surface (what you call)

Build-time Surface source-closure and helper-name digests use Node's native
SHA-256 on Node and the existing portable SHA-256 in browser source utilities.
The native module is loaded only on Node. Canonical
module ordering, UTF-8 replacement bytes, digest prefixes and published helper
names remain identical; source changes still invalidate derived receipts.

**Single entry.** `compileShader(source, options)` — pure function, `Promise<Result<CompileResult, ShaderError>>`. Same input produces same output; no mutable global state.

For graphics consumers, `renderEntries: { vertex, fragment? }` checks the
selected stages against the validated Naga IR, including fragment input
locations, types, and interpolation. Material cooking supplies its selected
entries; an absent or wrong-stage entry fails before publication. Pack cooking
propagates the structured compiler error without serializing it into a string.

The closed material context retains local-light membership for both Forward and
Deferred: storage-buffer contexts use buffers and uniform fallback uses the
same records through an integer texture. ProbeBlend requires storage. Custom Standard
Surface programs retain the same lighting modules as built-in Standard before
WGSL publication; runtime binding layouts follow the published program, without
reconstructing a missing lazy variant key. Standard Surface scene-index programs and their GPU Scene
receipts are also emitted only for storage-buffer contexts; uniform fallback
publishes its direct program without requesting storage-only Mesh metadata.

Custom Surface texture and sampler declarations derive from the root parameter
schema, including array textures and resources imported by Surface helpers.
Generation omits only resource names already declared by the selected template;
its built-in bindings and custom resources retain one declaration per binding in
both direct and scene-index programs.

Full-custom raster programs may conditionally declare `vs_scene_index` under
`GPU_DRIVEN_SCENE_INDEX_AVAILABLE` and keep their direct entry in the opposite
branch. Cook compiles each address independently with the native selector,
validates both selected entries, and publishes both artifacts. Scene entries
import `sceneIndexDraw` from `forgeax_view::common`; direct entries import
`meshes` and `instances`. The native families share binding coordinates, so
their imports and uses must follow the same conditional. The generated
`forgeax_material::parameters` module owns `MaterialParameters`, `sceneMaterials`
and `visibleItems`; uniform-fallback contexts publish only the direct program.
A native `forgeax::default-shadow-caster` Pass paired with a custom scene
program publishes the same address pair from the root parameter schema. Its
default opaque coverage requires only position (plus skin attributes when
selected), while retaining native transforms, clipping and LOD coverage.

Material publications use `material-cook/4`: one validated root contract and a
complete program set selected by Pass and compiler context. Pack and Native
cookers share the publication builder. Independent modules retain independent
WGSL; shared modules reuse code while entry choices remain pipeline facts.

Standard Pack materials publish both plain and vertex-color programs, including
matching direct and scene-index address pairs. The ABI receipt's vertex inputs
own this distinction; no second color flag is persisted in the cook context.
Runtime selection uses the mesh's color attribute, and extraction caches separate
the resulting material programs even when two meshes share one material handle.

The Native Pack cooker derives `skinned` geometry from a resolved Standard skin
root, including inherited roots. Its color, visible-surface and shadow programs
share that context and palette ABI. Readiness alone does not prove selection:
the consumer must find one program for its exact pass, geometry and address.

Ordinary non-Sprite raster Pack publications, including custom Forward WGSL, include
direct uniform programs for WebGPU and WebGL2 for every primary geometry they
publish. The composed View ABI switches `meshes` and `instances` from storage
to uniform bindings. A device or backend recovery selects these published
artifacts without runtime compilation; the two backends retain distinct
context and vertex-color selections. Uniform contexts have no scene-index
program or storage-only View extension.
Single-layer medium publications retain their storage-backed dynamic-input
contract and do not publish a WebGL2 uniform program through this route. GPU
particle mesh roots also retain their compute/indirect path instead of adding
an unusable raster fallback artifact.

> [!IMPORTANT]
> The material producer fingerprint changes when the required backend program
> set changes. Re-cook an older publication before expecting the WebGL2
> specialization; runtime cannot construct it from storage-backed WGSL.

Sprite materials publish both ordinary mesh and `sprite-instances` geometry
programs. The latter derives `PER_INSTANCE_REGION` from the component-owned
context: storage instances have current/previous matrices plus a UV region
(144 bytes); uniform instances have one matrix plus a region (80 bytes).
The Native Pack cooker publishes the default WebGPU/storage pair for built-in
sprite and sprite-lit roots, including source aliases and inherited passes.
Other backend/capability contexts remain explicit cooker inputs. Re-cook old
material publications to obtain the missing program; runtime never replaces a
published artifact with a legacy shader variant.

| Contract | Compile-time rule |
|:--|:--|
| Root parameter storage | Used UBO members retain declaration order, types, offsets, sizes and alignment. Compiler-renamed member spellings (including numeric suffixes) are diagnostic names, not buffer ABI. |
| Per-Pass resources | Unused bindings may be absent; used resources keep root binding numbers and types. |
| Custom resource names | Names such as `clearcoatTexture` do not enable Standard semantics or relocation. |
| Default shadow coverage | `forgeax::default-shadow-caster` without an explicit Surface slot uses opaque coverage and adds no PBR parameters. Standard helpers explicitly select their shared Surface. |
| Layout failure | The error carries the material, Pass, module, source, context, and actual/expected layout facts where available. |

```ts
import { compileShader } from '@forgeax/engine-shader-compiler';

const result = await compileShader(source, {
  id: 'forgeax_pbr::main',
  imports: { 'forgeax_view::common': viewSrc, 'forgeax_pbr::brdf': brdfSrc },
  defines: { LIGHTING_MODEL_PBR: true },
});
if (result.ok) {
  const { wgsl, glsl, bindings, manifestEntry } = result.value;
} else {
  switch (result.error.code) { /* exhaustive 7 */ }
}
```

### 7-member `ShaderErrorCode`

| Code | When raised | `.detail` shape |
|:--|:--|:--|
| `shader-compile-failed` | naga parse/validate/emit rejects WGSL | legacy `{ compilerMessages? }` |
| `compiler-init-failed` | wasm `ensureReady()` throws | legacy `{ reason? }` |
| `manifest-malformed` | `manifestEntry` emit detects shape drift | legacy `{ reason? }` |
| `shader-not-found` | runtime registry miss (consumer side) | legacy `{ reason? }` |
| `shader-import-not-found` | `#import x::y` targets an absent module | `{ code, importPath, fromModuleId, offset? }` |
| `shader-circular-import` | DFS tri-colour cycle detected before naga_oil emit | `{ code, cycle: readonly string[] }` first+last repeated |
| `shader-define-conflict` | same `#define NAME` declared in ≥ 2 modules | `{ code, defineName, sites: { moduleId }[] }` |

### 3 new `.detail` variants — JSON sample

```json
// shader-import-not-found
{ "code": "shader-import-not-found", "importPath": "forgeax_view::common",
  "fromModuleId": "forgeax_pbr::main", "offset": 42 }

// shader-circular-import (cycle visualised first+last repeated)
{ "code": "shader-circular-import", "cycle": ["a", "b", "c", "a"] }

// shader-define-conflict
{ "code": "shader-define-conflict", "defineName": "LIGHTING_MODEL",
  "sites": [{ "moduleId": "forgeax_pbr::main" }, { "moduleId": "forgeax_view::common" }] }
```

`result.error.detail.<field>` narrows under `switch (result.error.code)` with full IDE autocomplete (AI-user review affordance; AC-15).

---

## Layer 2 — Composition + HMR mechanics (how it works)

### naga_oil integration path

`compileShader` runs a deterministic 5-stage pipeline:

1. **`#define` pre-scan** (`define-scan.ts`) — parse `#define NAME` lines in all `imports` + the root source; reject duplicate `NAME` across modules with `shader-define-conflict`. `#define NAME value` (value form) rejected per D-05 OOS-1.
2. **Cycle pre-detection** (`cycle-detect.ts`) — DFS tri-colour over `#import x::y` edges; raise `shader-circular-import` with first+last repeated chain before invoking naga_oil. Catches cycles the naga_oil Composer would otherwise surface as prose-only error text.
3. **naga_oil compose** (wasm `compose_shader`) — `@forgeax/engine-wgpu-wasm` hosts a `naga_oil::compose::Composer`. Each module registered via `add_composable_module` with `as_name = moduleId`; root compiled with `make_naga_module`. Composer flattens `#import` graph, expands `#ifdef` conditionals against the `defines` set, produces a single naga `Module`.
4. **Portable WGSL canonicalization** (`wgsl-compat.ts`) — one internal `canonicalizePortableWgsl` façade owns post-Naga portability rewrites. The current rule uses a small lexical scan so only the affected numeric token changes; the canonical source then feeds parse, validate, reflection, hashing, and the manifest. Future rules extend this owner rather than adding a nested `normalizeX(normalizeY(...))` call chain in `compileShader`.
5. **Error mapper** (`error-mapper.ts`) — wasm `JsError` prefixes map to closed-set codes: `IMPORT_NOT_FOUND:` → `shader-import-not-found`; `CIRCULAR:` → `shader-circular-import` (fallback if step 2 missed); anything else → `shader-compile-failed` with raw `compilerMessages`.

The compiler owns all transient Naga handles. Validation consumes the parsed
handle; successful syntax-only diagnostic probes release theirs immediately.
A validated program is released in `finally` after reflection or selected-entry
validation, including failure returns. Compiler results retain ordinary source
and reflection data; native IR does not escape or wait for JavaScript finalizers.

### Bevy-style `moduleId` naming

`moduleId` follows Bevy's `namespace::path` convention — `forgeax_view::common`, `forgeax_pbr::brdf`, `forgeax_pbr::main`. The `#define_import_path` directive at each module's head declares its id; consumers `#import moduleId::{Symbol1, Symbol2}` to pull named items. This aligns with naga_oil's upstream convention and lets AI users copy Bevy shader examples unmodified.

### Cross-file HMR propagation (`@forgeax/engine-vite-plugin-shader` T-16)

The plugin builds a `reverseDeps: Map<moduleId, Set<rootEntryId>>` during `transform`. On Vite `handleHotUpdate(ctx)`, the plugin calls `getModulesByFile(ctx.file)` → resolves affected `moduleId`s → reverse-looks up every root that imported them → returns those root modules for HMR. Edit `common.wgsl` and every `pbr.wgsl` / `unlit.wgsl` depending on it reloads.

---

## Layer 3 — Deeper references (when you need internals)

**Sibling packages:**

- [`@forgeax/engine-naga`](../naga/README.md) — TS-only shell exposing `parse` / `validate` / `emit_reflection` + `composeShader` from `@forgeax/engine-wgpu-wasm`. Forbidden in runtime `@forgeax/engine-shader` (three grep gates).
- [`@forgeax/engine-wgpu-wasm`](../wgpu-wasm/README.md) — Rust crate merging wgpu 30 RHI + naga 30 three-stage bindings + naga_oil 0.23 Composer; single source-bound WASM artifact.
- [`@forgeax/engine-vite-plugin-shader`](../vite-plugin-shader/README.md) — thin shell forwarding `compileShader` + HMR.

**Upstream references:**

- naga_oil 0.23 — <https://github.com/bevyengine/naga_oil> / <https://docs.rs/naga_oil/0.22.0>
- Bevy `pbr.wgsl` exemplar — <https://github.com/bevyengine/bevy/blob/main/crates/bevy_pbr/src/render/pbr.wgsl>
- naga upstream (v29) — <https://github.com/gfx-rs/wgpu/tree/trunk/naga>

**Closed-loop decisions:**

- plan-strategy §S-5 / §S-7 / §S-9 — `feat-20260508-shader-pipeline-mvp/plan-strategy.md`
- M2/M3/M4 decisions — `feat-20260512-naga-oil-composition-hmr/plan-decisions.md` — D-04 / D-05 / D-07 / D-08 / D-11 / D-12 (moduleId convention + error taxonomy + anonymous-entry placeholder + offset passthrough)
- charter proposition 3 (machine-readable > prose) + AC-15 (no `err.message.match()`) — [AI-first contract](../../AGENTS.md#design-axiom--compression--intelligence)
- AGENTS.md §Error model — family-level `ShaderErrorCode` + `ShaderErrorDetail` row (T-22 anchored).

## Program compilation lifetime

The build-only `createShaderProgramCompiler()` serves material and VFX cooking.
Explicit compiler instances retain their caller-owned lifetime. Node Material Pack
cookers share one lazy pool per loaded compiler module. A complete material is
the parallel unit: source collection, Surface lowering, hashing, variant compilation
and ray cooking run together off the host thread. Each material Worker uses the
serial program compiler; Pack concurrency does not create nested shader pools.

| `FORGEAX_SHADER_COMPILE_WORKERS` | Material execution |
| --- | --- |
| Unset | Up to four workers, bounded by available CPU and memory |
| `1` | Original serial material cooker |
| `2` through `4` | Requested pool, clamped to CPU and memory admission |

Admission keeps 2 GiB of host headroom and budgets 2 GiB per material lane.
Each Worker has a 1 GiB old-generation heap limit; native/WASM memory is separate.
Idle workers are unreferenced and do not hold Node open. A failed job rejects its
caller; a failed Worker is replaced for later jobs without retrying failed work.
Caller inputs and returned artifacts remain independently owned.

Exact source and selected ABI facts validate on every cook. A bounded Surface
lowering cache reuses only the pure string rewrite after validation: 128 entries,
16 MiB retained UTF-16 payload, and at most 1 MiB per entry. Its key includes every
lowering input, including generated parameters, ABI and inlined helpers. Source
collection and diagnostic ownership are not cached. No World, material values or
project source snapshot is retained between jobs. Shader plugins and VFX keep
their existing lifecycle-owned compiler instances.

`createShaderProgramCompiler()` shares pending composition and validation and retains successful
compilation stages with independent retained-payload budgets: 16 MiB for composition
and 32 MiB for validation. A single input/result larger than 16 MiB is not retained.
Selections of the same WGSL count the source body once per stage,
regardless of how many materials or entry selections reuse it. The two public
WGSL fields share one immutable string;
caller copies retain independent mutable metadata without copying that source
twice. New source-and-options identities run source admission before reuse. An
exact successful invocation can reuse its admission facts within the same 32 MiB
result budget. Keys include raw source, imported bytes and all options, preserving
explicit undefined/scalar values. Selector containers are captured per invocation;
immutable WGSL strings are shared. Accessor-backed/non-data inputs and failures
stay on the ordinary admission path. Validation
reuse requires identical actual WGSL, selected vertex/fragment entries, ordered
attachment formats and dynamic-offset annotations. Distinct source contexts
that compose to those same facts reuse one validated result; changed programs
or selections run the real Naga path. Each invocation projects its own declared
import dependencies for HMR, even when its program bytes agree.
Hits refresh recency within their stage. Each stage retires its oldest retained
entry when its budget fills, so cold module expansion cannot evict every current
validation result. Shared WGSL bodies remain retained until their final entry
retires. These payload budgets exclude transient native compiler allocations and
JavaScript object overhead; they are not a process RSS limit.

Concurrent identical inputs share composition and selected-program validation
promises. Pending source bytes and selection facts count toward their stage budget;
completed entries account for each distinct WGSL body once. Successful results
are copied for each caller. A failed validation is discarded, and waiting callers
run their own diagnostic path so one source location cannot escape into another
source. Evicted pending validation cannot restore its entry on completion.

| Composition outcome | Retention |
|:--|:--|
| Pending within the byte budget | Shared by callers with the identical source key |
| Successful within the byte budget | Immutable WGSL available for scoped reuse |
| Rejected or oversized | Not retained; the same input may retry |
| Evicted while pending | Its later completion cannot restore the evicted entry |

Keys hash source chunks directly instead of JSON-expanding WGSL. Composition
remains keyed by prepared source, imported bytes and relevant
boolean axes. Malformed selectors still reach native rejection. Conditional
specialization and source diagnostics remain on the ordinary compiler path;
only successful program facts are retained, never native IR handles.

Post-Naga portability normalization is retained with composed WGSL. Its lexical
rewrite runs only when a whole long-decimal f32 token can exist, rather than for
ordinary long fractions or scientific literals. `FORGEAX_SHADER_CACHE_STATS=1`
emits per-instance periodic admission/composition/validation counters and retained
payload bytes for build diagnosis; the counters are not runtime frame metrics.

The real Standard reuse regression retains the complete raster/ray working set
between material publications and checks that neither composition nor validation
repeats. A mixed material authoring set retains composition and validated
selection facts together. Before WGSL-body byte sharing, the 29-material Lab run
with 256 cache entries performed 110 validations, down from 162 with the smaller
entry cap, with identical publication digests. This records validation work; it
does not qualify first-frame speedup. The current cache retains bodies once and
the byte budget evicts larger working sets.

Vite authored-material preparation uses the compiler factory for the complete
material and its variants, so entries sharing source do not repeat composition.
Every preparation still reads current source and admits the selected entry
contract before publication.

> [!IMPORTANT]
> Reusing composition never bypasses source diagnostics, WGSL validation,
> requested render entries/formats, or reflection of changed dynamic offsets.
> Only an exact successful WGSL and selection/reflection contract can reuse validation.

Packaged shader sources come from the package resolved beside the compiler.
The conventional workspace path is used only when that package cannot resolve;
an SDK's expanded source tree and installed package never both enter the catalog.
Explicit project roots still retain strict module-provenance validation.
The Pack cooker DDC identity includes the native/compiler bytes, source contents,
module IDs and source paths relative to distinct package/project root slots.
Relocating an unchanged checkout keeps that identity; changes to source bytes,
imports or relative source mappings invalidate it. Extra root discovery order
does not affect the identity.

Sources are read on every cook; material values, references, generations and
receipts are published anew. Failed compilations are never retained as results;
failed compositions are never retained. Returned results cannot mutate retained
values. Shader bytes stay binary until the Pack transport projection. External
artifact bodies derive from the complete validated record; the compiler cache
and other cook results retain their independent snapshots. Ray
compiler identity names the template and evaluation context; material identity
belongs to the fresh publication. The pure `compileShader()` entry keeps no
global cache.

## Standard Surface composition

Build-time composition resolves `program.moduleSlots.surface`, loads the
transitive `#import` closure, validates the Surface ABI, generates the material
parameter module, and reflects one cooked Standard artifact. The player receives
only the content-addressed artifact; compiler and Naga dependencies do not cross
the runtime boundary.

Surface helper imports are hoisted ahead of template declarations. Active group
imports from the same module are combined after conditional specialization, so
a Surface and its template can share normal helpers without replacing each
other's imported symbols. Disabled imports do not add required symbols.

Standard's optional `directMultiscatteringLut: u32` declaration derives
`DIRECT_DFG_LUT_AVAILABLE` through the same lowering used by raster and ray
Surface producers. Its value selects fit (zero) or LUT (nonzero), so value-only
inheritance preserves source and layout identity. The compiler relocates the
engine-owned `directDfgLut` texture after the complete reserved physical region
using `STANDARD_DIRECT_DFG_LUT_BINDING`; it reuses `irradianceSampler`. Ordinary
reflection publishes the actual resource binding. The default/canonical schema
has neither the field nor the resource, and a declaration with another type
fails before composition.

| Stage | Evidence | Failure owner |
|:--|:--|:--|
| Slot resolution | Standard module plus one Surface module | Material contract |
| Source closure | Ordered module IDs and closure digest | Shader source catalog |
| ABI validation | `evaluate_surface(SurfaceInput) -> SurfaceData` | Surface WGSL |
| Reflection/cook | Layout, program, and cook identities | Shader compiler / cooker |

> [!IMPORTANT]
> A valid Surface cannot repair an invalid root contract. Fix authored source
> or the producer, cold-cook the same GUID, and verify publication before
> retrying runtime load.

## Material MRT admission

The cooker validates `passes[].outputs` before publishing the material. For the
selected fragment entry, Naga checks output count, contiguous location coverage,
and scalar class against each declared attachment format. `uint`/`sint` require
unsigned/signed shader outputs; normalized and float formats require float
outputs. A declaration mismatch fails cooking; the existing Pack publication
retains its last-known-good generation. Device limits and format capabilities
remain runtime admission. See [public MRT](../render/README.md#public-material-mrt).

### Shared ray material cook

`cookRayMaterial({ material, table, sources, context })` resolves the existing
MaterialAsset inheritance, lowers the same Standard schema, composes its Surface
slot and compiles `ray-hit` compute, `card-capture` vertex/fragment, or
`raster-probe` diagnostic fragment WGSL. It returns the resolved asset, source closure and `RaySurfaceProgram`. Value edits retain
program identity; source edits change `sourceClosureDigest`. Contexts own texture
sampling policy, not separate material definitions.

The ordinary Pack cooker publishes each eligible rigid Standard `ray-hit` and
`card-capture` derivative alongside raster programs in the same receipt and
artifact set. Admission is context-specific: Card capture requires the canonical
Standard Surface; a custom Surface can retain its qualified raster/ray programs.
An ineligible context is omitted, while an eligible context's compilation failure
rejects the new publication. A consumer must report its missing context. Card
compilation validates `vs_card`, `fs_card` and four `rgba16float` outputs. Runtime
never imports the compiler. Texture/MASK and normal maps require their qualified UV
and tangent inputs; unsupported coverage, physical layers and resource profiles
fail admission. Custom Surface code must compile for compute and pass the GPU
geometric-normal/finite-output checks. This material delivery path does not schedule
Renderer Card capture, GI or a hardware query pipeline.

## Terrain raster context

Both `forgeax_material::terrain_surface` and `forgeax_material::terrain_id_surface` select Terrain geometry from resolved pass slots. The ID surface is an explicit Cook specialization, including inherited materials, rather than a runtime shader switch. All direct raster contexts retain the same shared vertex kernel and direct ABI receipt.

The terrain material context emits an ordinary cooked Standard artifact with the direct scene ABI receipt. It shares the terrain vertex kernel with shadow/depth/temporal and GBuffer contexts. Terrain's exclusion from SceneIndex never removes its direct ABI admission fact. Artifact request identity includes the visible-surface context, preventing a cached no-surface variant from satisfying a surface request. Runtime only resolves cooked artifacts; it does not compile terrain WGSL.

### Material source discovery

`listMaterialSourcePaths(roots)` enumerates the exact WGSL file namespace used by
`collectMaterialSources`. DevKit records this producer-owned membership in its shared
source snapshot before deriving the SSR input identity. Unimported shader modules
remain inputs because material programs can resolve them by module identifier.
