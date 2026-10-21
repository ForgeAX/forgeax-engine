# @forgeax/engine-naga

> **本包是 `@forgeax/engine-wgpu-wasm` 暴露的 naga raw bindings 之上的 TS-only 薄壳**，对齐三阶段 API（`parse` / `validate` / `emit_reflection`），关注点零业务逻辑。AI 用户（含 agentic AI runtime）可直接 `import { parse, validate, emit_reflection } from '@forgeax/engine-naga'` 复用 WGSL syntax check 能力——内部走 `@forgeax/engine-wgpu-wasm.ensureReady()` singleton 加载物理 wasm（plan-strategy §D-P3 / §D-P4 + research F-4 + charter 命题 1 渐进披露 + 命题 5 一致抽象）。

## 形态铁律

- **关注点单一** —— 只做 raw wasm-bindgen 出口的 TS 包装（snake_case naga upstream 原生命名延续）；reflection 字段派生 / 三件套 emit 都在上游 `@forgeax/engine-shader-compiler`。
- **TS-only 薄壳** —— 本包无 Rust crate / `Cargo.toml` / `build.sh` / `pkg/` 资产；物理 wasm 段统一由 `@forgeax/engine-wgpu-wasm` 出包，本包 deps `'@forgeax/engine-wgpu-wasm': 'workspace:*'`。
- **ShaderError 不重定义** —— `ShaderError` 类与 `manifestMalformed` / `shaderNotFound` 工厂唯一 owner 为 `@forgeax/engine-shader`（本包 re-export，build 与 runtime 路径共用同一个 `instanceof` 身份）；`ShaderErrorCode` / `ShaderErrorDetail` closed union 来自 `@forgeax/engine-types`；本包仅做 `try { ... } catch (e) { return err(wrapShaderError(...)) }` 包装层。
- **物理隔离** —— `@forgeax/engine-shader` runtime 包**禁止**直接或间接依赖本包（AC-06 三重闸门 grep 守护）。

## API 索引

| 入口 | 形态 | 说明 |
|:--|:--|:--|
| `getCompilerFingerprint()` | `() => Promise<Result<string, ShaderError>>` | 已验证且初始化成功的 Native 编译器身份；构建缓存必须包含此事实，缺失身份不能视为有效缓存命中 |
| `parse(source)` | `(string) => Promise<Result<ParsedModule, ShaderError>>` | naga `parse_str` 透传；syntax error → `Result.err(ShaderError code='shader-compile-failed')`（含 lineNum / linePos） |
| `validate(parsed)` | `(ParsedModule) => Promise<Result<ValidatedModule, ShaderError>>` | naga `Validator::validate` 透传；ownership 转移（消费 parsed handle） |
| `emit_reflection(validated, optionsJson)` | `(ValidatedModule, string) => Promise<Result<string, ShaderError>>` | reflection JSON 字符串 emit；ModuleInfo 已嵌入 ValidatedModule 句柄；上层 `@forgeax/engine-shader-compiler.parseReflectionJson` 派生 `BindGroupLayoutDescriptor[]` |

Reflection also carries `entryPoints`: the binding and top-level struct-field
reads of each actual entry and its reachable helper calls. The native Naga IR
owns this analysis. Helper arguments/returns preserve source fields; dynamic
aggregate access and partial aggregate stores conservatively retain their source
structure. Other entries and unreachable helpers do not contribute reads. Missing
metadata means unknown, never an empty dependency set.

Opaque module handles expose `free()` for deterministic native IR release.
`validate` consumes its parsed handle even on failure; do not free that handle
again. A successful syntax probe that stops before validation frees its parsed
handle. Reflection and selected-entry validation borrow the validated handle;
its caller frees it after the last operation, normally in `finally`. Garbage
collection is not an execution budget for native IR during long source builds.

签名映射 `@forgeax/engine-wgpu-wasm/pkg/wgpu_wasm.d.ts`（wasm-pack auto-emit）；本包仅做 try/catch + ensureReady 适配层。

## 关联

- 决策 plan-strategy §D-P3（`ensureReady` SSOT）/ §D-P4（薄壳 surface byte-for-byte 等价历史上 wasm-pack 形态的 naga shim，已在 feat-20260511-naga-rhi-wgpu-merge M5 整体归档删除——保留 surface 形态延续不变）。
- 上游物理底层 `@forgeax/engine-wgpu-wasm`（合并 wgpu 30 RHI + naga 30 三段函数 raw bindings 的单 wasm 出包）。
- 下游消费 `@forgeax/engine-shader-compiler`（仅消费者）；`@forgeax/engine-shader` runtime 物理隔离（AC-06 闸门守护）。

`validateRenderEntries(module, vertex, fragment, colorFormats?)` optionally
validates the selected fragment color interface against ordered attachment
formats through Naga IR. This is build-time validation; it allocates no GPU resources.

`boundGlobals[].elementStride` retains the Naga layout stride for fixed uniform
arrays as well as storage arrays/records. Consumers use that fact for joint
palette publication on both capability paths; the TypeScript reader accepts it
only on buffer resources and requires a positive integer. Scalar/struct uniform
blocks do not invent an array stride.
