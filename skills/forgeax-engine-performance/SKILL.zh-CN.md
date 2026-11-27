# forgeax-engine-performance 中文参考

[English tool entry](SKILL.md)

供人阅读的简体中文版本；工具固定入口为 SKILL.md。

先定位成本最高的 owner，按实际变化频率移除冗余工作，再验证用户要求的工作负载。遵守[交付与渲染门禁](../../AGENTS.zh-CN.md)。压缩后的发布大小、解码成本、各 owner 的传输副本分开报告。原生 LOD carrier 在独立 Renderer 之间共享原始 plain/zstd 的单个 owned URL，dispose 后 revoke；各 consumer 保留精确 shader roster 和真实解码。保留 GPU completion 失败样本；allocation 下降不能证明恢复成功。

CI CPU ratio 通过 pnpm ci:focus --kind performance --select ecs-ratios 或 render-ratios 复现，保留完整 single-worker、无 instrumentation 的 project 及 CPU admission 诊断。ratio 断言通过与总 sampling 超时是不同问题。daily 仅延后无断言诊断数据流，受门禁约束的 paired sample、workload、threshold、case bound 均不变。visibility 保两条各101 sample、10k entity 数据流；flat 诊断留在 full profile。比较相同 profile，保留失败。可复用行动规则归此入口，详细方法、反例、带日期测量归 Harness 链接；raw capture 留源码检出目录之外。经验更新同时维护规则和证据。

## 交付性能证据

每次性能测量都交付程序生成的图片和可复用视觉报告，默认 SVG/PNG 加 HTML；viewer 支持时使用自包含离线格式，在最终回复直接链接。只存文件或只给数值表格不算完整交付。报告包含原始输入、digest、source/build/workload 身份、单位、coverage 和生成命令。交付前打开 HTML 并检查图片。交互 HTML 必须支持真实图形操作，不能仅显示 SVG：用真实数据验证 hover、点击检查或下钻、筛选排序、缩放平移重置、重载导出。排序保 source row/node 身份，缺值与 line gap 保留；静态图是证据导出。

| 测量问题 | 默认路线 |
|:--|:--|
| 跨 target/完成区间 CPU | cpu.mjs report；timeline.svg/html，保留 AI JSON/可选 Perfetto |
| sample/CPU-GC/allocation/GPU pass/前后摘要 | render_metric_report.mjs，显式 source row 和同单位 pointer；report.svg/html |

memory/metric report 试用 ECharts 时，传 --html-viewer echarts --echarts-js LOCAL_RUNTIME。在源码之外执行 npm install --prefix /absolute/viewer-runtime --ignore-scripts --no-audit --no-fund echarts@6.1.0，选择 dist/echarts.min.js。生成器将 runtime/LICENSE/NOTICE 嵌入离线 HTML，记录 digest；memory HTML 的 gzip JSON 要求 DecompressionStream。runtime package/notices 随工具保留。比较期间仍默认 SVG viewer。

memory ECharts 支持滚轮缩放、拖动、点击下钻、Fit、Back/breadcrumb、bytes/count、全捕获搜索、重载、SVG/PNG。metric 支持原生 tooltip、wheel/slider、restore、点击 source、排序筛选重载和 SVG。memory 最多显示2000个 tree entry（含 Self/Other），Other 可展开完整 child；AI 输出仍含完整 graph。table/search 重绘保 viewport，focus/metric/depth 改变则 reset；metric 排序保 zoom，filter 改 population 则 reset。大型 snapshot parsing/index/reference 仍在 main thread，显示数量限制不等于 streaming loader 或全量 query 加速。

CPU 时间顺序使用 time-order stack，sample 序列使用 row-order line，可比摘要使用 grouped bar。unknown 保留为 gap；不能从 percentile 推断 distribution，不能比较无关 cohort，也不能把 GPU pass 总和当 frame latency。failed/partial 状态在报告中可见。捕获或可视化失败时交付已有诊断、指出缺少的产物，不编造数据。

CPU timeline.html 使用固定 Perfetto v59.1，提供 timeline/zoom/pan/track/search/range/slice arguments。从技能目录运行 node scripts/cpu.mjs serve REPORT_DIRECTORY，打开 loopback URL。report 接受 raw profile/capture directory 或 timeline.json；可用 --perfetto-ui HTTP_UI_BASE 自托管。官方 embed 必须走 HTTP，不能 file://；默认 hosted UI 需要网络，trace buffer 传给 frame 并关闭 sharing。无网络需自托管，不能称默认方案完全离线。

| CPU 产物 | 消费 |
|:--|:--|
| timeline.html+timeline.trace.json | Perfetto，completion selector/ms range，重开 Chrome/normalized JSON/binary |
| timeline-inspector.html | 离线 Top-down/Bottom-up、function/completion、call-tree SVG |
| timeline.json/analysis.json/call-trees.json/query | 全机器数据、有界 range/target |
| timeline.svg/生成 PNG 或截图 | 与 live viewer 一起交付 |

必须确认 Perfetto canvas 真正绘制 slice：选中 slice 查看原 name/source，验证 zoom/pan、改变 completion range、重开文件。PING/PONG 只证明消息接收，不证明解析或绘图。sampled JavaScript target 不等于 OS thread，completion gap 不等于 execution scope，重新渲染仍保 capture identity。cpu.mjs 通过公共 project play adapter 捕获和生成报告，report 可重开，calibrate 测精确 browser sampler cadence。按需读 CPU 流程。

实际程序的采样细节资格须保完整 call tree、native/unknown/source coverage、真实 interval median/p95/rate。归因前先数短调用样本；zoom 不能补回未采到的调用。请求值为正整数、timestamp 粒度和观察 cadence 均不能证明逐调用精度，未达标准须明报。profiler-off 对照独立；无业务插桩的 signal 仍会中断执行，高频采样属于诊断。focused target 可提高细节，但不能把独立 capture 拼成同时逐帧数据。优先显示 function/system 名称，source/VM 信息放 hover，从认证 mapping 恢复名称。completion gap、CPU estimate、GPU scheduler、同窗诊断与早期 stall 分开报告。

## 内存层级

工具契约运行 node --expose-gc --test skills/forgeax-engine-performance/scripts/__tests__/*.test.mjs；ci-core 执行相同完整 suite。GC flag 只用于显式 allocation-event 对照，不用于普通捕获/验收。memory.mjs 的 report 输出 normalized AI、离线 folder/treemap HTML 和两个 SVG；inspect 提供有界 path/children/record/reference 分页；rank 提供全局分页热点（--by self|total --query NAME）；capture 仅运行明确拥有的 Node workload。见内存流程。

| Population | 层级/指标 | 边界 |
|:--|:--|:--|
| sampled allocation | stack、V8 node self byte、sample/ordinal | 不枚举所有实际分配/对象；orphan owner 和 sample-size total 分开 |
| snapshot object | type/name/objectID，守恒 shallow byte/captured node、raw reference | 分组非 dominator ownership；weak 不 retain；VM/native 非逻辑应用对象数 |

Node 默认请求32768字节采样间隔，包含已回收 sample；对象 snapshot 显式用 --mode objects/both。没有业务 hook，不强制 GC；sampling 有开销，snapshot 可能阻塞并触发 GC。离线读取文件，metadata/population 可见，normalized snapshot 隐藏 raw string，原始数据保持私有。retained size、native GC、allocation event、matched comparison、GPU-process memory 分开看。

snapshot 用无损 indexed graph 避免重复百万 ID/名称，inspect/report/HTML 自动解码，不假设 memory.json.nodes 是 object row；保全部 object/reference，紧凑非截断。report/capture/inspect/rank --metric count 选 sample/node 计数，默认 bytes，HTML 无重 capture 切换；chart/sibling order/search/export 同 metric。Self 本地，Total 含后代。AI 用 rank ... --metric count --by self --limit20再 inspect --node ID 取 path；snapshot type/name 用 total，inclusive overlap 不可加。按 byte 采样偏大对象，sample count 非无偏 event 数/率。treemap/folder 同 metric（含零 byte count branch），detail 精确值/完整 path，render aggregate 不截 AI。

## 显式纹理准备

known CPU texture 挂 World 后 renderer.prepareTextureResidency(world,handle)，Three 初始化后 initTexture(texture)，共 drawing device cache/source revision。asset 保留 alive、普通 update/dispose；仅 storage 非全 scene pipeline，不隐藏 render 暖纹理。首用单测、未变版本无额外 upload。显式 generated-mip 只 submit 所选 texture，allocation 保到 queue complete，同级按原 consumer；拒 submit 可重试。

## 数值分配所有权

vertex storage 变化要验全部 pass（含 temporal/shadow）；遗漏 shader entry 等 pipeline 按 pass 解析默认，不凭 packed layout 造 forward entry。runtime Mesh 只保留 interleaved row，不同时完整 attribute channel；空声明不保非空 backing，独立 mesh 不共享 transferable backing。CPU loop 只 resolve 一次 meshAttributeWindow，offset/stride 直访 typed backing，无 Proxy/逐 vertex 对象，contiguous conversion 显式临时。raster upload/worker publication/range edit 直用 canonical row。

publication GPU comparison 借 row 须 generation witness，写前推进、精确 byte compare 前拒 stale，GPU generation fork 退 borrow comparison。不可控 caller buffer 仍 detached snapshot。验真实 hash collision/nonzero window/shared-leased generation/rejected transaction/retire，短 hash 非 equality。

按最后 reader 选 storage，先查 owner 既有 arena/pool，保留 persistent semantic facts：

| 生命周期 | 选择 | 资格验证 |
|:--|:--|:--|
| update/run 同步临时 | world.frameArena.alloc，连续 standalone 用 withFrameArena | 初始化复用 lane，outer 关闭前消费，含 fixed catch-up/command drain |
| system 跨帧 state | world.buffers.alloc/view/resize/release，既有 BufferPool | release 绑真实 plugin，resize 后重取 view，独立 reader 一次性 lease |
| await/transport/publication/submit | 原 publication/page/device owner，允许则 owned lease | arena 不得跨 await/yield/timer/transfer/snapshot/GPU complete，lease 只 pin 不冻结 |
| 少量 scalar/tiny temporary | 原 probe/显式 out/小 factory | 加 scope/handle/view/Result 前比完整 owner |
| 无 World 纯同步数值 | caller out/有界 invocation scratch | reentry 独立 scratch，复制 escape 前先 admit，测 cold/dense change |

arena 复用 bytes 仍每次建 TypedArray view/Result；pool 保留 capacity/metadata，backing 和 JS 对象都量。许多 tiny array 换许多 arena request 不证明收益，允许时单 phase window+offset，用 out-writing math 而非先分配。无 World 固定 scratch 可 factory 一次建多个不重叠 matrix/vector view，初始化全部 lane/reentry 独立；backing/view/cold metadata 分开，packing 不消 view/不证 warm gain。escape 独立 storage；读 buffer 只证明 identity 非 allocator 调用，actual factory construction 另测，诊断不入 hot。单 escaping output 多个 view 可共独立 backing 不重叠，保留 logical length/signedzero/held independence/final reader，仍有所有 view 对象。

每真实 system invocation 护 arena lifetime，手动 scope 不防 suspended escape reset。adapter 预期失败用 Result/保留 retry；准入计累积 multi-view/pass。allocate/fill/copy 显式 out/nonzero offset、scope 前消费，finished accumulator 无 reader 才原地 normalize。

完整 factory/arena/pool 比 warm/size change/spike-drain-trim/overlap/denial；计 copy/zero、CPU、backing、JS view/Result、capacity/metadata，cold world.memoryStats 配 allocation/retained heap。大 alloc/release 退 backing 后不漏 slot metadata。见[ECS memory](../../packages/ecs/README.md#numeric-memory-services)。

短 inline ECS 数组已要拷 pose/matrix scratch，用 read capability output-copy，不先 typed row view。每 read resolve 当前 row，验 grow/migrate/stale/out offset/overlap conversion，variable pool 仍 live slot。比 sparse/dense/idle/catch-up 完整 owner。vector read 换 length+逐 element World 可能重复 entity/schema/column；bulk-copy 省 resolve 却不能 early exit，按 channel mix/whole-game 证据决定。

retained snapshot compiler facts 重复先证 live publication strong path，在原 admission share detached immutable subtree，保留 variant/full validation；structural pool 仅临时 publication-local，cold CPU/loading memory/afterGC floor 一起量。snapshot node 含 VM/native，非应用对象/dominator byte。重复 borrow physical allocation 只 validate 一次、保留 typed window；成功 resize 才 invalidate、retire 清 owner cache。独立 completion capability 和 detached release callback 不能回收公共 lease，否则旧 callback 释放新 tenant。测 overlap/periodic+dense resize/cold alloc-retire，invalid/zero slot 不长 view-cache。额外 live header/JS index 与 numeric metadata/backing 分计；World 活着时 released window 须可 collect，warm rate 降低不抵 retained 回退。

固定 scalar-format codec 可持与 World 容量无关的有限 conversion window，前提仅 number escape、同步无 callback；从 native type metadata 派生，shared no-tear/foreign buffer/异常 index-align-detach 仍普通 typed access。这是固定 metadata 非 workload storage。验 World 完整 read/write/grow/migrate/relation/cold retire/backing+World collect，保留 public transient view、positive allocation control/完整 owner gate，warm scalar loop 不足。

## 推进优化

App/Worker/direct Renderer 使用 capture-owned session.beginFrame 身份，不独立 frame counter。先证预期 App/Render phase 在场；Update 中开始下帧恢复 App phase，missing 非零工作；显式导入 frame 严格递增。

慢 dev startup 分 product-DDC warmth 和新 browser/runtime。用 DevKit workspace-timing request/真实 watcher snapshot 归因 first-frame，duration 重叠要看 critical path/scan count 再称 startup/GPU 收益。warm backend 分完整 integrity serialization/file wait，按 content 数 HTTP encoding。原 serializer 批有界无 callback scalar JSON，encoder 并发按 task+input bytes 限制。同 publication share accepted immutable artifact body，优先小 backing、serve 前丢临时 content index，保留 digest/MIME/head-source fence/compress format-level，不加平行 cache。

先确认 active host watcher：live DevKit 拥有 source observation、关 Pack 独立 watcher；读现 Worker load/progress 再归因 module/GPU，pending Catalog 可能 server CPU。wire-table encoding 主导则 scope projection 保留 shared publication identity，使完整 closure 只 validate/serialize 一次；验完整 wire byte/scoped locator/source path/真实 start，孤立 encoder 快非完整 start。

movement route 需全 character footprint 避障，含 transport 反馈延迟/turn overshoot；保留 height/corridor guard，拒 capture 保留 last state/partial trajectory 和此前 rejected window，不能拼成功子集。改 route/cadence 新 cohort、保留 raw，跨 protocol 不能数值称 whole-game gain；report 描述从 protocol authority 派生。allocation stack 只映 ancestor 不能定 exact owner，改 caller 前查 unmapped library/native。inspection 返回期间 input 仍 held，测 fresh/stale reply+elapsed delay，actual sample 保留 spatial/height/travel；steering prediction 非 motion 证据，速度/input policy 随 workload 固定。

asset admission 先失败保留 named startup stage/failed scene，collector 内不重试 generation/延 deadline。健康 fresh owner+同 payload 验证后重启完整 cohort，不混之前成功 window 和后来 count/census。未复现 registration stall 仍 unproven。V8 inferred class 名可能 iterator 非 function Object() { [native code] }，查 generated 位置。live Query 已保留则不加 cache；完整同步内部 walk 若 row 不 escape 可借 Query.forEach cursor，保留 public 独立 iterator/nested isolation/failure close。

1. 全 build 成功终态后冻结 source/build/native payload、scene/backend/Workers/quality/actions，保原失败；content/profile/ABI 变要新 baseline，渲染不明走[RHI Debug](../forgeax-engine-rhi-debug/SKILL.zh-CN.md)。
2. 编辑前归因真实昂贵 population，分普通 completion 吞吐/侵入 profile/private control；指出可移工作和反证。
3. 先列有界已归因机会，选中全部实现后联合 build/regression/game capture，不每点广测。量完整 replacement 的 key/validation/allocation/retained/publication/upload/retire。
4. semantic control 后比预选 matched window；implementation/helper/wholeWorker/未完成 target 分报，已验证 owner 变化合批后再广跑。

nonempty native 仅 presence；缺 source-key provenance 保旧 bytes、pinned producer hydrate 后 build/freeze。fidelity oracle 不变，native bytes 变新 cohort。

持续 motion GC 验实际 moving game，owner control 每 call 改 pose/joint、含 dense/mixed content。moving 本身不证 changing-data 成本降，分 static reuse 报。降 allocation/natural GC 同时保留 throughput/tails；低 throughput 下低 B/s 不足。hot hit/Node/profile allocation 降不证 naturalGC；whole-game GC 不降或吞吐退则拒 candidate，保测量、恢复原 runtime bytes。

trace iterator 名是该 instrumentation 归因非普通对象数/GC；查部署 V8 tracking（full tracking 可能关 inline allocation）。warm real workload 另测，无 heap tracking/sampling/forcedGC/Debugger。native GC counter 仅 realm-wide 非 function 归因；替遍历语法前完整 owner counterfactual、保留 caller semantics。

natural GC omit disabled-by-default-v8.gc_stats（major full census）；owned window 内含跨边界 V8.GC_OBJECT_DUMP_STATISTICS/GC_Objects_Stats 污染则拒、保留 diagnostic。独立 disabled-by-default-v8.gc 含 boundary counter；tracing 仍有开销，比预选交错 ordinary windows，不减 census 时间造 natural pause。

native service lookup 真 owner 时在 pinned dependency policy 去多余 resolve/diagnostic，再考虑 caller 复制 service。每次重读 native authority；仅未 intercept native event owner 可跳 event 构造，保留 accessor diagnostic/intercept-veto/custom owner/method caller trace/isolation/retire-replace。源 patch+双 lock 验证 fresh pnpm/Bun，不改 installed/cache。tool 从 owner 包 resolve/验版本，root shim 可能另一版，安装 browser 不证 consumer 可启动 pinned build。hooked/ordinary controls 都比、慢路径 tradeoff 明报。

GPU-bound 先 capture，见下节。

## 移动帧测量资格

固定物理 device/OS/browser 或 WebView/Engine build/backend/realm/orientation/drawing buffer extent，窗口内捕真实 geometry；HUD/增 frame/sky-only 完成不算 scene。先 foreground 普通 play、真实 completion，queue completion interval/physical canvas 与 JS cadence/FPS 分报（queue 含排队/scheduler），复现慢时 stationary/moving 都比。

pass 归因用真实 Render Worker/local Renderer 既有[GPU timing](../../packages/devkit/README.md#opt-in-gpu-timing-in-a-generated-host)，保留 skipped；probe 改 startup/context/backend 则保失败、关 probe 重跑 ordinary 后再结论。每手机 comparison 只改一 condition，保原 quality window，重验 pixels/backend；低 res/关 work 标 diagnostic ablation。去 pass 定位成本后，改 quality 前先 feature 开着测同 draw 的 alternate native recording。

<a id="optimize-gpu-frames-from-a-capture"></a>
## 从捕获优化 GPU 帧

presented rate 低于 target、CPU 在预算内且 GPU timestamp union≥budget 才 GPU-bound。先以单代表 captured frame 做 benchmark；tape 固定 command/resource/graph，排 CPU/vsync/pacing/publication-credit 噪声。

1. 冻结 scene 稳态、跳 warmup，recorder host（dev start --rhi-capture true→rhi capture），保留 build identity/tape 源外，见[RHI capture](../forgeax-engine-rhi-debug/SKILL.zh-CN.md#game-cli-entry)。
2. rhi timing T.rhitape 报 union p50/95%interval/drift/top/preflight，--json 全 pass。首行 INVALID（前后 GPU 忙/quantized timestamp）丢。summary --passes --json 将 target/draw/pipeline 映 owner。
3. 改前估候选：--skip '<regex>'/--skip-passes/--skip-works 加 ABBA 变体，paired delta/significant 估删除收益；--isolate 读独立 cost、sum 仅上界。先最大可去成本，小 delta 加--ci-ms0.05。
4. 同 scene state 新 build 重 capture，timing after --compare before，交错两 tape、paired union verdict/per-pass；rhi read/同 tick 截图验图。
5. 确认 live：安静机器/idle GPU 测 presented FPS（非 rAF，credit 等待时仍 rAF）、live union、renderer toggle。rAF fps_mean 不是 presented，r2base56rAF 仅39.3submit/s。

| 问题 | Replay | Live |
|:--|:--|:--|
| 主导 pass/去掉节省 | rank+paired skip | feature toggle |
| light count/variant/consumer sampling | skip shadow raster 仍 main 采 shadow，不能重放此 cost | toggle |
| 跨帧 overlap/cache/pacing | 无，每次 reset 独跑 | 包含 |
| 相对 frame budget 绝对 ms | 不可，只同 run 变体 | 可以 |

Apple/tile GPU timestamp 重叠用 union 非 sum。replay 间 idle 降频，因此 GPU copy 恢复、back-to-back 提交。r2 M4Pro Metal/Dawn 旧 reupload union23ms、std4.6–5.1/drift；steady pipeline11.3/std0.2无 drift，live17.2/std2.3，replay 持续频率更低时长，只比 replay/replay。paired skip 约±0.05ms：shadow2.89/bloom0.50/FXAA0.24，live shadows=0省3.4，其他 live 在噪声内。见[benchmark](../../packages/rhi-debug/README.md#replay-gpu-benchmark)。

## 加复用前选 producer

| 重复工作 | 行动 | 正确性边界 |
|:--|:--|:--|
| partial query 建 full 再丢 | 共 validation 直接产所需，如 Fog-only | getter/validation 序、独立 LKG、旧 detached |
| 固参每帧上传 | physical resource 初始化，后仅动态 | boot/view/recover 都初始化，error/capture bootstrap |
| view/Feature 名字反复建 | 原 owner 保留 membership/role/scoped route，frame lease/resource 另 adopt | 真实 relation 用 ECS version，旧 frame 独立，raw borrowed live |
| residual roster 展开 dense | fixed slot 直读，publication/availability 更新 readable subset | rank/remove-reuse/missing/held/journal 丢后 full fallback |
| shadow cache 命中前重建 ABI | physical PipelineState 产 fixed binding route，只看 grow/replace slot、复用 leaf | 构造证明 fixed、layout/conditional/recovery root，borrow/copy live |
| 多 consumer 重建同 admitted fact | 原 producer/commit 产一次 | 生命周期/完整依赖证明 |
| producer token/pass count 重建 consumer graph | key 为 export shape/view-owned work，payload/import 读 exact publication | allocation/view compatibility、reorder/reject/held/multiview/旧观察 |
| entity/resource relation 逐帧 project | 原 phase 保留 numeric membership/shared immutable，增量改 | slot/gen reuse/remove/held/accepted version-scope/borrow |
| 临时数值 | bounded scratch 或 acquire/use/finally-release | reentry 独立、release 清 reference、escape detach |
| 少量闭合 immutable 定义 | finite 或 producer-derived share | mutable/custom live，shallow freeze/readonly 非 deep proof |
| 结果 cache | 测 identity/全 logical input/reuse distance，stationary+changing | 小稳 working set、cheap complete key、清 lifetime 才 singleton/boundedFIFO |

重复 program serialization 在 native receive 边界 detach immutable metadata，schema rebind 保留 fixed shape。全部相关 group 需 own data property/deep dense plainJSON 证明；numeric ownership flag/shallow freeze/accessor/sparse 不足。fixed snapshot+Pass 共 facts/string，不按 entity。memo miss 后来 freeze 也可继续 live，只有 positive proof 可 reuse。原 available-admission proof 可保留 immutable observation，不平行 roster；完整 contributor 复用前比全部 identity/reject/deformation/dispatch。admission 复制 roster、保留 held proof、borrow/reject recapture；完整 measure 含 capture/canonical/rebind/dense replace/borrow，warm saving/cold penalty 都报。

component version 可变而 selected row 不变；StateProjection 无 selected index/membership 变化时保留 collection，成功后才接受 empty candidate。moving audio listener/source 等独立 consumer 仍 run；pose write/remove/failed update 保持 retry。filtered projection 在一个 out append，不 flatMap 每行[]/[row]，保留 header/getter 先后、row 序/缺失/拒绝。即刻拆 temporary envelope 则传 source owner、primitive 只 capture 一次，membership 已知再 identity array/serialize；保留 identity 观察先于 borrow material/getter、missing 诊断，验 ignored pass/changing/borrow。

公共 iterator 是独立 completion capability 非 scratch。完整 owner 证据支持才 prototype 逻辑、callback 按需 bind；保留 detached call/stablefn/early-close 不 commit/stale-close 隔离/held row-span，不复活 returned cursor/pool escape facade。empty/dense/change/partial/cold+positive sampler 验，microbench 非 wholeWorker。commit/validation candidate 也可 prototype+按需 bind，保留 stale token/held fact/borrow-index lifetime，quiet/change/discard/held/cold 比较，closure 少可 CPU 慢。native record shader owner 已 capture 时，match current physical 后复用原 dependency envelope，custom/raw live，随 invocation 丢。

内部 FrameList 明确允许每 walk 一 private step；captured row 独立，return/fail 永久 close/清 input，仅 full exhaustion 发 cached rows，不扩到 public query/span。同步 forEach 可直 numeric membership 去 nested wrapper，保留 custom iterator lookup/receiver/close/nested/failure，仅完整 walk 发 state，含 partial/cold/repeated。原 cache entry 加 invocation stamp 替 hot Set，保留 cold cycle，量 extra retained field。

immutable visibility 在 extract producer 唯一，Feature 无新增 report 改变意义可共享。不为 inactive 每帧 copy+Set；borrow array/getter/custom live，shallow freeze 非 proof。完整 producer/cold/periodic 比较，不对无界 entity argument expansion。

复用 Map/Set clear 可能 CPU 更高、sample allocation 不变，wrapper 复用不证 backing；优先去 duplicate envelope、materialize 前比较 admitted field、大同步 index 用单 arena span。scope 结构化 allocation 失败、warm backing plateau/held independence/smaller-demand 恢复。private state 复用前封 callback reentry，old candidate 一次性。numeric stack 清 JS length 可丢 capacity，证据支持则 active range/原 lifecycle trim，deep/shallow/cycle/drain 验，reference tail 仍清。短 read cache 可 stamp retained table 代每代 newMap，保留 missed-generation expiry/immutable public，量 stamp/cold/partial/scanCPU。

binning 完整输入不变将 numeric membership 留 admitted view，unrelated light payload 独立刷新；存 numeric dep 不留旧 frame bag，hit 前 validate budget，成功才替 fact。change/fail/dispose 保留 old output；证真实 pipeline/config producer，borrowed frozen copy 非 owned default。stable/periodic/dense/cold 含 out backing/sampleJS；cache 省 backing 可增 cold。disabled profiler 也查 per-item callback lexical alloc，普通 route sharednumeric kernel、instrument path phase/output 不变。

material producer fixed-value fact 经既有 resource 传 phase consumer。每次 global identity lookup 会慢 borrow，caller 直 owner evidence；readiness/proxy/getter/旧 accepted 版本不依当前 proof。量 receive/adopt/单多 material/continuous/borrow，短 CPU 充分 warm、baseline 保留 original caller。跟 receive/schema-rebind 链，metadata-only/exact adoption 保留 proof，public alias 仍 borrow，fact 归现 resource authority 不逐 snapshot copy/freeze/register；continuous rebind proof maintenance 可慢。snapshot fact 须比 latest mutable owner 寿命长，留原 identity authority 不依 current version；多 holder/reject/exact clone/fresh copy 验，不给每 borrow 加 metadata。

prepared plan 的 fixed material/class slot projection 留 actual capture；首 consumer 供 ordinary index，不提前再建 index，每 record 保留 current accepted/World scope；borrow/mixedCPU-GPU 保持 live merge。stable/periodic/continuous 比较，retained index 有 cold cost。

cold Scene identity/content 与 pose/version 列分开，pose 不 copy 静态 relation。pending page capture 前返回 matrix window 也保护，后 write/slotreuse 不覆旧观察；量 actualcopy/oldroot-window/fullCPU，numericcopy 降不证 Renderer 独立 N。

source identity 与 raster demand 分开；emptyGPU eligibility 不意味 CPU fallback，hidden/zero instance 两 lane 都无需。修 membership producer，receipt/diagnostic/presentation 同 demand predicate，真实 visible 资源错误仍见。hide/show/zero-change/heldroster/真实 N-K 验，counter-only 不去遍历。

warning 不触发也可能扫 inactive，diagnostic 也 profile。captured root 保留 ordered demand 直消费，不从 custom projection 推需求。disabled 在 readrow 前、cheap light/latch 后退出；lit/dense/cold/borrow 保留 small-path/producer 成本。N full export 仍 O(N)另报。bounded identity 优先 producer immutable index，不能为64quota 预扫 N；保留 heldroot/addressgen。borrow array 原 identity 可变/custom membership 变，一 coherent observation count+sample 不加第二 scan。完整 producer/record/query 含 sparse late/poseedit/explicit/custom，GPU/wholegame 另验。字段选择在 owner 产 inventory 前传，不只 clone/serialize 前筛；scalar/capability 不建 perentity export。省 selection 仍 full detached，验 empty/explicitfull/old/crossWorker clone；retention/export 副作用独立。

小 matrix window 可 retain 旧大 page，连续 edit 使 current cache 留许多 old buffer，外部 reader 关也如此；从 current outputs 量 unique reachable backing，cold/rotating/held/drain。独立变化 numeric 用小 immutable chunk 降 copy/retention，计 extra chunk/viewmetadata、denseCPU/JSalloc；currentpage 清 removed，oldroot 保。chunk 仅缩 retainedunit，不证 lease/不授权回收 automatic reader 可见 storage。

bulk dispose 不同逐 row remove；clear authority 可能 derived hierarchy/bounds/staging/journal 还在。spike/dispose 前 drive 真实 consumer，discard history 回 cold、cursor monotonic 防旧证据复活，dispose 后验证 oldcaptured 值非 wrapperidentity。计 coldowner，emptyroot 不证 zero backing。World retire 仍 alive 查 strong heap path；同函数 closure 共 lexical，callback 可能间接留 previous；escape product 另 scope 仅 actualdata，oldheld 有效/unheld collect。WeakMap ephemeron value 不是 strongpath，以 data-only observation 重试再归因。

persistent numeric table physical backing 保留 full byte/DataView，offset 做 row write/clear/upload，仅 backing 变更新。真实 payload 验 nonzero sourceoffset。CPU table 退到 last sync reader 独立 heldGPU；拒 update/commit reentry、active queue call 延 release，create/upload/retire 注入 dispose 后才 adoptgrowth；heldversion/repeatgrowdispose 验。

hot 只读 allocation 所需列，full-row 才 detachedview。原序走 publicationgroup、不复制中间全 array，直建 index 无 mapped keyarray；sparsepose/content/instance/dense、zeroaddress/heldversion 验。retainedproduct 测 nextconsumer 含 serialize，少对象可使 native graph-key 更慢。borrowgetter/toJSON live，cold/change 保；plainobject probe 不授权 sharedmutable/customserializer，全 pathCPU 大于 allocsaving 则撤 cache。

fixed stagefact/syncfinalizer 在 installation owner 共享。runner 传 exactpreparation/accepted work，不新 closure/不 retarget sharedcontext；reorder 更新 eventfact 保留 heldframe。producer context/nativeplan capability fresh，测 submit/abort/source throw、siblings cleanup/retry/queuefencedretire；accepted/abort/change 完整比。

小 recordpool 可省 byte 却 lookup/clearCPU 慢。graph callback 仅 encoder/frame/resolver 则 encodeDirect 省 argrecord，需要 context 仍保，receiver 不变，普通 CPU 与 sample 分量。import resolver 调用前和 passencode 前都 guard retainedframeresource，recursive resolve 可先覆 activeframe；helper 非 wholeWorker。

derivedWorld 依赖从 actualreadquery 记录，StateProjection 管 membership/add/remove/gen；optional absence/requiredposejoin 都是 input。resource/time/assetadmission/routedfailure 显式。原 source 分 lightcontent/movingcamera，viewshadow/cull 归 consumer。cachehit/miss 都传播成功 nested component/global/pose，childtime/failure 使 parent 失效；failedextract 恢复 parent，foreign/unobservedchild 保守。static/dense 完整 publication 比；arbitraryextractor 无 completeownedroute 前保守。numericpublicationrange 可 admit 直 canonical row 无逐 matrixcopy，delta detached 非 borrowpacket。

incomingnumeric 先比 canonical 再 hydrate/stage；已 stageoperation 拥有 current，不可后来 span 只比旧 column。borrowwindow 一次 read，missingrow 不 read，保留 offset/parity/strictnumeric/duplicate/remove-recreate。大 validated transform-only 用 arena chunk 存 sourcecoord、共 commitlocalslotindex，不逐 rowrecord/新 Nindex；全 chunkadmit 后 canonicalwrite，denial 清 touched、duplicate/revert 保留 stickyparity。getter 仍 ordinary；tinyinput scope/view/Result 可能更贵，有证据保留 tinystaging。完整 N unchanged/partial 和 selected/fullchanging 测，incomingN 仍 O(N)，非 N-independent/wholegame。

hotcall 数非大 workingset，longlife 非 stablevalues。避免 perentity/materialcache、poseFIFO、同价 outputsignature、新 age/version/depscanner 只为少 alloc。GPUcache/lease/intrinsicinvalid/recover 归原 owner，不给 foreign/frozen 挂 metadata。

## 选择数值热路径

按已实现 [ECS](../../packages/ecs/README.md#physical-numeric-batches)/[Math](../../packages/math/README.md)，Query 保在真实 World/system lifetime，owner 管 reentry/replacement。

| 工作 | 优先 | 保持 |
|:--|:--|:--|
| readonly 非 temporal 含 sparse/optional | prepared query.batches，column 每 batch resolve 一次 | physicalstart,end)，indexed rows[0..count)，batch 边界验 optional absence |
| dense required numeric write | spans/shared kernel | declaredwrite/version/structuralfence/eligibility |
| tiny/knownentity | numeric worldRead probe | optional/type/bounds，fragmented1row 可 probe 更好 |
| incrementalderived | changed Query/StateProjection | 全 dep/membership/remove/recovery，changedrow 不替全 aggregate |
| managed string/public coherent declaration | semantic snapshot | stringdecode/detached |

batch 拒 write/changed/added descriptor，走既有对应 route。entitywindow/columnlookup/fieldposition 在 innerloop 外。span 反复 prepare 可在 columnowner 保留 latest complete physical window（backing/range/managedtype）；caller 可替 field 则 shape fresh，frozenmanagedreader 保原 boundstorage/ownenumeration/detachedcall。partialchangedwindow 不赶走 fulltable；replace/grow 丢 oldroute、不 retarget heldreader。量完整 query+numeric 非 cachedgetter。sparse 不 gather dense copy/不 rowwrapper，不展开 optional 全组合，column 仅 valid lifetime 借，structuralcallback/suspendediteration 保检查/temporal cursor。

out-writing Math 必须 out，可返同 out 或独立 boolean/status，factory 明确 alloc；precision/alias/lifetime/internaltemporary 都保测。??0不分配，证 bounds 后直 index，保有意义 absence。除非大量 callback 完整 owner CPU/alloc 获益，保清晰遍历。check:ecs-iteration/check:required-output/check:foundation-allocations enforce 实现快路，app/template 保游戏 API；finite gate 不证全 caller 最优/零 alloc。

<a id="remove-cpu-preparation-and-collection-work"></a>
## 移除 CPU 准备和集合工作

| Owner/population | 规则 | 反例/对照 |
|:--|:--|:--|
| exactnearestgeometry | 近 conservative bounds 先访问，收紧 exact minimum 再远 sibling | 两端/表面 exhaustive distance、实际 triangle 读有界、完整 motion 同、cold/queryCPU |
| native-only material fixture | 原 backend target、file-owned boundedcooker、packagecodec，wire 编码前留 validated byte view | portable parity/fullartifact/freshRegistry-device/heldmaterial/nativepixels/fullCPU |
| sort comparator serializekey | 排序时每 capturedfulltuple 编码一次按 exactstring 排，再 serialize 原 orderedtuple | singleton/locale/stabletie/escape/undefined/oldidentity/livechange/fullowner |
| composite/stringkey | 原 numericslot/produceridentity 优先 | slot/gen/realm/collision/fullkeycost |
| packednumeric/spatialkey | 验 integer range/exactdecode、原 quantization | safeinteger/32bit/负小数/order |
| tiny/sparselookup | 原 inline-first/singleton 仅适合有限 API | stored undefined/SameValueZero/insertorder/iterationchange/overflow |
| duplicatemembership | 原 owner 已证唯一才去 secondindex | insert/lookup/flush/reacquire/alias-barrier commandorder |
| emptyclassification | sourceroster 非空才 Set | 非空语义/类别 overlap/create-update-recreate/reset/retry |
| immutablepage nativeMap copy | nativeforEach 与 iterableconstruction 比较，privatepage 先 init 再 publish | custom/borrow iterator、order/heldroot/refcount/alloc-write-retirerollback/sparse-dense 完整 |
| perinstancemethod/accessor/resultarray | sharefn/descriptor 或直 orderedfact | receiver/lazy-own-enumerable/order/throw/factcount/Object.is |
| lazyrow 同 immutabledigest | getter 直绑原 fragment，canonical lazyselection 弱 key，不留 wrapper | lazyidentity/owngetter/foreignreceiver/publication 隔离，holdrow/getter 后释放验其他 sourcecollect，计 weakindex/cold |
| batchclosure 捕 optionalcolumn | sharedfn，仅 presentinput，column 每 livebatch 一次，unusedview 延后 | view 仍 lease/schema 代价，validation/migrate/reentry/detached，计 header/1row/absent/dense |
| privatecomputed scratch 经 genericiterablesnapshot | indexedlane 直 copy finalimmutable | 实际 privateproducer，public borrow/custom 语义/signedzero/held/reentry；escape 不能 arena |
| statecandidate 重建 changefact | frozenfull/empty，每 projection 至多 last equalpartial | declarationorder/held/独立 completion，quiet/full 快路，rotating/discard/cold/retainedarray |
| lazycollection 多次消费 | 原 owner numericmembership/有界 cursor，去 nestedgenerator | fixedmember/独立 walk/earlyreturn/heldrow/publicresult lifetime/fullwalk |
| columnshape 反复枚举 fieldMap | 原 orderedvocabulary/sidecarname | key/order/managedreader/stride/freshcarrier/grow/partial，narrow-wide 完整 |
| compiledowner 固定 MapSet | compile-ownedorderedwalk，resource/capability 仍 live | extraarray/rebuild-retire/order/resolverreentry，JIT 或已消 iterator |
| frame/record 构造 | 原 owner mutableinternal，发布 detachedimmutable，验 finalshape | heldsnapshot/asyncfact/replacement/reentry/symboloptional/enumeration/lazy |
| system 无 deferredstructure | 注册 commands:'none'省 transaction | 默认 commandbuffer freshidentity；denial/replace/reentry/predecessor flush/poison |
| fixed/variable schedule | 借 compiledorder numericwindow，topology 变才 membership，仅 deferred 建 ledger | midframeregistration capturedmembership/predecessor flush/abort/commandID |
| perframecachedomain | Mesh/resource 保留 hotweakentry，按 actualdistinctread 重建 | cold/sparse/unread/replace 退，计 capacity/lookup |
| privateledger | boundednumericgen 复用 pending/acceptedcell，callbackdetach | commit/reject/clear/heldcallback 精确、不 retainretired |
| rollback | 原 invariant 允许才 journal 本 transactionfreshaddition | arbitraryreplace/remove 仍 snapshot；abort/retry/completionlease |
| simulationservicelookup | pluginactivation 解析并留 Fiber | unload/reinstall/dependencyinvalid，无 globalcache |
| count 逐帧变 | 各 owner 共 dynamicCapacity/shouldShrinkCapacity，reservation 内 inplace、保留 address-buffer-binding、仅 clearreleasedtail | 首 publication exact，越容量/大 shrink 重分配，rowtemporal/diffupload，uniformfixedarray |
| validate/copy/reduce 多 walk | perleaf 融合、Math.min/max 无 branchfold、loopidentity/uniquenessmemo | scatteredrealdata branch mispredict，保留 invalid/NaNreject |

cachehit 也可能 allocoptional/diagnostic 集合。coldtemplate/value ledger 仅请求构造时共 admit，pose-only 不需 fullrowMap。activecontrol 需实际改 material/row 非同值；量 heldMap 减少和 coldheader，完整 prepare/transfer/accept-discard/recycle。liveflag 按原序 read，miss/fail 才建 name/descriptor，保留 finite slot；shared/ordinaryhit/periodicrecover/colddescriptor 验，functionheap 归因不证 finalGPUcache miss。

小 fixedrestriction 不可枚举大 universe，immutablequery 保留 source membershipbound、遍较小域，nested 传 bound 不 eagerintersection；sortedorder/multiplicity，booleanrestriction key dedup、fixedowner 才 exactcountcache。attemptedcheck 按 K，双 operand 顺序、必要 output/treelookup 与 wholemaintenance 分开。

borrowedkeycursor 仅 intrinsicfixednumericroot；publicSet iterator 普通 result lifetime，arbitraryiterable live。walk 独立，break/throw 关 inner，empty 可 sharedimmutabletermination。先融合 nestedbookkeeping 再 pool，量完整 sparseconsumer，少 generator 非 win。JIT 可能消 record；Set loop 换 forEach 加 callback/context 可增 alloc，generator 变 array 多态可增逐 memberalloc。完整 consumer 比较，private reusedresult 仍独立 walk/earlyreturn。短 CPU 充分 tier warm，cold/partial 另留；unchangedcontrol 同倍移阻归因 processratio，tier 后相邻 alternatingCPU+freshprocessalloc。coldcapture 只 membershipcachemiss，不加每 hotcursor 字段；one/manyroster/repeatedread 验，full exhaust 才发布、失败丢。

清 arraylength 可丢 backing。quietimmutableoutput 只有两 ledger 都 exact detachedentry 已由 root 持才保留 secondcapacity；change/fail/shrink/dispose 清 candidate/retire，不为容量留 borrowrow。完整 walk/addressconsumer、sparse/dense/duplicate/reorder/spikedrain 验；为省 quietwrite 加 branch 可能慢 changing。

binding coverage 依 peer 同 material/group/World/Mesh/draw，不仅 exactbinding；每 batch 全 check 又扩无关。原 sourcebatchdiff 维护 adjacency、pruneretire。fixedroster 不证 consumerselection immutable，actualproducer 另 admit，borrow selection 全 rejudge。availableproof 比 identity/reject 所有 input、deformation/fragment/ownerdevicegen；复用已读 privateprimitive 不另 roster。custom/borrow/unavailable 普通 route，dense replace/steady/periodic 量，proof/freeze 可慢 dense。

stockreadonly 静态 Query 可每 World 一份，own frozen declaration，每 hit 记 full vocabulary、失败 creation 重试，普通 iteration 解当前 member。先问 ECS activecursor，nested callback（含 throw）外 cursor 未关须独立 Query。不 sharetemporal/不丢 optional absence/joineddep。去 dependency percall fallbackarray 前完整 extractcontrol，数 attempt 不只 write，zero-write 可全 scan。

copy-on-writepagepool 若 automaticimmutable row 必须 detachnumeric，会 duplicatebacking；完整 owner 计 escapedvalue/rootedge，lastreaderpass 不证 CPU/memory 收益。physicalreuse 前内部迁 scopednumericrow/delta、publicautoobservations 分保；总 backing/CPU 增即拒。persistentmembership 只提交 actualflip，pose/content 变可 membership 不变，bitmapcopy/editbatch 前滤 noop，保留 entry/remove/availabilityrecover/heldframe。

push 可复用 capacity、splice 产 resultarray、MapSetwrapper 复用不证 clearrefillbacking。实际测不按语法禁。fixedbindingsequence 经完整 produceradmit 后 rank 直索引不建 generator 取一条；coldmerge/partial-range/order/slotreuse/held，steady/densePass 完整 query-walk-read 验。

intermediateroster 无独立语义则直接 publish finalaccepted。perviewvisibility/cull 与 sharedprepare 分开，producercallback 保留 acceptedworkselection。VFX 代码/layoutimmutable 共享，各 Playerbuffer/seed/tick/feedback 独立；retainedeffect material-mesh-texture 完整 closure 跨 replace/abortACK/retire 保。

producerownpredicate 且无 requiredcopy/timing/resource 边界的 orderedcompute 可共 physicalpass，全 resourceunion、每 kernelpipeline/binding 显式，custompredicate 无明确 admit 保分 pass。验 indirectreadback/Skin overfloworder/pixels/timestamps，少 APIcall 不证少 shader/lowerframe；physical 变化改变 queryinstrumentation，先 equalwrite/samescopecontrol，cold/steady/unresolvedasync 可见。

many-static-light 每帧多为重建未变 snapshot；componentmutationepoch perentitycache 仅非 interpolated/volatile，返回同 object 让 deepcompare 短路。120灯 extractself 去掉、deepcompare 半约0.3ms/frame；purecameracollector 记 mutation/structureepoch+Time/FixedTimephase。CPU 交错 profile 按 functionself，不总时（同 build5.4–9.3ms）。

## 经既有契约减少 GPU 工作

| 工作 | 边界 | 验证 |
|:--|:--|:--|
| 材质 constantUV math | 原 cook/uploadderived ABI | f32round/schemaoffset/direct-Scene-rigid-skin 一致，fragmentdependent 留 shader |
| 重叠 neighborhood | 共享 actuallaneintegercoord 再 conservativefootprint/losslessrow | f32phase/nonpow2直 textureoracle，center/rowmajortie/invalidveto/background-farthest/barrier；rejectedregion、separatedevice replay 后 matchedlive；[TSR |
| staticfeature/unusedresource | compileractivegraph/static switch | program/macro/layout/binding/startup 一致，animated 仍 data |
| counteronly 复制 fullcapacity | persistentproducer 按 declareddemand 定 storage/import/copy | 默认 detailedreadback/originalframefence/pendingmapskip/replacecleanup |
| loading-onlysource | 成功 prepare/admit transition | freshinvalid/coldfail/recover 可见 |
| sparse/local 贡献 | 原 view/compositefootprint | jitter/upscale/filterAA/border/history，pixels+actualraster |
| batching/welding | author/publication | CPUrow/retainedgeometry/topologycandidate/draw 分计；完整 attribute、primitive-material-corner 序 |
| shadowprepare/retention | scene/view/physicalowner | 同 bounds 内容变/lightmaterial/perviewfrustum/receiverfilterbiasguard/newgraphdevice |
| GPUteststartup 重复 | 共 initrenderer/device，freshWorld/asset | requestbudget/leasecleanup，独立 constrained/publication/coldtemporal/freshreplayfalsifier，framespixels 不变；[预算](../../scripts/ci/README.md#native-fixture-workload-budgets) |
| testreadback/逐 texelassert | harness 复用 unmappedstaging，aggregate exactpredicate 失败 | 每 read/frame/predicate 保，unmap 前 copyownedbytes，extent/device 换，拒 restoreallocation/损坏 finitecoverage |
| replayprefix | 原 FrameModelmetadata 投影，batch 选 workread | exactpixel-param-depth/provenance/原 framewindow/独立 falsifierdevice/nativebudget |
| snapshot/referenceassert | sharedbytehelper 全 payload，reference 用 identityoracle | 所有 byte/metadata/provenance/negative，realmatcherguard/fullnative；[工作](../../scripts/ci/README.md#native-payload-and-startup-work) |
| materialwirekey | 全 canonicalartifactbyteview+不变 JSONmetadata | realenumeration/serializer/differentbytes 同 claim/subview/metadatacollision/source-decode-adopt；[传输](../../packages/pack/README.md#shared-material-program-transport) |
| fixturecook | 仅真实 backend 契约 fixture 声明 storageWebGPU 或+rays | 全 programbyte-selectionparity/rayCard/producerID/outputcontextguard/原 portable constrained fallback，digest-wire 后 normalizeview 一次 |
| gziptransport | Node 包 nativecodec、browserWorkerportable | 全 payload/stored digest/corruption/replay/conditionalpackage/Nodecodeccallbudget 后完整 timing |

少 shader op/tap 只是 hypothesis，actualbackend 需 pixels 接受且 GPUcost 低。M4Pro1080p r2 main 约11ms，去 ambientIBL 全 res 无 gain、half 仅-0.6；末 transparent depth/stencil discardstore 无 union/main 变化。永不取 discard 放 override 后 main 反慢2.7–2.9；compile-time 去全部 opaque discard 重 shotmain 半。Apple TBDR 可达 discard 关 HSR，override 折 if(false)不可靠；Tint 把 standardSurfaceDiscards 降 MSL if(false)。早期删 LOD/viewclip fs_opaque 三 perf 交错7.80/7.93/7.85对7.79/7.82/7.65在噪声，不证 fold 免费。每 discard 用#if AXIS==true（ALPHA_MASK/LOD_DITHER/CLIPPING_PLANES），boot 新 axis 默认 false，不依 if(false)；合 three-state none/clip/lod+clip 裁 row、不增 independentaxis，实 backend 逐验。whiteirradiancefallback 改1.0 main7.70→8.17，已撤。

首用 nativeasync digest 不可改同步 JS。manifest crypto.subtle 换 lazy @noble/hashes sha256使 firstacquire1624/1720/1726→2491/2727/2875ms，verifier 约1046ms（11372fragment/25.4MB/5752source）；nativeasync integrity offcriticalpath，应保并 end-to-end 量。res/cascade/distance/filter/quality 变新 profile。

## 编译期 shader 特化

| 规则 | 原因/实测（r2 M4Pro1080p） |
|:--|:--|
| disableddiscard 源级 preprocessor 去掉，不 if(false)/override/uniform；默认 opaque backend 零 discard_fragment | Metal 保留 literal branch，可达 discard 使 TBDR 失 HSR/mobile earlyZ。两 never-taken 去掉重 shot16.6→8.5ms；viewclip/LOD 仅-0.1也去；全 dump38→17，剩实际用 pipeline |
| material 选 ALPHA_MASK（cutoff>0或 alphaHash），每 variant 仅所需 cutoff/hash/clip/启 crossfade 才 LOD | sharedunuseddiscard 所有 opaque 付费，cutout 不带 LOD；UE mobile AllowDitheredLODTransition 默认 off。submit58.6→60、gap p95-2ms、union-2.6~-3.6，t600/1800checksum 同 |
| 新 axis 全入[variant-permutation-rules.ts](../../packages/shader/src/variant-permutation-rules.ts)，runtime 不可请求组合一 rule+reason+test，相关 switch 合 axis；512MBseed/128MiBpublication 不改 | independent LOD×clip 四倍 row、4GB OOM；三组合121.0/121.9MB；prune5747→3299row、143.9→121.3MB；SIMPLE 未剪3715/149.85MB→3395/129.35MB |
| DIRECTIONAL_SHADOW_SIMPLE opt-in 仅 config 证明等价（1cascade/no blend/pcfvogel/no constantbiascamera），isSupportedVariantKey 否则 general；special 未编好用 prewarmgeneral 且 pixel equality/countfallback | 漏 prewarm CI 等12帧空图；1lightunion10.21→9.05（ablation90%），nolight8.29→7.55，MSL261→240KB |
| shadercontainer ASCII JSON，非 Latin1（含 WGSLcomment）escape | 一字符使全 V8string 二字节；约175字符130M 容器约234MB，ASCII128MB，text+container402→280，过 Node22 512MBseed |

perf 独占 slot 前先 cheapcheck：有 Harness UE 源码时查 permutation/DITHERED_LOD_TRANSITION/mobileEnvBRDFApprox/PSOprecache（64002override 取回 receiver 收益0%）；Dawn dump_shaders 查 MSL 已去 discard_fragment/_pickCascadeLayer/PCSS，仍有就不跑；freezeAt 约6秒重/典型/spike shot 定方向，kept 才 fullinterleavedAB，同 perfjob 所有 cell、只重建 changedpackage。620对1850的 spike main 多5.66ms 在 shadow receive（shadows0为1.56）。只减可比 cell：displaycapidle 降频，shadows0 union13.66反 base12.17；reference 同 programvariant，0light 选小 cluster 所以用1light；gputiming 本身57.0对60submit/s。新 Skinwrapper/recycledpage 不证 pose 不变，保留 conservative demand；logicalretained 不能初始化 replacementphysicalGPU。

## 保持调度、物理和延迟工作

| 症状 | 下一步 | 不变量 |
|:--|:--|:--|
| 长 completed picture 间隔 | join 精确 World/device/frame task-submit-complete/validthreadclock | taskwall/threadCPU/notificationdelay/GPUduration 分开，unknown/rightcensored 保留 |
| Hostidle 漏 nativeanimationcallback | Window/Worker frameprovider、compositorbegin/drop 先比再 publicationcredit | 优先既有 Worker/Hostchannel 非新 clockWorker，busyRender 也漏所以测；Workerclock 是 nativepacing 非 timer/syntheticcompletion，保留 Windowtime/input/visibility/cancel/dispose，计 Worker/message/heap，去 override 后 sustainedmotion 验、browser 版本分 |
| backpressure/catchupburst | 减占原 credit 工作 | input/World 变前 admit，ordered effect/fixeddelta/droppedtime |
| GPUcomplete 期间 nativeCPU/alloc 涨 | draw/complete 分 threadCPU、另 census eventpump | 操作/pixels/rawregression 保，diagnosticscheduler 非 productiongain |
| nativephysics 压力 | 恢同 snapshot，比 phase/shape/compoundleaf/activecontact/step | nativeonly 不含 controller/publication，pose/velocity/sleep/event 同；抑 contact 改行为 |
| callback/event 默认开销 | 无 JShook 则 nativefilter，仅 decode 必要 contact | customcallback/sensor/response/unknownpair |
| 停输入后破坏变慢 | 同 World 贯穿 warmup/持续 impact/stoppedtail，trace support/fracture/admit/publicationqueue | 每 queue oldestage/produced-completed，boundedqueue/counter 非收敛 |

terrain/fragment 广 wake 与 visual-only 在真实 producer 分开。budgettraversal 到首 yield 前 inplace，不全 copyqueue。关 collision/damage/effect/shadow/publication 是 sensitivity control 非等价优化。

## 分配与性能证据资格

双比较明确：原 unoptimized→全部 retained 为累积，previousaccepted→newbatch 为增量；拒本批不抹以前收益。累积两边各自 lock/patch 重建，共 native/assets/workload 固定、capture 前后验 loadedpayload。allocationrate/completedthroughput/GCthreadCPU/pausewall/worstpause 分报；低 byte/GC 不证 FPS/短 pause，serial 窗口全保。

每轮 Engine/Render 分列 event/byte 总量、topsourcefunction count+byte 份额、otherunknown；同 rowset 用于两分布，countheavy 也含，row+remainder 两总守恒。附 duration/completedwork，以各 realm 真实 completion 归一（World 非 Renderer）。ordinarythroughput/samplebyte/intrusivetrace/afterGCcensus 分表不同 population，不叫 sample 对象数。retainedtype/node/selfbyte 与 churn 分。浏览器用 forgeax:frame-completed 观察，不只 rawWorker（splitRender 可独 MessagePort）；counter/absence 解释前 positive readyframe，缺 count 标 unmeasured/缺 capture。

说明是否改 source/注 listener-control/enabletracking/pause-forceGC；profiler-off 仍可含 inputdriver/inspect/observer，profilebyte 仅该诊断估计非普通精确率。calibration 在 counterbaseline 前，剩开销明报不减假 constant。private/intrusiveevent-frame 降非 wholeWorkerbyte；不一致时同 collector 重放 fullbeforesource、恢复 candidate，保全 window/throughput/byteperframe/coldmetadata。中途 package 成功可能 declaration/shaderprofile 未完，重叠 probe 拒。before-replay 前 seal 安静验证 candidate，finally 恢复 exactsource/output 后验 full manifest/generatedreceipt；成功 archive 只支持同 protocolretry，不能补不完整 motion。只 switch 差异 bytes 或独立 frozencheckout；equalbuildrewrite 会 wakewatcher，记 hostactivity、buildrestore 窗口外；incomplete recovery 不能借前 cohort 成功 window。

| 证据 | 必需核算 |
|:--|:--|
| churn/retained | rate/promotion/afterGCfloor/peak 分，乘积非 GCequation，含 TypedArraybacking/pool/duplicategraph |
| scalinggain 当前 scene 小 | 两 population 和新 retainedbaseline marginal，允许目标显式 storage/update 取舍，不能称 CPU/GC/FPS |
| source 归因 | loadedJS+双 map 认证，direct/ancestor/unresolved 一次，ancestor 非 exact expression |
| JITprobe | warmactual、collected、escapingpositive；marker 可 inline 时指 URL/function，orphanunknown |
| noisy/small | 预选 window/order、全重复 workcount，min/localvariance 不能改预算 |
| clock | threadCPU 非 wall，GPU sum/union/envelope/completedpresentation 各异 |
| ready/complete/capture | actualowner/receipt/fence；draw 成功/queuewait 不证 ready picture |
| proceduralaction | selectedproducer 成功+expectedartifact 后 freeze，UI/无 error 不证 generation/旧 asset 等价 |
| frozeninput | README-only 也 fullpayloadidentity，wrapper 同不证 WASM 同 |
| backend/bundle | virtualprepare/match 与 nativeexecute 分，一 bundle 前可许多 sourcecheck |
| CIplacement | complete file 含 skippedprocess，interrupt 无 completion，roster/assert/deadline 保，scheduleestimate 须 finalheadCI |
| coverage | actualwrapper exclusion/type 模式后 member，结果 JSON 验 case |
| testattribution | actualop/phaseduration 先选 owner，intrusive 独立、conservativepredicatereject 后比 fulloutput |
| privateinstrument/stub | Node/Null/stub 非 browsernativeGPU/FPS |
| vsynccap | GPUunion headroom=1000/p50，submit/s 对 rAF（2credit）和 mainthreadCPU；不可 uncappedChrome 作 headroom（GPU 争用，同 build57.8capped 对43uncapped） |
| AppleGPU | perpass timestamp+union+固定 res diagnosticablation（shadowraster/sampling/locallight/post/scale），看 serialcriticalpath 非 sum，ablation 改 pixel 只定位、不 ship |
| Metal 大型 fs | exclusiveperfslot 实测 main，不凭去操作；Tintoverride 留 if(false)，reachable discard 失 HSR。material compilevariant alpha；a1 override64001仍 alphahash main+2.7、submit57.6→51.7；d12去两 discard16.6→8.5、41.3→58.1/full58.8→60。MSL 验零 discard。receiver64002折 PCSS/cascade/variance 收益0，SIMPLE 仅 config 满足、先 dump 无_pickCascadeLayer/PCSS 再 perf |
| crossbuildreplay | 同 deterministictick，readback/indirect 全 seed，不同 unseedcount 无效；replay/live 符号不同 live 定 |
| loadedhost | beforeafterload/startceiling/interleave，hoststall 两 build 均 noise 非 gain-regression |
| Nodemicrorun | realcount/scatteredtransform，uniform 可反转 branch-fold，保变化都 realgameprofile 确认 |

knownallocowner 不合理零为 unmeasured，保留 raw、warmordinal 后 sample/coverage/positivecontrol 验。recover 改 interval/setup 两边新 matchedcohort、保留 reject。queuefake 若保留 syncuploadinput 要 scratch 复用前精确 bytewindowcopy，保留 assert 另验 realGPU。upload 移 creation 验 capturebootstrap/freshreplay/livepixels。单 owner 去 alloc 不证 wholeWorker/retained heap/target 解决。

<a id="gpu-capture-workbench"></a>
## GPU 捕获工作台

[gpu.mjs](scripts/gpu.mjs) 提供 resourcebyte-count 层级、pass-resource usage、selectedwork shader-binding 图、APIspan；保留 canonicaltapedigest/resourceID/workIndex，不新 recorder/replayowner。原 summary/overlap analyzer 数值权威，本入口加视觉交付。

```sh
node <skill>/scripts/gpu.mjs setup
node <skill>/scripts/gpu.mjs report frame.rhitape --out-dir /outside/source/gpu-view
node <skill>/scripts/gpu.mjs query /outside/source/gpu-view/gpu.json --search shadow
node <skill>/scripts/gpu.mjs serve /outside/source/gpu-view
node <skill>/scripts/gpu.mjs images /outside/source/gpu-view
node <skill>/scripts/gpu.mjs timing capture.json --pointer /gpu/samples/0/observation/frame --out-dir /outside/source/gpu-time
```

report 默认当前目录 packages/rhi-debug/dist/index.mjs，另安装--rhi-module，或 canonical producer {identity:{tapeDigest},frameModel}JSON。setup 一次下载固定 integritychecked ECharts/Cytoscape/ELK，--runtime-dir 改用户 cache；resourceHTML 嵌 runtime/license 可离线。Perfetto 固定 hosted UI，--perfetto-ui 自托管且 HTTP。images 需 Playwright/sandboxChrome，--playwright-module 选安装。每 report SVG+HTML+AIJSON，验图/真实交互后分享链接/PNG。

> [!IMPORTANT]
> byte 仅 capturedresourceclosure/descriptor，非 nativeallocation/residency。view 共 textureID；未知 size 保未知（含不支持3D 估计）。count 是 unique APIobject，仅观察 buffer/texture 销毁。图 edge 为 draw-dispatch binding/attachment，不是 transfer/barrier/compiledDAG。APIspan 事件 index 非 GPUtime/retire。timeline 收同 Rendererframe rawlive begin/endtick，分 displaylane 保留 overlap；sum/union/envelope 非 occupancy/wholelatency。不从 replayaggregate 造 interval、不对 GPU-CPUclock、不按 label 拼无关 capture。

## 详细方法与证据

| 需要 | 参考 |
|:--|:--|
| baseline/clock/coldidentity/batch | Measurement |
| gap/taskjoin/backpressure | Slow frames |
| key/fanout/rollback/VFX/publication | CPU preparation |
| heap/scratch/ECS/output/反例 | GC |
| static/uniformderived/coldresource | Materials/shaders |
| coverage/filter/shadow | Shadows |
| native/contact/replay | Physics |
| support/queue/stoppedtail | Destruction |
| 小稳定 working set | Working set |
| Fog 直接产/shadowinit/边界 | Fog/shadow |
| allocation/lifecycle | Allocation |
| cacheregression/cold/nativecomplete | Regression |
| adapter/工具 | Toolbox |

analysis/render 用 Nodebuilt-in 读 local，原名恢复用 caller 固定 TSparser。capture adapter 在 publicprojectplay，需 browser/GPU 准入，tooloutput 不资格认定 deliverygate。

| 工具 | 输入/结果 |
|:--|:--|
| [memory.mjs](scripts/memory.mjs) | allocationstack/snapshot，report-inspect-ownedNodecapture，folder/squarifiedtreemap、AIJSON、SVGPNG/离线 HTML |
| [gpu.mjs](scripts/gpu.mjs) | canonicalRHI→resourceworkquery、离线 ECharts/CytoscapeELK、SVGPNG；rawliveGPUtick→overlapPerfetto |
| [cpu.mjs](scripts/cpu.mjs) | livegame3d+autoreport/browsercalibration/saved 分析，HTMLSVGJSON、totals-gap/Perfetto |
| [render_metric_report.mjs](scripts/render_metric_report.mjs) | 显式 JSONPointer，同单位 bar/line、离线 filter-reload-table/source digest/reusableJSON，null unavailable |
| [summarize_gpu_timing.mjs](scripts/summarize_gpu_timing.mjs) | observation 语义 passcost/completeness/union/envelope |
| [analyze_gpu_timeline.mjs](scripts/analyze_gpu_timeline.mjs) | 同 reportcompletionreceipt、overlap/envelope/missingpopulation |
| [analyze_heap_profile.mjs](scripts/analyze_heap_profile.mjs) | SamplingHeapProfile 守恒 direct/ancestor/unresolved/owner |
| [symbolize_heap_profile.mjs](scripts/symbolize_heap_profile.mjs) | scriptdigest/frozenhiddenmap 认证 source |
| [compare_heap_profiles.mjs](scripts/compare_heap_profiles.mjs) | 两 retained 或两 churn，package-file-function-unresolved byte |
| [heap_snapshot_census.mjs](scripts/heap_snapshot_census.mjs) | V8守恒 node/selfbyte/type-name，非 event/dominator |
| [allocation_trace.mjs](scripts/allocation_trace.mjs) | 同 tracker 累计 selfevent/byte、守恒 function，含 collected/VM |
| [summarize_game3d_allocations.mjs](scripts/summarize_game3d_allocations.mjs) | moving/count/census 认证 digest，realmname join、守恒分布/独立 completion |
| [capture_game3d_counts.mjs](scripts/capture_game3d_counts.mjs) | intrusive Play，各真实 Worker 验 live/collectedwitness 后有界 motiontrace |
| [capture_game3d_allocations.mjs](scripts/capture_game3d_allocations.mjs) | publicplay，3ordinary+3collectedsampling，有界 WASD/completion |
| [game3d_motion.mjs](scripts/game3d_motion.mjs) | fixedtarget 真实 input、positionfeedback/finiteXYZ-height-range/travel/全 exit 放键 |
| [game3d_workload.mjs](scripts/game3d_workload.mjs) | realvaseproducer/不变 publication-param-geometry receipt，terminalfailure 拒保留 oldmesh |
| [capture_game3d_retained.mjs](scripts/capture_game3d_retained.mjs) | intrusive Play 真实 motion、Apppause/drain、serialWorkerforcedGCsnapshot、恢复 healthycompletion |
| [allocation_probe.mjs](scripts/allocation_probe.mjs) | Nodewarmfunction sampledbytes/call 防回归 |
| [summarize_native_gc.mjs](scripts/summarize_native_gc.mjs) | ownedthreadnative，Minor/Major/finalization、有界 allocation-promotion |
| [compare_samples.mjs](scripts/compare_samples.mjs) | rawarray+workload identity，matched 统计或显式 mismatch |

memoryadapter 需明确匹配 workload。默认 runtime-vase 保留 producer/publication；stockrobotcorridor 设 FORGEAX_MEMORY_WORKLOAD=stock-corridor，验 actualplayer/hardware/bothWorkers/WorldID/Renderepoch/全程 boundedmotion。缺 vaseprojection 是 mismatch，不能绕。debuggerarchive/snapshot 前 pause/drain 含 physicalRendercomplete。

movingalloc 设新源外绝对 FORGEAX_ALLOCATION_OUTPUT，执行 forgeax project play <absolute-path-to-capture_game3d_allocations.mjs> --root templates/game-3d --backend hardware --headless true --require-ui --viewports 1280x720 --timeout-ms 240000 --json。ordinaryownerpage，另在前后 freeze/verifybuildnative。侵入 debugger/source archive 前实际 App 暂停并 drainsubmit，completion 不变，再 resume/warm。productiondeadline 不动、保留 timeout 图；collector 设变新 baseline。stockemptycorridor fixedtarget，用实际 position/camerayaw，逐观察 finiteXYZ/groundheight/spatialbounds，失败放键。仅 horizontaltravel 可能是掉平台，invalidatevisualcompare；失败全保，motionprotocol 变要新 matchedbaseline 含 fullduration/endvisual。

Canvas 非 bubblingcompletion 在 capturephase 听，sample 前 ready receipt；heldinput 非 motion，逐 window 查 travel/health/WorkerID/readyrate。全重复/失败保；ratebound 只是 asyncsamplerboundary 非 confidence；orphanbyte 计 unknown，sample 非 temporarycount。retainedcensus/eventtrack 与 ordinary 分。

retained 同 command 换 capture_game3d_retained、FORGEAX_RETAINED_OUTPUT。DevToolsclosurescope 找 realApp；不可用即失败，不能假 pause。两 snapshot 全过程 zeroinflight/completion 不变、resumehealthy。forcedGC/snapshotwall 侵入，非 naturalpause/ordinarypeak/movingrate。截图即时 archive+producerdigest 认证（play 复用 perscriptpath）。

event 用 capture_game3d_counts/FORGEAX_TRACE_OUTPUT，actualruntime 用 knownlive/forcedcollect/不变 cumulativesourcecounter 验。VM 可同 function 增 event，不能逻辑 object 相等/从 survivingID 推 cumulativetype。trace-node self 只加一次，functionstart/ancestor 非 exact expression；tracking 改变执行、不含 external/GPU，不能 ordinaryrate/movingbudget。

各--help，Toolbox 管 args/exit/adapter；privatepath/raw 保，摘要仅其分析边界。CPU node <skill>/scripts/cpu.mjs --help/report CAPTURE_DIRECTORY（raw profile/report/frame/optionalmap→新 view），单 cpuprofile 也可，--dist 与--engine-root 同时恢复认证原名，已有 output 拒覆盖。

| live CPU 设置 | 默认/override |
|:--|:--|
| 请求 interval | 1微秒，FORGEAX_CPU_INTERVAL_US |
| motionwindow | 3000ms，FORGEAX_CPU_WINDOW_MS 允许1000..30000 |
| target | 全 JS，FORGEAX_CPU_TARGET=Host/forgeax-engine/forgeax-render |
| ordinarycontrol | 3×5000ms，Profiler/Debugger off |
| output | 必须新绝对 FORGEAX_CPU_OUTPUT，view/ |
| releasename | FORGEAX_CPU_DIST frozen dist，FORGEAX_CPU_ENGINE_ROOT source/build 默认 cwd |

offlineinspector 树/function/completion，Perfetto timeline。cpu query timeline.json，--view functions 默认/intervals/tree/completions，同 normalizedsample/原 aggregation，GPUmemory 留原入口，无新 recorder/querylanguage/scenarioanalyzer。

| 选择/投影 | 控制 |
|:--|:--|
| target/range | --target NAME_OR_ID；from-ms/to-ms 或 completion-index，subrange 需在 completion 内 |
| context/interval | --search name/source，--node-id targetlocal 需单 target |
| sort/page | function selfMs 默认/inclusiveMs；interval startMs 默认/durationMs；completion completionGapMs 默认/startMs；limit100/offset0在 aggregate 后 |
| tree | --view tree --direction top-down/bottom-up，全 path 无 filter/page，散 visit 聚合、recursion 独立 |

completionrow→选一个→functioncontext→nodeinterval；interval 保留 canonicalsliceIndex/original-clipped/sampleRange，非 CDPindex/invocation 数。保留 SHA256/capture/clock/coverage/reconstructionaudit，unobservedunknown。进程内[scripts/cpu_query.mjs](scripts/cpu_query.mjs) selectCpuTimeline/queryCpuTimeline 可 borrow selection 共 projection，--output NEW_JSON 不覆盖。

cpu 公共 playadapter 冻结 bytes、realWASD/completion，source archive 前 drainEnginepublication+physicalRender，恢复推进验证。release 支持 forgeax-cpu-profile optin 和 idleEngine recorder；CPU 案例记观察限制，非 browser 数值保证默认。GPU/GC/heap/scheduler 分开。

numericreport：node <skill>/scripts/render_metric_report.mjs INPUT.json --rows-pointer /samples --unit ms --chart line --out-dir NEW_PRIVATE_DIRECTORY；CPUself 用/topSelf、label/functionName、value/selfMs；GPU/pass 用/passes、重复 durationMs/mean 和 p95。comparison 显式同 unit /baseline/p95、/candidate/p95，先查 producer 可比。这些仅 display projection 非新 acceptance/clockauthority。

可复用 decision 留本入口，方法/反例归 topic，datedresult 单 scopedcase，见贡献。去 superseded，rawfail 私有；单 run 数/hostpath/quality/未实现 prototype 归 case，入口只规则。

animation 外部 sampletime，speed0仍需 poseeval；保留 event/normalize/targetupdate，只跳未变 clockwrite，经同 owner 验 pause/wrap/externaledit。fixedinputmaterialbuild 经 Packsourcefence capture 完整 WGSL/pathnamespace，显式 captureMaterialSourceSnapshot 传 cooker；不应用 live/default。transportDDC 需 productcacheproducercheck+明确 pure/sink-free policyID，cacheddeptopology 只排 work 不能 admit/skippublication。
