**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具入口为英文 `SKILL.md`。

# forgeax-scriptable-pack-review

Scriptable Pack 是代码创作资产格式；procedural 指按规则/算法生成内容。构建期 *.pack.ts、直接生成的 runtime asset、可执行 runtime generator 都可审阅。Pack 有效、执行成功、publication 被接受，仍可能包装预制数据或 Base64，格式与程序化来源必须分开判断。

本文包含 [Engine 契约](#engine-contract)和[历史 Palace 证据](#historical-palace-evidence)，可单独分享。所有权在 Engine skills/forgeax-scriptable-pack-review；Harness 分发共享工作流技能。

## 审阅输入

记录下列条件，采用用户已给选择。required type 未明确时，继续格式/闭包检查并询问，确认前不能总体 PASS。

| 条件 | 必需事实 |
|:--|:--|
| 对象 | Pack entry、仓库/revision、交付目录、整包或用户选择的 output 范围。 |
| 要求类型 | 程序化资产：无公开生成参数的固定配方；程序化资产生成器：公开参数接口，不改源码即可生成变体。 |
| 执行阶段 | build time、runtime、both；区分提交前生成数据与准入可执行代码后生成实例。 |
| 数据策略 | 默认严格程序化；仅明确授权才允许辅助数据，记录允许种类/目的/范围。 |
| 用途 | Engine/SDK 版本、承诺 output/consumer、质量/预算/平台限制；runtime Host/realm（Node、browser main、Engine Worker）、dev/build、program preparation、persistence 承诺。 |

> [!IMPORTANT]
> 公开生成参数必须属于交付接口。内部函数参数、build context、常量、环境变量、output shader 参数、camera control 都不证明 generator 分类。有效公开 seed 可成立，完整 defaults 不改变 generator 分类。

分别记录 required type 与 actual interface type。不匹配为 FAIL，不能重分类需求。无效公开参数是 generator defect，不能降为 fixed asset 审阅。fixed instance 的生成能力属于 parent，检查交付是否包含 parent source/dependency。

本技能产生审阅结论，repair/conversion/publication 依用户范围。首审或版本不同，比较内嵌契约与目标定义、validator、真实生产路径。历史证据不证明当前 API 或某交付 PASS。

## 生产路径

| 路径 | 正式生产/消费 | 审阅重点 |
|:--|:--|:--|
| Build-time Scriptable Pack | definePack -> Host Producer/Cook -> Pack v2/Catalog -> load(guid, kind) | 隔离冷生产、Cook/artifact 证据、source closure。 |
| Direct runtime asset | 交付算法 -> Asset map -> prepareRuntimePackContent -> App runtimePacks.producer.admit -> combined Catalog/load | 必须交付算法与输入，单独 mesh/texture bytes 不证明程序化。 |
| Runtime Pack generator | prepared JS artifact（DevKit 转 TS）-> admit anchor -> generate 参数实例 -> combined Catalog/load | 完整 program/fixed dependency、公开参数、publication/recovery；admit generator 不执行 build、不产生 output。 |

Import RuntimePackProducer 拥有 runtime production，App 装配到已有 asset service。production 在 asset loading/ECS frame 外显式调用，消费保留 Registry/GUID 所有权。调用 geometry 函数或画临时对象不算 Runtime Pack 交付。

interface/execution path 独立分类。fixed recipe 可在 admit 前算 runtime data，direct data generation 有公开参数仍需 generator checks。producer.generate 要已准入且 parameters 非空的 anchor；admit 无参数 definition 不生成 fixed asset，不能为迎合 API 塞无意义参数。

## 通用检查

每适用项标 PASS/FAIL/BLOCKED/N/A，带文件定位或执行证据。N/A 说明不适用原因，未知/未执行不是 N/A。

| ID | 检查 | 通过条件 |
|:--|:--|:--|
| F1 | 源码格式 | 目标版本能发现/加载/验证 entry；export/schema/identity/parameters/build signature/result 或 runtime source/program/instance 满足选定路径。类型断言/tsc 不替代 Host validation。 |
| F2 | Output 契约 | 正式生产 materialize 所有要求 output；检查承诺、稳定唯一 sourceKey、kind/payload、refs/component schema、缺分支、重复 key 覆盖、空输出。build 返回完整 map，不是旧 per-output declaration list。 |
| C1 | Source 闭包 | 递归列真实 local library/re-export/dynamic load/script/input，交付或声明固定 dependency，路径/大小写可移植。runtime code 要已验证 executable JS closure、匹配 Host import identity，仅可编辑 TS 不够。 |
| C2 | Asset 闭包 | production reads/output refs 追到 sibling、交付 dependency、明确外部资产；记录 GUID/source/package/fixed version/resolution。runtime generator 声明所有 runtime.dependencies（含非默认分支），admission 保留精确 GUID version/可恢复闭包；只有 GUID、临时 URL、作者绝对路径不够。 |
| C3 | 可重建 | 隔离目录或 fresh Host/realm 清 derived cache，仅用交付算法、合法输入、锁定依赖、声明环境冷生产消费；排除作者缓存、未交付文件、隐式下载。声明 fixed cooked dependency 可作 carrier，仍查 P1/P2；承诺源码重建须冷 Cook。持久化另须 T4。 |
| P1 | 来源 | 从 recipe/input 经真实 generating function 追到各关键 Asset，也查 library/package dependency/parameter default/remote payload。 |
| P2 | 规则贡献 | 明确创造内容的结构/采样/组合规则，如尺寸构建、曲线、布局、噪声、语义材质配方。只迭代/解码/复制/解压/转换存储结果不够。 |
| R1 | 稳定性/副作用 | 同 source/dependency/identity/effective parameters 在重复、fresh process/realm 冷生产得到等价 payload/refs。随机性有 seed，排除 clock/global counter/环境偶然性。generation 不写 source、不随机 output identity、不改 live World、不自行发布 Catalog；调用者经正式 producer 发布。 |
| R2 | 可用性 | 经正常 Registry/load 消费当前已验证 output；检查 finite geometry/index bounds/required attributes、texture extent/format/byte length、scene refs/hierarchy；视觉/音频/运动承诺需真实看/听/玩。admission、Catalog rows、cache hit、LKG preview 不证明当前请求可用。 |

比较实际 payload/refs，不只 package ID/sourceKey。记录非语义 tool metadata 排除项，浮点 tolerance 必须有目标契约依据，不能掩盖差异。

## 程序化内容与伪装数据

判断什么信息决定内容，不按扩展名、代码量、数组长短、压缩比、有没有 loop 判断。

| 来源 | 严格策略结论 |
|:--|:--|
| 语义尺寸/颜色/材质系数/seed/少量控制点和布局配方/通用算法常量 | 有语义和生成规则则允许，最终逐顶点/像素/采样结果不能改名控制点。 |
| 计算所得 TypedArray/index/pixel/sample | 向上追计算，二进制输出不否定程序化来源。 |
| runtime blobs、snapshot binary table/Base64、verified JS artifact、fixed cooked bytes | 是交付/持久化 carrier，非自动失败；追原链，编码算法结果仍程序化，编码预制内容仍数据。 |
| inline Base64/hex/compressed string、byte array、完整 vertex/index/pixel/audio sample table | 承载预制内容即 FAIL；拆字符串、算术改写、移到 library/npm 不改 provenance。 |
| 每 face/pixel 一个表达式、巨大 switch、资产特定 fitted neural weight/coefficient | 编码结果而非规则生成则 FAIL。 |
| 外部成品 model/image/audio、大型测绘/scan/map outline/逐对象坐标表 | 数据依赖，严格策略中相关内容 FAIL，放包外也一样。 |
| 预生成 triangulation/roof partition/lookup result | 区分通用常量与资产特定 baked result；只有交付逻辑/合法输入经正式冷路径在删 cache 后重建并有证据，才按生成链判断。注释 generated 不够。 |
| 参数化 model selector/prefab scaler/decoder | 参数可有效但 P1/P2 仍失败，color/scale/seed 装饰不使 prefab 程序化。 |

1. 搜 encoded string、numeric table、TypedArray initializer、decode/decompress、file/network read。命中只是线索，追消费者后再判。
2. 对每关键 output 区分规则、语义配方、已存结果，同时查 scene composition/layout source。
3. 隔离副本对可疑 table/cache 验证其生成链；有意义尺寸/采样密度变化可暴露是否重算。此实验不把 fixed asset 变 public generator，也不证明所有 input。
4. 分别记录 procedural/data/external dependency。小程序化对象不能替预制主要交付背书，closure 不等于 provenance。

允许辅助数据时逐项对照既有授权，报告“程序化+数据混合”，P2 仍适用；辅助数据不能无限替代承诺主体。发现失败后不能放宽策略。只审选定 sub-output 也覆盖全部依赖，结论仅限该范围。

## 类型专项检查

### 程序化资产

| ID | 检查 | 通过条件 |
|:--|:--|:--|
| A1 | 固定配方 | 正式使用无需公开参数、源码编辑、隐式环境输入、猜工具顺序；direct runtime 交付固定生成/提交入口。 |
| A2 | 固定结果 | default production 覆盖承诺资产，允许内部 seed/argument；验证 R1，不要求公开变化。单独 bytes 不证明可重建链。 |

### 程序化资产生成器

| ID | 检查 | 通过条件 |
|:--|:--|:--|
| G1 | 公开契约 | 可发现 name/type/default/semantics/legal domain/unit/enum/range/coupling/asset-ref 要求。文档可说明语义，不能发明 Engine schema 字段。 |
| G2 | 默认值 | omitted、explicit-default、inherited、override 均按目标契约产完整可用结果。 |
| G3 | 有效变化 | 每声称参数至少一个合法对照按预期改变真实 geometry/material/hierarchy/sample，不只 hash/log/metadata。conditional input 在激活时测，enum 可选算法配方。 |
| G4 | 范围组合 | default/interior/boundary numbers、所有 bool/enum、coupled boundary、昂贵组合。大空间说明采样/未覆盖，不称穷尽。 |
| G5 | 无效输入 | 错类型、未知名、非法 enum、非 finite/越界数、违反组合按契约明确拒绝/规范化，不能静默用旧 cache/坏资产。 |
| G6 | 实例隔离 | 正式 Host parameter/instance 路径 A-B-A，再 fresh process/realm 重现 A。cache identity 覆盖 source/program/instance/effective values/fixed dependencies/producer versions；instance ID/internal refs 正确，不硬编码 root。runtime instance 指 admitted anchor，resolved inheritance 转 effective defaults，不另指 live instance。 |
| G7 | 资源边界 | segments/density/resolution/recursion 增长有可执行 bounds/budget；采样最昂贵合法组合，对交付预算记录 time/memory/output size，不套通用本地 timeout。 |

G3 证明参数效果，P1/P2 证明程序化。seed 检查同 seed 重现及代表性异 seed 变化，不要求每 seed 唯一。直调 library 不替代 G6 正式接口。

## Runtime 检查

runtime/both 使用 T1–T6，纯 build-time 标 N/A。子项按承诺能力适用，未知/未执行仍为缺口。

| ID | 检查 | 通过条件 |
|:--|:--|:--|
| T1 | Host/program 准备 | 在真实 App/realm 取 runtimePacks，producer.inspect().imports 匹配 module identity。direct data 无需 program host。代码交付含 executable JS，DevKit 真实转换 TS；正常 generation/recovery 不引入 filesystem/DDC/TS/shader compiler，runtime material 用 cooked shader contract。 |
| T2 | 依赖/消费 | 验全部分支 fixed deps/refs/siblings；App combined Catalog/fetcher 或 openPackage 加载当前 output。data 用 prepare/admit，generator 用 admit/generate，不能空 anchor publication。plugin reading/publication/installation 分别证明。 |
| T3 | 失败/竞态 | 同身份 reentry/conflict、invalid parameter、generation failure 不暴露半包或旧结果成功。async 测 old/new race、withdraw/dispose 后迟到、AbortSignal。cancel 不打断正在执行 JS，也不要求回滚独立提交 restore recipe。 |
| T4 | 持久化/冷恢复 | 有承诺则真实写读 portable snapshot/export，清 cache，fresh scope restore，按 GUID 消费；查 full payload/internal ref/typed view/fixed versions，保留原 definitions/JS programs/accepted inputs/reachable closure。DDC/CacheStorage/GPU handle/Fiber 不是存档权威。corruption/missing deps/unsupported version 明确失败。 |
| T5 | 消费者/生命周期 | parameter replacement 经契约 refresh/reload，释放旧资源。withdraw/provider dispose 退役自有 publication；consumer/installed Fiber 各管 cleanup，publication 不自动 rebind World/Renderer 或 uninstall plugin，restore 不安装 plugin。 |
| T6 | 平台/预算 | 实测承诺 Node/browser main/Engine Worker、dev/build。browser 新创作代码需 native module delivery 证据，static loading 不够；render 要真实 browser/backend 消费，Node 不替代。分别记录 cold preparation/capture、warm generation、GUID load、explicit export、GPU completion 成本。 |

可恢复 direct-asset snapshot 可只有完整数据而无 procedural algorithm，T4 不替代 C3/P1。明确临时且不承诺持久化时 T4 可 N/A，C3 仍须由交付算法/合法输入冷生成。两阶段承诺分别举证。

<a id="engine-contract"></a>

## Engine 契约

2026-10-14 对照 Engine df4c86bf12bf117ed229e2721e98d60ad1b0d7a0 检查，以下为 source-contract facts，不是被审交付 runtime acceptance。目标 revision 不同时重查实际行为。

| 关注点 | 应查契约 |
|:--|:--|
| 代码定义 | 从 @forgeax/engine/pack/source 导入 definePack；schemaVersion:'2.0.0'、稳定 packageId、build(context) 同步/异步返回 Result<sourceKey -> Asset 或 PackCookSource>。可选 sceneComponents 声明 custom scene schema；custom cook source 需 NativeCooker。 |
| 参数能力 | fixed asset 省 parameters，空数组无效；参数化定义列表非空，字段含 name/type/default、适用 minimum/maximum/values/kind。base context 有 packageId/readByGuid，参数化另有 values。material parameter 是另一层。 |
| 身份/output map | Host 从 (packageId,sourceKey) 派生 GUID，stable sibling ref 用 AssetGuid.derive(context.packageId,sourceKey)。不随机 output ID、不硬编码实例 root ID。返回完整 map，旧 per-output GUID declaration/externalAssets 不是字段。runtime generator 声明完整 runtime.dependencies。 |
| editable/data source | .pack.json 为 schema v3：packageId、assets[sourceKey]；instance 有自己的 packageId/parent/sparse values，区别于 cooked Pack v2 与 Scriptable definition v2。 |
| Runtime content | prepareRuntimePackContent 验证/复制普通资产为完整 source/program/blob/dependency projection。admit 验 generator/program/fixed dependency 不执行；generate 解析已准入 parameter anchor，发布完整 instance output。runtime instance 不沿 live instance 链。 |
| 继承 | resolvePackParameterInheritance 解析 authoring parent；prepareRuntimePackAnchor 保留 program/dependency closure，把 effective values 转 anchor defaults。新 instance 用新 identity、同 anchor、稀疏 override。 |
| 可执行权威 | RuntimePackProgram.artifact 为 verified JS ESM，含 entry/export/module source/fixed Host import identity/digest。pack/runtime 的 preparePackProgram 解析封存 JS，不执行/转换；devkit/plugin-build 的 prepareRuntimePackProgram 转 TS、留原文；可编辑源码不证明编译等价。 |
| Realm 装配 | App assembleRuntimePacks 经已有 provider 返回 producer/catalog/fetcher，每 realm Registry 一套。app.pluginContext.get('runtimePacks') 或 game-plugin inject 访问。用 combined catalog/fetcher，assetAssembly.catalogSource 保留交付 base；native Host import 保留实际 component/Cordis identity。 |
| Browser program | pack/runtime-browser 的 prepareBrowserPackProgramScope/createBrowserPackProgramHost 拥有 native browser module delivery；main/Worker dev/build 分验，static archive 不证明新 runtime code。 |
| Publication/result | admit/generate receipt 暴露 identity/status/publication/Catalog rows，不含 full payload。pending/current/failed/cancelled/withdrawn 与 LKG 分开检查；耐久数据用 snapshot/exportSource。 |
| Fixed dependency 保留 | asset owner retain/exportSource 捕获精确 GUID version、完整 sibling/ref；保留 delivered Pack、原 artifact bytes/programs/per-target executions/tool attachment；plugin sibling 需 prepared target coverage。temporary URL/load-only program entry 不证明 durable closure。 |
| Durable snapshot | runtime-pack-source/2 保留无损 plain JSON 和 little-endian binary table，含 typed-view path/shared-backing Base64。验证 kind/alignment/range/完整 table use，v1 明确失败。copyPackData 保留合法 typed-view offset/alias、排除无关 backing bytes，拒 accessor/function/sparse array/subclass/shared mutable storage。 |
| Recovery/effects | snapshot/exportSource 保留 source/program/accepted instance/reachable recipes；restore 在新 scope 重新准入，可重放 generator；Host 拥有实际存储。cancel fence publication/next recipe，不中断 JS，restore 逐 Pack 独立提交，consumer rebind/plugin install 分属其他 owner。 |
| 结构化失败 | 读 code/expected/hint/detail.cause。含 runtime-pack-invalid/conflict/dependency-unavailable/execution-failed/cancelled，保留证据，不能用 LKG 替代。 |

源码定位：packages/pack/src/pack-authoring.ts、program.ts，packages/import/src/runtime-pack.ts、runtime-pack-content.ts、runtime-pack-snapshot.ts，packages/app/src/runtime-packs.ts。固定 revision 详细契约：[Pack](https://github.com/ForgeAX/forgeax-engine/blob/df4c86bf12bf117ed229e2721e98d60ad1b0d7a0/packages/pack/README.md)、[Import](https://github.com/ForgeAX/forgeax-engine/blob/df4c86bf12bf117ed229e2721e98d60ad1b0d7a0/packages/import/README.md)、[App](https://github.com/ForgeAX/forgeax-engine/blob/df4c86bf12bf117ed229e2721e98d60ad1b0d7a0/packages/app/README.md)、[DevKit](https://github.com/ForgeAX/forgeax-engine/blob/df4c86bf12bf117ed229e2721e98d60ad1b0d7a0/packages/devkit/README.md)。

<a id="historical-palace-evidence"></a>

## 历史 Palace 证据

<details>
<summary>2026-09-15 Palace 快照的内容来源示例</summary>

Engine 2b613d2209e4335c2eab2c75ebaeb2eb269b2879，apps/showcase/palace。以下只是 source observations，不是完整已执行 Palace review，不证明当前 showcase 内容/API。构建及来源先读固定 [Palace README](https://github.com/ForgeAX/forgeax-engine/blob/2b613d2209e4335c2eab2c75ebaeb2eb269b2879/apps/showcase/palace/README.md)。

| 相对文件 | 证据 | 限制 |
|:--|:--|:--|
| assets/palace.pack.ts | 无公开参数；buildPalace() 组 mesh/material/scene，固定 seed 生 grain texture。 | 内部参数不是公开 generator，entry 单独缺 dependency closure。 |
| assets/architecture.ts | box/tube/column/rail/roof/hall 按尺寸/曲线/bay/建筑规则生成，buildPalace 是 fixed recipe。 | 也消费地图/预计算数据，仅读生成函数不验整包。 |
| assets/environment.pack.ts | analyticDaylight() 由方向/天空公式计算 Uint8Array pixels。 | 二进制结果不等于内嵌 prefab，静态阅读不证明消费/外观。 |
| assets/footprints.ts、waterways.ts | 地图轮廓/水路是输入数据，记录 source/delivery/policy。 | TS table 不是生成算法。 |
| assets/roof-partitions.ts、footprint-triangulations.ts | 预计算顶点/三角形/分区要追 generator/冷重建。 | comment/digest 不证明删后再生。 |
| tools/roof-authoring/generate.mjs | @matthewjacobson/str8、earcut 从 footprint 派生 partition；工具/依赖/输入属 rebuild closure。 | 有工具不证明正式 Pack 冷生产调用它，map 仍为数据。 |
| assets/caihua.png.meta.json | sidecar 指外部 forgeax-engine-assets/demo-assets/palace，README 另列 stone/plaque 输入。 | sidecar 不交付原图，快照并非无外部资产。 |

此历史整包严格策略下，已知 map/image 使 provenance 失败，建筑规则仍是有用程序化示例。允许辅助数据也要其余检查全过才 PASS。

| 交付情形 | 校准结论 |
|:--|:--|
| 固定 hall 配方、library 生 column/roof、有冷生产/消费证据 | 程序化资产，无需公开参数。 |
| 同 hall 有有效公开 width/bays/seed | G1–G7，完整 default 不改变分类。 |
| library decodeMesh 藏整模型 Base64 | C1 可过，P1/P2 失败。 |
| 规则/语义配方算数百万 pixels | 不因 TypedArray/输出大拒绝。 |
| 合法参数/build 的 values 只进 log | F1 可过，G3 失败。 |
| 参数选择/缩放 baked model | 有参数效果不证明 provenance。 |
| 依赖未交付 ./lib/roof.ts | 作者机器能跑也 C1 失败。 |
| 删 cache 正式 build 失败，私有脚本可重造 | C3 失败，cache 声明不免 P1。 |
| source/screenshots，无可用执行环境 | 只有静态局部结论；无已证失败时总体 BLOCKED，截图不证明冷生产。 |

</details>

## 结论与报告

| 总结论 | 条件 |
|:--|:--|
| PASS | required type 确认且匹配，所选数据策略下全部适用检查有执行证据通过。 |
| FAIL | 至少一个适用要求有证据未满足，仍保留其他证据缺口。 |
| BLOCKED | 尚无已证失败，但 type/dependency/关键执行证据缺失，说明缺什么、如何取得。 |

产出简洁 Markdown，无需额外 JSON：

```markdown
# ForgeAX 程序化资产审阅

- 对象 / revision / 交付范围：
- 要求类型 / 实际接口类型：
- 执行阶段 / 生产路径：
- 数据策略 / 已授权辅助输入：
- Engine / SDK / source revision / 实际 Host / realm / dev-build 环境：
- 总结论：PASS | FAIL | BLOCKED

## 检查结果

| ID | 状态 | 证据定位 / 命令与观察结果 | 问题 / 修正方向 |
|:--|:--|:--|:--|

## 来源与依赖

| Output | 生成规则 | 配方 / 原始数据 / cache | 交付与解析 |
|:--|:--|:--|:--|

## 执行证据与覆盖限制

- 冷生产 / 消费 / 重复；generator 对照和边界结果。
- runtime 正式 prepare/admit/generate、publication/current execution、冷 snapshot 恢复、withdraw/cleanup、适用平台证据。
- 未执行检查、未覆盖组合、辅助数据、结论范围。
```

格式、闭包、程序化来源、参数、runtime delivery 结论分别列出，局部通过不替代总体结论。source inspection 不证明冷生产、外观、合法输入覆盖、恢复；示例/Engine 测试不能替另一交付验收。
