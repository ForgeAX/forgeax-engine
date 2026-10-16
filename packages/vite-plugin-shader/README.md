# @forgeax/engine-vite-plugin-shader

Package-owned material programs declare their resource interface in
`package.json#forgeax.materialPrograms`, keyed by the WGSL filename under
`src/shaders`. Values use the ordinary MaterialProgram fields without `module`;
the existing WGSL module declaration retains identity. The producer validates
the declaration against reflection and publishes the same ABI receipt as Cook.
Shared profile provenance includes these declarations and the package WGSL,
so a declaration edit cannot reuse an older inferred-layout publication.

> **本包是 `@forgeax/engine-shader-compiler` 的 Vite 插件薄壳，对齐 Vite 4-hook 模型（load / transform / generateBundle / handleHotUpdate）全装入，约束 transform 仅 forwarding 调 `compileShader`，不重新实现编译逻辑（AC-02）。** AI 用户（含 agentic AI runtime）通过 `import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader'` 在 `vite.config.ts` 里注入 plugin，得到 build-time `.wgsl` → 三件套 + manifest 落盘 + ShaderError → RollupLog wrap（plan-strategy §S-6 + §S-7）。

## Engine inputs and ABI transport

Engine shader loading is kept in `src/engine-inputs/`. `load-engine-shader-entries.ts`
owns the canonical WGSL entry and import closure; `shared-engine-inputs.ts`
owns packaged dev/prod manifest projection. Both paths feed the same plugin
manifest owner and the same `SHADER_MANIFEST_PATH` constant.

The ray query, transport, raster-receiver and diffuse-composite entries use this same loader in
both standalone and Vite builds. Their traversal module and imports live in
`packages/shader/src`; test-side string insertion is not a publication path.

The standalone `buildEngineShaderManifest` builder combines the admitted shared
or packaged engine projection with freshly compiled `materialPackages`. Authored
base and point-shadow builds retain SSAO from the complete source-build roster.
Custom materials use the same source/import/cook path and do not trigger another
engine-wide compile when that projection is available. Missing/stale profiles and
explicit source validation retain the complete source producer. Result arrays
are independent of the base manifest.

Source compilation keeps the complete variant roster, but projects each variant's
source and import catalog only when a compiler slot starts that job. The worker
pool therefore retains prepared inputs for active jobs rather than the complete
Cartesian roster. A single worker follows the same sequential admission rule;
results retain their original order. After all jobs settle, the pool closes each
worker's message port and awaits its normal exit rather than interrupting native
or WASM teardown with `terminate()`. Job errors retain precedence over shutdown
errors, and a worker that exits before returning its job rejects that job.
This applies to both Vite and the standalone source builder.

Production and development publish the same `4.0.0` manifest: each WGSL source
is identified by a domain-separated SHA-256 digest of its ordered fragment
digests, while repeated source blocks are stored once in a shared fragment table.
Material variants and direct entries refer to those identities. Identical ABI
receipts are stored once and variants refer to the receipt table. Every pooled
fragment, source sequence and referenced receipt is still validated;
all producer-declared variants survive publication. Runtime joins and retains
only requested sources after complete admission. Packaged profiles from an older
transport fall back to the complete source producer even when WGSL is unchanged;
obsolete shared transfers fail and must be rebuilt. The manifest is the complete
runtime shader publication. Both source builds and prepared inputs omit redundant
per-variant WGSL, GLSL and reflection files; inspection reads the manifest sources.
The development HTTP producer carries the verified packaged or shared engine
publication directly into the response, remapping only referenced fragment and
receipt indices. Fresh authored sources use the same digest and fragment
publisher. It does not expand and republish every engine variant; profile
replacement and plugin close retire the prepared publication with its input
generation. Source-byte validation, the variant roster and source-build fallback
remain authoritative.

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
Each batch in the single-worker path owns the same bounded program compiler as
each Worker. Reuse ends at the batch boundary; changed entry and reflection
options still pass their own validation.

Development requests reuse one serialized response for the current shader state.
Each request still resolves active material packages and primes missing entries;
successful source, import, package or shared-input changes invalidate that response.
Failed author edits preserve the existing last-known-good state. Failed publication
is retried, and `closeBundle` releases the retained response with the shader inputs.

Standalone point-shadow requests without authored packages reuse an admitted
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

The packaged input roster contains `base-ssao` and `point-ssao`. SSAO is an
independent fullscreen entry, so the same projection used for transferred inputs
removes it when disabled without recompiling material shaders. All four public
point-shadow/SSAO configurations remain available. The release producer removes
obsolete no-SSAO copies while preserving declarations and other live profiles.
The packaged `buildEngineShaderManifest` path retains SSAO in both point-shadow
configurations, matching its source-built manifest and the runtime Standard
profile. Explicit bundler `engineEntries.hdrpSsao: false` still removes it;
configured shared inputs retain their producer-owned projection.

Each prepared profile records `source.json` with the `engineShaderSourceDigest`
of the `@forgeax/engine-shader` `src/` WGSL it was compiled from. The loader
recomputes that digest over the resolved shader sources and admits the profile
only on an exact match; a missing record or a mismatch (for example a profile
left behind by an earlier SDK or Dawn preparation after a WGSL edit) warns once
and compiles from source instead of publishing stale bindings.

The public `VIEW_ABI` export is typed transport metadata for
`forgeax_view::common`: group 0, binding 0, and the 1280-byte upload shape, including camera clipping planes, fog and atmosphere. It contains no live WebGPU object. Consumers should use the manifest
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

Serving hosts share one verified compact engine publication per physical
base/point profile. Each load still verifies current engine source provenance
and hashes the actual manifest/import bytes before reuse; changed bytes replace
the profile, and corrupt or stale input retains its existing failure/fallback
contract. Project, authored-material and HTTP response state remains server-owned.
The standalone builder checks the current packaged input before reusing a
projection keyed by its admitted row identity. Source and shared builds coalesce
only while running; a subsequent edit or replacement at the same path is read
again. A completed authored generation is not held in a permanent option cache.

## 形态铁律

- **薄壳 forwarding** —— 4 hook（`load` / `transform` / `generateBundle` / `handleHotUpdate`）全部装入，但 `transform` 仅 forwarding 调 `@forgeax/engine-shader-compiler.compileShader`，不重新实现编译逻辑（AC-02 闸门）。
- **peerDep vite** —— 插件签名走 `'vite'` 的 `Plugin` 类型；vite 由 host 应用提供（`peerDependencies: { vite: ">=4" }`）。
- **hint 双投影** —— `toRollupLog(err)` 同时把 `ShaderError.hint` 放到 `RollupLog` 顶层与 `meta.hint`，AI 用户消费走 `err.hint` 顶层（charter 命题 5 一致抽象 + 命题 4 显式失败；plan-strategy §S-7）。
- **emitFile 必经路径** —— `generateBundle` 走 `this.emitFile({ type: 'asset', fileName, source })`，**禁止**直接 mutate `bundle[fileName]`（Rollup 官方 danger callout，research Finding 3）。
- **HMR 默认传播** —— `handleHotUpdate(ctx)` 返回 `ctx.modules` 即可；客户端 `import.meta.hot.accept(` 由 `transform` 注入字面量（whitespace-sensitive）。

## API 索引

| 入口 | 说明 |
|:--|:--|
| `forgeaxShader(options?)` | Vite plugin factory，返回含 4 hook + `resolveId` + `load`（virtual module 通道）的 `Plugin` 对象（w14 落地 + feat-20260608 M3 扩展） |
| `engineShaderSourceDigest(root)` / `PACKAGED_SOURCE_RECORD` | Packaged-profile provenance: SHA-256 over every `*.wgsl` under `root`, written by the release producer to `source.json` and re-derived by the loader |
| `toRollupLog(err)` | `ShaderError` → `RollupLog`（hint 双投影，w14 落地） |
| `ForgeaXShaderRollupLog` | RollupLog 扩展类型（`hint` 顶层投影是 forgeax 自定义字段） |
| `virtual:forgeax/bundler` | Build-time virtual module emitting `forgeaxBundlerAdapter()` factory（feat-20260608 M3，详见下节） |

## `virtual:forgeax/bundler` virtual module

The build revision is resolved when the virtual module is loaded. Constructing
plugins for unselected projects performs no revision subprocess. Explicit
`FORGEAX_SOURCE_SHA` precedes `GITHUB_SHA`; an active load otherwise queries Git
in the current working directory and keeps an undefined revision outside Git.

> feat-20260608-create-app-param-surface-trim / M3 / D-4 q7-A: a single inline-emit virtual module that surfaces the build-time bundler-injected wiring (`shaderManifestUrl` + optional `importTransport`) as a `BundlerOptions`-compatible factory call. AI users discover the entry through one import line; the manifest URL stays a single SSOT inside the plugin emit path.

```ts
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

// One-screen takeoff: pass adapter() directly as the third arg.
const app = await createApp(canvas, {}, forgeaxBundlerAdapter());

// Spread form when a real dev import-transport must be wired:
import { createDevImportTransport } from '@forgeax/engine-runtime';
const bundler = { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() };
const renderer = await createRenderer(canvas, {}, bundler);
```

**Form invariants:**

- `forgeaxShader(options?)` mounts `resolveId` (claims the virtual id) + `load` (returns the inline adapter source) hooks alongside the 4 build hooks. Same plugin, no second package.
- The adapter source closes over the plugin's `SHADER_MANIFEST_URL` constant -- a single SSOT shared with `generateBundle` emit + dev `configureServer` middleware. `apps/` source never types the literal `'/shaders/manifest.json'`; CI grep gate (AC-12) enforces zero hits.
- The adapter source **does NOT import** `@forgeax/engine-app`. The return value relies on TypeScript structural typing to satisfy `BundlerOptions` at every callsite (D-4 q7-A reverse-coupling guard: `vite-plugin-shader` -> `@forgeax/engine-app` is forbidden by the package layering).
- The TypeScript ambient module declaration (`declare module 'virtual:forgeax/bundler'`) ships in each app's `src/vite-env.d.ts` so per-app `tsc --noEmit` resolves the import without each app having to depend on the plugin's package types.

## 关联

- 决策 plan-strategy §S-6 4 hook 分工 / §S-7 ShaderError wrap（hint 双投影）/ §6 M2 范围。
- 上游 [`@forgeax/engine-shader-compiler`](../shader-compiler/README.md) 提供 `compileShader` 纯函数 + `ShaderError` 5 字段顶层错误类。
- 集成端 [`apps/hello/triangle/vite.config.ts`](../../apps/hello/triangle/vite.config.ts) M2 注入验证（w15）+ M3 替换 fixture 为 pbr.wgsl。

SSAO is included by default, matching the runtime `StandardProfile.ssao` switch. `engineEntries.hdrpSsao: false` explicitly strips it for a producer that never supports AO; requesting AO with that manifest produces a renderer error.

Workspace discovery constructs this plugin for unselected projects. It resolves
Git revision only when the virtual bundler module loads, retaining explicit
source/GitHub revision precedence and the missing-repository result. The
revision regression checks100 unselected instances and the selected load;
this avoids unused startup work and makes no GPU/frame speed claim.
