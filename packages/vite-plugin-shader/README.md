<!-- LANG-SWITCH -->
**Language**: **English** · [简体中文](README.zh-CN.md)

# @forgeax/engine-vite-plugin-shader

## Preparation feedback

`forgeaxShader({ onProgress })` reports input preparation from `buildStart`,
before Pack starts producing assets. Source compilation reports the WGSL path
and the completed/total variant count for that source, then reports it ready.
These are observed compiler completions, not a whole-project percentage.
Observer errors cannot interrupt compilation; scheduling and cache admission
remain owned by the existing compiler and publication paths.

## Native source delivery

`forgeaxShader()` publishes Engine sources in the native `7.0.0` library.
Engine modules are shared once and the runtime compiler prepares the selected
programs. The Vite transform validates imported WGSL and preserves its original
lookup handle. With `engineEntries: false`, the output contains only project
shaders.

| Consumer | Publication |
|:--|:--|
| Standalone Vite | Engine templates and cooked material packages supplied to the plugin |
| DevKit Play and production build | Engine templates with material artifacts published through Pack |
| DevKit resource and workspace previews | Engine templates with cooked texture-view materials |

An `8.0.0` manifest embeds a source-template library and a separately versioned
cooked section. Set `publishAuthoredMaterialShaders: false` when Pack supplies
the project's material artifacts. Build local Engine packages with
`pnpm build:engine`. Use `publication: 'compiled'` for hosts that explicitly
require a composed publication. Legacy publication versions remain readable.

Package-owned material programs declare their resource interface in
`package.json#forgeax.materialPrograms`, keyed by the WGSL filename under
`src/shaders`. Values use the ordinary MaterialProgram fields without `module`;
the existing WGSL module declaration retains identity. The producer validates
the declaration against reflection and publishes the same ABI receipt as Cook.
The shared publication fingerprint covers these declarations and the package
WGSL. A declaration edit invalidates the prior publication.

> **This package is a thin Vite wrapper around `@forgeax/engine-shader-compiler`.** It installs the four hooks (`load` / `transform` / `generateBundle` / `handleHotUpdate`); `transform` only forwards to `compileShader`, without reimplementing compilation (AC-02). AI users, including agentic runtimes, inject `forgeaxShader` from `@forgeax/engine-vite-plugin-shader` into `vite.config.ts` to compile `.wgsl` into three outputs, write the manifest and wrap ShaderError as RollupLog (plan-strategy S-6/S-7).

## Engine inputs and ABI transport

The plugin configures Vite Worker output as ES modules. App's native module
Workers retain lazy runtime imports and code splitting without per-project
Worker configuration; main-thread and Worker builds use the same runtime modules.

Engine shader loading is kept in `src/engine-inputs/`. `load-engine-shader-entries.ts`
owns the canonical WGSL entry and import closure; `shared-engine-inputs.ts`
owns packaged dev/prod manifest projection. Both paths feed the same plugin
manifest owner and the same `SHADER_MANIFEST_PATH` constant.

The stock import catalog includes the dependencies of its published modules.
`loadCloudRendererModules()` consumes that same catalog; registering a new
imported module belongs to the Engine source loader, not a Cloud-specific
exception or a caller-maintained substitute catalog.

Source receipts can move with their declared layout into a disposable project.
The receipt names the shader payload next to it and admission checks that path,
the inventory and the producer digest. Compiled inventories resolve from their
producer workspace, supplied through `workspaceRoot` by a host serving another
project.

Repeated Node loads of the same live publication share verified immutable row
facts; each consumer receives its own entry and material collections. Inventory
checks and the actual payload digest run on every load, so changed or missing
bytes cannot reuse admission. Weak publication ownership retires the expanded
graph when its consumers release it; the lookup does not retain it globally.

The Node loader deep-freezes its private JSON snapshot directly and reuses native
ABI facts that are already transitively frozen. Reflection validation remains
complete. Field projections preserve admitted WGSL getters, so default fields do
not materialize utility source before a consumer needs it.

The ray query, transport, raster-receiver and diffuse-composite entries use this same loader in
both standalone and Vite builds. Their traversal module and imports live in
`packages/shader/src`; test-side string insertion is not a publication path.

Standalone hosts use `buildEngineShaderTemplateManifest()` for Engine sources or
`buildProjectShaderTemplateManifest({ materialPackages })` to add cooked project
materials. The runtime host supplies the matching portable compiler to
`ShaderRegistry`. Vite and standalone acceptance load the production template
publication and check selected resampling, Cluster, DFG and temporal programs.

<details>
<summary>Explicit compiled publications and legacy profile inputs</summary>

The `buildEngineShaderManifest()` builder can produce a composed Engine
publication. It also reads verified shared inputs. Callers serialize its result
with `JSON.stringify(manifest)` so it can preserve the prepared transport.

Source compilation keeps the complete variant roster, but projects each variant's
source and import catalog only when a compiler slot starts that job. The worker
pool therefore retains prepared inputs for active jobs rather than the complete
Cartesian roster. A single worker follows the same sequential admission rule;
results retain their original order. Worker replies transmit the shared WGSL
body once, and the parent interns equal immutable bodies across completed
variants. Each result keeps its own metadata while its public WGSL fields
refer to the same canonical body. After all jobs settle, the pool closes each
worker's message port and awaits its normal exit rather than interrupting native
or WASM teardown with `terminate()`. Job errors retain precedence over shutdown
errors, and a worker that exits before returning its job rejects that job.
This applies to both Vite and the standalone source builder.

Compiled Vite builds and development serve the `6.0.0` manifest. Each WGSL source
is identified by a domain-separated SHA-256 digest of its ordered fragment
digests, while repeated source blocks are stored once in a shared fragment table.
Material variants and direct entries refer to those identities. A synchronous
publication interns each immutable fact object once before canonical value
deduplication; distinct equal objects still share the same table index. This
identity reuse ends with that publication, so a later source or fact edit is
read afresh. Identical ABI receipts, bound-global declarations and entry-read arrays are stored once; each row retains the exact
receipt, ordered binding and entry-read references, including the distinction between missing and
empty facts. Every pooled fragment, source sequence, receipt and entry-read
reference is still validated;
all producer-declared variants survive publication. Runtime joins and retains
only requested sources after complete admission. Packaged profiles from an older
transport fall back to the complete source producer even when WGSL is unchanged;
obsolete shared transfers fail and must be rebuilt. The manifest is the complete
runtime shader publication. Both source builds and prepared inputs omit redundant
per-variant WGSL, GLSL and reflection files; inspection reads the manifest sources.
The development HTTP producer carries the verified packaged or shared engine
publication directly into the response, remapping only referenced fragment and
receipt and entry-read indices. Fresh authored sources use the same digest and fragment
publisher. It does not expand and republish every engine variant; profile
replacement and plugin close retire the prepared publication with its input
generation. Source-byte validation, the variant roster and source-build fallback
remain authoritative.

### Complete engine profiles

Legacy packaged profiles and compiled shared inputs carry the complete renderer
publication. Each material primary and variant keeps facts from its own
compiled artifact; publication pooling stores compact indices and expansion
resolves them before profile admission.

| Published row | Required facts |
|:--|:--|
| Material primary and each variant | Artifact hash, exact source digest, current compiler profile, `/3` reflection, entry reads, and its own receipt/defines |
| Resampling compute and fragment programs | Stable engine identifier, exact entry stages, `/3` reflection, compiler/source identity, and output contract |
| Direct engine entry | Exact source/reflection references and selected variant identity where the entry is material-backed |

`buildStart()` submits both light-texture resampling programs independently of
the optional SSAO entry. An incomplete or stale packaged profile falls back to
source compilation; shared engine input with missing rows or artifact facts is
rejected and must be regenerated with the normal engine build. Custom manifests
remain optional and continue to use `ShaderRegistry`'s general admission rules.

Standalone callers use `JSON.stringify(manifest)` on the builder result. Its
serialization retains verified shared blocks and projects only entry metadata;
source-built results use the same publication owner as Vite. Do not spread the
builder object or republish its expanded fields: that discards its prepared
serialization and repeats source expansion, splitting and hashing. The next
build still validates current input bytes, including in-place replacement.
Hand-authored test manifests use `publishShaderManifest` once at publication.

Authored-material preparation and direct WGSL transforms use one Shader Compiler
program compiler per plugin lifecycle; a standalone manifest build owns its own
compiler. The existing joint64-entry/16MiB budget covers all packages, file
identities and variants in that scope. Shared code composes once;
distinct entry, output format and reflection contracts still run their own
validation. Source and option bytes determine reuse; changed sources and failed
preparations retain the existing HMR recovery path. `closeBundle` releases this
compiler's retained work before a subsequent `buildStart`.

Engine source variants respect `FORGEAX_SHADER_COMPILE_WORKERS`, including a
single-worker build: one compilation completes before the next starts. The
default pool reserves one available CPU. Both default and explicitly requested
pools are capped at 16 compiler workers, since each owns a Naga/WASM instance.
Both the standalone builder and Vite retain the complete ordered variant roster.
Engine variant descriptors share the original source closure. Conditional source
and import projection runs only when a serial or Worker lane admits a job; the
producer does not retain a projected import tree for every waiting variant.
Every published row and its result order remain unchanged.
Compiled Engine results enter the existing source-fragment and reflection tables
in roster order, with at most twice the worker count awaiting ordered publication.
Only selected root candidates retain a complete body; the complete variant fleet
is not held as expanded WGSL. Vite and standalone production use the same owner.
Standalone JSON serialization borrows its prepared publication, while explicit
in-process inspection admits the pooled facts and reads source lazily. This changes
build memory ownership, not shader validation, row admission, wire version or GPU
compilation policy. Consumer failures drain active native work before closing ports.

The repository source producer sizes its V8 heap from runner memory, retaining
the existing 4 GiB minimum and six GiB reserve, using at most half the available
memory above that minimum, and capping the heap at 24 GiB. Packaged release-profile
compilation defaults to two workers and caps explicit requests at four, within
the same CPU and memory limits. Both complete profiles still require verified
compiler, source and profile identity before reuse.
Each batch in the single-worker path owns the same bounded program compiler as
each Worker. Reuse ends at the batch boundary; changed entry and reflection
options still pass their own validation.

Development requests reuse one serialized response for the current shader state.
Each request still resolves active material packages and primes missing entries;
successful source, import, package or shared-input changes invalidate that response.
Failed author edits preserve the existing last-known-good state. Failed publication
is retried, and `closeBundle` releases the retained response with the shader inputs.

Explicit compiled point-shadow requests without authored packages reuse an admitted
packaged point profile when present. Missing inputs and explicit
`FORGEAX_ENGINE_SHADER_SOURCE_BUILD=1` requests retain source compilation.
Authored point-shadow packages reuse the admitted point projection while their
own sources are freshly cooked. Invalid shared inputs and missing authored
sources remain explicit failures.
Both shared and packaged projections retain the producer's reflected
`uvSetCount`; only a row without that field receives the zero default. Reusing
compiled inputs must preserve their vertex-layout facts as well as their WGSL.

Forced-source production resolves each entry's unchanged transitive import
catalog once before its capability variants, including utility entries without
variant axes. Per-variant import reachability
scans only preprocessor directives, preserving nested conditionals, commented
imports, traversal order and every published variant. WGSL bodies remain inputs
to the original source projection and compiler validation.

Each source-compilation Worker prepares the selected Standard Surface source
and owns one existing Material Program Compiler instance for its job stream.
The same internal preparation function serves serial compilation; its emitted
module is packaged with the plugin and adds no public entry point. The catalog
is sent once per Worker, while each job retains its source, defines and imports. Composition and exact-result reuse share the
compiler's original 128-entry / 16MiB bound; distinct reflection and entry
contracts still validate independently. Worker termination releases that state,
and emission keeps the original job order.

The legacy compiled input roster contains `base-ssao` and `point-ssao`. SSAO
is an independent fullscreen program. A caller may exclude it with
`engineEntries.hdrpSsao: false`.

Both profiles live in one deterministic `dist/engine-inputs/profiles.json.gz`
container (`packaged-profiles` entry). It pools the WGSL fragments and source
tables the profiles share, carries the import catalog once, and stores each
profile's rows with its own key, fragment-table and source order, because
compiler and merged app-input producers order them differently.
`packagedProfilePublication` rebuilds the exact producer publication, and the
encoder refuses a profile that would not. A single-profile preparation retains the other profile only when it
was compiled from the same WGSL. The container records the
`engineShaderSourceDigest` of the `@forgeax/engine-shader` `src/` WGSL it was
compiled from. The loader recomputes that digest over the resolved shader
sources and admits a profile only on an exact match; a mismatch (for example a
container left behind by an earlier SDK or Dawn preparation after a WGSL edit),
an obsolete container version or an absent profile warns or falls back and
compiles from source instead of publishing stale bindings.

To explicitly prepare a legacy compiled profile, run the producer in the Engine
checkout after building its packages.

```sh
node scripts/forgeax/prepare-shader-release-inputs.mjs --build --profile base-ssao
```

The producer reuses only a receipt matching the current compiler, source and
profile and the actual shader payload digest; otherwise it compiles the complete
profile. Repeat preparation reports `compile count=0` for an admitted hit.
Packaging without `--build` also requires that receipt; unverified input fails
with `shader-profile-input-unverified` before replacing the existing container.
Explicit compiled Vite consumers resolve the prepared container and matching
shader sources from the plugin package. Missing profiles and stale compiler
facts select the complete compiled source fallback.

</details>

The public `VIEW_ABI` export is typed transport metadata for
`forgeax_view::common`: group 0, binding 0, and the 1296-byte upload shape, including camera clipping planes, fog, atmosphere and sky fog. It contains no live WebGPU object. Consumers should use the manifest
and reflection output; they must not add a second manifest URL or hard-code a
carrier-side index.

Authored material packages are compiled as a complete Pass set through
`cookMaterialAsset`. Vite uses the compiler's source discovery, retains every
module and capability variant, and publishes shared modules once. A failed
later Pass leaves the previous complete material generation installed; a
successful edit replaces all of that package's program rows together.

For Standard roots, the plugin passes the complete source catalog and geometry
kind to that cooker. Capability lowering belongs to the cooker; stripping imports
before lowering would erase scene-index, clustered-light and skin programs. The
manifest publishes both direct and scene-index results with their actual ABI receipts.

Authored WGSL requests use native normalized filesystem paths for identity after
removing Vite query/hash suffixes. Both slash forms therefore match the same
prepared material on Windows. Absolute filesystem sources (including drive-letter
paths) remain authored sources; non-path producer keys such as `gltf:material:Name`
are already cooked publications and are not compiled again. At the Vite HMR
boundary, dependency edges use Vite's slash-normalized file identities so watcher
changes can reach affected authored and direct WGSL modules without query suffixes
splitting their file identity.

Pack-owned runtime materials use `publishAuthoredMaterialShaders: false` so
Vite supplies build artifacts without creating a second runtime material
registration. Their cooked record remains the runtime publication authority.

The plugin releases its manifest, variant, authored-material, and packaged-input
payloads in Vite's `closeBundle` lifecycle. A subsequent `buildStart` loads its
inputs again, including after a dev-server restart. Closed servers must not keep
another copy of the shader fleet alive through retained plugin callbacks.

Serving hosts can reuse the verified shared Engine template publication. Each
load verifies the producer receipt and the actual shader payload digest.
Project, authored-material and HTTP response state remains server-owned. A
subsequent source edit or input replacement is admitted from current bytes.

## Invariants

- **Thin forwarding** -- Install all four hooks (`load` / `transform` / `generateBundle` / `handleHotUpdate`), but let `transform` only forward to `@forgeax/engine-shader-compiler.compileShader` (AC-02).
- **Vite peer dependency** -- The plugin signature uses Vite's `Plugin` type; the host application supplies Vite (`peerDependencies: { vite: ">=4" }`).
- **Two hint projections** -- `toRollupLog(err)` places `ShaderError.hint` at the top level and in `meta.hint`. AI consumers read top-level `err.hint` (charter propositions 5 and 4; plan-strategy S-7).
- **Always emitFile** -- `generateBundle` calls `this.emitFile({ type: 'asset', fileName, source })`; never mutate `bundle[fileName]` directly (Rollup's warning; research Finding 3).
- **Default HMR propagation** -- `handleHotUpdate(ctx)` returns `ctx.modules`. `transform` injects the whitespace-sensitive client literal `import.meta.hot.accept(`.

## API Index

| Entry | Description |
|:--|:--|
| `forgeaxShader(options?)` | Vite plugin factory returning a `Plugin` with four hooks plus `resolveId` and virtual-module `load` (w14 and feat-20260608 M3). |
| `engineShaderSourceDigest(root)` | Legacy packaged-profile provenance. SHA-256 over every `*.wgsl` under `root`, recorded in the packaged container and re-derived by the loader |
| `encodePackagedProfiles` / `decodePackagedProfiles` / `packagedProfilePublication` / `PACKAGED_PROFILES_FILE` / `PACKAGED_PROFILE_NAMES` | The legacy pooled `profiles.json.gz` container and exact per-profile rebuild |
| `toRollupLog(err)` | `ShaderError` to `RollupLog`, with two hint projections (w14). |
| `ForgeAXShaderRollupLog` | RollupLog extension type with ForgeaX's top-level `hint` field. |
| `virtual:forgeax/bundler` | Build-time virtual module emitting the `forgeaxBundlerAdapter()` factory (feat-20260608 M3; see below). |

## `virtual:forgeax/bundler` virtual module

The build revision is resolved when the virtual module is loaded. Constructing
plugins for unselected projects performs no revision subprocess. Explicit
`FORGEAX_SOURCE_SHA` precedes `GITHUB_SHA`; an active load otherwise queries Git
in the current working directory and keeps an undefined revision outside Git.

> The inline virtual module returns renderer build inputs and App host capabilities through one factory call. It keeps the shader manifest URL as a single SSOT and moves Vite environment, HMR, debug recorder, and browser relay interpretation into this tool adapter.

```ts
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

// One-screen takeoff: pass adapter() directly as the third arg.
const app = await createApp(canvas, {}, forgeaxBundlerAdapter());

// Spread form when a host supplies a runtime import transport:
import { createDevImportTransport } from '@forgeax/engine-runtime';
const bundler = { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() };
const renderer = await createRenderer(canvas, {}, bundler);
```

**Form invariants:**

- `forgeaxShader(options?)` mounts `resolveId` (claims the virtual id) + `load` (returns the inline adapter source) hooks alongside the 4 build hooks. Same plugin, no second package.
- The adapter source closes over the plugin's `SHADER_MANIFEST_URL` constant -- a single SSOT shared with `generateBundle` emit + dev `configureServer` middleware. `apps/` source never types the literal `'/shaders/manifest.json'`; CI grep gate (AC-12) enforces zero hits.
- App consumes the generated adapter as `AppHostAdapter`; generic App runtime code never reads Vite metadata. Optional recorder and browser bridge methods dynamically import `@forgeax/engine-app/host-adapter` only when the Vite gates enable them, and HMR teardown is registered by the tool adapter.
- The plugin package does not add an App runtime dependency. Its ambient virtual module declaration type-imports the existing App facade so consumer callsites retain the full host adapter contract.
- The TypeScript ambient module declaration (`declare module 'virtual:forgeax/bundler'`) ships in each app's `src/vite-env.d.ts` so per-app `tsc --noEmit` resolves the import without each app having to depend on the plugin's package types.

## Related Work

- Decisions: plan-strategy S-6 hook responsibilities, S-7 ShaderError wrapping (two hint projections), and section 6 M2 scope.
- Provider: [`@forgeax/engine-shader-compiler`](../shader-compiler/README.md) supplies pure `compileShader` and `ShaderError` with five top-level fields.
- Integration: [`apps/hello/triangle/vite.config.ts`](../../apps/hello/triangle/vite.config.ts), M2 injection verification (w15) and M3 fixture replacement with pbr.wgsl.

SSAO is included by default, matching the runtime `StandardProfile.ambientOcclusion.enabled` switch. `engineEntries.hdrpSsao: false` explicitly strips it for a producer that never supports AO; requesting AO with that manifest produces a renderer error.

Workspace discovery constructs this plugin for unselected projects. It resolves
Git revision only when the virtual bundler module loads, retaining explicit
source/GitHub revision precedence and the missing-repository result. The
revision regression checks100 unselected instances and the selected load;
this avoids unused startup work and makes no GPU/frame speed claim.

Conditional source projection and active import discovery use ShaderCompiler
`projectShaderConditionals`; Vite only selects the author axes to flatten and
walks the resulting import closure.

The Rollup diagnostic projection derives shared fields from `ShaderError`. Compiler
admission constructs that error directly; Vite retains the same error code,
source position, typed detail and hints when forwarding it to bundler consumers.

Engine compilation, packaged inputs and authored manifest maps derive their
shader row fields from the runtime ManifestEntry contract. Build-time UV counts
and the legacy empty GLSL field remain explicit boundary refinements.
