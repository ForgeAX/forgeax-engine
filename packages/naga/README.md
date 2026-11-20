<!-- LANG-SWITCH -->
**Language**: **English** · [简体中文](README.zh-CN.md)

# @forgeax/engine-naga

> **This package is a TypeScript-only wrapper over naga raw bindings from `@forgeax/engine-wgpu-wasm`.** It follows the three-stage API (`parse` / `validate` / `emit_reflection`) without business logic. AI users, including agentic runtimes, can `import { parse, validate, emit_reflection } from '@forgeax/engine-naga'` for WGSL syntax checking. Internally, the `@forgeax/engine-wgpu-wasm.ensureReady()` singleton loads the physical WASM (plan-strategy D-P3/D-P4, research F-4, charter propositions 1 and 5).

`composeShader` optionally accepts a synchronous output normalizer. Naga reparses
and validates that returned WGSL and compares its complete buffer ABI before
returning it. The next exact `parse`/`validate` can consume this checked IR once;
changed bytes take the ordinary path. Opaque handle ownership and explicit
render-entry/reflection admission are unchanged.

## Invariants

- **Single responsibility** -- Wrap raw wasm-bindgen exports in TypeScript, retaining upstream naga snake_case names. Reflection-field derivation and the three emitted outputs belong to `@forgeax/engine-shader-compiler`.
- **TypeScript-only wrapper** -- No Rust crate, `Cargo.toml`, `build.sh` or `pkg/` assets live here. `@forgeax/engine-wgpu-wasm` packages physical WASM; this package declares `'@forgeax/engine-wgpu-wasm': 'workspace:*'`.
- **One ShaderError owner** -- `@forgeax/engine-shader` owns `ShaderError`, `manifestMalformed` and `shaderNotFound`. Reexports preserve the same `instanceof` identity across build and runtime paths. Closed `ShaderErrorCode` / `ShaderErrorDetail` unions come from `@forgeax/engine-types`; this package only adapts `try { ... } catch (e) { return err(wrapShaderError(...)) }`.
- **Physical isolation** -- The `@forgeax/engine-shader` runtime must never depend directly or indirectly on this package (AC-06 enforces three independent checks).

## API Index

| Entry | Signature | Description |
|:--|:--|:--|
| `getCompilerFingerprint()` | `() => Promise<Result<string, ShaderError>>` | Verified, successfully initialized native compiler identity. Build caches must include this fact; missing identity cannot qualify as a cache hit. |
| `parse(source)` | `(string) => Promise<Result<ParsedModule, ShaderError>>` | Forwards naga `parse_str`; syntax errors return `Result.err(ShaderError code='shader-compile-failed')` with lineNum / linePos. |
| `validate(parsed)` | `(ParsedModule) => Promise<Result<ValidatedModule, ShaderError>>` | Forwards naga `Validator::validate`, transferring ownership by consuming the parsed handle. |
| `emit_reflection(validated, optionsJson)` | `(ValidatedModule, string) => Promise<Result<string, ShaderError>>` | Emits reflection JSON. ModuleInfo is embedded in the ValidatedModule handle; `@forgeax/engine-shader-compiler.parseReflectionJson` derives `BindGroupLayoutDescriptor[]`. |
| `composeShader(entry, imports, defines)` | `Promise<string>` | Build-time Naga Oil Composer passthrough; resolves selected imports and throws prefixed composition errors. |

Reflection also carries `entryPoints`: the binding and top-level struct-field
reads of each actual entry and its reachable helper calls. The native Naga IR
owns this analysis. Helper arguments/returns preserve source fields; dynamic
aggregate access and partial aggregate stores conservatively retain their source
structure. Other entries and unreachable helpers do not contribute reads. Missing
metadata means unknown, never an empty dependency set.

Each newly compiled entry also publishes `effects`: Naga's transitive
`mayDiscard`, fragment `writesDepth` / `writesSampleMask` outputs and bound
`writesStorage` (including atomics and storage textures). Private/workgroup
stores do not count as externally visible storage writes. This is an additive
field in the existing reflection wire; absent older metadata remains unknown.
Native validation owns these facts; consumers do not scan shader text to infer
them or manufacture effect-free defaults.
The native projection visits validated `Kill` statements and their function
calls. Naga's `FunctionInfo.may_kill` is a uniformity fact and omits uniform or
unconditional discard, so it cannot serve as this complete effect contract.

Opaque module handles expose `free()` for deterministic native IR release.
`composeShader` optionally accepts a source-normalization function. Normalization
runs inside the checked writer boundary, before its final parse and ABI check.
The call returns WGSL; the next exact-source native `parse` consumes the bounded
one-shot checked IR, and `validate` transfers its existing validated information.
A changed source parses independently. Both asynchronous compilation and the
prepared synchronous compiler consume this same native ownership path.
`validate` consumes its parsed handle even on failure; do not free that handle
again. A successful syntax probe that stops before validation frees its parsed
handle. Reflection and selected-entry validation borrow the validated handle;
its caller frees it after the last operation, normally in `finally`. Garbage
collection is not an execution budget for native IR during long source builds.

Signatures map to the wasm-pack-generated `@forgeax/engine-wgpu-wasm/pkg/wgpu_wasm.d.ts`; this package only adds try/catch and ensureReady adaptation.

## Related Work

- Decisions: plan-strategy D-P3 (`ensureReady` authority) / D-P4 (the wrapper preserves the historical wasm-pack naga shim surface byte for byte; the original was archived and removed in feat-20260511-naga-rhi-wgpu-merge M5).
- Physical provider: `@forgeax/engine-wgpu-wasm` packages wgpu 30 RHI and the three naga 30 raw-binding functions in one WASM.
- Consumer: `@forgeax/engine-shader-compiler` only. The `@forgeax/engine-shader` runtime remains physically isolated, enforced by AC-06.

`validateRenderEntries(module, vertex, fragment, colorFormats?)` optionally
validates the selected fragment color interface against ordered attachment
formats through Naga IR. This is build-time validation; it allocates no GPU resources.

`boundGlobals[].elementStride` retains the Naga layout stride for fixed uniform
arrays as well as storage arrays/records. Consumers use that fact for joint
palette publication on both capability paths; the TypeScript reader accepts it
only on buffer resources and requires a positive integer. Scalar/struct uniform
blocks do not invent an array stride.

## Buffer layout reflection v3

`emit_reflection()` publishes `shader-reflection/3`. Every reflected buffer has
a recursive `typeDescriptor` from Naga's validated type/layout projection:
scalars and vectors retain scalar width and alignment, matrices retain their
column/row dimensions and column stride, arrays retain their element descriptor,
Naga stride and constant/pending/dynamic size, and structs retain their span and
member offsets. Each member carries its own recursive descriptor.

The older flat fields remain projections for existing consumers. For an array,
`elementType`, `elementStride` and `arrayLength` must agree with the recursive
element, stride and constant count. Non-arrays cannot publish `arrayLength`;
their applicable element type and storage stride must match the descriptor.
The reader rejects schema `/2`, missing descriptors and contradictory flat
fields. Do not repair a stale entry by editing its flat fields.

```ts
const parsed = parseReflectionWire(reflectionJson);
const slot = parsed.boundGlobals.find(({ group, binding }) => group === 0 && binding === 3);
if (!slot || slot.typeDescriptor.kind !== 'array') {
  throw new Error('expected the published array buffer layout');
}
```

> [!WARNING]
> Direct `emit_reflection()` preserves Naga's reflected `@align` and `@size`
> layout facts. The pinned Naga Oil import/header writer does not preserve those
> tokens for composable modules. The composition boundary therefore rejects an
> active imported padding attribute with `shader-compile-failed` at
> `naga-oil-import-layout-admission`, before it can publish a mismatched ABI.
> Keep the source and host contract intact; use a naturally laid-out buffer
> whose host packing matches reflection, or a writer that preserves the layout.

Raw `composeShader` keeps conservative padding admission for registered modules.
Modules without `align` or `size` identifier tokens need no layout-specific
conditional preprocessing; the composer still validates their defines when
selected. The candidate check stays conservative across directives separating
`@` from its name. Padding inside comments does not select that check. Registered padding, selected-module
unknown defines and definition conflicts retain their existing failures. The
public compiler projects its selected source before calling this boundary.

After changing Naga/WASM reflection, rebuild the source-matched producer and
verify its provenance before rebuilding shader publications:

```sh
pnpm --filter @forgeax/engine-wgpu-wasm build:wasm
node packages/wgpu-wasm/scripts/verify-current.mjs
pnpm build:engine
```

Then rebuild or re-cook manifests from their owning source producer. Runtime
admission rejects old `/2` or inconsistent `/3` publications; bypassing that
check would let host packing and WGSL disagree.

## Prepared composition and module reuse

`PreparedNagaCompiler.composeProgram` returns final WGSL and an invocation-owned
validated module. An optional synchronous source normalizer runs before the
checked writer parses and validates that final source and compares its buffer
ABI. The Shader compiler passes its existing portability normalizer here, so
reflection uses exactly the WGSL delivered to the GPU without a second parse.
The consumer frees the validated module after its last reflection/interface read.
Both composition APIs use main's one-shot checked-program handoff. The exact
normalized writer output and validated IR stay in the native owner until the
matching native parse consumes them. `composeProgram` transfers that owner
through the same native parse/validate entrypoints; it adds no compiler cache.
A changed source or an output over the native retention bound follows ordinary
parsing and validation.

The native composer retains one bounded definition-independent import closure
and its unchanged registration prefix. Definition-dependent imports and automatic
bindings use fresh composition. Entry selection, imported padding, normalization,
validation and writer ABI checks remain authoritative. Reentrant normalization
uses the same checked native boundary; failed composition cannot publish a
successful program. ShaderRegistry remains the complete program reuse owner.
