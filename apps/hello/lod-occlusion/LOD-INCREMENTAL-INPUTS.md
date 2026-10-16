# E03 构建期增量输入

本工具只准备固定 E03 fixture 的真实产物。它调用公开 `gltfImporter`，经
`ImporterRegistry` / `produceSourcePackage` 校验声明闭包，再使用
`normaliseForPack` 序列化原 payload。不会修改 glTF、Meta、原 refs、Pack 或运行时加载策略。

在 Engine 仓库完成依赖安装及公开包构建后，从本 app 目录执行：

```powershell
node scripts/prepare-lod-incremental-inputs.mjs --output C:/evidence/e03-inputs --shader-manifest C:/existing-build/shaders/manifest.json
```

输出目录必须不存在。可省略 `--shader-manifest`；此时 `shaderClosure.status` 明确为
`not-prepared`，不能把缺失 shader publication 的结果作为完整渲染输入。该脚本使用工作区
公开包入口，不能直接导入到浏览器；不引入运行时 importer 或 compiler。

## 产物与来源

`manifest.json` 最后写入，包含实际 producer HEAD、固定基线
`f34758bab0284ac1d63f55b701170ab4d8793299`、源文件和 Meta 的 SHA256、公开 producer
入口编译文件的 SHA256、原 sourceDependencies、五个原 GUID / refs 和两次准入名单。
入口摘要用于复验实际执行字节，不等同于全模块依赖闭包或 GPU 资源 readiness。

`assets/<guid>.json` 保存原 payload 的公开 JSON 投影、完整 `AssetRef`（含 sourceField）及
artifact 描述。`artifacts/<guid>-body.bin` 是原 importer 产生的 Mesh binary 字节；描述包含
原 mediaType / assetCodec、真实字节数、`contentEncoding: identity` 与
`integrity: {algorithm: sha256, digest}`。manifest 同时记录 asset JSON 文件摘要。

提供 shader 输入时，`shaders/manifest.json` 是该已有构建产物的完整字节副本。
公开 `readShaderManifestPublication` 检查 publication source table、WGSL 源摘要；脚本
另核对材质实际程序 `forgeax::default-standard-pbr`、`forgeax::default-shadow-caster`
是否存在。样例材质无 texture / parent refs，采用 engine-owned native Standard 程序，
无需项目自定义材质 cook。`cpu-publication-verified` 仅表示上述 CPU 校验，不表示
ShaderRegistry 全量语义准入、所选 specialization 可用、设备上传或 GPU pipeline 创建成功。
`gpuReadiness` 始终为 `unverified`。真正消费时仍须由 Renderer 的 shader、material 与
residency owner 准备并验证对应设备资源。

## Selected input identity

Both smoke hosts use `scripts/load-lod-producer-inputs.mjs`. Set
`FORGEAX_E03_INPUTS_DIR` to one prepared directory. The expected producer commit
defaults to this checkout's `git rev-parse HEAD`; `FORGEAX_E03_PRODUCER_HEAD` can
explicitly select an earlier producer after sample-only changes. The loader
checks source and Meta bytes against this checkout, hashes the actual resolved
public glTF/Import/Shader entry modules, and verifies the shader publication's
length and SHA256. Dawn also compares the built app shader manifest; Browser
checks the shader response consumed by the page.

The Node host selects the exact manifest SHA256 before browser startup and passes
`{ manifestUrl, producerHead, manifestSha256 }` as
`globalThis.__forgeaxLodIncrementalInputs`. The browser verifies its fetched
manifest against that identity before any catalog admission. An old manifest is
never relabeled as the current producer. Asset JSON and binary hashes remain
checked at each admission, including the later lowest-LOD stage. These checks
prove the selected entry/publication bytes, not a complete transitive module
closure or GPU readiness.

The real-input regression cases in
`src/__tests__/lod-acceptance-evidence.unit.test.ts` run when
`FORGEAX_E03_INPUTS_DIR` is set. They cover selected identity mismatch, wrong
roles, modified source/Meta/module hashes, missing or corrupted shaders, and
missing, truncated or altered asset JSON/binary bytes. They also retain the
actual decoder/catalog/World positive path and verify stable root identity and
shared-reference count across lowest-LOD admission.

## app 消费契约

使用 manifest 的相对路径（相对产物根目录），先校验实际文件字节长度 / SHA256。
JSON 中 refs 是完整 `AssetRef[]`；传给公开 loader 时投影 `refs.map(ref => ref.guid)`，
传给 `AssetRegistry.catalog` 时保留原 `AssetRef[]`。不改 refs 顺序，否则 binary 内
material / LOD ref index 会指向错误 GUID。

Mesh 使用 `@forgeax/engine-assets-runtime` 的 `meshLoader.loadPack`：

```ts
const decoded = await meshLoader.loadPack?.({
  guid: row.guid,
  kind: row.kind,
  payload: row.payload,
  refs: row.refs.map((ref) => ref.guid),
  artifacts: { body: { descriptor: row.artifacts.body, bytes: verifiedBodyBytes } },
}, loadContext);
if (!decoded || 'ok' in decoded) throw new Error('Mesh decode failed');
assets.catalog(row.guid, decoded, row.refs).unwrap();
```

`verifiedBodyBytes` 是从独立 binary 文件取得并校验的实际字节，`loadContext` 是实际宿主
提供的公开 `LoadContext`，不通过此片段伪造资源准备。材质使用公开
`materialLoader.load(row.payload, row.refs.map(ref => ref.guid), loadContext)`，检查返回
成功的 MaterialAsset 后同样 `catalog`。运行时消费仅使用 loader / catalog，不导入本构建脚本。

先按 `admission.initial` 顺序准入材质、中模、root；最低模尚未 catalog，Scene 也不准入。
此时 root 完整保留对中模和最低模的原 GUID 引用及 coverage 0.5 / 0.2。随后只按
`admission.later` 准入最低模。最低模使用原同 GUID，不重新 catalog root，不重建 World，
不替换已有 root payload / shared ref。该约束由直接测试通过公开二进制解码和真实 World 验证。

五个 producer 输出全部保留。Scene 保存在独立文件中作为闭包证据，列入
`admission.excluded`。正常 `loadByGuid(root)` 会 eager 加载最低模；这是原契约的正确行为。
阶段缺席测试使用明确的增量 catalog 准入，不把普通 Pack 路径伪装成 deferred loading。

## 验证与后续验收

直接测试位于 `src/__tests__/prepare-lod-incremental-inputs.unit.test.ts`，属于 Node / CPU
unit 测试，不调用 GPU。设置 `E03_SHADER_MANIFEST` 可额外校验已有真实 shader publication；
设置 `E03_PRODUCER_EVIDENCE` 可保存原始 producer 与真实 World 控制组结果。

控制组覆盖原 GUID / refs / binary 保真、最低模暂未 catalog、随后同 GUID 准入时 root
对象 / World identity / refcount 保持、全部 catalog 的正常路径、实际 Pack root eager
加载、截断 binary 拒绝、已有输出不可覆盖及缺 shader closure 拒绝。省略 shader 输入时
只证明 CPU 资产准入边界。失败执行不返回成功 manifest，保留部分文件供检查；重试用新目录。

This producer does not supply Camera/LOD submission facts or GPU completion
receipts. The regular Browser and Dawn smokes independently require at least 60
completed and 60 accepted receipt frames in each of five phases: near/far
fallback, lowest-LOD readiness, hidden, restored visibility, and late revision 3
after accepted revision 4. Both CameraViews must retain same-submit attribution
in the same World. This document and the CPU tests do not replace those GPU
results.
