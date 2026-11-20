<!-- LANG-SWITCH -->
**语言**：[English](README.md) · **简体中文**

# @forgeax/engine-naga

> **本包是 `@forgeax/engine-wgpu-wasm` 暴露的 naga raw bindings 之上的 TS-only 薄壳**，对齐三阶段 API（`parse` / `validate` / `emit_reflection`），关注点零业务逻辑。AI 用户（含 agentic AI runtime）可直接 `import { parse, validate, emit_reflection } from '@forgeax/engine-naga'` 复用 WGSL syntax check 能力——内部走 `@forgeax/engine-wgpu-wasm.ensureReady()` singleton 加载物理 wasm（plan-strategy §D-P3 / §D-P4 + research F-4 + charter 命题 1 渐进披露 + 命题 5 一致抽象）。

`composeShader` 可接收同步输出规范化函数。Naga 返回结果前，会重新解析并验证规范化后的
WGSL，再比较完整缓冲区 ABI。下一次字节完全匹配的 `parse`/`validate` 可消费一次该已验证
IR；字节变化时走常规路径。不透明句柄所有权与显式渲染入口、反射准入规则保持不变。

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
| `composeShader(entry, imports, defines)` | `Promise<string>` | 构建期透传 Naga Oil Composer，解析选中的导入，并抛出带前缀的组合错误。 |

反射还包含 `entryPoints`，记录每个实际入口及其可达辅助调用读取的绑定和顶层结构体字段。
此分析由原生 Naga IR 负责。辅助函数的参数和返回值保留源字段；动态聚合访问和部分聚合写入
保守保留源结构。其他入口和不可达辅助函数不贡献读取依赖。元数据缺失表示未知，不能解释为
空依赖集合。

不透明模块句柄通过 `free()` 确定性释放原生 IR。`validate` 即使失败也会消费解析句柄，
不要再次释放该句柄。语法探针成功但不继续验证时，应释放解析句柄。反射和指定入口验证借用
已验证句柄；调用方在最后一次操作后释放，通常放在 `finally` 中。长时间源码构建不能依赖
垃圾回收来控制原生 IR 的资源预算。

签名映射 `@forgeax/engine-wgpu-wasm/pkg/wgpu_wasm.d.ts`（wasm-pack auto-emit）；本包仅做 try/catch + ensureReady 适配层。

## 关联

- 决策 plan-strategy §D-P3（`ensureReady` SSOT）/ §D-P4（薄壳 surface byte-for-byte 等价历史上 wasm-pack 形态的 naga shim，已在 feat-20260511-naga-rhi-wgpu-merge M5 整体归档删除——保留 surface 形态延续不变）。
- 上游物理底层 `@forgeax/engine-wgpu-wasm`（合并 wgpu 30 RHI + naga 30 三段函数 raw bindings 的单 wasm 出包）。
- 下游消费 `@forgeax/engine-shader-compiler`（仅消费者）；`@forgeax/engine-shader` runtime 物理隔离（AC-06 闸门守护）。

`validateRenderEntries(module, vertex, fragment, colorFormats?)` 可通过 Naga IR，
按有序附件格式验证选中的片元颜色接口。这是构建期验证，不分配 GPU 资源。

`boundGlobals[].elementStride` 为固定长度 uniform 数组及 storage 数组、记录保留 Naga
布局步长。两条能力路径中的关节调色板发布都消费该事实；TypeScript 读取器仅在缓冲区资源上
接纳它，且要求正整数。标量和结构体 uniform 块不会臆造数组步长。

## 缓冲区布局反射 v3

`emit_reflection()` 发布 `shader-reflection/3`。每个反射缓冲区都包含来自 Naga 已验证
类型和布局投影的递归 `typeDescriptor`：标量与向量保留标量宽度及对齐；矩阵保留行列维度
与列步长；数组保留元素描述符、Naga 步长及常量、待定或动态长度；结构体保留整体跨度和
成员偏移。每个成员也包含递归描述符。

旧扁平字段继续作为现有消费者的投影。数组的 `elementType`、`elementStride`、
`arrayLength` 必须与递归元素、步长和常量数量一致。非数组不能发布 `arrayLength`；
适用的元素类型和 storage 步长必须匹配描述符。读取器拒绝 `/2` schema、缺失描述符和
互相矛盾的扁平字段。不要通过修改扁平字段修补过期条目。

```ts
const parsed = parseReflectionWire(reflectionJson);
const slot = parsed.boundGlobals.find(({ group, binding }) => group === 0 && binding === 3);
if (!slot || slot.typeDescriptor.kind !== 'array') {
  throw new Error('expected the published array buffer layout');
}
```

> [!WARNING]
> 直接调用 `emit_reflection()` 会保留 Naga 反射的 `@align` 和 `@size` 布局事实。
> 固定版本的 Naga Oil 导入、头部写入器不会为可组合模块保留这些词元。因此组合边界会在
> `naga-oil-import-layout-admission` 以 `shader-compile-failed` 拒绝活动导入中的
> 填充属性，防止发布不匹配的 ABI。保持源与宿主契约完整；使用自然布局且宿主打包与
> 反射一致的缓冲区，或使用能保留布局的写入器。

原始 `composeShader` 对已注册模块保留保守的填充准入。没有 `align` 或 `size` 标识符
词元的模块不需要布局专用条件预处理；组合器仍会在选中时验证其 defines。即使指令分隔了
`@` 和属性名称，候选检查仍保持保守。注释中的填充不触发此检查。已注册填充、选中模块中的
未知 defines 和定义冲突保留原有失败。公开编译器调用此边界前先投影选中的源。

修改 Naga/WASM 反射后，先重建与源码匹配的生产者并验证其来源，再重建着色器发布：

```sh
pnpm --filter @forgeax/engine-wgpu-wasm build:wasm
node packages/wgpu-wasm/scripts/verify-current.mjs
pnpm build:engine
```

随后从所属源生产者重建或重新构建清单。运行时准入会拒绝旧 `/2` 或不一致的 `/3` 发布；
绕过该检查会使宿主打包与 WGSL 不一致。
