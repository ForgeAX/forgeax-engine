# forgeax-engine-debug 中文参考

[English tool entry](SKILL.md)

供人阅读的简体中文版本。工具仍读取固定英文入口；下述门禁、错误码、命令与证据要求保持原契约。

Native GI 作业因共享 shader 准备耗尽执行窗口而取消时，在 GPU 作业前使用现有 Main core/point producer 准入。保留精确源码、compiler/profile/payload 验证、三份完整 roster 和原来的 30 分钟执行界限。显式手动诊断仍使用独立完整源码 producer。仅复用符合资格的早期成功；不得重新标记 artifact receipt，或把取消作业中已完成的前缀称为整个 owner 通过。参见[输入准入](../../scripts/ci/README.md#native-gi-shader-input-admission)。

Browser 在测试主体之前卡住，先区分 profile 准备和 GPU 执行。通过维护中的 Browser project 运行精确的 GPU-driven View 文件；native-WGSL owner 按 [CI 指南](../../scripts/ci/README.md)使用源码 publication 和空 Pack root。保留混合 roster 的依赖、原用例、deadline 和 60 帧断言。取消准备不等于测试通过。

native manifest 复用缓慢，先分析真实完整文本，再考虑增加 cache。保留有界逐块 ASCII/UTF-16 身份检查和完整 digest；对比 cold admission、实际复用和之后的原始对照，并测 retained heap 与 peak memory。生产调用只需一个 Renderer inspection domain 时只请求该字段，避免收集无关诊断。临时 publication 序列化后，不应跨消费者的异步渲染会话保留 producer 对象；验证真实 V8 生命周期和 peak RSS。完整 manifest 准入后才共享 lookup index；拒绝新替换不能破坏旧的已验证准入。offscreen surface image 和 error listener 随所属配置退役。

DevKit offscreen-target 的 CPU lifetime Focus 只需要 package output；native Modeling render owner 独立执行真实验证和像素检查。Shader 仅测试代码改变却触发两个源码 profile 重建，先检查 producer input key；从 key 排除测试，但保留可执行 compiler 输出、raw source、WASM 和 payload 验证。保留完整 native owner，对受影响 CI consumer 重新验收。

新增 Dawn 文件时扩展显式 discovery contract，不重写历史 timing receipt。计入源码拥有的 deadline reserve 或现有保守未测 forecast，保留所有实测 cohort，并对新增真实 native owner 完成验收。

Browser 在测试收集之前发生模块获取失败时，重试浏览器前先检查 Vite transform 错误。Windows OXC 可能错误解析自动 composite project references。规范的 Browser project 用 Vite 顶层 `tsconfig` 设置，为 transform 和 optimizer 固定共享编译选项；保留严格类型检查的 project references 及原运行时测试。

重复 Node transform 启动使用现有 child 共享的、以 source/config/lockfile 为键的文件系统 cache。fresh evaluation、mock 和 native lifetime 不变。发布前执行真实 cache invalidation/V8 counter 门禁；coverage adapter 关闭 Node bytecode cache，但保留 transform 复用。测量完整 instrumented owner 的 cold、warm 和后续 uncached 对照。

Three Dawn 输入族耗时长，调整 placement 前先数 native device request。同一串行不可变配置内复用一个 Renderer，cleanup 归文件；保留每条完整帧流和 fresh-device replay。边界拒绝用例仍用 fresh Renderer、保留空源码断言。隔离文件间不共享 device，不改 deadline。fixture lifetime 改动后，运行完整 Dawn roster Focus 和 native owner。守恒检查保留语义用例输入、deadline、oracle helper；历史 whole-body hash 不变，不能把分配样板当成验收或重写旧证据。

subdivision/sweep 的 CPU coverage Focus 只准备 package output，shader profile 与其 oracle 无关。候选 Modeling 集成使用原有有界 worker 准入，与 CI 资源策略一致。干净候选先构建 package，再让 digest fixture 导入两个 invariant owner；完整 suite 复用原 file-phase reporter。

Renderer 启动慢，先 profile 真实 Browser 工作，再改 prewarm 策略。publication metadata 在完整 structural interning 前无损合并 JSON row child；保留 signed zero、sparse array、optional value、非标准 prototype 的 fallback，以及全部 source digest 和严格 reflection 准入。在原 retained-heap 界限内验收两个完整 SDK profile；延迟整张表可能节省 CPU 却导致内存门禁失败。

checkout 长时间卡住，先从已完成日志识别精确 Git 操作，再判断 cleanup/disk。Git HTTP low-speed 限制必须在 checkout 前生效；所有 workflow（含 fixed-submodule composite 的 caller）保持相同五分钟 checkout 窗口。新增 input-admission job 的 producer-wait 不能替代该界限。保留 auth、TLS、完整历史、有界 retry。通过原 Primary 执行 native stalled-transfer/healthy-reconnection 回归，不能从总 fetch 时间推断未观察到的传输速率。

Project Play coverage 长尾保留七个 native Browser 用例：BASE 验收及 verified POINT 恢复后，在已有 View shard1 执行。Core 只去掉重复 V8 owner，full/Nightly 保留该 owner 和全部 coverage threshold。CI repair 复用前，source View0/1 执行必须包含真实新增步骤；两个完整 combined View owner 均在原 30 分钟窗口验收，再对改变的 coverage lane fresh 验收。

View/live Browser producer 被 kill，先关联 cgroup OOM delta 和 process tree，再归因 manifest fetch/transport。DevKit 默认 backend heap 为获准 host/container 内存的四分之一，build child 继承，显式 caller limit 保留。live-look fixture 在本地 unit/full coverage 共用原 exclusive Scene owner；daily primary 在原 prepared worker 无 instrumentation 执行三个 native Browser journey 各一次，core coverage 排除它们。移动 owner 仍保精确 roster、所有 oracle/timeout，不能连 native acceptance 一并删除。

大型 native fixture manifest 使用共享 owned sealed-byte publication，不在每个 Renderer 重复 decode 和 percent-encode 整份文档。保独立 device、所有 workload/falsifier，在所有 owner 结束后退役 URL。transport 优化不能验收先前卡住的 GPU frame。

CPU 性能用例超时，区分 ratio 断言与总 sampling 时间。用 performance Focus 的 ecs-ratios/render-ratios 复现 CI 完整 single-worker、无 instrumentation 的 project 和共享 CPU 诊断。daily visibility 只延后无关且无断言的 flat 诊断；两条各 101 sample、10k entity 的数据流、10% 界限、60 秒限制保留。full profile 保留 flat baseline；保留失败 sample，发布前验证整个 performance owner。

干净 ci-core 的 Content Water ENOENT，在 package JavaScript 构建前通过 prepare-assets-checkout.mjs 准备 pinned Assets。Content lifecycle 验证原 digest，public SDK source 使用 sealed resource closure；不能豁免 binary gate 或替换缺失源码字节。

本地共享 Assets checkout 使用 `--assets-source-root <exact-pin-export>` 恢复 Focus：验证 gitlink 导出的 Water blob，再传 Content 显式 source directory，保留共享 dirty 文件和普通 semantic package cache。

no-View verifier 的临时源码来自 tracked-file copy，不含 prepared binary。选择 public source mode 前保留 SDK_RESOURCE_ALLOWLIST，在 sealed closure 验 Water provenance；私有 Assets/View 仍缺席，原 Engine build/API probe 保留。

no-View source 在 POINT 生产后取消，保留临时 package/compiler 重建和 POINT source producer。向原 Engine build 传 prepared BASE 的 `--base-shader-input-root`，以及真实 HEAD 的 `--source-revision`。core restore 先比较 revision、rebuilt compiler/source/profile fingerprint、path-bound payload digest，只复制 BASE receipt/payload；任何 mismatch 都拒绝。普通 SDK source verifier 仍执行独立 cold build。

源码编译 coverage OOM 使用 split runner 现有 exclusive source owner、capacity-derived producer heap 和一个真实 Vitest file worker。先预留 heap，再按 cold producer budget 接纳 compiler worker：默认至多四个，还受 CPU/剩余内存限制，保留 caller limit。Coverage Focus 同策略，createVitest adapter 必须把 CLI worker limit 传入 resolved project config。普通 child heap、完整 variant、原 timeout/aggregate threshold 不变；资源控制回归不能替代原 Linux 编译。

published manifest 的 Null-RHI 准入在 V8 coverage 超时，先查 metadata decoding/sharing 和 concurrent child，再改 runtime/case bound。完整 GTAO structural case 使用原 exclusive CPU contract batch、原30秒 deadline，保前三文件 timing identity、新 reserve、全部原断言；partial selection 不可继承完整 receipt。成员改变后，所有 affected coverage producer 和 strict aggregate 重新执行。

大型 diagnostic manifest 只在原 evidence 路径序列化，保真实 manifest/deadline。partial daily timing cohort 明确 profile，core-only observation 不可定 full/Nightly roster 成本。保留 failed/unstarted reservation、全部历史 replay bound，四 producer 与 strict aggregate fresh 验收。

full-atmosphere WebGL2 parity 失败，在 Browser failure upload 保留 artifacts/ci-focus/atmosphere-full/。WebGPU reference 先执行；dispose 后截图不能识别失败后端或保留 replay input。改 shader 前检查 capability、startup/warm RHI tape，GPU stage、scene、case、pixel、frame 界限不变。

direct-DFG cold-source 超时，先比完整 Engine manifest roster 和 compiler throughput，再判断 deadline 回归。相关测试共用 SHADER_MANIFEST_TEST_TIMEOUT_MS=900 秒；旧300秒不覆盖扩大后的源码 roster。原文此处要求三个独立 cold build、断言/source 准入；后文当前去重所有权规定优先。预算修正不等于实测速率提升。

历史 shard0 总 job bound50分钟，其他45分钟；独立 conditional budget 检查不保证修正 worker 后必然完成。执行目标约30分钟；晚 source admission 仍可不足，须报告该边界，用完整 child cost 做 placement。当前 Water 通过原 exclusive-group 机制将串行 Vite source child 分为 unit/public/resampling、Surface、direct-DFG 三 owner，650/530/530秒 reservation 都是 forecast。五文件恰一次，保四 shard 完整 merge 和历史 roster identity；changed lane/aggregate fresh。不以 prepared profile 替 cold，不改 case deadline。

移动 ordinary coverage child 时，比较实测 file-worker policy 与目标 lane request。当前 Render half2 receipt 用两个 admitted worker，四 shard 都请求两个；CPU/memory cap 和 exclusive source policy 仍权威。纯资源修复保持成员稳定、保原成功 artifact，按正常资格决定复用；旧较快 child 不证修复后的完整 lane wall time。

## 每日 CI 工作量与磁盘

CI 缓慢或不稳定时，先看已完成步骤、cgroup 和磁盘，再改预算。干净 SDK seed 缺 Node 工具，先核实 locked install 在 source guard 前执行；不能依赖 persistent node_modules 或删除 guard。Browser/Dawn/Coverage core 使用经过审查的 core-validation-deferred.json；full 保留全部 owner。core 的 RHI、completed-frame、像素门禁不变，coverage 保全部 project/threshold，consumer 仅移除冗余准备。默认 shell 尽早禁用 native core dump，保普通诊断，queue/execution 分开报告。参见[运行指南](../../scripts/ci/README.md#core-validation-cost-and-crash-output)。

减少冗余用例时，同步 local/PR/Nightly 共用 owner matrix，保留代表性 backend/threshold，并验证 native 数量。历史 case time 不能证明真实 critical-path 节省。参见[矩阵](../../scripts/ci/README.md#reduced-test-matrices)。43781598349 的 coverage1 cold resampling pending 超时：ordinary DevKit/Vite Pack 使用原有界双 worker；partition、exclusive、timeout、sibling artifact 不变。用实际 worker 运行完整 owner，本地结果不能替代失败 Linux shard 或 strict merge。

Core App producer 使用产物契约声明的 Smoke root。新增 App 构建前，先确定消费其输出的 shader、Pack 或 preview。必需 inventory 检查和 Browser 合并独立于 Smoke 执行。Vite transport 和 DFG coverage 测试消费已准入的 BASE profile，Core 负责冷编译；full-profile 与独立源码检查保留独立编译路径。SDK CI 修复时，检查每份回执记录的 archive profile；无法确认有效的扩展范围前序运行时，扩展范围必须重新执行。参见[按消费者划分的 PR 必需工作](../../scripts/ci/README.md#required-pr-work-by-consumer)。

<a id="pr-ci-repair-workflow"></a>
## PR CI 修复流程

普通 Dawn SIGKILL 必须关联原 job 与 cgroup OOM counter delta。原有界 module-phase reporter 虽沿用 Modeling 历史名称，但观察公共 Vitest lifecycle，并不限 Modeling。保留 ordinary fork 和 case 界限。仅凭 signal、生命周期内存峰值或未完成文件不能定位泄漏；修复资格仍取决于 fresh native 执行。

Three Surface expression 与 ordinary 工作并行而超过 native case budget 时，使用既有双 slot Dawn owner；保完整 cook、60 帧、texture、rebind、replay 和原120秒界限，四 Dawn lane fresh 验收。Browser 对应 group 在同 process 内排空相邻 GPU 工作，保 paired file、capture、deadline、60帧；exclusive admission 改变会影响 placement，因此四 Browser lane 也 fresh。Direct Surface shadow/consumed-resource coverage 超时保两个原 exclusive child、真实 cook 和 case deadline，使用有界 compiler 与 package-only 准备。Standard/Skin cold-cook 保完整四 root 文件、全部 variant/artifact 断言、原15秒用例界限；原 exclusive source-contract batch 单 file worker、至多四 compiler worker。历史三文件 receipt 不变；当前五文件 forecast155秒含独立新增60秒 reserve。发布前验证完整 scheduler 与实际 instrumented cold cook，最终四 coverage shard/aggregate fresh。

internal lint 报 EISDIR，先检查 filesystem entry type；snapshot directory 可用 .ts 结尾，discovery 只接纳文件，但仍访问目录内真实 TypeScript 子文件。cold path-tracer timeout 保真实 material cook、wire roundtrip、完整 loader admission 和原 case deadline。九材质 fixture 只有 emission 需要第二份完整 serialized publication，其余 selected program 保真实 cooked bytes，省无用 return copy；GPU/raster bridge consumer 仍收到完整 publication。GBuffer-v2 AO falsifier 改 packed normal 中的 AO，不改 reflectance alpha；保真实 normal/validity/roughness、零值/部分 AO、direct/emission 不变、fresh replay 和原 pixel tolerance。

SDK/compatibility compiler fingerprint 不符，比较真实 Core WASM/glue provenance 与独立重建 consumer。相同 Rust source key 不证明 compiler bytes 相同。在 profile admission 前经共享 verified publisher 接纳精确 Core compiler；compatibility 用 --prepare-compiler，SDK/Native download 在 admission 前准备。保 source SHA/provenance、rebuilt JavaScript、完整 profile/payload 验证，更新 paired raw browser glue，保 stale-source/corrupt-byte falsifier。native source publication 修复不破坏 compiled Core 旁 template manifest：验证其 library，不强制 compiled delta；真实 delta 保 reflection binding/nested entry read。isolated development host 仅接纳 literal module-relative resource（包括 compiler provenance/raw glue），保目录隔离/byte check。pending display 旁 cube progress 要区分 encoded face 与 sibling presentation readiness，仅 matching target/generation encoding 和 accepted fence 推进 face。44024988647 后既有 exclusive Render cold-producer child 保 stock/Skin/scene-data/planar/retained-GI 全文件、原 case bound、immutable timing、新 reserve。

未测新 Dawn 文件在 fileReserves 登记 conservative forecast，纳入精确 core discovery，不改历史 receipt；完整 Linux evidence 前保最大文件 fallback，本地 native pass 只证明 correctness。发布前 Node Focus 验 roster/placement，保四条 final-head Dawn lane。减少 Browser device/case 数时同步 workload budget，通过 ci:focus --kind node --select scripts/ci/__tests__/browser-work.test.mjs 双向验证，再由真实 Browser 确认数量。DevKit project-session coverage 在两个短寿命 Vite server 执行真实 lifecycle plugin；保 delay/replacement/stale-owner close，Browser journey 仍准备完整 shader/Pack。

artifact restore 卡住时，检查 body progress 与外层 transfer deadline。accelerated restore 的25秒 idle retry 保持在原120秒 wall bound 内，exact product SHA/digest 不变；普通下载保自己的 body-idle 策略。其他 ID/digest 和 semantic GPU gate 均不可绕过。checkout git clean 遇 inaccessible dependency shim，只在 checkout 前、runner temporary directory 内，用 noninteractive sudo 清当前 workspace 的 node_modules；后续 install 无法修复更早的 checkout 失败。通过 setup-node-pnpm Node Focus 验真实 shell 的 path/symlink boundary，成功 sibling 按显式声明复用。

denseWatershed 超过五秒时，先找岸线创作中的重复工作。单个 Pack 内可以复用不可变的边系数，用准确最近距离排除不可能的候选；不同变体和坡度计算共享不变量高度，使用准确数值键和独立变体偏移。验证每个采样高度、完整 Pack digest 及完整的插桩 Water 子任务，不做舍入、降低精度或延长时限。DOM toggle 销毁时，先通过所属清理路径注销 section/document 监听，再关闭执行环境。Water CPU 单元与 coverage Focus 按 roster 仅准备 package；R4/R5 船体测试由唯一的组合 owner `@forgeax/water-r5-gpu-mesh-async-pontoons` 负责，不预编译无用的 fleet。保留原始准备失败与消费者 Engine 前置条件；公共 runner 改动后重新执行受影响分片。

针对运行 44023395616 的 Dawn 超时，保留 core 普通与原生执行的完整回执，以及未完成 GI 的成本预测。单次遍历的 sequencer 调整回填顺序时，交换完整的 DirectLightGI6 与 Surface owner，并保留 Modeling 首次启动预留。四条 lane、原生生命周期和原有界限不变；Node 与 Dawn 都需重新验证。Three compatibility 变基时，保留 split-node 输入用例的确定性折叠与展开，不按历史布局拟合。ShaderCompiler/Modeling 单元与类型检查仅准备 package；源码 coverage 保留当前前置条件。AudioWorker 的冷依赖优化发生在页面导入之前，保留立体声与超时判定。

保留 Shell 刷新失败的首个终态；`pagehide` 先断开连接，立即撤销正在退役调用方的结果准入，只让独立认证的替代实例发布 ready。还需复现 `pagehide` 发生时 preview close 已在执行的情况：旧执行环境断开传输不得破坏替代实例，原生清理失败与超时必须可见。实际移除 owner 后，手动推进 watch interval，等待下次计划检查，再启动宽限计时；旧的在途计数不能证明所有权已清空。保留磁盘锁与进程身份，空观察者的 backend root 与 game 分开。退役后 `projectTarget=null`，旧 ID 留在 `projectStatus.target`；嵌入 fixture 等待文档发布及 Engine marker 后再读取 target，root broker 没有浏览器时也要转发 Engine 状态。View 重启保留 backend、退役 frontend lease；同根目录恢复准确的丢失会话，不复用失败 target 或重播非丢失错误，仍需新 target 与真实帧。

隐藏 iframe 的 probe 使用 Shell 时钟；保留 World 与 stopped submission，因为隐藏页面没有 rAF。原生内容导出保留一个 `latestBlobURL`，直到替换或销毁；在 Chromium 验证延迟下载、清理及 SDK 持久化和重新打开。先等 Save 可用，再启动原生操作时限，同时观察点击和下载；通过真实按钮验证 inspection 的保留时间超过下载预算。同文档嵌入复用现有 Engine presentation，第二个 Frame 会替换 live Host socket；仍需验证 preview、Play、capture 以及 Linux X11 的真实可见性。资源子订阅滞后时，只取消已退役的 preview lease，串行处理退役与新 placement；读取旧 target 的撤销状态时保留新请求。Pack reveal 与页面列表使用同一 Shell owner 集合，排除嵌入别名；保留 owner 的失败/通过回归及 texture authoring、Modeling 的完整浏览器验收。checkpoint 错误必须在原时限前出现，preview 失败必须导致 journey 失败。缺少 Dawn addon 会阻塞原生图像验收，WebGPU 不能替代。View 单元测试包含相邻和 `src/__tests__` 目录，须确认 CI 的实际发现范围。查询失败 target 时，不能用路由不匹配掩盖 Renderer 错误；保留基于 session document/target ID 的分发，`liveTarget` 仍为空并拒绝外部 target，原始失败归所属会话。

View/SDK 定位器失败时，先查看失败截图和文档 URL。Next/plain Shell 中只有一个 Engine iframe：等 marker 后在该 Frame 内查询 Renderer 全局对象和资源 canvas，Shell 控件仍在父页面；保留像素、捕获、帧数和刷新断言。规范化 URL，将 project 放入 JSON 输入，不与 flag 混合；CLI adopt 保留 root/target，不要求 entry URL。SDK 的真实 project document helper 必须打包，并验证安装后的冷导入。固定 MCP 使用 binding heartbeat，Codex 迁移归路由模块负责。无 project 的诊断页不自动打开 chooser；fixture 按所属模块发布状态和文档，不能省略字段来绕过捕获或产物要求。参见[配对修复](../../scripts/ci/README.md#paired-view-capability-repairs)。

cold BASE 在 standard pool 卡住时，使用已有且容量经过验证的 heavy `ci-core` 执行 package JavaScript 与两个 profile；shared app input 只在 standard pool 转交输出，不再次 checkout、安装或启动 compiler。保留 heavy count 28、独立 profile key、源码 payload 与上传。resolver 显式区分 BASE/POINT，不能由 execution ID 选择 profile。CI 工具修改发布前执行 Core 的复杂度、文件大小和 Focus 检查；stable WebKit 在修复资格检查之后、昂贵准备之前要求 Core ID，legacy reference 独立保留。合并 producer 后，pin、Codec 和 heap 绑定实际执行，退役旧的第二份闭包；离线安装器使用根 pin。SDK 准入要求实际 Core 执行及成功上传，消费者重试保留 attempt；廉价投影不能冒充源码生产，也不能擦除历史冷启动成本。

SDK POINT 或 stable WebKit BASE 的独立重建身份不符时，先从同一 Core archive 恢复准确 compiler/glue，再构建普通源码 JavaScript。相同源码可能生成不同字节；保留验证和 legacy reference。workflow 改动需运行完整的 shader profile producer 契约，保留准确交接、悬空 cache ID 拒绝，以及 producer、source、GPU 的顺序。shared recovery 发生 OOM 时，在加载 compiler plugin 前完成预算准入；调用方移除固定 heap，仍保留预留容量与四 worker 上限，投影保持轻量。保留原 OOM；失败时没有诊断内容可跳过，成功时必须有完整 roster。

metrics 慢分 setup/producer，disabledunbudgetedsoftwareFPS 不装第二 browser；sandboxpath/LOD-GPUassert/60frame 保。Coretransfer 缺先看 sharedartifactverifiedBASEcompanion，非 POINT/松 fingerprint/加 transfer。noViewsource 也 admit 同 BASE 跨 sourceprojection，parentrevision/rebuilt compiler/payload 保，不 copyparentJS/造 receipt；CoreRestore+noViewcontract 及 realLinux verifier，budget 改还跑 Primarytypedexecution/lifecycle 非仅 Node。

coverage 恢复加速后仍超时，要比较完整子任务以及并行与独占阶段。只有完整执行才能写入 replay ledger；中断和未启动任务保留预测，旧窗口不变，在原四个 job 内平衡。验证完整 placement 契约，并重新执行四条 lane。Dawn cache 以 source/config/lockfile 为键共享 transform，原生生命周期保持独立；通过真实契约验证相同大小/时间戳下的失效，并运行完整像素 owner，受影响 Dawn 检查重新执行。修改 timing ledger 发布前，运行包含新 JSON 的真实 Core `pnpm run lint`，仅检查指定源码文件会漏掉 JSON。保留解析后的测量与来源；规范化 hash 可忽略空白，原始日志 digest 不变。

Dawn 普遍慢比 CPUmodel/native binary/driver/pressure+quota，label/count 非 throughput，affinity 可能 topology 不是 bindingdefect；慢 CPUclass 需 qualify。daily 配对仅 measured1slot 在原2worker、每 child≤4rasterthread，unknown/large2slot；初 reserve 后先 longforecast 回填，membership/history 不变，fresh process/GPUdrain 后 ordinary，fullserial。matchedwholeowner+containerpeak、changed fresh，serialhistoryforecast 非 pairedacceptance，不扩 bound。dailyplacement 用 complete same profile cost、守恒2slot/native wall time、保大历史/earlyreserve；完整 roster/replay 再4fresh。

missingdeclarationpreflight 看 JS 是否 clear dist/bundleentrydecl；共 tsup：tsc 全 declaration，JS 保留成功后仅 pruneobsoleteJS，不在 preflight 掩缺/加 timeout。actualconfig 复现丢、保留及 cachehit。Naga/compiler unit/type/6exactpublicationregistryJSON/runtime-publication.unit Focuspackageonly（rawWASM 不需 profile），source-row-transaction/nativeNode 保；fullShader/realconsumer 仍 Engine。compile 贵仅 exactsource 的 definition-independentNagaimportIR 复用 registrationprefix，changed suffix 重建保留 contiguousspan，不填 hole 替，optionconflict/fresh entry/autobinding/conditionalfallback 保。compose→reflection 重复 parse 仅 exactWGSLcheckedwriterownedIR 转交，portable normalize 后独立 reparse/validate/fullbufferABI；boundedoneshotwitness，changed fresh，publicphase/opaqueowner/renderentry/reflection 保。

TSRfixture 共享与 temporalscale 独立的8xrasterreference，其 history/frame/motionstop/capture/pixel 保；inputtimeDevKit 真实 Unlitbox/browser 不无关 lights，改后实际 native Browser。unbudgeted12Waterappsize 诊断已 manifest 明确退，不为 missinginformational 重 build；packagesize/threshold/appacceptance 保。standalonecoldsourceFocus 同 capacitypreflight、heap headroom/4cap/小 explicit/原 deadline，留2worker889.57样本，新 default 完整 owner 验证非扩900。

44046829101 coldglTF transmissionphysical、importedScriptableStandard、materialcook/GBuffer/static switch/pool 文件进原 Compiler/Packexclusive、历史 label 保/selfproducepackageonly；glTF 原 serialpublication 不新 coldchild，所有 case/portable/instrument/30-60-90-120s 保，4coverage+aggregate fresh。coldcoverageFocus 从 canonicalgroup 明确 prereq，DFG/Surface 自己产不先 unusedBASEPOINT，其余 Engine；instrumentbudget/test 保，cancelprepare 非 accept。

重复 identicalcoldEngine 现统一断言到原 DFGcoldowner：ClusterABI/resampling/DFGfitLUT 共一 freshfullsource，真实 Vite 独立 cold；此当前所有权优先前述3次重复处方。variant/timeout/threshold/history 保、changedownerfresh。nativepointsmoke 缺 profile 后 OOM 用 shared manifest ensureShaderManifestProfile 原 verifiedboundedproducer，DeepAgent/GI/LearnRender 在 roster/metrics/directroute 共，framepixelshadow/smokelimit 保，不依 shardnum。

> [!IMPORTANT]
> Dawn placement 当前 conservativeweight/completeownerreserve+deterministicsequencer 优先后文旧 replay-window 处方。历史证据/integrity 保，layoutfitting 退役。所有 runtime assertion/case-processdeadline/4lane 不变。

planar 两完整 carrier 进原 serialSurface，60frame/clipmulti/replay/deadline/4lane 保，failureupload 含 artifacts/planar-reflection/dawn/。reuse coverage-artifact-unqualified/missingmetrics 先查 artifactavailability；successfulCore/shared/4Coverage/closedmetrics 留到 producerexpiry，不能立删。shareddeleteowner 用于 normalcleanup/defaultbranchbackstop；largeapptransportcleanup/originalretry/failed capture 保，missingsource 按 expiry，backstop 正常 merge 后 deploy。

修复历史查询失败时，保留原始运行、作业与产物集合。共享客户端对临时失败进行有界重试，成功历史只在本次调用内缓存，返回安全错误码。认证失败、历史缺失或重试耗尽时正常重新执行；如果已经继承 metrics，则明确失败，防止混用证据，不放松资格条件。私有 Git 使用 `persist-credentials: false` 时，源码准备器仅在子进程环境保留 `GH_TOKEN`/`GITHUB_TOKEN`。只有 HTTPS GitHub 且没有匹配认证 header 时才回退；保留优先级、header 重置、pin 和干净检出回归，不持久化 token。

Host authoring coverage 超过十五秒时，先检查真实用例、已准入 publication 和 workspace timing。区分私有已解析 JSON 与公共借用数据，保留严格的即时 reflection、reference 和 digest 验证；测量完整冷启动与内存峰值，不能仅测 helper。独占源码任务超时时，比较已完成 program、lowering/compile 阶段以及进程 CPU/heap。`FORGEAX_SHADER_COMPILE_DIAGNOSTICS=1` 只提供有界构建遥测，不能视为通过。保留全部 family、variant、独立冷 producer 与原时限；四 worker 都繁忙不能证明队列挂起。

Modeling 用例失败却没有捕获时，在 Engine 的 Dawn 测试中通过 `FORGEAX_DAWN_CAPTURE_TEST` 选择准确路径。使用官方 recorder，为实际构造器和现有的四参数就绪帧辅助函数添加捕获。不要修改固定的源码子模块，也不要更换设备。保留原始错误、提交以及准备和完成阶段的时限；无法捕获时明确报告。用其他代表性管线得到的结果，不能替代原设备、描述符或首次绘制的验收。

morph Surface SSR 准备失败时，在发生失败的就绪等待之前，捕获原始首次 SSR 提交及其原生回执。保留准备结果与管线检查，不等待另一个信号，也不绘制恢复帧。失败后生成的 tape 不能证明原来待完成的帧通过；阶段、用例、帧数和像素界限保持不变。

如果原始回执将问题定位到 SSR trace PSO 编译，就分析该准确编译配置。将切平面校验移到粗步进之外时，仍须保留单一计数器、候选顺序、恢复状态和细化覆盖；用完整网格和蒙皮回放比较，保留 64/1024 上限及原 GPU 时限。着色器字节比较或删减功能的实验不能替代这些验收。

cold first use 在 pixels 过后超时保留 tape、分 processstartup/native first use/hot replay/cleanup，原 device/scene/deadline；hot 不 qualifycold，sourceablation 不 qualify 原，lightingspecialization 按 acceptedView/publishedvariant/fullnativecacheidentity。Outline 保留 artifacts/outline/dawn/经原 lightingAOGIupload，先 initialframe/demand 再 shader；历史 upload 缺是 missing，不改 pixel/ready/replay。VFXlimit16保留 live receipt/Renderer 和 artifacts/ci-focus/vfx-mesh-lighting/limit16/original-operation.rhitape，construction 前 emptyregistry 开 capture（250ms snapshot/64MiB），原 draw 结束、不等 failedGPU/再画，capturefail 显式、gates 保。visibilityratio timeout 保完整 profile/101sample/population/ratio/60秒，经 CPUaffinity 完整 suite、pressureinterval 先归因，本地非 Linuxfinal。

lintinternal2GiBOOM 保留 Primary4GiB/full scan/rule/diag。sdkseed yaml cleanresolve 复现，pinnedpnpm/npm+frozen install 在完整 acceptance 前一次，parser/export/provenance/deadline 不变，warmlocal 非 bootstrap。

PR 创建后，每次后续更新都必须采用此流程。初始 CI 运行建立基线；每次后续推送通过 `CI-Repair-From` 声明，复用同一 PR 中符合资格的成功检查。变更的类型、目的和大小都不构成豁免，也不需要用户额外授权维护这项声明。不能复用的检查在该流程中重新执行，不能因此删除声明。

| 时机 | 必需动作 |
|:--|:--|
| 诊断 | 读取 PR 当前提交、CI 运行及作业。独立作业继续执行期间，可复现已经结束的失败，并保留结果。 |
| 准备 | 最终候选通过相关本地 `pnpm ci:focus` 检查。等待当前 CI 运行结束后再推送；以同一 PR 上前一次已完成的运行为基线，即使其总体结果失败。尚无 CI 运行时，先建立初始运行。 |
| 推送前 | 保留 PR 正文，恰好设置一个 `CI-Repair-From:` 行，值为基线运行 ID 或 URL。将需要重新执行的检查列入 `CI-Repair-Rerun:`，读回正文后再推送。遵循[声明和产物契约](../../scripts/ci/README.md#explicit-pr-ci-repair-success-reuse)。 |
| 观察 | 核对新运行对应最终 PR 提交，检查 `[ci-repair-reused]` 步骤和资格摘要。分别记录继承结果的原始运行、作业、源码 SHA，以及重新执行的结果。检查为绿色本身不能证明复用有效。 |
| 无法复用 | 检查资格拒绝原因；在下次推送前修正声明或基线，并报告缺失的历史或产物。保留符合资格的成功结果，让其他检查按契约重新执行。 |
| 资格验收 | 最终提交通过完整的新执行或合格继承，取得受保护审查后正常合并。下次更新前，将基线推进至本次已完成的运行。 |

Coverage core 保留 Modeling 内核测试、标称 S6，以及代表性的运动和网格发布集成测试。CI 运行指南列出移出的示例及其保留用例。产出和合并使用同一 profile。现有四个 job 跑 12 个 Modeling 分区，full profile 跑 16 个。成员变化后重新验证四个 Coverage 分片，旧分区耗时仅供原清单回放。

运行 43802933357 的不同失败分别交给对应 owner：SDK source-export guard 之前执行已有的锁定安装；冷 authoring publication 使用已有独占 coverage 准入；portable VFX core carrier 将冗余点阴影方向交给 unrestricted carrier，保留纹理限制、超时、IBL、深度和回放断言。kernel 与 WebGL loss owner 在原 batch 内排空 GPU 邻居。新增 Browser 文件留下尾部单文件组时，在原 batch 数量和成本界限内调整，保留完整发现、独占 runner 准入和 planner 回归。morph 的四个 backend/skin 用例继续使用已有单文件独占组，保留十五秒准备限制。混合 native/Three 阴影就绪问题用新进程运行 interop 文件并排空 GPU 邻居，保留二十秒界限、60 个完成帧及原生捕获、像素和回放检查。Renderer/Host optimizer HTTP fixture 区分回环传输错误、非 200 Vite 响应与优化依赖字节变化。Modeling 面板截图已经验证真实高亮；没有新增判定依据时，无需重复 CLI 截图。将终止归因到 GPU 或 shader 之前，记录阶段信号与 cgroup OOM 增量。

View 能力的任务分配变化后，重新执行全部四个 `view-integration-N` 检查，保留完整命令集合、实时与冷启动链路、三十分钟 job 上限和历史准备预留。父任务超时后，只记录完整 owner 的测量；重新平衡时保留未完成 owner 及其历史预测。已取消父任务中的冷构建阶段完成，不代表父任务通过；新的有界 compiler 策略和剩余浏览器 owner 都需要新的运行时证据。共享 shader 只有在当前 inventory 与 payload 字节通过所属验证后，才能复用存活的不可变事实；release 不得保留进程全局图。

最终提交允许继承合格证据，不要求所有检查重跑。文件类别或运行时改动本身不能成为删除声明的理由。失败、取消、缺失、新增检查以及必需产物依赖，按指南中的执行与历史恢复规则处理。必需的 `ci-repair-policy` 状态由现有 `ci-core` 执行发布，保留 GitHub Actions 身份和限定的状态写权限；缺少该状态的旧 workflow 成功不能取得合并资格。在昂贵准备前检查声明，缺失、无效、过期声明或无法取得历史都会使 Core 失败并阻止正常合并；只有 PR 初始版本可以省略。同提交重试和重新打开 PR 保留原基线，不新增 job 或矩阵 lane。策略检查失败仍通过本流程修复，不删除声明强制完整 CI。workflow 读取触发事件中的 PR 正文，启动后修改正文不会追溯影响该次运行。

no-View 源码验证器也消费配对 View CI 的普通 BASE 回执 `shared-build-inputs-release/base-ssao`。缺少 Core/shared transfer 不代表没有 BASE publication；先检查该 producer 位置，在投影前验证准确 revision、重建 compiler、profile 与 payload。

声明的已完成手动运行为锚点时，只有在修复 owner 验证仓库、分支以及独立的 commit-to-PR 关联之后，才能提供先前成功结果。配套 workflow 必须使用同一原始提交，保留实际手动运行、作业和源码来源；缺少证据时正常执行检查。当前修复 workflow 本身仍由 PR 事件运行；私有仓库调用 job 需要 `actions: read`、`contents: read` 和 `pull-requests: read`，以完成独立关联验证。

与 Engine PR 同时引入 View 能力时，在 View 推送前声明完整的 `Engine-Revision`。View CI context 选择该配对 Engine 源码；修复声明保留合格的 architecture 成功，失败或缺失的 build/browser consumer 重新执行。保留准确配对产物及真实 GPU/View 验收，参见 CI 指南。

部分 coverage 修复保留已通过分片，通过共享修复产物 owner 恢复原始产物。分片准入将覆盖源码和 compiler 输入与通过 digest 验证的原始 coverage map、原执行 SHA 比较。输入变化或证据缺失时，在写入复用标记前选择正常新执行。保留合并的严格验证、每个原始产物与源码 hash、准确完整分组以及全部阈值。不改写旧产物 SHA，不将中断子任务当作完成证据。历史 placement 测试回放原 project/file roster 与成本，当前 CI 发现仍包含新增输入；保留原预算断言，区分预测与完整执行。

SDK CI 修复保留每个合格成功 consumer，即使其他 consumer 失败。合并任务按原 run/job/source 身份获取和验证产物，并纳入新执行的失败项；来源缺失或矛盾仍判失败。正常 SDK/发布验收仍要求完整的同源码字节集合，不能把继承回执改成当前 SHA 或 SDK 版本。

仅重试失败作业后，shader 准入通过完整 job 历史及准确开始/结束时间，将复制的成功 producer 映射回原执行。保留原 attempt 的产物名、job ID、source SHA 和 digest。历史缺失、含糊或新执行没有自己的产物仍判失败；不能重跑已通过 producer 或重新标记旧产物来修复准入。

coverage 超时且无断言失败时，比较 affinity owner 压力采样的区间增量。其显式 coverage 命令保留原始 host CPU 与 cgroup CPU 使用数据；其他调用通过 `FORGEAX_CI_CPU_TIME_DIAGNOSTICS=1` 启用。host steal tick、cgroup usage 纳秒和 throttle 时间的单位分别处理，不能从累计峰值或生命周期事件计数推断新 OOM。诊断期间保留合格成功检查、原分组和时限。只有一个 coverage 分片失败时，仅强制该分片重新执行；不要声明合并 consumer 为 fresh，因为那会重建所有 provider。失败的合并任务正常执行并恢复合格 sibling 产物。

所选模板启动超时，保留该页面的启动检查和回执元数据。daemon 私有浏览器不能提供 tape 时，明确报告附件缺失；启动与 gameplay 时限不变。MCP replacement Preview 超时，使用当前 target 的 backend timing 和原重启里程碑，包含两份 cleanup snapshot 的 Pack commit 时间。迟到的 URL 发布不能算在原 iframe 时限内通过。启动失败后，在最终销毁前交回当前 page/browser 和原始错误；页面仍可访问时记录诊断，再通过调用方单一 owner，独立尝试清理每项资源。

View restore 卡在 authored Pack 生产时，使用已有 `FORGEAX_WORKSPACE_TIMING=1` backend 记录。按进程单调时间 `atMs`、source key 和 GUID 关联源码工作列表阶段与原生发现/cook recipe，区分阶段准入等待和实际 recipe 耗时，保留结构化失败及有开始无结束的记录。这些诊断不能证明 cache 复用、ready generation 或原 View 验收时限通过。共享临时项目 reducer 还要访问嵌套 Pack，将声明的程序化纹理分辨率限制到受支持的 512 方形最低值。保留完整 Modeling job、输出身份、几何、骨架和动画，不修改已创作模板的默认值或删掉材质来通过启动；以原时限验收完整 View 与 SDK consumer。

IBL 准备期间出现 `directional-shadow-candidate-failed`，比较已结束尝试的队列准入与 `sceneSubmitted`。已接纳的准备工作没有当前阴影像素证据，不能因此制造 candidate 错误；录制、提交失败和非法灯光配置仍属于错误。复现完整 `image-environment-presentation.browser.test.ts`，保留真实完成 fence、像素断言与时限。

Modeling Show 准备失败时，读取现有 Dawn failure upload 的 `artifacts/modeling-show/dawn/` 下的原失败帧、`preparation-events.jsonl` 和最终结果。区分已接纳但仍待完成的原生 PSO 与缺失的准备请求；销毁阶段结束不能证明原帧或像素通过。保留九十秒就绪、十五秒准备和 60 帧断言。live-sync smoke 在 ready 后仍是平坦画布，而断言要求实际渲染像素时，使用 `dev verify`；`dev capture` 有意观察包含准备阶段的当前 surface。保留最终 revision、UI 文案、像素、恢复断言与已有捕获时限。

任务分配改变检查成员时，推送前将所有受影响的成功检查列入 `CI-Repair-Rerun`；这些检查重新执行，无关成功保留原证据。执行时限与文件 roster 不变。Dawn 发现或任务分配变化时，使用完整 Linux 回执，重新执行四条原生 lane。固定原生尾任务本身已超过 lane 回放窗口时，先重新分配完整 owner，再回填普通工作。历史行保留实测 roster 和显式预留，后续新增发现继续使用当前保守容量；中断工作不能计入测量。运行完整 Dawn roster Node owner，新执行受影响 Primary 契约与四条 Dawn lane。历史样本的 source/worker 身份不变。参见 [Dawn 门禁](../../scripts/ci/README.md#dawn-gates)。

添加复用后，workflow 契约断言要包含相应 guard，同时保留 lane、前置顺序与失败证据要求。跨仓库 Modeling candidate workflow 只对 Vitest suite 分片，命令为 `test:modeling -- --candidate --modeling-shard=<index>/4`；四个 job 各自保留 Engine/Modeling 构建、类型、消费者与准入检查。各 job 独立，复用按展开后的检查名和实际检出的 Modeling head SHA 验证。

显式要求 coverage 或 smoke 合并任务重新执行时，即使基线全绿，也必须重新执行每个 producer。产物数量必须准确，不能在新合并中混入没有当前产物的继承 producer。coverage 历史在执行前被阻塞时，将当前产物恢复步骤纳入未运行步骤 guard：存在时须唯一且 skipped；保留没有该步骤的旧记录，拒绝已执行恢复的记录。按当前 workflow 派生步骤 roster 验证完整复用 owner。不得绕过合并保护或禁用 ruleset。独立 Linux 主机不是发布前提，必需 Linux 执行仍在 PR CI，取消和失败尝试保留在证据中。

artifact-runtime preflight 失败时，保留 upload/install 准入 guard 与标准带括号状态条件，例如 `steps.ci-repair.outputs.reused != 'true' && (failure())`。运行完整 `artifact-policy-runtime` Node 契约，不弱化运行时检查。

Bun portability 重建缺少固定 Water 文件时，在 Node setup 之后、输入恢复与无缓存拓扑构建之前，执行现有 asset-checkout preparer。保留准确 pin 与来源验证、Bun 自己的依赖树、全部运行时 probe 和修复复用 guard。

## 其他故障排查路由

BevySSAO on/off 像素相等先查 receipt.presentation，completed preparation 无 scene。共享 readydriver 每 variant60张、retry 不推进 World、两 threshold/failureimage 保。SDKsourceexport yaml cleaninstall 先于全 contract，shaderworkflowordergate 保；Hostdisconnect 先 backendlog，外部 tempinventory 失败用 DevKit 传 forgeaxShader 的 explicitworkspace，不从 Viteroot 推、不换 profile。缺 bundlemetric 先 declaration/artifactclass，shaderPack 非 compressedbrowserbundle；12unbudgetedWaterdiagnostic 退，package/file/dir 保所有 byte/missingemptyreject/threshold、不造成功。Windowsbench/VFX 用 ownpnpm lifecycle，entryguard nativepath 比较不拼 fileURL；pixelparityVite 用原 JSentry+Node、保留 pnpmfallback/双 build/spawnerror/producerexit，CPUtransport 非 Browsercapture。

SDKseedERR_MODULE_NOT_FOUND 先 failedtestimport/workflow，pinnedsource 先、原一次 frozen install 后完整 policy，不第二无条件 install/stub/delete。seedcoldcancel 等 sameheadMainCoreBASE/sharedPOINT 完成，seed 重 compiler 后验 restore 原 publication，producerwait 不同原30min，missing/mismatchfail。[SDK](../../scripts/ci/README.md#sdk-consumers)。profile 后 SDKOOM 看 actualbuild:engine/profilecontainer 而非猜 source，declaration 继 runnerheap、encoder 自 admit、cold≤4memorybound，验证不松。512MiB JSONparsechecker 用 runnerderivedchildenv，afterGC128MiB retained/full source-count-digest 不变，realcontainer 验不重 cold。

stable/WebKit source timeout 先 same-sourceCore/base receipt，successfulCore 后 carrier、只 restoreBASE 完整 compiler/source/profile/payload；POINT 不能替，missinginvalidfailedprepare，不在原10min 内再 cold/加 deadline/unrun 当 pass。[compatibility](../../scripts/ci/README.md#pinned-webgpu-compatibility)。Windows physicalGPU Focus 设 FORGEAX_BROWSER_GPU=native，其余 supportedplatform，保留 physicallease/adapter/sandbox/frame/deadline；Browser/Dawn continue-on-failure 收独立完整 owner、aggregate 非零，本地 native 非 softwareCI 资格。absoluteCPUtier 验 heavycapacity，runtimeonlyVitest 关 coverage/type，CPUpressure/full case-sample-budget 保，fulltype 归 coverage；异 hostpass 仅诊断。

readypixel 失败分 preparation/completed picture，signalprep 后首 readyGPU 共原 settlement，pending/steady15秒；每 physicalsubmit 关 record、rearmexactobserve，timeoutclock 推进当前 budget。submitter GPU 完成前返 receipt 让 driver 见 signal，physicalcomplete 才 recycle、onCompleted await；boundedfailure/原 deadline。lightingchannelrecovery 每 attempt 重 armobserve/单 submissionrecord，completion 后退 pending 再同 snapshotretry。[driver](../../scripts/ci/README.md#readiness-aware-test-drivers)。

main 绿但 skipruntime 看 postmergequal：相同 Gittree+latestmatchingPRsuccess 才 reuse，unchangedmain 不足，earlyadminmerge 后 pending/fail/cancel/API 缺走 full。[postmerge](../../scripts/ci/README.md#post-merge-qualification-reuse)。PRmatrix 首 failed child 先看 cancel sibling，普通 PR 释放容量，repair/push/manual 保独立结果。interrupt 无 timing，ciFocus 修原 owner 后 fullworkflow 含 cancel 完成才 qualify。[matrix](../../scripts/ci/README.md#failed-pr-matrix-admission)。filediscoveryoracle 用 canonicalowner+sharedVitestpolicy，不先 importroot 再 replaceproject（会构造丢 Browser/Dawn），CLIcollection/fileassert/testchilddeadline 保，完整 instrumented coverage local/Linux。

Dawnordinary 耗 native 尾 window 保4child 全 process overhead/wholefileshare，历史/unfinished forecast/2200s replay 不变，不扩40minstep。member 变4fresh，compactexchange LinuxFocus 两完整 group+interruptjourney，placementgreen 非 nativequal。partial 只 complete process/native 记，interrupted forecast、旧 replay 保；config/dawn-timings.ts 解 archive，golden 独立 fixture。native texture 并原 mipmapowner 全 assert/budget，4lanefresh。merge 新增 ordinary 从 complete child+overhead 替 largest fallback，历史原 roster/current discovery 分验；无 complete 则 measured 后回填、不挤 qualifiedlane、fullfallback/globalspread 保。partialordinary inheritedfileforecast 与 processobs 分，先 freezeoldmissing 再新 measure，capacityglobalmax 保、provenance/conservation/replay 验；partial file 可 conservativeforecast 非 completedprocess。pairmin 可 boundedcohortrank/firstwaveseed，所有 capacity/spread/window 保，missingnative 也 freeze；coldreserve 集中先交换 nativewholeowner 再 ordinarysearch。Browser 完整 test 后 cancel 查 smoketail，同4job measuredheadroom 搬全 server/pixel/cleanup，双 lighting/deadline 保。

coveragetail 超时4jobcompletecost、只 completeupdate，inherited/interrupt/unstarted forecast 保。[coverage](../../scripts/ci/README.md#coverage-execution)。ScriptablePackworker 冷时 capturedJSON/publicationclock 进原 exclusivepublication，全 single/reusable/cleanup/V8/5s15s，历史 ID+新增 reserve，完整 child/allreplay。assetlibraryWatercook instrumenttimeout 整 file 入原 DevKitbootstrapexclusive，receiptID/原 obs 保、reservationWeight 算 combined；全 case/deadline、4coverageaggregatefresh；Focus asset-libraries.integration.test.ts 含两完整 file。ordinaryRenderhalf 需2worker 放 admit2的原 job，wholelane/optimizer 保留 policy，历史1worker 不能改 stamp2，fullCIqual。

lateDFGcancel 留 partial、reserve 原 full case，不扩 case/job，complete 进 distinctcohort，forecastonly 也保留 missing，greedy 先受限2workerhalf，所有 replay 验。Modeling 图消失先 actualfailurePNG/DOM/journeyJSON 原 upload，pagecrash/backendOOM 关联，别人的图非 failed frame。Import 真实 Vite shortbound wholefileexclusivepublication，历史 receipt 不受 project 顺序、added reserve，realbundle/export/identity/Nodeleak/双 deadline，4fresh。pair/threegroup 挪不动用原 bounded4groupcycle/完整 replay/LinuxFocus，同 whole owner/cap/search/history。uniformslow 跨 owner 先比，partial 单独 scenario 不拿 cancel 时长替、sourceID 不擦；raise underestimatedreservation 不 restampcompletecohort。currentcapacity 从后 complete receipt reservationWeight，earlierseedcost/missingID 保，两窗验。

frozen/current/retainedmax forecast 同2slotmodel，大 placeholder 改 greedypair；recordedcohortseed/boundedwholelookahead，不 roundoverrun/改 window。runtimeonlylaunch 按 mean/每适用 budget、broadhalffirst，replay 同序；typechecked 保持 cohortrank/job0preflightreserve。forecastseed 验 exactroster/mode/admission/allwindow，stale 退 normal，不替 CI。每 missingowner 显式 fallback，jobcancel 无 complete；slowwave 独立 scenario，subdivisionlate 不证 regression。partial4shard 仅 complete、4producer+aggregate fresh。measuredwork 超 ideallane 就别只 tuneplacement；Modeling 可 boundedheavyfileworker，V8/isolation/case/heapdeadline 保、complete child/residentmemory 测，plainsharedmodulepass 不 qualify。

multicameraBrowser World/publication/publishedVFX 独立 exclusive process，180scase/300sprocess/4job/framepixelrecovery 保；RenderWorkerrecovery+两 pressuretier 同理完整 singleton exclusive，member 变4fresh。coldmaterialready 看 firstframeGPU/nativePSO，generationownedasyncprepare，missingrequiredpipe/entry 保持 pending，60frame/reference/replay/bound 保。CSMprep 先 affinitywrapper 是否管 GPUthread，firsterror/readybound/scene 不变，recorder 未 admit 无 tape。LOD CPU v5 submittingthread 同步 gate 与 processnativeworkerrawdiagnostic 分，20%/双 order/full window/GPUfalsifier 保，performanceFocus hello-lod-occlusion 真实 Linux，-profile 仅有界 phase 诊断非 ordinaryqual。

GIoffdarkbyte mismatch 先 baseline receipt，同 readydriver 不推 World、exactpixel/volume/replay。[native](../../scripts/ci/README.md#test-work-and-cost-regression-checks)。directlight attachmentprovenance 分2completedscene 与 spotconverge，15s/full8case/attachmentassert。Primarymanualoverride stance exactsource 跑 node apps/hello/triangle/scripts/ac-08-grep-gate.mjs，rule 不变，publicationstrictfailure/Coreearlygate。30sprocess 先 sourceenum/tokenfilter，symlink/rule/deadline 保，共 physicalread/lexing 不 retainfulltree；sourceinventory+completegate、NodeFocus scripts/ci/__tests__/rapier-release-payload.test.mjs 用真实 Node 非 emptyVitest。Rapier 全 file 在 PrimaryNodepool 前 serial 避 TScompiler，全 scope/oneread/30s 保。

RapiercacheECONNRESET 在 optionalcache 前 source-keyedreleasefallback，同 producer 两 dimensionkey/byteinventory；Mac 包 Linuxinventory 看 AppleDouble、无 hostmetadata 重产不松 inventory，rollback/locked source/runtime60frame 保。[recovery](../../scripts/ci/README.md#failure-recovery)。FBX/Basis mainFocusSDK 共 prepare，releaseready 先 cache、strictcompletefile/locked source、realparse/encode-transcode/runtime 保。UIBlitz/wgpu 也先 currentlocal-release 验证再 cache，sourcebyte/sourcekeyfallback/nativebuild 不变。candidate authplaceholder 先 standaloneView/Modeling gitdir 再 recursive；publicsource export-source-missing packages/modeling 先 prepareexactgitlink 再 export。[Modeling](../../scripts/ci/README.md#modeling-source-preparation)。

coldreadypicture 先 receipt/captureviewprogram，不 settlesleep，positivepicture/independentphysical-missingdraw 保；SDK runverify 验收，capture 可 unfinishedcover。thumbnail unreadobserve 归 retrydriver：等 prepare/GPUcomplete、消费实际 observationdomain 再 rearm，queuebound 保。managedmaterial 首 drawnonoperational 需 hostinit 后公开 Rendererfacade，nativeprobequeuecomplete 非 ready、原 picture count/pixels 保。

SVGzerobinary 看实际 bytes，[textvector](../../scripts/ci/README.md#text-vector-source-assets)，binary/NUL 拒保。dataURLstartupmodule 无 directory，buildtimeembedvector，runtime-acceptance.mjs 完整 portabledoc/failureobservation；原生 defaultscreen 保留 CSSvalidator/SVGdecoder/painter、realBlitzlogo/完整 WeChatrecovery，不松 CSS 接 browserellipsis。设计契约归 README/AGENTS，诊断 current source/actual failure，历史 lane/run 非操作指南。

coverageonlycoldscan/compilerdiscovery 完整 selection 复现，再原 exclusivefile 且 ordinary 排除，V8/case/allwindow 保。Ubuntu 镜像 sizemismatch/502用 signedsource/boundedmirrorinstaller，packagefailfatal、affectednativefresh，不弱。[buildinput](../../scripts/ci/README.md#build-inputs)。首 WebGL2readyGPUstall 捕 actualwork/shadowreceiverspecialization，[shadowfree](../../scripts/ci/README.md#webgl2-shadow-free-first-frame)，completionbound/realreceivingshadow 保。

NightlyDawn 过 coveragecancel 看[Linux](../../scripts/ci/README.md#nightly-linux-ownership)，samecommitfullCIgraph4coverage+global，不能 serialfallback；nightly_full_profile 和 reusedDawnstep 都看，fullframe/browserunitNightly 保、PRmainbounded，consistency 沿 calledge。hostedprobe/Metal/bound 保，trackingissue 记 timeout，完整 Nightly 才 qual。capturetiminghot/coldwall 比较看 phase/rebuildtrace，warm 可慢，duration/env/perftier 保。

collisionlongscan 完整 owner+nearesttriangle，fullmotion/negativecontrol，[CPU](../forgeax-engine-performance/SKILL.zh-CN.md#remove-cpu-preparation-and-collection-work)。runnerlost 按 kernelfingerprint join 窗口 memoryPSI/OOMrawdelta，历史 OOM/后 pressure 不证 incident，failed run/interrupt 边界保。Packslow 先完整 build/opjournal，strictdisjointbounds 先 reject、closedcontact/errororder/fullbytes 保，以 phasetiming 反证 sampleattribution，再 ordinarymatched，不 profile 当 throughput。nativecase 分 source/cookCatalogadopt 与 drawreadback，backendfixture 须 portableparity/fullnativepixels/freshconsumer/原 frameassertbound。

Appcapture 无 scene 辨 preparing，positiveowner 用 waitForAppScene/当前 Worlddevicecompleted 而非 fixedwarmup，failure 仍 rawRHI；Skin/history 改先 build 实际 Rendercarrier，sourceunit 非 staledist 证。stablecompat 完整 ciFocus --kind compatibility --select stable，genericBrowser 可不同 executablepolicy；sandbox/limits/nativearchivepixel/fallback 保，quotaGPUworker 先查，零 completed 无 pixelaccept。archive 后 Instance 丢保留 pw:browserstderr 再归因。MCPApp recoveredscene 等 latestWorld/device matchingready，60floor/180s/完整 PlayPreviewpixel；Browserroster 选 maintainedsceneproject、120scase/15sready 分。

CSMBrowser 查 shard1 RuntimePackWorker 后 serialchild、Dawnnormalize 在 Worker 后，Vitest 全完 jobcancel 非 renderfail。完整 cost/serialtailreserve 平衡、interrupt 旧 forecast、changedRerun，verifiedinput/fourcascade/tape/live-replay 保；coldprep 在 Engine signal/startupbudget，GPUsubmitcomplete 短界，recorder 前 readyfail 无 tape。

runtime-tool/host/test-export 修[namedboundaryowner](../../scripts/ci/README.md#runtime-and-tool-boundary-contracts)，check:runtime-boundaries/test:runtime-boundaries/正常 production 后 distcheck，不 consumerdefine/devfallback/baseline 遮 dependency。Waterbrowserdistributionresolve 先 Viteroot packages/engine（umbrella）/Waterdist，无 sourcealias，roothoist 不 required。cubeplanecontact Forward/Deferred 分 owner，各36case/coldrenderer/framepixeldeadline；log 停 scan 不证 scannerstall，要 casetiming/liveprocesspage。[Browser](../../scripts/ci/README.md#browser-gates)。

workflowstance 修 namedjob，auxpublication 自行 verification/publicationfail，optionaltransport 不授权 joboverride。instrumentcoveragefail 精确 child/file 经 coverageFocus、V8/allcase，unit 不足，4mergefullthreshold/final head，localfull 先 pinnedAssets。Enginebuild 前各 ensure-wasm+Codec no-dynamic-Function，ignoredpkg 非当前 contract。rawgluerestoremismatch 比 Core/sharedfingerprint 非 source key，adoptverifiedsharedcompiler 同时 deriveglue（normal/partial），producerrehydrate 非 editgenerated。Node 工具测试在真实 Noderunner、Vitestroster 外，requiredCI 保留 assert。same-sizewatcher 验 stat、distinctinitialtimestamp，不 sleep/deadline。

重复 wholejobtimeout 保每 run 完整 scenario，非 partial/fast 替；allreplay/largerreserve/overhead/unfinished forecast，wholechildfile 移，compiler 测值仅 matching 场景。不能加 allrunmax 约束排除实际可行 scenario；每 job 至多 evenrostershare+1child 避 longtail。重复 coverageparenttimeout 替 push 前 local4V8+merge 完整。nativeonereceiverdirectlight 先 fullRHI 再 optional occlusion，shadowclearcoat 保默认、HDR/reference/shadow/24-60frame，本地 Linux 仍 finalCI。

Threematerialfirstcompletion 保留 failedtape、actualfragment/Viewslot，fogfreeview 把 admittedviewFog 跨 hiddenprepare/visiblerecord 选既有 unfoggedentry；analyticfog/finiteatmosphere 仍 composition，unknownhelperconservative，全 case60frame/pixels/freshreplay/deadline。ViewreplayInstance 丢保留 tape/page/devicefacts，比 softwarelaunch 与 Vitestwatchdog、pwstderr 后归因，shortwatchdog 仅 falsifier，unchangedrealtape+完整 diagnostics sandbox/allbounds 重跑。

coverageparentidlepeer 查 crossprojectbroadhalf 一起跨 jobs，wholechild/V8/allfile/threshold/deadline；complete 才 timing，observstamp run、partial 不用旧 peer 优化保留 larger forecast 至 current complete，全 refresh 每 rowstamp，用 explicitpartialfixture 验 stale 非 live 表 mutate。allpassingchild 但 parentcancel 先 ordinary/exclusivetail 对 peer，完整4receipt 独立 cohort/unfinished forecast，localfilecorrectness 非 parentqual。equalmoves 卡 pattern 用1for2wholeowner，同 count/broadfine/exclusivecap、独立 typechecked/allhistoricalwindow。long15minexclusive 先 reservejob、其他 exclusive 不放 serialtail，costrankfinewaves 同时保留 broadseparation，perpartitionforecast 独立 raise 继承 max；replay 指导、finalCIqual。currentcompletechild 全更新无旧 samplegroup 也含，reserved/sourceforecast 与 latestobs 分；setuptransfercleanup 最终计，tightreplay 非执行目标。历史 typecheckmode 保持，独立 preflight 不暗加 job0，freezeoracle 不让 live refresh 擦，interruptcompiler 无 sample。

jobcancel 无 assert 看最后 stage，exclusive publicmodulecasephase 有界，noViewSDKsourceclose 前流原 stdout，childexit/heartbeat/log 保，missingcomplete 未验证，不 deadline 延/用 cachedbytes 冒独立 sourceproof。local 单 job 不能移 peer、barrier 仍 serialexclusive。Modeling 单 file 受 neighbor 竞争可整 fileexclusiveV8、ordinary 全排、原 deadline，failed 无 timing。

dualhostStandardparity 原 shortbootstrapexclusive 全 pixelcompositorfalsifier，host 并行 init、coldscene 顺序 complete 防 peerGPU 帧留 pending barrier；15sready/90scase/两 host，sameheadLinux+fullBrowser。单 cube benchmark 关 optional occlusion 保留 GPUvisibility/indirect；Browser 双 device 开默认 occlusion 要求 byteidentical、restorelight/30sstartup。GBuffer 空看 selectedmaterialpass+publishedentry，Forward 有 fs_gbuffer 不证 draw；仅完整 currentdevicecontributorproof 可省 lighting，attachmentloadclear/全 SceneDatareject 保。

Threetextureflat 重复 reference 设备用 upstreamfixture 独立 filedevice、每 comparisonfreshRenderer/nodecache，9freshreplay/像素帧；每 flatmaterial 独120s BrowserDawncase，3matrix 全保，Browserguard11devicerequest。[budget](../../scripts/ci/README.md#test-work-and-cost-regression-checks)。multicamera/alpha-shadowprocess 看 readback/overlapdevice，两 fullfileexclusive/allcasepixeldeadline。weaponspirit draw-entity-missing 保留 predisposalcanvas/Renderer/asyncPSO artifacts/ci-focus/weapon-spirit/，sameheadFocuspass 不解释原 fail/fullCI，先 tape 后 render 改。independentview/textureflat 受 neighbor 同 headCIprofileLinux Focusexclusive，全 case bound，本地 hardware/focus 非 fullshard。

Standardmaterial 首 submit 先 framecapture，cold/warm 分、fragmentdiscardoverride；directdraw 共 mask 且 GPU LOD absent/cameraclip 保，无 declaration 保原 constant。clippixel/60frame/bound/fullLinuxfile/fullBrowser，localreplay 不足。Toon 首 ready 缺 draw 保留 adapter/shaderinfo/pipetimestamp/post-failure tape，Focus 匹 CIprofile/pinnedLavapipe，diagnosticframe 不 qualify 旧 fail。Three/native 影首 shadowGPUfence 不同60frame 稳定、双 caster/stabilitycase/replay 保。Surface Browser 分 render/App lifecycle，两个 Surface-only beforeconsumecatalog 独 exclusive process，render+双 recovery 原 caseprocess。IES 先 cas 截图，ordinarypublication 分 owner，全4case/19independentdevice/exclusive/bound，选 coldprofile 直接构造；sharedsettlement 分多 completedpreparationwave+ready picture 与各15s submit/pending/steady/ordinarycompile，legitprep 后 readyGPU 不能误 missingcompile。

full source ValueDeserializer 先 retainedinput/output，Worker immutableWGSLbody 一次 transport，rosterinternequal 保每 variant/独 metadata；fullpublicationbyte/真实 Nodeprofile，heapfail 与 Naga panic 分别、皆非 transportretry。nativeselectoracle 同时 stateevent/popupPNG，CDPfocus 非 OSpopup 仍开，其他页 activation 可 dismiss/提交后键盘；singleforeground/exclusive，全 assert/deadline、4Browserfresh。

native/coverageparent 孩子过仍超时比4ordinaryDawnledger/16Modelingpartition，保留 wholefilecost，lateGIcancel 不抹 earlier；current complete 转 previousslot，capturelongspread/先 reserve 后 ordinary、whole owner。distinctsnapshotreplay/firstcostrankwave 独 lane/unfinished forecast，freezeoutgoingfixture、largercost/fullowner/4job/bound。coveragepartialappend 独 cohort 不 restamplatestcomplete。[场景](../../scripts/ci/README.md#complete-run-placement-scenarios)。

coverageisolatedsource 尾查 ordinaryforecast 排 file，movedsource 只 charge 一次，完整 owners/bounds。Modeling16partition 更新全 file+process/skip overhead，排 separate/performance 后同 ledger 算 reserve、largerfilecost 保；连续4partition 散4job 防 equalforecast 聚集。DevKitRender 后尾跨 project broadceiling，实测 slowlane，quota 同非 elapsed 同、原 jobfinalCI。1024mippadding 保3bake/falsifier60s，public4Workerrowexecutor、serialworkerbyteparity/fullV8file，不缩 texture/延/无 instrument 替；failed 无 sample。

liveDaemon/AppWorkercoverage 整 fileexclusiveCPU 先 qual，HTTP/module/graphicsfalsifier 保、nestednative 自 GPU 准入。[owner](../../scripts/ci/README.md#execution-owners)。Viteshadercoverage resampling/SurfaceABI/DFG 原 sourceexclusive、publication 继 compilerbudget，callcount/mock 在 observing realm。Three/IES failureartifact 保留 literaltrackedsource/testroot 后 glob，dependencyexclude/wildcarddepth 不能 boundtraversal；optionaluploadtimeout=tapemissing，recover 真 capture 再 shader。syntheticnativecontext 也需 requiredcamerasnapshot（即使 shader 不用 View），原 producer/native depth/pass/clip 保。

coldscenematerial ForwardDeferred maingeometryasyncprepare 独于 Feature/shadow/temporalgetter，不改 globalgetter。GPU-driven 含 Unlit 归 registeredprepare/pending barrier，普通 encodelookup 为 cube/offscreen 保留 syncready；改后完整 multicamera+real delayedPSOUIreplay。ordinarymissingdraw 用 submitted evidence 不全 frame 当 prep，pendingviewbeforesubmithook 保。pendingUI tape 仅 UI 且像素异查 compositorload 未 init surface，Record 按 actualencodedwork 清/载、保留 preparedgraph/output；nativepipelinegate/freshreplay pendingdynamicretainedUI。staticoracle 同 snapshotreadydriver、原 pixels/frame/capture；directnative 前 buildEngine，map 路径非 dist 新。

Core smoke 数 ready scene picture 非 completedprep，sameWorldretry、等 preparationCompleted 再新 ready receipt，不 sleep。uniformblack 比 backgroundsample 必须 fail，shader 前 capture、shadowparticipation 与 flatnormaloracle 分；positiveframe 先 prepare 再 arm，readbackhook 不再 draw。[scene readiness](../../scripts/ci/README.md#core-smoke-scene-readiness)。pausedrecovery 固定 World 含 physicalinput；unsupportedvideo structural 保留 completedsubmission 不强 native 不能 picture。Bevy 首 readycoldnative 在原 totalbudget 内有 boundedfirstallowance，pending/steady 短，stalledcold/steady 仍 fail，只 readycomplete 计。

nativejobcancel 先 testverdict/setup，optionalartifact 丢可 fullsourcebuild；Dawn40minstep/50minjob 区分30min 目标，不能加界称目标达成。Browser Vitest RUN 前 stall 看 browser-startup owner/phase/heap，sameheadLinuxCI Focus，不复现保原 failure，focuspass 不证 externaltransport。latecomparison full roster/failframe 保，completecasepartition 控 process，allpixels/freshreplay/60frame/readycaseprocessbound。directionalThree baseline/filter/layer-variance 同 renderer 顺序，共 warmup/replay、各原 case。Spot 先单独完整240s native-reference-replay、60warmup/fresh device 再 exclusive，placementfresh。

Browserjobdeadline 全4filecost、历史大值/startcleanup 一次/serialsmokereserve，interrupt 不 cost。PreviewcoldCatalog 分 cook/browserready，watchsnapshot 归 revisionobserver 有界 pathroot/baseline/drain-closefence；Catalogstartup180s 若替90默认需 explicitallowance，不改 browserGPUcasejob/不称 speedup。skyIBL 长 parent namedresource/freshnativeconsumer、cuepixel/frame/ready 保，fixednative 先 reserve 后 ordinary，4completeordinaryfileledgerfresh、larger forecast/所有 discovery。reservedcapture 先 admit，interrupt 非 sample。compilerstatecallcount 留 observing realm、全 context/artifact；独立 schema transition 同 cooker 顺序 falsifier 后每次 cachedStandardreturn、portablematrix/case 保。

CSPtimeout 分 Workerinit/Previewteardown，closeVitePreview 清 unfinishedHTTP，全 inline/externalWASM/deadline，原 CIcontract 验 cleanup 再 fullBrowser。fixtureoverhead 审两 reachablegraph 含 conditionalshadow，actualshadowresource/replayqueue 先查，performanceprecision/independentpublicationfalsifier/selectedprovenance/frame 保。SDKUI 颜色差先 retainedPNG/actualviewportstatusfooter，长 version 可能 wrap 入 oracle，精确色/solidpatch 保，留 minUIheight。

globalprobepartialwritecoveragefullfile 进原 exclusiveGI，非 broadDevKit 竞争。Dawnpartial 较4ordinary/native 完整 cost，interrupt 无 sample、skipfile 计 process overhead；earlierordinarysuccess 不被 laterinterrupt 抹，dawn-file-seconds 更新但保留 larger forecast/fullnative；capture 远低 reserve 也先 all4share+native 同 boundreplay，firstcapture/exact partition 保。[GI](../../scripts/ci/README.md#gi-coverage-and-material-publication)。

GPU snapshot/reference 昂贵先 matchertraversal，fullbyte/provenance/独 negative 保、byteworkbudget 修 oracle 非豁免。tapetransportgzip 独 GPU，Node 条件 nativezlib/browserportable，realcodeccall/fullcrossbyte/corrupt/browserpackage 后 fulltiming，capture/replay/digest 不减。wireintern 查 Packcodec 实际 bytes，保留 metadata/publicationID/[programcontract](../../packages/pack/README.md#shared-material-program-transport)。slowmaterialfixture validated byte view 到 realpublicationdigest/wire，numericprojection 一次再 nativeJSON；storageonly 明确 target，GI/ray webgpu-storage-ray 含 rayhit/Card，actualcontextguard/fullcompilerparity/portable constrained fallback 保；提前 JSONroundtrip 会逐 bytearraydigest，realdecode/adopt/integrity 保。paritytimeout 先 binarycompare 非加 compiler/deadline，exactbyte-meta/concurrentcook/diagnostic/crashrecovery 保。

ModelingDawncollection/staleframe 用自包含 defaultTG/nativevalidationrecoveryfalsifier，TG_CASE_DIR 可选；template 改 probeSH 验真实 productionpreblend，不依 let/var 拼写。R-internal-C 在 kernelrename 标记 member+typedcaller，完整 candidate、kernelPRmerge 后 Enginepin，naminggate 保。Modelingcoverage16partition/manifest/fulltestthreshold/deadline；C410 fullbruteforceconnectivity/geometryfalsifier，S7profilelabelinspection/600s 全 animation，heapbudget 看 NodeinheritedV8覆盖 Workerlimit。declaredmaterialexclusive 仍慢看 filewidespy 关 Nodeworker，只有 Naga callcount 需 observing，realcook/allmaterial/assert/deadline 保。absoluteModelingtier 记 failedclock/case/runner，nominalheavyuninstrumented，全 runtimeoffline/sampleattempt/budget，异 host 非 algorithmgain/重试理由。

firstpicturetimeout 关联 receipt/nativepipe/queue，reason 首 blocker 非后来最久；共 Enginecompletiondriver 不 floodqueue，bound/picture count 保，denseIES 原 exclusive 全 file。SDKsource consumer 后 integrity 尾超时用 boundedfileIO rereadcurrentbytes，SQLite 唯一 mutablestoreexception；verifySdkArtifactInventory/verifyImmutableSdkStore。[SDK](../../scripts/ci/README.md#sdk-consumers)。sourceverifier ok:true 后 cancel 仍保，fullcold/template/View/exit/upload cost；compilerparallel 已 capacityadmit、archivestepdefault 不改。当前 sourcejourney40min 是校准非 speedup，30min 未达，双 coldprofile/browsercase 原 bound/完整 Linuxfresh。

并发 CI 变慢按 affinity kernel fingerprint/CPU mask/interval 比较，同 mask 非同 host。quota-only container 在 pool 保全部 physicalcore、每 verifiedcore 一个 logicalCPU，runnernamehash 不能 reservehostcore。GPU 各 thread 都看，SwiftShader 可能稀疏 mask 重置 contiguousID；原 generationcheckedcorrection 作用全 pool，quotacap/bound 保。[资源](../../scripts/ci/README.md#failure-recovery)。Bunscan 超时比 visibleCPU 与 cgroup/actualscanner，MathECS 完整 canary 经 affinity 单 Vitestworker（41572730945六 workerquota 仍争 live read），full case/negative/type/deadline 保，本地 serial 非 Linuxqual。

SDKbootstrap/publication 比 Node/npm/pnpm 实际与.nvmrc/.npm-version/.pnpm-version，PR/Candidate/Promotion 同 toolchain，修 operation 保留 sealedsource/version/immutablebyte。Candidatecollision cancel 分 coldjob 与 browserdeadline，annotation/producertiming 先看、pin/allcollision 保；[critical path](../../scripts/ci/README.md#sdk-candidate-critical-path)完整 Candidate 恢复。重复 cold 先 same-sourceBASE/POINT 可选 admit，receivercompiler/source/profile/payload 仍验。publicsourcejoblimit 取消非 compilerfail，fullbuild/setupdryrun 保，publicPR60minbuild/publisherwait 由此派生；exactGittree/sealedCandidate 保，controller repair 可 reviewedMainSHA publication_controller_sha，不重建 occupiednpmversion。public_preflight_runner 仅 CPUsharedtaskgate，mirror 等 remoteCI 不得持 lease。[publication](../../packages/engine/RELEASING.md#repairing-publication-after-immutable-bytes-exist)。

SDKfullscene 超时在另 admittedcarrier 测 exactartifact 再改 source/test，backend/viewport/60ready 保；首 ready 和后60各90s、总180，记 phase，是 functional 边界非 perf 豁免。full_scene_runner 可 qualifiedLinux 承 npmdiagnostic 和 project/source archive，exactarchivejourney+npmboth 验、每 owner 共享 taskadmit、privatehostconfig 隔离。runnerpolicyconditional 每 literal branch 按 poolcapowner 验，dynamiclabel 未验证不能 exempt/忽 unselected；复杂度超拆 branchaggregation 与 scalar/matrix 分类，完整 policy+complexity/failclosed。

cookbookmissingexport 修独立 Harnessrecipe、fullcookbook 编当前 Engine，再按[docinput](../../scripts/ci/README.md#independently-owned-documentation-inputs)更新显式 Preflightpin。Packdraft 修后仍 declarationerror 比 sourcedigest/draftrevision，explicitreopen 用 Packserializedrefresh 保留 edit，nativeauthoringrecovery 先验、不改 Viewwait/parametercontrol。Render benchmark.test.mjs Nodecontract 归 Primarynode，Vitest 只排这些、source tests 保。“emptyframe”先 samplecoord/fullreadback，可 subject 不在两个 backgroundprobe，pixelthreshold/lifecycle 保，fullsmoke 要 LODfixtureproducer。

nativeUI 先 artifacts/ui-*/pairedsnapshot，WASMprovenance/browserversion、Host 原生 editmodifier，exactfileCIprofileFocus、geometrypixel lifecycle 保。Browsermeasuredcoverage 缺 cost 只 completedexactchild 更新，85%floor/inherited/cases 保，skippedinterrupt 不 measure。不同 runner 相反 geometry 先 actualChrome，reuse/cache 都 versionpolicy，不交替实现/重试选兼容 runner。Workerreplacement-epoch 保留 report、realtermination，先 rendercreditwait 不改 frame deadline，stale/duplicatefence/recovery。[split](../../scripts/ci/README.md#split-worker-admission-recovery)。

Dawncancel 保留 job、unfinishedwholeownerFocus，onlycompletesuccess+skip overhead/larger forecast、4lane/lifetime/deadline。ThreeBrowser fulljourney 与 plannerweight 对比：shadowfilter/manualreplay/loading/materialoutput/environment/transmission/output/rendertexture 不能 unknown5秒；direction/point/spot shadow.fixture 各 process，各 shadow-kindfile 不重合 deadline。directionexclusive，managedmaterialshortbound 排邻 bootstrap。compat3caseexclusivebootstrap shader 后，native 两个60/autoWebGL2/pixel，archiveinitsignal 在 coldsettlement、ordinarysubmit/steady15秒；Linuxfocus 非 fullqual。alphashadowBasic/Standard 各 exclusive/allpixel/freshreplay/bound。24casematerialoutput 在39457755532后也排邻，measurement/全部 case 原样。Threerender native/capture/coldreplay 分，2boundedreplayslot 独 device/immutabletape、rendererclose 前 drain、failure 透传，60frame/pixel/120scase。

Viewtexturechannel/mipslice/environment 跑 tools/view/scripts/verify-texture-preview-integration.mjs，artifacts/texture-preview 图/pixel 真实 Pack/exacttarget；onelevelEquirect 不暴露 IBLroughmip，未知 render 先 RHI。UV/materialnavigation 用 verify-resource-preview-lifecycle.mjs、UVmaterialPNG/exacttargetdiag，workspace shard 真实 browser；syntaxerror 归 probeowner，runtime assertion 保。MCPblankReact527看 emittedfrontendstartupgate/Viewcontracts，builder 从 ViewinstalleddepsresolveReactDOM，不延 deadline，修后完整 game3dPlayStop。

Viewjobtimeout 看 stageseconds，game3dstdio/nativeworkspace 一起；POINTbrowserlane 按 BASEaccepted 后计 work，长 plugin 不放两 POINTlane，完整 probe 按4shard、JS/TS livecold/原 cap/assert 保。Engine-onlysource 慢先 verifiedsharedmiss，sharedpayload 仅 candidate，rebuilt compiler/source/profilematch 才 reuse，misscold 保；artifacttransportfailure same-source rerun 非弱 aggregate。startupHostdisconnect 先 artifacts/view-integration/<probe>/Backenddaemonspawn 匹 child 并 cleanup 后保留 stderr、原 timeout/exit；SDKsource 同 artifacts/sdk/view-source/backend 以 PID/starttime 排无关，log 缺保留 nativefail，socket 断不定 cause。MCP404 barepackagename 拼 module 目录修 dynamic import specifier 分类，package 原 resolution/URLbroker，optionalreject/原 repeatPlaybrowser 验，去虚假 request 不足恢复。

重复 appbuild/metricaggregate 按[单 build/metricsowner](../../scripts/ci/README.md#one-build-and-one-metrics-execution-owner)，先 disjointAppBevyroster/actualconsumer，retainedBevy60frame、producerfail requiredaggregate。Bevyinputtailrelease 前停用 readydriver 非 rAF，减 ECSsubmission 保留 simulationhorizon。RuntimeVase 重生后 template motiontimeout 先 producer/recoveryrender，原 submittedprefix 含 recovery 须 ready，CPUadopt/submittedonly 不足。Bloomloss 前 graph 空先 completed ready 再 crash，warmSubmit/HUD 非 scene，bound/pixel 保。runner 总分钟/critical path 不 queue。

sharedshader134OOM 比 parentheap/stepshaderlimit，variant/worker 前看 sharedbudget，coldfail/verifiedreceipt 保。sourceContentKey mismatch 先 wgpu/Blitz actualgitlink，共 input 也 sync 已有 publiccheckout，Cargo.toml 非 pin。frozeninstallNO_IMPORTER 查 package 是否 targetHEAD，removedsubmodule 残留归 prepare-pnpm-workspace，warning/error 保；nestedembedded.git 无 rootsubconfig 需 HEADreflog 证历史 exactgitlink 再 prune、无关 repo/changedcommit 保。

nativefixture 先 actualdevicerequest/replaysubmission，sharedRenderer/device 但 World/asset 独立、constrained/publication/falsifier 保，redundantwork 负 control。registry 不绑多 World；AlphaHash 冷 livehost 保仅 batchreplay、aggregate 每 texel；Furnaceready 属当前 receipt，multiviewGI staging 复用每 frame/ownreadback 保。Dawnpassgroup 但 jobcancel 分 cleanup，completeemittedroster child 可成本、job 仍 fail，4lanecleanupheadroom 不能延 job。newfile 最大 fallback 可能 strand、onlycompletecost、skip overhead/缺 resultforecast 保。serialDawn Mesa8worker 按 heavy、Browser 并发各4，singleVitest/admission 保。nightlysharedshader 单独4GiBheap（2GiB 装 fullreflection 可爆），不是 Dawnshard。BevySkyboxDawn 过无 Chrome 修 fleet 共 install，realWebGL2保。guideformscrollwidth 先 nativeclient/outerrect，保留 ancestorextent/externalgeometry/fullinput，[UI](../../packages/ui-blitz/README.md#ownership-and-observable-behavior)。

Linuxsoftware pnpm ci:graphics setup/[isolated](../../scripts/ci/README.md#concurrent-local-sessions-and-the-gpu-lease)。RustGPUcrash 保留 failedprocess，用 workflowserialentry 同 upstream/fulltarget/rayquery，SIGSEGV 非 transport/pass。官方 pinnedarchive 镜像移动后保留 bytes/hasherror，不绕。基础 init/ordinary 不需 Dawn，pnpmtest 仍 DevKitbrowser，Dawnoptin。冻结安装提供 `pnpm test:dawn` 使用的上游预编译 Dawn。游戏中的 Node GPU 工具按[提供者契约](../../packages/dawn-node/README.md)安装。缺少 GPU 证据要保留失败，Ray Query 仍由 native wgpu 验证。

WindowsBrowser/Dawn 走 Nodesuite，full roster/deadline/directenv，无 POSIXassignment/managerupgrade。smokeroster 或 exit0无 receipt 看[Windows shell](../../scripts/ci/README.md#windows-repository-shell-commands)，canonicalframe/assert 保，zero 非 qual。multiprojectexcludeglob forwardslash 传 resolvedproject，run-vitest-projects Node 真实 regression 普通需 run/排除必须不 run，DevKitleasednative 保。WindowsNightly CMakegenerator（VisualStudio182026）非 MSVCcompilepass，DXCLLVMcoldlimit 先 workercap；coldbudget/contentkeyoutputcache 归 guide，不 cacheCMaketree。

packagescript 用 pnpm shellEmulator，directlauncher 用 pnpmCommand 含 compositeSmoke，childfailreceipt 保。coldpackageimport 未 buildcompiler 查 forgeax.buildDependencies/devDependencies，buildgraph 排序/invalidation，compiler 不进 player。ShellCheck 按[transport](../../scripts/ci/README.md#ci-code-ownership)，roster/failureexit 保。gateprocessdescendantPID 缺先 fixturestart/parallelNode，completeownerbulk 后 serial，原1.5/2s/readiness/escalation/exit。Viteportleak/smoke 不退看 descendant 继 stdout，sharedownedprocesstree+realTCPregression，仅 ownedtree 结束。ImportsidecarEPERM 比 destbyte，等价才成功，异保留 structuredfail/rollback。

ViewFocus kind=view 用 run-view-integration --list-groups 精确名如 game3d，fullowner/transport/capture，pass 非 finalCI，CLItimeout 即使 fallbackPNG 健康仍 fail。Chrome158 SiteInstance/has_site_ exactversion 复现，parent 先 ownedHTTPHost 再 sandboxsrcdoc，allow-scripts/opaqueorigin/Chromiumsandbox/pixelfailure 保，完整 Viewcontracts，不 retry/关 siteisolation。fullBrowser 过不了 Focus 需 browser_profile=ci，localdefault 不同，lifecyclepixel deadline 保；nativeFocusRenderer 前 validator 拒看 inheritedBrowserpolicy，unselected absent 不能 emptystring/松 validator。SSRrecovery20s 看 pipelinelabel/spec，Standardmaterialcache/exactLKGrequest/targetedbootstrap 保。treeshake 缺 production 走原 sourcebuilder 仍缺 bundlefail，Nodepath 空格直接 Node 无 shell、realhellocube regression；coverage 转 FORGEAX_SHARED_APP_INPUTS_MANIFEST，source key/deadline，不重复 shader 变长。DFGboot 正常 sharedpackaged 选择，shaderproducer 仍 cold，bootJSON/fitLUT/admit 原 deadline。WindowsRapiercompile 后 stall 看 declaration/tsupentry，realjunction rapier-wasm-declarations.test.mjs 保。

RuntimePackWindowswgpuwebgl2按[准入](../../scripts/ci/README.md#windows-runtime-pack-webgpu-admission)，backendpixel60保。MeshIOadapter unavailable 查 LinuxVulkanSwiftShaderflag 是否误入 Windows；sRGBoracle 真实 linearread/live-replay-missingtriptych，formatprecision 独立原 HDRbudget，20case/gammaUVfalsifier 保。WindowsnativeRayQueryproducer[显式 nightlymaintainerdispatch](../../scripts/ci/README.md#windows-native-ray-query-artifact-producer)，dailyPR/postmerge 自 hoststrictartifact。LinuxNagaSDKtar 缺 xz 先 xz-utils 再 pinnedSDK，全 WGSLSPIRVsnapshot 原跑，setupfail 非 pass。

nativeGIimport 慢 sourceboundsharedinput/FORGEAX_SHARED_APP_INPUTS_MANIFEST 普通 builder，fullGPU/falsifier、非 uncheckedold。PreviewCapabilityLablate 分 Catalog/decode/completed ready，failed frame/browservsdiagnosticDawn 分；reusebyte 需 digestsize，decoder 快不 qualifystartup。templateondemandproducer 先 ownVitebeforeconsumeCatalognativeimportbarrier 再 browser，browsercompletiondeadline 保。SDKcleanbuiltimport 缺看 seedproductionowner，npmnativebinding 缺 exactbytes/installflag 复现，publishedlayout/externalpeeredge 在 DevKitrunSnapshot 保，install 非 nativerun；compactsourcefragment/receipt transport/materialize 保留 sourceID 不 tableindex。

TASK_CYCLE 查 exactclosure，仅原 ownerbuilddeliberatecycle 允许，其他 filteredreject。PreviewCatalogWindowsDDCEPERM 看 readinessoption/nativewatcher/dest，templateconsole 保留 nativeErrorfields，terminalpromptfail、健康 startup 保留 allowance、backendstop 独 retire；Catalog/completeddeadline 分，inspection/capture 非 ready。[恢复](../../scripts/ci/README.md#failure-recovery)。ScreenProbe motion/noise/sequence 先 RHI 实际 probe/pixel，wholequality/timing 与 kernelcontrol 分，artifact 在时下 currentmotiontape/pixel/typedreads，metadata/oldtape 不补 current；RayQuery 非 Dawn、diagnosticupload 不 admitfailedgate。

VFXMeshlimit16 originalreceiptGPUcredit/completion+boundedfirsttape，inflight unavailablecapture 保、先 recordedowner 后 laterframe；local/publicationexclusive 先核再改 GPUdeadline。WS1009/unsupportedlength 保留 error/tapebyte/transportbudget。Topologyartifacts/ci-focus/topology/failure.json，Catalog 归 producer，framePNG 走 RHI，oracle/timeout 不变。

Threeoversizedfeaturefile 共 callback/initialeditedcapture 保，4partition+externaltexture 完整 successfulcost（startup/cleanup），免 group 重造 timeout；localtiming 非 CI，120case300process。Dawnjobcancel 即使 nativePASS 也 cleanup 超 job，complete child 仅 cost、finalCI 仍须过。PRcost 与 fullforecast 分，coreProfile 仅 samepolicycompletechild，historicalmax/fullNightlycost 保、interrupted forecast/explicitreserve，wholeowner4lane/Modelingfirstcapture 保；sequencer 变 coverageinputguard fresh。42147390301 screenprobe39min 启动40mininterrupt，无 sample；42156059037 ordinary4=1773s 后 native、directlightinterrupt，历史 lane 移动只是当时观察、保4lane/bound，surface/heavy/vfxdepth/nesteddiscard/GI5 reserve 纳 balance，onlycompleteforecast 更新。isolatednewowner conservativeperfile 至 complete process（startup/cleanup）；workercount 变需 currentpolicyreceipt，interrupt 旧估计，fullfinalgate。

coldPreviewfullreload 看 Vite late dependency，literal dynamic import 即 vite-ignore 仍 pretransform，Node-only 仅 nativepathload；nativeremote/coldbrowserregression 保。learnrender4.10MSAA coldoptimizer+30sgoto 仅 signaturebound 一次 retry，[guide](../../scripts/ci/README.md#failure-recovery)，两 attemptOFFON/P2都保、再 timeout 红。PlayOUTDATED_OPTIMIZED_DEP：init 异步 scan，freezepluginURL 前 awaitinitialscan；coldPlay/projectlock/cachereuse/renderfail 保，secondaryRuntimePackexport entry 经 executingclientresolve 再 optimize、nativeidentity。Workerpreloadreload504 exactlate dep 加 existinginclude 经 owningworkspace（runtime > water > clipper2-ts），6nativeerrorlifecycle/zeroGPU，全 focus 后 fullbrowser，保留 fail。pairedreplayworkindex 按 swapchainprovenance/trailingprobework 对 selection，共 appselector 拥有 default/explicittransport、sameartifact/backend/pixel 保。

Dawnpartitionroster actualtitle 大小写对 run-dawn-partitions，VFXstandalonePlayerMeshFilter 两 mode 归 mesh，uniquecoverage/assert/failedreject。38488147135@9ef74f951按[artifact/Play](../../scripts/ci/README.md#artifact-sharing-and-adopted-play-readiness)，liveWeakRef 与 collectrefetch、hiddenfatalmarkup 与 realstartup 分，MCPBackendlog 归 spawnCLI、120sreadycleanup。7a25ead8e 初连/mobile 按[并发连接](../../scripts/ci/README.md#first-workspace-connection-and-concurrent-validation)，ownedBackendstage/fullpointer，少 compilerinvocation 不 qualifydeadline。Snake latejoinACKretry 按[ACKadmit](../../scripts/ci/README.md#multiplayer-startup-and-baseline-ack-admission)，Worldreceivesystem 初 poll、真实 browser delayedHost，不扩 ACKbudget。

## 冷编译器与图形准入

declared-standard-material.integration.test.ts 的 clearcoat publication timeout，应在原 exclusive coverage file 验完整 material compiler 和原 deadline。先以唯一 owner、无竞争 instrumented child 建立证据，再改 runtime。普通 publication 继续原 storage WebGPU/file cooker；独立 cold compose/cache owner 保 portable 行为，通过真实 program selection/instrumented coverage 验证。Three render-reference-replay 保 fresh Browser/exclusive、原 native/reference/replay frame/bound；不能为 graphics 竞争放松 pixel/capture。

## 渲染：先使用 RHI Debug

复杂或原因不明的渲染故障，先使用 [RHI Debug](../forgeax-engine-rhi-debug/SKILL.zh-CN.md)，采集真实失败帧并检查工作、绑定、资源和像素，再考虑修改 shader 或材质。这适用于缺少输出、光照或阴影错误、闪烁、后处理伪影和后端差异。明确的启动、资产、schema 错误直接交给对应 owner。无法采集时保留结构化失败，遵循 RHI Debug 恢复路径。

损坏的 demo 可能暴露 Engine 的能力缺口；沿所有权追查，不能用占位资产、手动帧循环或 demo 侧 fetch 绕过。没有相机的 World 合法：empty 启动出现 `render-system-no-camera` 时追查 renderer，不要求添加 Camera。模板 Browser smoke 应拒绝该事件，而不是豁免空场景的控制台检查。

配对 View 安装缺少 `@forgeax/engine-modeling` 时，先准备 Engine 固定的 `packages/modeling`，再执行 pnpm install，保留准备过程的 checkout 凭据。GPU 纹理预览缺少稳定版 Chrome 时，首次启动和冷重开都采用维护的浏览器 channel 或显式 executable，保留沙箱、像素及生命周期检查。

配对发布先验收并合并 View，再更新 Engine gitlink；Engine 要求维护分支祖先关系。完整成功的 View cohort 可保留原 build 和四个 Browser 执行；部分完成的 cohort 需要新 artifacts。晋升 main 必须使用与验收完全相同的 PR tree。合并后查询不到 PR 时，追查 source、branch 和 commit 关联，不能用旧绿灯掩盖更新的失败或未完成验收。

## CI 诊断与迭代

### 安装入口、质量门禁与执行权威

安装入口契约失败时，在同一 workflow 入口的每次 filtered frozen pnpm install 前运行 `prepare-pnpm-workspace.mjs`，保留 package filter，再执行对应契约测试。Core preflight 在 native 准备前执行原入口检查；完整 primary lifecycle 批次仍必需。macOS compiler-cache 路径不符时，先规范化 fixture 临时根目录，再推导预期路径，保留精确 source 隔离和 artifact 断言。

`check-no-assets-load` 失败应检查命名 Pack 的生产依赖。`AssetRegistry.load` 是合法游戏运行时 API；guard 约束的是 Pack 离线 source/evidence 边界。Pack 不引入 runtime，并保留“允许 game、拒绝 Pack”的可执行回归。

手动运行拒绝目标分支已存在的 evidence 时，检查 guard 的比较基线，按[手动 CI 比较基线](../../scripts/ci/README.md#manual-ci-comparison-base)通过 comparison_base 传入实际 target SHA。保留新增 evidence 拒绝和完整产品检查，不能删除无关基线文件补偿缺失的 PR event base。

synthetic merge 安排八个 Dawn lane 而产品 source 只接受四个时，在 main 集成时对齐 workflow 和执行 selector。SDK ZIP/npm 分组及 receipt aggregate 同样对应四个 consumer。缩短 native owner 数组时，先按原文件身份映射保留的成本，再赋新数字组号。保留 native、像素、生命周期和 seed 身份检查；执行前 selector 失败不代表后端失败。

function-complexity 或 dependency-vulnerabilities 失败遵循[源码质量棘轮](../../scripts/ci/README.md#source-quality-ratchets)：拆分所属函数或升级所属依赖声明；基线增加需要经过审查的理由。撤回公告留下旧例外时，先验证上游状态和当前 lockfile 扫描，再删除。Atlas matcher 修改保留有界 built-CLI 用例、两个正向 glob 对照和同步 lockfile。未维护依赖没有补丁版本时，检查锁定 target feature tree；未使用的 optional Cargo adapter 只有在给出精确 manifest、不可达证据和到期时间后才可接受，仍保留 digest 固定扫描和新 CI 验收。

CI 减量遵循[CI 代码所有权](../../scripts/ci/README.md#ci-code-ownership)。合并后 roster 或 fixture 成本骤增可能恢复了已退役工作；检查删除历史，保留共同预算、四 job matrix，以及真实新增功能和生命周期覆盖。[SDK consumer 映射](../../scripts/ci/README.md#sdk-consumers)规定 npm diagnostics install 也运行已发布的 Game 3D Play helper，ZIP project 保留 TypeScript live/cold。本地 Engine View 成功不能验收 installed Play snapshot；修改 deadline 或拆四 consumer matrix 前先读失败 owner 的阶段日志。

复现使用 `pnpm ci:focus --kind <kind> --select <selector>`（也可 bun fx ci）。本地 Actions emulator 和 workflow-string snapshot suite 已退役。明确列出的 Node planner suite 在 locked install 后从源码运行，保留所有断言；native 和生成输出 owner 保留原准备。改 CI runner script 时，除 focused tests 外，还跑 Core 相同的 pnpm run lint 和 pnpm check:function-complexity。TypeScript test 新增或改变 JavaScript helper import 时同步显式声明，并在 workspace 准备后运行 `node node_modules/typescript/bin/tsc -b`。

改 Coverage placement 时检查完整 planner suite，对比所有保留历史场景的精确分配与 lane forecast，以及两种当前 typecheck 模式。Profiler D-6 启动优先重开已验证 Core BASE+SSAO 字节，保留原 paired frame 与 allocation 门禁。repair 缺 shader cache 时，用 Node Focus 执行 recover-repair-shader-inputs.test.mjs 的原有界 archive 恢复；Core producer 计算两种 source fingerprint 并验证每个恢复 payload，profile 改变或不可用时仍源码编译。

workflow 修改同时运行 Actionlint 和 `node apps/hello/triangle/scripts/ac-08-grep-gate.mjs`，并完成最终 head CI。artifact 字节和 source admission 仍在真实 consumer 强制检查，不重建 timingRoster 或第二套预期 workflow graph。Smoke schema 3 使用 scalar oracle 和 manifest-owned 命令，保留精确成员关系、拒绝混合 schema receipt。Bun 直接消费 core/shared artifact，检查自己的 install/build/runtime 路径；重复 source scan 留在 primary owner。

可选真实 GPU timing workflow 在单 job 验证 producer report；已退役的 host-contention admission report 不再是资格声明。workflow 和 executable roster 是调度权威，不恢复 terminal-SLO projection、cost ledger、DDC relay、feature-branch attestation job。Node/pnpm setup 只有一个共享 Action；Smoke receipt 验证留在 required aggregate。成功后读该 job 日志，失败后读原 shard evidence。

[CI 运行指南](../../scripts/ci/README.md)拥有四 Browser lane、四 Dawn lane、core Smoke roster 和四 SDK consumer。每个 matrix 含平台条目在内至多四个实际 job。将诊断通过视为复现前，比较 Focus 与完整 CI 的 CPU admission。material-edit fixture 在 Browser/Dawn 共用一个完整 case 预算，仍执行全部生命周期、像素和错误断言。dpkg 中断状态使用现有系统依赖安装器；目标 repair step 被跳过仍缺恢复证据，即使 job 为绿。

Browser 实测 roster coverage 失败时，按[成本公式](../../scripts/ci/README.md#browser-gates)从完整 process receipt 补齐成本，保留 source-run provenance，区分摊销 group 成本与独立文件 timing，维持 coverage threshold，避免重复计算启动成本。

TAA Dawn 全零 readback 时，检查真实 RHI capture 的 native pipeline validation，并在 fixture 使用验证过的 async pipeline creation；unfilterable float texture 搭配 nearest sampler 时需要 non-filtering layout。resize 等价失败先比 frozen reference 与 production attachment，再改 WGSL；texel 边界 witness 避免精确插值平局，保留 physical-lattice guard 的 GPU falsifier。

suite 有意保留代表性 core coverage：独有 Browser transport、Worker、media、recovery 用例不能删；共用数值 fixture 可归一个真实后端 owner。已删重复测试和旧调度 guard 保持退役。live-dev-client startup-deadline teardown ENOENT 时，保留 500 ms 项目 deadline 和 3 秒 case bound。detached fixture child 可能尚未发布 session file；删除项目前停止实际 spawned child 并等待退出，保留 owner-liveness 断言。

### Dawn、View、Coverage 成本与完整性

Dawn job 在 27 分钟界限于 native 执行期间或之后取消时，结合 annotation、完整 owner 成本和 [Dawn 成本表](../../scripts/ci/README.md#dawn-gates)检查 runner variation。保留取消 receipt，以完整最终 head CI 验收新 placement。同 head 完整 lane 重试再次超时，必须先刷新完整 file/owner 成本；只有证据支持才归因瞬时竞争。

从多个完整 native roster 更新原 file/owner 表。fixed reservation 与观察尾部不符时，在四 lane 内重分完整 owner，普通 file 仍由同一 sequencer 安排。取消 run 只接纳独立完成的 owner 和 ordinary-file receipt；部分 owner、未开始尾部都不完整。调查 artifact 保留逐文件 observation provenance。deadline 恢复取 inherited forecast 和新完整观察的较大者；未观察文件保留保守 fallback。计入 ordinary file 分摊的 native process 开销，以及 fixed owner 完整 child-process/cleanup 成本。大量新文件套用最大文件 fallback 时，近似文件数不代表近似工作量；归因 runner 前报告 measured-cost coverage。

历史 full-profile run 42929802533 保留四个完整 ordinary receipt、28 个完整 native owner。shadow-fields 只完成 9/12 断言：保留 172.358 秒历史 reservation，排除 75.378 秒部分 process。将完整 442.941 秒 modeling-s6 从 lane 1 移到 lane 2，重放所有窗口，保留当时 40 分钟 Dawn deadline；placement forecast 见成本表，完整 Nightly 仍必需。

View parent timeout 要比较四 shard 完整 owner receipt。Game 3D 阶段连续、语言 live/cold 链完整、RHI page 在 lane 首位。必要时将实测 diagnostic probe 分为完整 owner；完整 Modeling journey 放在有实测余量的既有 lane 最后，中断 journey 保留先前完整 forecast。保留所有命令、四 job、30 分钟上限，遵循 [Modeling 窗口验证](../../scripts/ci/README.md#modeling-window-verification)。

完整 GI journey 到 native step deadline 附近才开始，先用原 placement-reserve admission，再 ordinary backfill。慢 runner 将两个 Modeling owner 放大时，在现有 lane 分散独立长 capture journey。部分执行不作实测成本，保留此前 replay scenario；在不改测试和 deadline 的前提下证明 journey 提前开始。coverage parent 上传 artifact 时取消，即使 children 全通过也无资格；再次完整 final-head 前重放完整 child，预留 typecheck 与 transfer 空间。

取消 job 中已完成 ordinary process 可作成本观察，中断 owner 和未开始尾部不行。缺 process-start 时先核实完整 file 身份，再接纳 emitted file set。接纳更大 observation 前冻结旧缺失 owner 的 forecast；新测量进入当前容量及独立 replay，不能追改历史 cohort。改变 execution window 前穷尽四 lane 首波排列。

完整文件重分仍无法满足原约束时，评估完整 native owner 转移，再跑所有受影响 lane；成功子分区不能测量已中断整个 owner。native worker 退出时，对比选择 roster 和 emitted results 找缺失 owner；在 fresh process 验证完整 capture/replay，若涉及共享 native lifetime，再用既有 isolated-owner 路线。保留所有 file、断言和 deadline，失败 process 不提供完整成本。

中断 owner 中已完成单文件超过原 reservation，说明旧 forecast 已被推翻，但仍没有新完整时长。CI guide 的 reservation estimate 使用该 file 对比完整匹配 roster 的 slowdown；将 estimate、假设和原失败与实测 owner 时长分开，仍需完整 final-head CI。

成本变化会自动移动 ordinary work；手动移完整 group 前，重放四 lane 当前 discovery。缺历史成本标 forecast，setup 与 runner variation 独立报告。保留四 job、27 分钟 deadline、frame window、后端断言。上游删重复 wrapper 时，以实际 discovery 对齐 explicit owner，heavy-group 成本按文件身份映射，不能用旧数字 label。

新完整观察超过 forecast 而其他 lane 提前结束时，先用保守最大值重放 discovery，再搬 owner；单次异构 runner 观察不能降低成本。中断 owner 保留历史 forecast，未测尾部单报，要求完整 final-head。Transmission、Shadow、Screen Probe、多视图 GI 的完整 serial native process 成本不能集中一个 lane；Surface、VFX depth、Direct Light 同样分散，ordinary 新成本共用 placement。Core flow self-test 留在 primary 原回归批次；source admission 和真实产物生产留在 core producer。

shared-input producer 慢时分开 cache admission、cold shader compilation、catalog 准备。使用原 heavy pool 和共享 cgroup capacity 检查，worker 数取 cgroup capacity。归因资源分配前比较完全相同 cold output/CPU work；cache-hit timing 与 compilation speed 分报。declaration Worker 出现 ERR_INPUT_TYPE_NOT_ALLOWED，以真实 Dawn preload 复现；fixture 从文件启动，不把仅 eval 有效的参数传进 tsup Worker，保留 declaration 内容断言。

Coverage 慢尾遵循[执行规则](../../scripts/ci/README.md#coverage-execution)：ordinary child 先占满可用 slot，再 exclusive phase。完整 run 更新已有 project cost，不能加 worker exception。Render/Vite Pack 各自保留 ordinary child，将大 import 成本归本包。完整 lane estimate 含 type preflight 和每个 exclusive owner；过期 exclusive cost 会把 serial tail 集中一 shard。

Browser 跨 runner 校准取历史与完整 child 摊销成本较大者；分组前计入已完成 Runtime Pack Worker/Mesh 尾部，未开始尾部留旧 forecast。失败 parent 可提供成功 child timing，不能提供 full-CI 成功；setup、queue 分报。DevKit/Render broad half 在 fine partition 波次后启动太晚时，该完整 half 在 job 先入场，并在模型保持顺序，保留 exclusive barrier/full roster；中断 child 不作 sample。

同一波次 rank 仍聚集时，将完整 fine wave 原子分布到同四 job，避免 greedy 死路；保留精确 file discovery 和 exclusive source headroom。child-cost ledger 保留完整 child 观察和历史最大值，refinement 只能在原 capacity envelope 内平衡。验证真实 CLI typecheck override：runtime coverage child 不重复中央 declaration-test owner；修改 Vitest project-override patch 同步两 lockfile。

完整长 project 切 native partition 时，两 half 在 initial placement/refinement 始终不同 job，不能因两个 parallel slot 又集中同 runner。用实际 discovery/配置 sequencer 证明文件守恒，保留 exclusive owner、ordinary non-coverage route、concurrency、heap 和 deadline。type-test root 保留选中 tests、imported source、ambient declarations；普通 source check 归 core/primary。

runtime-vase Browser 慢尾先确认共享 canvas budget 生效，再改 UI；完整截图与两条 60 帧路径保留。View diagnostic resume 同时等待真实 buffer resize 和 frame completion，旧尺寸完成不是 resize evidence。Play capture 后 pick 报 extent-mismatch，检查 completed receipt output mapping 与当前 drawing buffer；之后 resize 会使旧 ready completion 失去截图资格。

Coverage 分开估算 parallel phase 与 serial exclusive tail，共享计划独立于 runner 执行资源限制。Browser 使用 browser-file-seconds.json 完整 child 成本（含 startup/cleanup）与实测 serial tail，不另加固定 startup surcharge，最长 lane forecast 在完整 CI 验证。多个文件通过后 group timeout，要看完整 serial batch：ordinary batch 共用测量表，原五分钟 deadline 内目标 150 秒，isolated owner 保持完整。

### GPU fixture 与产物归属

大型 capture transfer 复用共享无损 compactTape fixture。保留 seeds、events、pixel check、真实 replay falsifier；只有 retained tape 可重建且无 downstream consumer 时才省去重复 work/resource JSON。Smoke placement 使用当前完整 gate time 加 post-roster tail；退役工作同时移出估计和执行。

App build slot 闲置先查启动顺序，原 input inventory 优先较大 closure，不另设成本表或加 concurrency。live-sync 共用 disposable-project reducer，保留真实 CLI/daemon/browser journey；fixture 缩小与实测耗时影响分报。Mesh 保留十六条 distinct route 和所有真实 capture/replay/falsifier；成功 CI 仍保留每个 offline analyzer input，可省重复 control tape、geometry dump、preview。必须跑整个 Mesh verify package command，单 Browser script 不验收源码数值 oracle。

GI load 使用共享 ray budget 与较小 two-level multi-view grid；edit/rebuild convergence、movement signal/noise、Screen Probe history、多视图 fairness 两后端仍用 64-ray override。共享减量在 Dawn 和 native Ray Query 都验证；低 sample oracle 失败不能放宽 threshold。volumetric fog 只有一个 required Smoke owner，已删 Dawn wrapper 重复同 script；额外 byte-difference 断言已归 script。

Dawn 时长须区分 static setup 与 temporal acceptance。未改 material/color fixture 复用 render-quality.json 的 static frame count；Surface optical/MSAA、Forward/Deferred parity、clipping、lighting-channel baseline、material MRT、framebuffer preparation 共用该预算。shadow-field 比较共用 map size 并保留不同 half/twice-size pair、全部十二断言、fresh host、varied/held pixel control。保留 cube-face completion、recovery window、pixel/replay falsifier。Lens sample 显式六帧并保持 composition window，维持 60 帧 fixture lifetime；convergence、async readiness、canonical 60 帧 smoke 不变。

移除无成本界的 report-only GPU benchmark。GI pass-presence 复用 renderer-irradiance-field.fixture.ts 的连续帧观察，保留逐帧 absence、数值阈值、replay、falsifier。Direct-light regression 与 HDRP producer 范围独立：pnpm test:dawn 拥有 regression，required color-lighting metrics 拥有与 Browser URP 联合的四份 native capture。producer 失败执行 `FORGEAX_DAWN_PARTITION_SCOPE=producer node scripts/ci/run-direct-light-dawn.mjs`，每份 live capture 直接复用于 artifact 检查，不重渲染。

Mesh interchange 保留不同 format/material/camera/skin route；重复 OBJ/GLB 性能 sample 归 opt-in fidelity benchmark。可选 Mesh、lighting-channel/GI、Wave 1 capture 仅失败上传；成功查看 check log，不能将可选 artifact 缺席视为缺验收，required producer artifact/receipt 仍必需。

读取失败 head 日志，分清 preparation/execution/teardown/transport，通过所属 package 或 ci:focus 复现。保留真实 backend/失败断言，修 owner、跑相关检查，再用最终 commit 完整 CI/SDK 验收。60 帧 smoke、pixel threshold、negative control、coverage threshold 不变。FBX skin 已记 pass 后 exit 139，检查 standalone smoke native teardown：先退役 Renderer、World context、offscreen target，再排空共享 Dawn owner 后出 receipt；验证真实 60 帧及 FALSIFY=static，本地未复现不验收失败 CI。

### 构建输入、安装与共享资源

缺 output 需[源码 build 或已验证 producer artifact](../../scripts/ci/README.md#cross-platform-host-build-inputs)。CI consumer 先 restore/verify；真实 source-build miss 才通过共享 Action 准备 wgpu、Rapier、Blitz UI、Codec。SDK Candidate UI contract 失败时，检查 parsed YAML 中 verified shared-artifact 和 source fallback 两分支条件，保留 receiver cleanup、source/byte 验证、先准备再 build。

干净工作目录在 frozen install 前准备 pinned submodule。assets shallow.lock 由 prepare-assets-checkout.mjs 处理：只有排他、匹配的 Actions workspace 可恢复早于本次 source checkout 的 lock，保留 local/current-job lock 与 foreign-Git-directory 拒绝。native payload 验证 source/recipe/bytes；CI Focus 即便 Browser selector 也在 Engine build 前准备 Rapier。Chromium 始终启用沙箱；使用本地 GPU lease 与既有 cleanup，不加 retry、deadline 或 per-test scheduler exception。

Rapier cache miss 比较 build-rapier-native.mjs 的 key、cache entry 和 verify，producer content key 拥有完整 input closure。验证成功后 post-step upload 卡住，按 [Build inputs](../../scripts/ci/README.md#build-inputs)检查 verified payload cache；跨 run 复用 payload，不额外上传 Cargo target archive。fetch 401/exit128 检查 URL 匹配 checkout HTTP 配置：临时 Git repo 经 git-http-environment.mjs 接收凭据并有界 fetch，不打印或持久化 authorization header。

多个输入准备同时失败先查 core producer，成功 upload 后才能 fanout。prepare-ci-inputs Action 先验证恢复字节，真实 source miss 才准备 wgpu/Rapier；成功恢复路径不做 native preparation。filtered pnpm install 若没有 ignore-scripts 仍运行 root hook，先查 Harness clone postinstall 成本再归因 Rust/cache。以最后执行的 producer log 区分 Action download 与 artifact transfer；Getting action download info 在 composite 前卡住也可能源于未使用 cold-path Action。wgpu fallback 共用 payload 的 GitHub cache Action，避免另解析 Rust-cache Action。

cold install 对比下载平台与真实 host。普通 CI 在 install/run/exec 全程保持 PNPM_CONFIG_SUPPORTED_ARCHITECTURES 一致；仅 install 临时 flag 会使 pnpm12 重装 broad closure。prepare-pnpm-workspace.mjs --install 不使用 force/root postinstall；filtered frozen install 同一 preparer 加 filter，先 cleanup 后解析依赖，不扩大 closure。SDK PR preflight、benchmark、SDK source-rebuild reinstall 同路径；退役 workspace importer 不构成重生成 lockfile 的理由。SDK 发布仍要完整 installed platform closure，准备归 distribution owner，不能改全局 workspace policy。

Snake Browser ACK 耗尽，检查 process fixture 在自管 ACK-paced World 更新前关闭 server 自动 clock；双 clock 绕过 backpressure，真实 socket recovery/retry bound 保留。Rapier Rust 完成后 cold preparation 卡住，查 wasm-opt 与 cgroup cpu.stat；共享 Action 通过 runnerResources 推导 BINARYEN_CORES，上限四线程，Cargo worker limit 不约束 Binaryen。用真实 CPU quota 复现，不能只有 affinity；保持 optimizer flag，比 payload hash。

shared catalog/shader preparation 不需 Runtime/Rapier：empty Vite entry 不载 Runtime dev transport，production selection 排除 Runtime、两维 Rapier，native 准备归实际 runtime owner；Codec 属该 closure，仍需准备。正负 selector 都用 filter-prod，混用 selector family 可误含其他 workspace。LOD FORGEAX_E03_INPUTS_DIR 失败，对照 hydrated app shader manifest 检查 CI 原 importer producer 准备。

DevKit native unit queue 中，new-project-workers CPU 准备在外层 GPU lease 之外，native-unit-owner 为已准备工作取 lease；scene-bootstrap 直接用 WebGPU，保留外层 lease。split-unit runner 从共享 file-set 定义将两个完整 journey 排最后。

DevKit Browser 慢分别测 Vite server 创建和首个 presented frame，并查 active fixture 的 authored-Pack timing。轻量 Worker、live-look、MCP Game3D、Runtime Vase 各自拥有资产，共用 optional Engine content mount 的 opt-in reduction。View JS live/cold 链同置 shard2，为 shard0 留完整 Runtime Pack Browser owner。library admission 独立 owner，full profile 保留 template mount。轻量 Worker interaction 可省 optional local reflection probe，但 IBL diagnostic/full profile 保留 authored probe。

Windows GPU timing lifecycle child import 用 pathToFileURL 转 built fixture path，保留 real-device receipt GC、destroy count、child-exit 断言和原 deadline。资源探测/并发预算归 [runner-resources](../../scripts/lib/runner-resources.mjs)，ordinary fixture 尺寸归 [render-quality](../../scripts/test/render-quality.json)。Coverage child compiler budget 按 container capacity：parallel child 共享 CPU/memory，exclusive 拥有完整预算；shard membership 不来自具体 runner quota。

multiplayer Browser ACK stall 检查 session error、drawing buffer、presentation viewport。browser-canvas-budget.mjs 约束 App canvas，Snake 也从共享 budget 推导 presentation/screenshot 尺寸，限制 software Chromium 合成。保留真实 network journey/finite ACK policy；后一个 client 入场须等前一个 App 完成首帧，只有 join 不够。各 client 独立 Chromium process，context 仍共享 GPU process，一个 device 启动可阻塞另一 client 的 frame ACK。Pack inventory coverage timeout 保留 oversized-cache boundary，mutation check 用原 small-input snapshot owner。过载修复复用这些 owner 与 disposable-project reducer，不另加 probe/per-consumer patch。

Dawn import 成本使用 builder 已准备 JSON serialization 和共享 manifest URL fixture，不展开重发布已验证 block，不以 path-only cache 替 source validation。保留 native isolation；断言过但 worker termination warning 仍不验收 shared-module 实验。CI guide 定义昂贵共享 fixture 的 Browser/Dawn owner 与显式高质量 subsurface control。

Core upload stall 区分 CreateArtifact retry/blob transfer，保留有界 PR upload/source recovery，只有 core transport 失败仍保独立验证的 shared input。Core transfer map 省嵌入 source text，保留 coverage 所需 JavaScript mapping；declaration 源码构建，不用远程 declaration cache。lighting-channel Browser 用 ordinary bounded batch；Dawn shadow-fields 十二断言保留在三个 native process。

Browser startup stall 查 Pack/authored material preparation，explicit group 使用 workspace owner/声明 shared source root，包含经共享 fixture 引入的 material contract。保留 deadline/首次失败，whole-group 自动 retry 保持退役。core/shared-input stall 查 ci.yml 共享 native shader step、profile fingerprint、portable receipt，再比较 cold/cache。cache restore/save 各一分钟 step deadline，segment download timeout 不约束 metadata；cache timeout 仍到 mandatory source/byte verify 和 source fallback，不能继续 save。

shared catalog timing 包含前置 profile preparation；显式 shader input 复用前 admission，缺失重建。source producer 验恢复字节并重建 miss，只有一份 receipt，Actions cache hit 也 admission。Coverage 从 admitted core/shared product 准备 base/point SSAO；standalone SSAO/Vite manifest 断言编译 full fleet 时，先查准备，不改断言。cold source production 与 worker lifecycle 保留 focused owner。

SDK package verification 拥有默认 production build，custom-base empty project 保留 direct CLI coverage，原项目从既有 build 打包。SDK subprocess 失败先 pnpm test:sdk:contracts，再 installed consumer。public-source View device loss 保留 Playwright process output、原 tape、selected work index，验证 fresh-device disposal 和真实 captured pixels；本地通过不能验收失败 SDK consumer。

npm consumer ERR_HTTP_HEADERS_SENT 查 response header 提交前 upstream body read。sdk-lib.test.mjs 使用中断 HTTP response 执行 build/preflight/publication listener，保留 502 与后续成功请求。SDK packing 对比共享 archive writer compression time/bytes，所有 npm carrier 共用 deterministic level6；source build 在 runner cgroup 内普通 priority 串行执行。SDK doctor/test/build/Browser 共用一份 disposable consumer copy，256 方形 shadow map 保留 authored 三 cascade，archive 不变。

installed View 保留 JS/TS live publication、JS cold reopen；Game3D build/input/rendering 归 SDK Project，完整 Play/restart 归 Engine/View integration，不另跑 installed View。View Game3D 从 paired Engine 导入 reducer。准备期 Stop timeout 按 [Play preparation cancellation](../../scripts/ci/README.md#play-preparation-cancellation)，保真实手势、matching request cancellation、原30秒恢复；之前 Preparing label 不能分类后来的 adopted Stop，native readiness/cleanup 独立必需。

adopted Play 在 document 到达前隐藏时查 CSS：visibility:hidden 会暂停 native iframe rAF。Engine cleanup ACK 前保持透明且 pointer-inert，保120秒 bound/真实 frame 和 cleanup。MCP Host response contract 等实际 query admission，原500ms reply bound 内排空 native response event；保三 blocked query、四精确成功 reply、async service work。

### View 分片、发布与外部故障

View 尾延迟取 run-view-integration.mjs per-owner timing。保四 shard、完整 owner、JS/TS live 和 JS cold；保历史 completed maximum，用 post-pairing Browser gate 和已观察 source recovery 重放 timeout 窗口。中断 owner 用前次完整 forecast，paired step 成功后仍预留 runner cleanup，保30分钟上限、120秒 setup/transfer reserve。

| Shard | 完整 owner |
|:--:|:--|
| 0 | Contracts、Engine-only、texture preview、Pack authoring、GPU texture 2D，然后 POINT Runtime Pack Browser |
| 1 | Game3D、lifecycle、Pack save/reopen、GPU texture array，然后 POINT Project Play |
| 2 | Plugin、workspace、runtime JS |
| 3 | RHI pages、runtime TS、Modeling |

Modeling 最后，避免后续 Browser journey 继承其 GPU 工作。preview capture 等 overlay、选 Mesh page，再要求该 target 下一 completed frame。成员改变同步 placement contract/两份 CI guide，四 shard 全 fresh。移除重复 diagnostic observation 仍保真实 post-profile game-state assertion/failure capture；backend restart 后、任何 project intent 启动新 GPU game 前运行 projectless no-WebGPU probe。

diagnostic 共用 canvas budget，区分 CSS layout/drawing buffer，hidden/resume 间保真实 realloc。故意 retire View target 后断言 lost state，通过 guarded workspace reopen 再挂新 Scene；不导航旧 target，不在 tab click 前尝试 drain 它的 async notice。reload/service restart 后显式选 RHI Debug，默认 Scene；保留 guarded target identity 和独立 run 检查。replay device-limit 失败比较 capture/replay channel 和 adapter limit，View Linux 默认跟共享 browser config。

Learn Render observation stall 用 monotonic clock 测完整 quiet window，五秒原界内新 error 重启窗口。nine-light 共用 exclusive Browser admission；Boss Lightning baseline/field 与 SDF 命令保独立 Smoke receipt owner。

full SDK Candidate 在 source producer 后保四 parallel consumer、full-scene profile window、完整 seal。单 consumer 成功不能资格认定 Promotion。npm visibility/publication transport 失败按 [release recovery](../../scripts/ci/README.md#sdk-candidate-critical-path)，对 completed Promotion 只 rerun failed jobs，不重做成功 qualification/publication；区分 submitted/staged npm bytes、public metadata、exact tarball、fresh consumer。

Candidate seed 在 verify 前 transport 失败按 [SDK consumer guide](../../scripts/ci/README.md#sdk-consumers)复用 bounded downloader，保留 exact artifact count/source/bytes。只有 source 不变且 required artifact 完整才 failed-only retry；source repair、expired input、cancelled run 需要新 Candidate。失败 run 保留的 artifact 不能授权 Promotion，controller 要求 completed successful Candidate 和完整 seal。

> [!IMPORTANT]
> 已证明仅外部 transport 失败，才仅重跑 failed job。通过的测试前缀、取消尾部、缺失 artifact 都不是成功。比较 job execution 与总 runner occupation，queue 单报。新 run evidence 记录 delivery PR，不追加到此技能。

多线程 frame-p95 比较是显式 bench:production 诊断；ordinary CI 在 shared-inputs-browser 保留 capability、Worker recovery、raw-kernel speedup，共用 setup、不改 build dependency。GPU timing refusal/null-backend/artifact-validator unit 归 Render coverage；短 consumer probe 不放 core/shared、artifact、metrics producer。端到端性能声明需稳定 benchmark 条件，只有 CPU capacity/affinity 不够，raw-kernel 证据范围更小。

copy timestamp envelope 含 marker/sync overhead；原60帧 gpu-pass-timing-copy.dawn.test.ts 验 ordering、bytes、query retirement、recovery，较大独立 copy 不必 envelope 更长。重复 copy-size 比较不回 correctness gate。SpecularAA 保留 image reference/G-buffer replay falsifier，无 threshold 的重复 cost report 保持退役。Dawn lane 取消比较 completed process/unfinished tail，等 container CPU budget 不证 runner 等速或 estimate 通过。

managed scene-SDF 按 [guide](../../scripts/ci/README.md#managed-vfx-scene-sdf)及真实 carrier evidence，缺 Pack index/field/program artifact 归 app-shard preparation，GPU admission 前准备。SDK dirty-source 查明确路径，retired submodule cleanup 只在 disposable CI checkout 后、prepare 前；不清 contributor checkout、不关 source admission。

backend-stop deadline 保留 owner log/native disposal trace，健康 game 或完整 replay 不证 retirement。replay 像素通过而 native shutdown 崩溃，追 bootstrapDawn disposal lease 全 caller；await replay disposal 和 native owner，对 opaque RHI device 调 optional destroy 无效。按 native cleanup order 包括 replacement timestamp device，再认定 pass。textures bootstrap 保原 exclusive short-renderer owner/deadline，isolated pass 不替完整 CI。

Browser Catalog HTTP failure 先查有界 failed-source response observation，再查 rendering；observer 保原 scoped Catalog response、不加请求，没观察到 body 仍 unverified，保原 failed check/producer error。Preview Catalog startup timeout 区分 Vite listening 与 Pack accepted；查现有 stage timing/native cooker admission，dev wrapper 明确 concurrency。ScriptablePack 只 batch opt-in reentrant output，上限四个，保留 authored order/failure draining；保留 Catalog deadline/full source closure，isolated startup pass 不验收 Browser gate。

native startup/Preview first-frame timeout 按 [recovery](../../scripts/ci/README.md#failure-recovery)，缩 smoke fixture 前看真实 frame resource。CI 共用 bounded native batch、render-quality 和 project reducer；场景未写 quality field 时也检查 capture dimensions，reduction 必须限制 Engine default。审 fixture quality 跟 literal new URL Worker bootstrap，ordinary geometry 同样声明 shadow map/cascade workload；DevKit runtime-browser companion 虽 Node 文件也可拥有真实 Playwright buffer。保留 quality/capacity owner explicit override、完整断言和 deadline。

native replay cost 查单次 read 是否重置重放相同 GPU prefix；独立 selected-work read 可 batch，保留 exact provenance/intermediate bytes，独立 falsifier 使用 fresh device。Three shadow timeout 以 light/mutation label 联合 three-shadow-measure/three-render-replay；milestonesMs 为各 operation 起点累计值，相邻相减定位 capture/upstream/cold replay，已 schedule 不等 completed。保留 case deadline/fresh replay device。

完整 shard 比 Focus 慢时，比 runner-cpu-pressure delta 及不同 container/host PSI scope，缺 counter 保留 unavailable；累计 throttle/host pressure 不能独自归因，分测试不证完整 journey 更快。每 shadow case pass 前排空 replay slot；独立 public phase case 各有 completion barrier。单完整 case 可通过同两个 immutable-capture slot pipeline 内部 live phase，返回前排空全部 fresh replay。保留 controls/case/process bound，teardown 不能补 case 验收。Nested Discard 保留 ordinary pixel assembly/bounded shadow，temporal capture/replay 独立归属，fixture 实际 device/shadow inspection 守边界。

shared archive timeout 后 build-shared-app-inputs heap 耗尽，查 recovery child Node flags：与正常 shader producer 同 bounded4GiB parent heap，独立于 compiler worker admission。保留 verified core、完整 shader publication、原 transfer/recovery deadline，见 Build inputs。

native Host failure 按 [build input](../../scripts/ci/README.md#cross-platform-host-build-inputs)、[Rapier](../../scripts/ci/README.md#native-rapier-artifact-admission)、[Codec](../../scripts/ci/README.md#codec-payloads-before-native-factory-builds) owner。先查 explicit Host initialization、forgeax-native condition、source identity、完整 generated inventory，再 runtime 诊断。保留 retryable initialization/真实 native test，缺 Host boundary 如实报告，不拦全局 WebAssembly。实际 simulator/device evidence 独立于 Node。

无外部 Pack 的 UI fixture 用 explicit Browser source selection，mixed selection 保留 closure。maintained project runner 丢 selected Browser file，查 config/browser-file-selection.ts，经 run-vitest-projects.mjs 复现原 file；Vitest CLI/runner 必须同 file、optimizer entry、authored Pack root。保留 broad/mixed selector/unrelated-runner guard，先 nearest vitest-browser-project.test.ts，再独立保原 connection/pixel deadline 下真实 Browser acceptance。

compact manifest failure 查 v4 source fragment/resolved receipt fact；相同 numeric index 不等相同 ABI value。frame probe 等 submitted receipt 的 completed-frame signal，不等 animation callback。

## 英文指导文档门禁

修改 agent 指令后运行 `python3 scripts/forgeax/check-agent-docs-english.py`。保留命令/API 标识，标题变化同步链接。固定英文入口仍接受英文检查；明确命名的中文副本供人阅读。

## 症状索引
| 症状 | 可能原因 | 参考 |
|:--|:--|:--|
| Linux/CI 无可用 GPU，需要 CPU profiling；requestAdapter() 为 null 或只有 software adapter | 没有可用 GPU；software WebGPU 会把 CPU 测量消耗在模拟上。 | [WebGPU stub](../forgeax-engine-rhi/SKILL.zh-CN.md#webgpu-stub-cpu-diagnostics-without-gpu-work) |
| 纹理 demo 为白方块，缺纹理/光照渐变 | texture paramValues 保留 unresolved GUID string，未转换 Handle。 | White textures |
| spawn-data-unknown-field 或实体不可见/灰色 | data 字段拼错或已过期，例如 MeshRenderer.material 应为 materials。 | Spawn fields |
| 注册 MaterialAsset 报 shader not registered | pack.json shader identifier 过期。 | Shader identifiers |
| 所有断言通过，CI 仍失败 | teardown 的 unhandled rejection 令退出码为1。 | Exit status |
| 只有新工作目录 ENOENT/unresolved package | 未初始化 submodule 或缺构建输出。 | Worktree setup |
| warm HMR 后纹理消失 | vite-plugin-pack DDC 丢 sourcePath 或写入 source tree。 | Pack HMR |
| 仅 Windows 失败或 CRLF diff | 缺 LF attributes 或路径分隔符处理。 | Windows |
| cubemap 上下颠倒 | skybox.wgsl 重复 V-flip。 | Skybox V-flip |
| 矩阵正确且 cascade 运行，CSM 阴影仍全亮 | 负 viewZ 与正 splitPlanes 比较选近 cascade；远处投影离开 tile 返回1.0。 | CSM depth sign |
| castShadow 已开但 mesh 不投影 | 手写 material 没 ShadowCaster，未进 shadow depth pass。 | ShadowCaster |
| Standard material 冷启动/无 IBL 时黑 | async Skylight cubemap 是唯一 ambient source。 | Ambient readiness |
| 多 mesh glTF node 绑定所有 mesh 的 material | bridge 未按 meshIndex 筛选。 | glTF materials |
| 帧中仅一个 mesh 缺失，onError 的 rhi-descriptor-invalid 指出缺 @location(N) | material vertex stage 读取 mesh layout 不含的 attribute；renderer 跳过该 draw，不创建非法 pipeline。补 attribute（三角列表 MeshBuilder 补 normal/uv/tangent），或改用不读它的 material。 | `packages/render/src/vertex-input-guard.ts` |
| pbr-skin pipeline 缺 binding/vertex slot5 | Skin shader 复用 standard PBR layout，JOINTS_0/WEIGHTS_0 未上传。 | Skin pipeline |
| Browser skin 黑而 Dawn 通过，VBO 为768而非1152字节 | parser、bridge、mesh-loader、render-data、pipeline context 或 extraction 链中断。 | Attribute chain |
| hello-skin dev Fox 报 asset-not-imported 为黑，smoke 通过 | 缺 build/submodule，或 sibling 占端口。 | Fox dev loading |
| clip/world matrix 推进但 Skin 停 bind pose | palette allocator/dynamic-offset/extract 连接错误、MAX_JOINTS 溢出，或注册 SkinAsset 前 async instantiate。Skin.joints.length=0 与 JointCountMismatchError 指向最后一种；e5e68b35 增 SceneAsset.skinGuids 和 fail-fast skin-asset-unresolved。 | Static skin |
| 历史 SDK 的 FBX skin animation 变形/翻转 | 已删 binding.cc 将 Euler degree 误读 quaternion 且只 sample 一轴；ufbx bridge.c 用 ufbx_evaluate_transform。 | Historical FBX deformation |
| FBX parity snapshot 失败 | bridge.c 的 axis conversion、material classification、node filtering 或 animation extraction 漂移。 | FBX parity |
| FBX WASM ENOENT | contributor checkout 缺 generated pkg payload。 | FBX WASM |
| FBX WASM Browser 初始化成功，Node 失败 | ENVIRONMENT flag 或 Node 版本不符。 | Node WASM |
| 首帧 SkinPaletteOverflowError needs=16384 cap=16320 | MAX_JOINTS=256 超过 PR361 确立的 pbr-skin group2 binding1 容量。 | Palette overflow |
| Edge adapter-unavailable 且黑屏 | Browser 设置禁用 hardware GL。 | Edge configuration |
| 启动/发布只报 WebGPU、adapter-unavailable 或 object Object | 诊断被压平或只观察一个 backend channel，不足以判断机器不受支持。 | Capability diagnosis |
| WebGL2 fallback validation panic：storage/uniform mismatch 或 VIEW_FORMATS | variant key、graph viewFormats、texture reinterpretation 缺 capability gate。 | Fallback gates |
| WebKit 报 mesh SSBO ceiling0B 且黑屏 | downlevel default 的 maxStorageBufferBindingSize=0 被误当真实上限。 | SSBO ceiling |
| WebKit submit 后黑屏/GPU loss，但无 onError | wgpu error-sink 失败没传 JS。 | Submit errors |
| WebKit probe 报 Surface does not exist，但 hello-triangle 正常 | probe main 有限循环后返回，未保留 Renderer；GC finalize WASM Surface。 | Probe lifetime |
| CI job/cache/skip 行为与旧排障说明不同 | workflow 已变化，应用旧建议前核对失败 commit。 | [CI operating guide](../../scripts/ci/README.md) |
| 长会话 GPU buffer/texture/cubemap 数持续增长 | store eviction、instance buffer、transient resize 或 handle-keyed WeakMap 缺对称释放。 | Resource growth |

打开对应 recipe，以当前失败 frame/process 验证假设；package contract 仍是设计权威。

### SDK、原生执行与 MCP 消费者

PR SDK seed timeout 分开 checkout fetch、assembly、consumer 成本。保留 exact-head checkout/targeted ancestor fetch（capability baseline 要历史），不 fetch 无关 branch/tag，不延30分钟。重放真实 ancestry/source-export/SDK checkout 回归，再要求完整 final-head consumer CI。

resolve 成功后 release-source-not-on-main/stable 按 [shallow release ancestry](../../scripts/ci/README.md#release-source-ancestry-from-shallow-checkouts)，比较完整 branch history 再归因 source drift；release-policy owner fetch 足够历史但仍拒 outsider，保留 sealed Candidate bytes 和 publication guard。

MCP check 为绿但 Scene 黑或 Play fatal screenshot，按 [consumer acceptance](../../scripts/ci/README.md#optional-mcp-app-consumer)检查真实截图、可见 native fatal detail、console error；旧 completed-frame counter 和空 pageerror 不足验收，RHI Debug 保失败帧。Vite cold-start 慢，在最后 package build 后检查并准备 packaged shader input，再按原 Browser deadline 重试。

minimum-limit WebGPU PBR pbr-view-bgl binding mismatch，先保首条 native validation，不被 invalid-bundle/submit 连锁淹没。比 cooked program context 与真实 View topology；storage buffer 不意味着 extended sampled-texture budget。旧 publication 经 Shader compiler owner 重新 cook，再验同 Browser/pixels。

required Runtime Pack plugin 卡 dependency retention，比 native HTTP 与真实 MCP iframe bridge 的同 publication，保首 blocked stage/cancellation cause。改 startup deadline 前查 resource size、MIME-independent wire compression、chunk count；native 快只隔离对照，不是 MCP/GPU pass。不可压资源验证 broker192KiB window/shared document-Worker-Node decoder：stride 取首个真实 chunk，最多四 read inflight。保完整 byte comparison/response-cache bound，在 maintained runner CPU affinity 下重跑 nested consumer。raw artifact-cache miss 重读已安装 material 时先查原 material artifact owner，再考虑 cache/缩 publication；capture 可按 frozen digest 借字节，但仍验完整 publication、拒篡改。

embedded Runtime Pack CacheStorage/ServiceWorker 失败，读 structured game-operation error，查 native frontend borrowed PackProgramHost capability。保留 sandbox/executing Engine namespace identity，复用真实 template interaction/recovery probe；frame 和健康 startup barrier 不证 operation 成功。MCP renderer 在 runtime module import 崩溃，保留 CDP crash/native stderr，归因 assets heap 前查 runtime-import.mjs；remote compilation 不修改 adapter 捕获的 native importer。local UI 用普通 button event/native input validation，opaque document 无 form-navigation 权限。

首次 Host timeout 且 header 显 restoring-project，查 nativeViewConnected：native transport connection60秒，project restoration 共首 Editor180秒 frame deadline，两 owner 分测、header label 分开。native View 连接后 MCP document failed/transport timeout，document compilation 与 restore 分查；presentation 拥有 pending compilation，短 document query 轮询 completed resource ref。保留 RPC/source-read deadline、bounded task、replacement cancel、terminal source failure、完整 native Scene/Play-Stop/Backend recovery journey。

cold Renderer 后 direct-light attachment timeout，完整 file 先做既有 lighting comparison，再 attachment contract：comparison 原预算接纳 cold preparation，attachment 保留 fresh World、completed-frame count、断言、15秒界。保失败 timing，要求完整 Browser owner/最终 CI，local phase trace 只是诊断。

### 成本窗口与性能复现

Coverage 慢 child 已完成、owner 未完成时，completed receipt 与 explicit reservation 分开。所有已接纳 replay window 可容纳后再平衡 retained maxima，不能用旧快 cohort 消除它。保完整四路 wave、broad half、source isolation，numeric modulo-rank spread 不是附加 workload 约束。publish 前本地验所有窗口，job deadline/concurrency/coverage ownership/threshold 不变。

新增 Dawn file 后 placement headroom 失败，先查 measured entry。通过 [ledger](../../scripts/ci/README.md#dawn-gates)接纳完整 ordinary-child 成本（含 skipped-file overhead），保留 forecast/snapshot/lane/deadline。42388664877 是完整 ordinary cohort，DirectLight owner 中断；更新成本保留 full forecast/全部旧 replay，重跑每个改动 lane。42394605381 有完整 ordinary cohort/22完整 native owner；与前16场景分开保留，GPU Timing 中断和六个未开始 owner 留 admitted forecast。将完整 owner 移已有余量，重放17窗口、跑四 affected lane。不加 runtime solver、不将生成 ordinary assignment 复制源码；原 sequencer 以相同 maxima、first-wave spread/deadline 安排 whole file。

procedural Content coverage timeout 同时比较真实 V8 和 ordinary Node timing。只有 source channel 相同才共享 ordered statistics；完整 byte hash、原 dimension/mip、hook bound 保留。Content unit Focus package-only，runtime consumer 完整 prepare。算术 operation 少而 instrumented owner 更慢，不算有效优化。

Browser serial tail 超目标时，比完整 business owner 与已准备 consumer 的余量。Runtime Pack Browser acceptance 在 View0 原 BASE checks/verified POINT restore 后执行，保每 case、原 environment/deadline，Browser aggregate 含 View。扩大 owner name 后继承旧成功前要求实际 source execution step。匹配的 core/lightweight/fixed-smoke group receipt 可定 dispatch 成本，不改成员。保完整 child overhead、exclusive admission、unknown-group/full-profile forecast、全部旧 sample；不加 process、不将 placement replay 称 Browser qualification。

Dawn step timeout 对比每完整 native owner/ordinary child 与 forecast。最后 owner 临 deadline 才启动表示 placement 耗尽；重跑前刷新 completed receipt。44113035424 完成372普通 file/22 native owner，VFX depth 启动只剩87秒；接纳这些完整 receipt，退役已测 SSR provisional reserve，完整 VFX 先 reserve 再 ordinary backfill。中断 owner 仍未测，保旧观察/原界，四 lane fresh。

若 serial work 总量超过四窗口，placement 本身不能验收。遵循 bounded ordinary forks，验 resource admission/实际 project pool，保留 raw serial cost/full native owner，四 PR lane 和完整 Nightly 都验。普通 file 启动/import/cleanup 含 skip 全计，只从完整普通 process 分摊并守恒 elapsed。多阶段 owner 早期 phase 过但中断仍用 full forecast、不添 partial sample；其完整 journey 先 reserve，现有 lane 平衡完整 owner。

新完整 child forecast 超四窗口则如实保留 infeasible，先满足全部可行历史窗口，再尽量减 overload；不可牺牲旧 headroom/屏蔽 bounded first-wave search。部分 PR depth receipt 与 full-owner forecast 分开，只有 final-head native 执行资格认定。Alpha Hash 单跑成功但 ordinary child 丢 Worker，保留 dedicated serial fork/two-slot admission、五 Forward/Deferred case、temporal frame/replay。placement 用完整历史 file cost，失败 child log 分存，publish 前 local red/green replay 和 relevant final-candidate ci:focus；required Linux native owner 留最终 PR CI。

Standard nonreceiver 首 native GPU completion 卡住，保真实 failing tape，改预算前查 shadow reception。direct draw 可将 source fact 映到 declared fragment specialization，mixed/unknown batch 保留 conservative default。验 receiver/nonreceiver lookup 分离、pixels 不变、positive dynamic-shadow control，再跑完整 Browser owner/原帧和 deadline。

roster Browser child 缺 packaged point-SSAO，在权威 roster shard 前准备现有 verified profile，使用 shared point producer receipt/exact source-profile fingerprint，base-SSAO 不可替代。保留 child heap/startup deadline/frame/pixel。Linux setup/native crash 后 disk exhaustion，先用共享 Node/pnpm owner，不添 workflow export。装 Dawn preload 保留 BASH_ENV 原片段，验下一 Bash step/descendant core limit；import workspace package 的 source guard 在 root locked install 后，setup 回归检查全部 workflow 的 cold Node import。

LOD 性能复现走 Focus performance owner，共 CI CPU-affinity wrapper/default10GiB Node heap。local default2GiB heap abort 是 prepare 失败，不是性能回归；保留 caller option/完整 paired protocol。

artifact Create/Finalize ECONNRESET 区分 blob 上传完成与 receipt 接受。共用 upload owner：required 三次错开同名尝试，acceleration input 两次，canonical overwrite 不产 retry duplicate。保留 exhaustion failure/实际成功 attempt；无 receipt 无 qualified input。外部 transport 不重跑成功 tests。

authored-shadow 全 case 通过后 process timeout，查完整 fresh-device replay count/test-hook duration。daily core replay policy 保全部 native/reference picture/pixel assertion，只 defer reviewed duplicate replay 并接纳新 state；full/Nightly 全 roster。两 profile 在真实 GPU 验，不扩大 process bound，不将 scheduling receipt 称完成 replay。

canonical-kit cache recovery 用 prepared workspace 的 root package mode/原 selector，保留 actual cache-hit、missing/corrupt-byte recovery、metadata identity。Engine/full mode 拒 partial selection；bounded process owner 使 timeout/cleanup 可见。

Browser Mesh/FXAA serial tail 过重时，将完整 owner 搬已有 prepared Browser consumer 的 measured headroom。Mesh/WebGPU FXAA 共短 fallback Worker/原 FXAA server，在该处安装 Vulkan/保留 explicit channel。保留 environment、pixel command、failure evidence、owned-server cleanup、required Browser aggregate。只刷新完整成功 child，含摊销启动，异构 sample 保旧较大 forecast。所有 changed placement fresh；estimate/failed parent 不证 execution success。

### Smoke/Bevy 与 artifact 传输

Smoke/Bevy 重复 setup 用原四 Smoke Worker 跑完整 canonical/package-derived inventory，canonical tail 排空后再 Bevy serial native phase。原 app producer build retained Bevy app，通过 strict Pack closure 传 shader delta/package smokeArtifacts.packGuids；verify restore/shader expand 后执行 bevy:smokes -- --prepared-inputs，缺 input 在 native admission 前失败。

app package/canonical roster 的 Pack root 相加，包含共享 scene 加载的 authored material，不只 smoke script 直接读纹理。Clearcoat 保留 derived material GUID/HDR。authored Shader app 给 renderer 完整 built publication，engine-only manifest 不发布这些 program；Parallax 复用 app publication，不另 Engine build。composite preview owner 声明 smokeArtifacts.preview:true、启用 Vite build manifest，转全部 emitted chunk/CSS/asset（含 dynamic import），三 app-shard upload 都保留 hidden descriptor。

Skybox 保留 native/WebGL2 两验收，不重复 build。共享 owned-server helper 防 startup fail/occupied port/browser-launch error 留 detached preview。primary input restore 后尽早跑 CI execution/lifecycle 回归；recovery fixture 的 merged Smoke scope 含 Bevy，保留 exact membership/fail-fast graph coverage。

app-shard build timeout 查 producer callback cost/discarded output。Core consumer-inputs build 保真实 app/Shader graph/Pack hook，但 transfer-only bundle externalize 无用 Engine runtime JS。Preview/project-CLI/program-Worker facade host 保留 full build，Engine metadata 仍用于 producer identity；full/Nightly 不 opt-in。cache identity 含 output mode/producer bytes，比较真实 Shader publication，既有 shard report 保留 per-app timing/RSS。

core app build 保192/240（80%），只 defer48个 reviewed Bevy boilerplate bundle，无 custom WGSL/Pack carrier/assets/prebuild；其完整 native smoke 仍 required，新 app/full/Nightly 默认 build。producer/source recovery/aggregate profile 对齐。本地 Bevy 默认 build，保独立 duration policy/60 completed frame。

三个 protected Bevy check name 是实际四 Worker result 的轻量 standard-pool projection，不删 required name、不加 heavy matrix、不从 rename 推成功。fresh final-head 前在给定 runner class 验 exact membership/inherited CPU-preload/combined runtime。执行转移同步 shared repair consumer inventory，真实 worker 可 reuse，result-only projection 始终观察当前 matrix；每真实 consumer 保留 checkout/provenance/step guard。

实际 daily CI/SDK/compat job（含便宜 projection/final cleanup）明确 deadline，early shared contract 防六小时默认。queue/unresponsive cancel 独立诊断；timeout 是 containment，不证 runner 恢复。

大型 artifact latency 用 shared bounded range owner，不复制 workflow downloader。要求 advertised range、strong immutable identity、exact range boundary/原 SHA256，storage request 不带 GitHub API bearer token。不支持 range 时先退役全部 partial writer 再 fallback；identity/bytes 损坏直接失败。保留 retry/idle bound，在该 runner class 验真实大 archive。daily/final timing 区分物理执行和继承成功 consumer。

Node policy/CPU ratio Focus 通过 packages-only 验 package build receipt，不 cook 不使用的 Engine Shader/assets。Browser/Dawn/Smoke/View/LOD/runtime-unit Focus 保完整 Engine prepare。必须执行 selected owner，prepare shortcut 不能变 skipped test 或 complete-CI 声明。

native Shader manifest URI 编码 Invalid string length，在 bounded native smoke child 使用 process-owned processShaderManifestUrl，保留 byte identity/plain-zstd decode；长寿命 owner 用 openShaderManifestPublication/explicit dispose。不加 heap、不弱化实际 frame/pixel owner 来容纳 percent-encoded JSON。

native Blob manifest 经 local Pack fetch shim 报404，用 createDistAssetFetch 只拦 fixture origin、保留 native transport。delta expansion ENOSPC 保留 merged catalog sealed/atomic，prepared Bevy 只展开 selected group；frame/pixel/完整四 group roster 不变。prepared consumer 必须用 restored app-shard projection 或 source builder retain-artifact-only layout；raw producer delta 非 runtime manifest。

这些 harness 执行设施变更后审 compatibility surface diff，只在真实 owner 执行后更新已审 input。repair push 前本地跑 surface checker；同 gate 在 core producer fanout 前，防未经审查的 harness 变更先启动 native/browser fleet。

[English tool entry](SKILL.md)
