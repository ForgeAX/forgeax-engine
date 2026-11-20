**语言**：[English](AGENTS.md) · **简体中文**

> [!NOTE]
> 本文供人阅读。工具识别的入口仍为英文 `AGENTS.md`，工作约束与英文版一致。

# ForgeaX View

View 是可选的资产查看器、Pack 创作客户端，以及 Engine AI 运行的只读观察器。AI 是主要用户。Engine 在独立浏览器中拥有执行权，通常无头，并使用固定工程输入。View 拥有自身浏览器资源、工作区 API 客户端、前端插件和呈现。AI Display 从不承载游戏。

`node tools/view/start.mjs [--project G]` 在前台保持 View 呈现和借用的启动器存活。它先发布普通 URL，再通过 H 已有进程管理器异步确保 Engine Backend 运行。View 解析匹配的 Engine 和自己的 Host Pack；默认 H 为每个安装共享的系统临时工作区。`--new-instance` 分配唯一临时 H，显式 `--root H` 选择调用方管理的实例。Backend 终止后，Shell 仍可用于重新启动。启动直接调用公开 `ensureDevKitView` API；实例控制显式使用返回的 H。低层 `backend start` 和 `view start` 仍可独立使用。普通文件启动省略 G 时绝不将 H 当游戏：新所属方未绑定，已有工程仍是权威。旧低层 `view start` 要求兼容 Backend，可接收显式 G，或包含 `forge.json` 的 H。

Engine 拥有唯一共享工程与会话；普通 URL 连接采用它，只有选定呈现者放置文档。呈现者交接等待准确旧帧退出；嵌入式工程调用方仅在同一 Engine 运行时借用选定呈现者的 broker。显式工程 URL 是可选且受保护的切换命令。DevKit 拥有持久的已知与最近工程目录及 Node 可见文件夹浏览；View 消费结构化结果。离线、已连接未绑定、已连接已绑定均保留同一 Shell。用户另行打开浏览器；Play 和独立 AI 运行各需单独操作。库路径借用调用方 Page。View 启动器契约由产品所有，H 的进程管理器仍是唯一 Backend 权威。

View `start` 和 `status` 暴露所属方派生的 `presentationId`。原生准入 lease 替换后固定 URL 仍可能有效；URL 相同本身不证明呈现生命周期相同。嵌入消费者保留未变化资源，先退休旧文档，再准入替代文档。

Scene 资产使用 Scene 页面；其他资产使用注册的资产页面。状态和目标使用 scene/preview 命名，资产呈现使用 viewer，共享表单 token 使用 control。当前术语契约见[页面命名](README.zh-CN.md#page-plugins-and-names)。

## 架构共识

> 保持 Host 轻量，将行为放在插件中。优先减少概念，而不是新增注册表、生命周期或权威来源。

以下日期决策按从新到旧阅读。同一边界的新决策替代旧说明，未改变的约束仍生效。提案行为和实验不属于实现证据。修改运行时边界前，检查已安装 Engine 包的导出、README 和匹配实现证据。北极星是这些决策的索引，不是竞争契约。

| 决策（由新到旧） | 当前权威 |
|:--|:--|
| [2026-11-05 云材质和体积纹理检查](docs/2026-11-05-cloud-material-volume-texture-design.md) | Engine 通过资产检查返回有界 cooked cloud 参数和解析后的实例值。View 已有资产页负责分组只读详情及纹理导航。3D 源增加 GPU 图集、切片和立方体表面模式；缩略图使用立方体表面，初始通道为 RGB。该任务明确授权配对的 `vc-ue` Engine 变更。 |
| [2026-10-26 蒙皮资源预览](docs/2026-10-26-skinned-resource-preview-design.md) | Engine 可选原生 preview Fiber 提供静止姿态 Mesh skin 绑定和刚性加权 Material 基元，与缩略图共享。原始资产绑定与材质程序仍为权威。View 保留已有准确目标操作、放置和输入策略。 |
| [2026-10-22 材质纹理引用](docs/2026-10-22-material-texture-references-design.md) | Material Details 从捕获的发布中显示所选材质输出声明的纹理依赖，按显式 Catalog kind 过滤。它们是去重资产引用，不是 shader slot，也不证明实际采样的 GPU 绑定。共享缩略图和资产动作保留原所属方，Engine 仍只读。 |
| [2026-10-22 Mesh 预览漫游相机](docs/2026-10-22-mesh-preview-roam-camera.md) | View viewport 输入 Fiber 在借用 Engine canvas 所属文档中采样隔离 Mesh 输入，使用已有公开目标相机方法。Mesh 点击不选择 Scene 实体。Restore 在提交初始预览姿态前完成该文档相机事务。同文档 Mesh 面板保留自身输入控制器；其他资产页保持放置与输入策略。扩展原生 preview adapter，不改变 Engine 相机或资源权威。 |
| [2026-10-22 Material 预览基元与导航](docs/2026-10-22-material-preview-navigation.md) | Engine 原生 Material preview Fiber 通过准确目标 `preview.material.get/set/rotate/reset` 拥有球、圆柱、平面、立方体几何及对象旋转。View 负责图标和输入：左键转对象、中键平移、右键或滚轮推拉；Reset 恢复朝向和打开时相机，保留基元。不使用 WASD。替代 2026-09-24 文档中的 Material 专用导航，Scene 不变。 |
| 2026-10-21 网格 UV 预览 | 扩展资产预览统计：已有准确目标 `preview.display.get` 可投影一个基础 LOD UV 通道及其绑定发布，JSON 限制 8 MiB。View 负责只读通道选择、完整框选引用 UV 与单位方框、本地 2D 平移缩放，保留实际重叠。导航复用当前布局路径，不查询 Engine；工作区快照不含 UV 数据，网格解析和 3D 渲染不迁入 View。隐藏面板取消读取并保留导航；绑定变化拒绝过期布局。 |
| 2026-10-20 Scene 三角形拾取 | View `scene.pick` 针对已提交目标帧请求三角形粒度；Engine 检查所有与射线相交的 mesh bound，选最近的受支持三角形。直接 `engine.target.pick` 默认仍用 bounds。CPU 几何不可用时封闭失败，不改变 View 选择。替代统一前端平台设计中的 viewport 选择精度。 |
| 2026-10-19 Pack 创作草稿 | Pack 和 DevKit 拥有内存草稿、字面量保存和显式生成。View Parameters 面板与绑定 Inspector 字段共享一个 Engine 草稿及稀疏事件。运行时字段立即预览，生成字段等待 Generate，空分组隐藏。未暴露 TS 字段向 Agent 上下文提供选定工程与目标、源码修订、反射 schema 和解析绑定；未解析嵌套路径保持未解析。参数诊断复用已有 Engine 资产检查操作。只为已声明创作字段扩展只读检查，独立运行和游戏观察保持原行为。 |
| 2026-10-19 嵌入画布选择 | 仅当 Engine 可信解析器返回相同运行时，嵌入 canvas 才借用保留 Shell 的 Broker。独立入口仍隔离；已认证调用方身份、过期目标拒绝及连接所有的清理不变。替代 2026-10-11 独立会话设计中以连接相等为页面边界的规则。 |
| 2026-10-18 纹理检查 | Texture 和 Equirect 页面通过准确目标 Engine 操作提供 RGBA、实际 mip 与 slice、HDR 显示及方向环境投影。Engine 保留源码和 GPU 权威，View 负责控件与输入。替代固定纹理四边形呈现。 |
| 2026-10-16 Engine 操作历史 | Engine CLI/SDK 命令回执和已验证 PNG 产物无需 View 即持久保存。可选原生 History 前端读取已接受工程的有界公开历史 API；不重放操作、镜像命令状态或启动游戏。运行时观察保持独立。 |
| 2026-10-16 View 呈现 API | `view.workspace.presentation.*` 读取已提交 Shell/PageHost 及原生 Dock、抽屉事实，调用与 UI 相同页面动作。Backend 将有限请求响应生命周期路由到一个已认证文档，并汇总其有界工作区摘要，不保留 UI 镜像。运行时 `tabs.get/select` 绑定独立。 |
| 2026-10-12 统一前端平台 | 默认 Browser 和可选 MCP/Codex producer 共享一个 View mount；原生 platform Fiber 拥有可逆 realm 行为，保留公开 Engine/Host 权威。 |
| 2026-10-12 公开操作名称 | 领域 ID 派生 CLI/MCP 名；认证 Backend CLI 通过工作区 provider 提交普通扁平参数。命名设计见 View Harness PR #20。 |
| 2026-10-16 资源预览复用与关闭 | View 在同一工程、浏览器、Catalog 生命周期内复用已准入准确资源绑定，以可取消 lease 合并并发导航，发布 opening/ready/failed 请求。资源插件先 detach 被替代 surface，再准确 preview.close；通用异步 PageController.beforeClose 支持单个与批量关闭，保留失败页面。隐藏页面保留目标。可选 display 操作先发现再使用。替代 2026-09-21 资产页设计中仅成功才发布 opening 的规则。 |
| 2026-10-15 资产预览统计 | Mesh 使用固定视口统计和整层可见性；Texture 用 Properties 信息头；Material 用独立 Stats 面板。所有绑定事实保留 Engine assetBinding 发布身份。可选原生 preview display Fiber 通过准确目标 preview.display.get/set 拥有线框、实际碰撞和边界几何；View 负责菜单及默认值。不写资产、不增加可展开 HUD、不推断 Collider 语义或估算 GPU/编译成本。 |
| 2026-10-19 原生资产检查 | Engine target-tools 为 engine.entity.inspect 增加可选有界 assetReferences，解析 schema 声明的共享资产 handle 和持有的 Registry 身份，包括实际 mesh 材质槽。View 导入所属方事实类型，保留 primary 策略、控件和导航；面板及 core 不读 World。不再保留 query PluginAsset、动态 program、专用 Tool、runtime-Pack 生命周期或 internal-Pack 过滤。engine.asset.open 返回准确所属方及绑定；preview close 在原生清理成功前保留身份，失败可重试。Scene Tree 快捷动作要求单个已声明且解析的 primary；资产名不导航，独立 folder/ExternalLink 按钮浏览或打开独立资产页。不支持的控件保持禁用。PageType 选择预览或通用详情，详情不创建隐藏预览。新页面菜单用类型标签，标签页用资产名。替代[常驻引用设计](docs/2026-10-15-view-resident-asset-references-design.md)中的运行时机制及隐藏规则，其前端策略保留。 |
| [2026-10-15 完整组件概览与分组 Details](docs/2026-10-13-view-inspector-component-tree-design.md) | 全部场景实体共享只读对象头和所有返回 ECS 组件的有界概览，包括实体级数据和瞬态标记。每个原始组件独立一行，MeshFilter/MeshRenderer 分开。点击清搜索、打开 All、展开并滚动到组件，不过滤其他数据或改变场景选择。卡片几何与独立滚动区保持。替代 2026-10-13 实体根/功能树及组件过滤。平台剪贴板与可见性所有权、共享控件保留；primary 类型分类器留在 workspace-core，禁止同级 feature 依赖。Engine 不变，资源页独立所有。 |
| [2026-10-12 全部场景实体详情](docs/2026-10-12-view-entity-inspector-design.md) | 所有场景实体使用分组只读详情。Common 显示当前实体本地变换和主能力，普通网格恰含 Transform/Static Mesh/Materials。Inspector 本地关系树及 Scene 分类器被 2026-10-13 组件投影与 workspace-core 分类器替代。Engine 不变；资源页、缺失身份及默认材质事实保留原边界。 |
| 2026-10-09 dev:ui Fixture Host | UI 开发用普通 Viewer 连接同仓库私有 Fixture Host。Host、WebSocket 传输、工作区 broker 和前端插件仍是生产代码，仅 Engine workspace provider 提供确定性夹具数据。产品源码不含 mock 数据、demo props 或回退 mount 路径。 |
| 2026-09-24 运行时内容 | Content Browser 在准确工程 App 上消费 Engine runtime Pack 工具。UI 草稿和快照不拥有执行权；独立 run 绑定仍只读。本地验证完成，配对 PR 检查覆盖集成提交。 |
| [2026-10-11 独立 View 会话](docs/2026-10-11-independent-view-session-design.md) | 新文档打开独立普通 Engine 运行时，可见浏览器重载保留会话。Broker 和 Display 按已准入连接路由；Pack 回执在确认时重查实时工程与源码。 |
| 2026-09-23 包 Host 组合 | 显式 backend start --host-pack 选择 View 打包的 PluginAsset，不给游戏添加 View 资产。View Fiber 拥有 Backend 子项和 ToolApi 命令；Host 每连接投影一个前端根。替代 Engine 0.2 决策中工程所有的 View Host 选择。 |
| 2026-09-23 Engine 0.2 PluginAssets | 原生 PluginAsset 和 Cordis 生命周期；其工程所有的 View Host 选择已被包 Host 组合替代。 |
| 2026-09-22 简单工程入口与刷新 | 已知工程意图直接从返回 URL 打开。刷新通过常驻 View 入口恢复准确丢失目标并启动新 Scene，不重放编辑历史；2026-09-23 Engine 0.2 设计替代其直接刷新路径。 |
| 2026-09-22 工作区体验 | 每 URL 工程意图、准确目标 Scene 恢复和已提交帧拾取；View 拥有导航策略，Engine 执行语义移动和相机事务；验证状态见设计。 |
| 2026-09-20 启动边界 | 显式 Backend、可选 UI、独立 Shell 就绪状态和准确观察绑定。 |
| 2026-09-19 独立 AI 运行 | 固定 run 输入、独立浏览器、View 只读观察；替代默认 AI iframe/carrier 执行。 |
| 2026-09-19 Engine 权威 | 移除 UI 后 Engine 领域工具仍存活；插件仅提供自身实现的端点。 |
| 2026-09-17 插件贡献 | 声明式包贡献；旧启动和 carrier 提案服从以上决策。 |
| 2026-09-15 单 BackendHost | 每工作区 Host 一个 Backend 组装，不是全局进程单例。 |
| 2026-09-13 工程与资产及插件检查 | UI 和 CLI 消费 Engine 操作与准确工程、目标身份。Asset Tab 替换被 2026-09-21 插件页面设计替代。 |
| 2026-09-12 Host/Plugin | 静态 Catalog、Backend 权威 HostAssembly、Cordis 生命周期。 |

| 边界 | 工作共识 |
|:--|:--|
| 资产引用卡片与缩略图 | Scene 和 Mesh 共享材质槽布局与 64px AssetReferenceField；Material 复用引用字段，不虚构槽索引。Engine 负责缓存 PNG 生成；workspace-core 提供可取消缩略图读取，各面板拥有投影。Mesh 仅在匹配返回 Mesh GUID 与绑定数字材质 handle 后，才从准确 preview 实体读取原生引用。槽顺序和原始详情来自捕获的 assetBinding。Material slots 使用带独立蓝条的 Inspector 分组头，位于 Submeshes 前；Material 的 Texture references 位于 Passes 前，只读 GUID 匹配的发布输出，保留首次引用顺序并按显式 texture/equirect Catalog kind 过滤。未知依赖报告信息不全；绑定 preview 不用更新检查发布替代。引用只在同绑定内跨线框显示保留；未知和 builtin 身份不导航。缩略图双击、Enter 及 ExternalLink 使用已有资产打开动作；单击及名称不导航。工程、目标、绑定、Catalog、浏览器变化撤销过期读取；Scene 额外隔离选择。设计：[Inspector 缩略图](docs/2026-10-22-inspector-asset-thumbnails-design.md)、[Mesh 材质槽](docs/2026-10-22-mesh-material-slots-design.md)、[Material 纹理引用](docs/2026-10-22-material-texture-references-design.md)。扩展 2026-10-19 原生检查决策。 |
| 纹理检查 | Texture/Equirect 向准确 Engine target 和 generation 发送 preview.texture.get/set。Engine 拥有绑定源码事实、选择验证和普通材质渲染；View 拥有通道与投影控件、平移缩放输入和每页表单状态。Equirect 源 mip 0 与内部 IBL 预过滤 mip 不同。 |
| 操作历史 | forgeax.view.page.history.frontend 拥有时间线、分页、详情及保存图像选择。Engine 拥有持久调用回执与产物摘要。view.workspace.history.* 带已接受工程根委托给 engine.history.*。隐藏页取消读取；新记录不切换活动页。前端通过 type-only import 使用 Engine 所属方类型。 |
| 工程与运行 | Engine 观察创作文件。AI run 拥有冻结的工程及依赖输入；Scene 变化不更新 run。Engine run 服务拥有生命周期、捕获和错误，CLI 提交请求。 |
| AI Display | Runtime capture 选择本文档 Play 或只读独立 Engine run。UI 从已接受工作区派生工程根；view.display.bind 可通过 engine.run.observe 发现当前 run 一次，随后固定准确 `{root, runId}`。显式 API/CLI 身份独立于 Scene 仍受支持。不自动跟随替代 run。run 退休时只保留最后接受图像并标记；新绑定清除。日志和身份为折叠详情。隐藏 Play 捕获页停止采样；标签页、输入、焦点、resize、刷新、移除 UI 和停止 View 都不控制独立 run。设计：上下文派生捕获。 |
| Scene | 独立可见 Engine 工作区目标拥有 App/World/Renderer、资产和相机。View 拥有按键映射、灵敏度、速度曲线及 pitch 限制偏好，通过公开 API 提交语义相机移动。Engine 积分移动，拥有完整相机事务和目标本地 orbit pivot；通用观察保持独立策略。Preview 调用携带 targetId 和 targetGeneration。 |
| 实体 Inspector | 所有场景实体共享只读容器，对全部返回 ECS 组件提供有界、独立滚动概览。原始行独立，含实体级数据和瞬态标记。点击打开 All，将独立 Details 区滚到该组件；分类恢复完整实体级分组。这些动作不改变场景选择。View 不虚构组件附着或子实体边；Scene Tree 拥有 parentId 导航和分页结构读取。workspace-core 的纯组件名辅助为 Scene Tree 和 Inspector 提供 primary 类型；Common/Object/Rendering/Physics/Animation/Media/Effects/Behavior/All 能力保持叠加。枚举、颜色、向量和集合由 schema 定义；仅凭数组长度不构成向量类型。View 可保留多个实体 ID，但 Engine 检查、高亮、聚焦仍只处理已验证 primary。实体检查保持准确目标和同步取消。资源导航必须有显式返回 GUID，不推断 World handle、默认材质或绑定版本。Engine 通过 entity.inspect 拥有可选原生引用事实；资源页独立，mesh 标签页用已打开资产名。 |
| Host 与插件 | 同一 BackendHost 上 Engine 领域插件先于选定 View PluginAsset。backend start --host-pack 独立于游戏工程选择 View 包 Pack，Engine 解析模块及原生 Cordis Fiber。View 拥有 Backend 子 Fiber 和逐连接前端根投影；Browser FrontendHost 激活根。前端根在 App bootstrap 前启动 Shell 和服务页；冷工程打开时常驻 View 入口可激活。健康可见重载在 Engine 退休旧浏览器资源后激活相同 project/session/target；已知终止失败使用受保护准确目标恢复。借用 engineWorkspacePresentation 的面板只在 Engine 发布准确服务后启动，待呈现 Fiber 不阻塞原生根激活。根 revision 改变需新前端环境；子项移除和恢复用 Cordis 所有权，不原地替换 HostAssembly。释放 View 撤销子项、工具、连接及投影，不更新 Host assembly。纯 UI 插件不创建空 Backend/API/CLI 对应项。 |
| 面板归属与呈现 | 每个 claim 声明页面归属，即 pageType 与 page dock 布局，或 Shell 底部归属，仅 layout.order，默认 Shell 底边抽屉与折叠标签条。Shell 面板可从该边移入页面，保留相同 claim 和 mount host；关闭页面回到 Shell 底边，页面类型退休时，在其 Dockview 注销后协调存活 Shell claim。页面归属面板仍由页面所有。presentation.get 从实时 Dockview 实例和面板派生 page/Shell 所属方，以及 grid/edge/floating/popout 位置，不增加第二份放置存储。 |
| 状态与呈现 | Shell 品牌、文档页签、偏好共享一行导航。主题默认 system，有 Host 外观时采用它，否则采用 OS；显式 light/dark 覆盖。Content Browser 从接受的 Catalog 与工程快照生成资产引用；可选平台对话能力只追加 Host 草稿，不提交。View 保留绑定、选择和呈现快照。view-workspace-core 不依赖 React，不拥有 UI；view-components 不感知工作区。产品插件拥有 React 面板，组合两基础模块。不复制工程 watcher、资产注册表、场景图、相机账本或运行时。Engine 拥有 Catalog 源定位器及配置的 assetRoots；Content Browser 只投影这些目录内的源，包括 Pack 和 HTML；外部及生成源留在 Engine Catalog 供其他消费者使用。View 没有目录名默认值或平行资产根配置。每资产预览面板拥有 DOM 容器，通过公开 createSurface 承载专用 Engine type-preview surface。Engine 拥有 canvas；View 将准确 Scene surface 借入独占视口，不跨资产页签克隆或共享。绑定预览属性消费 Engine assetBinding 快照并保留发布身份；创作资产属性消费 asset.inspect，kind 来自该检查 identity 与 meta，不额外 inspect。渲染实际 Engine 数据，明确报告能力缺失；样例数据只用于显式 UI demo。 |
| 所有权与失败 | 创建方释放资源，借用方不释放。卸载 UI 保留领域调用。健康刷新保留 project/session/target，仅在 Engine 退休旧 preview 和 Play 后推进 browserGeneration。View 移除容器前恢复借用 canvas 位置；保留已有 Play iframe 与原生帧调度直到清理确认，未选中的 Play 透明且不接收指针；不在替代浏览器创建退休中的 Play。采用的 Play 启动期间 Scene preview 保持隐藏，包括 Stop 撤销 Game 观察之后；仅当该 Play 就绪或退休才恢复。已知终止失败通过常驻入口，在 Engine 验证准确丢失目标后请求新 Scene。不重放写入、输入或 Play。独立 run 不受影响。 |

可选嵌入辅助 `startView()` 在未提供 BackendHost 时创建一个；生成的浏览器文档创建配对前端 Host。传入的 backendHost 和 frontendHost 都是借用。Node FrontendHost 要求显式 `frontend: true`。默认 CLI 使用常驻 Engine 所属方，而非嵌入辅助。旧低层 view start 在返回普通 URL 前提交显式 project，或含 forge.json 的 Backend 根；普通 start.mjs 先发布独立 Shell，再通过 ensureDevKitView 提交可选显式 G，省略 G 不选择 H。

工作区前端插件拥有常驻、前端认证的 API 连接和已确认工程意图；没有该端点的嵌入借用其传输。刷新通过常驻 View 入口转移准确丢失工程，以默认页面、选择和相机开始，不恢复历史资源页、布局或 Play；保存文件、主题和语言保留。离开文档不得 bootstrap 新 Renderer。显式 view project open 通过同一共享 Engine 工作区所属方准入工程；选定呈现者放置准确文档，其他连接观察。

独立入口文档只消费已确认工程意图，通过可信调用方解析器打开自己的 Engine 会话，不导航到其他存活文档的目标 URL。健康重载保留准确会话。Shell Broker 拥有页面选择和资源打开；只有 Engine 可信解析器返回保留 Shell 拥有的相同运行时，嵌入 canvas 才借用 Broker，独立入口仍隔离。页面清单与呈现保留 Shell 连接身份；最后连接关闭后 Broker 退休。Display 拥有逐连接绑定，Pack 回执重新验证实时 page/project/source revision。React 消费者共享投影。Shell mount 不需要 canvas，只有 viewport surface 等待 Engine 呈现。

已确认工程控制 `context: 'project'` 页面，包括 Runtime capture。远程打开和页签恢复都未提供工程时，显示必需但非模态的工程对话框，使产物页和工作区导航仍可访问。打开工程不启动或重新绑定独立 Engine run。启动、工程打开、浏览器附着和 run 观察是独立操作。工作区前端组合拥有既有 Play 呈现 Fiber；viewport 面板仅借用位置，移除面板不销毁游戏文档。Bootstrap 只构建 Host 和 platform；新行为放在插件。文档导航属于显式 `workspace/document-navigation` 模块，不属于 Engine Host platform。普通游戏平台及其保留 program namespace 不包含它；Play 仍通过已有 iframe handle 加载 Engine 所有的 URL。

每项能力都有原生 Cordis 所属方：用 inject/provide 声明依赖，用 effect 注册贡献和逆操作，随所属 Fiber 撤销，包括可选诊断观察器和动画回调。优先已有插件；API、CLI、UI 消费同一领域实现。纯辅助、ECS 查询和帧执行保留直接数据路径。隐藏面板观察释放活动读 lease、保留 UI 状态；受控资产预览隐藏时让出持续渲染，Engine 插件保留查询和显式捕获。游戏执行不采用此呈现策略。

常驻 View 工作区在原生 Backend Fiber 下注册 view.workspace.* ToolApi 操作。公开操作 ID 决定 CLI 路径及 MCP 名称。认证 Engine Backend CLI 可提交扁平参数对象；workspace adapter 建普通请求并应用同一所属方授权，前端仍使用显式工作区信封。前端传输和 Engine CLI workspace call 进入该 provider，先调用同一 View 工作区所属方，再委托 Engine 执行领域工作。旧 forgeax-view workspace 传输客户端仍可用，wire 服务通过运行中 View 的该 provider 路由。不改变工程根插件发现或启动。

独立 HTML 文件页使用 PageHost 文件请求和工程范围文件服务；沙箱 DOM 预览与视口控件由 HTML View 插件所有，不借用 Engine canvas、不合成资产 GUID。编辑和资产预览使用准确 Engine surface；适配器缺失不回退到 URL iframe。每资产页签在该 surface 文档中、面板所有的容器内承载专用 Engine type-preview surface，否则封闭失败；从不借用 Scene viewport 所属 canvas。

隔离文档下，View preview-surface adapter 挂在保留的 Engine 文档内部，借用 iframe 位置，不改变其父级或生命周期。canvas 本地输入 Fiber 安装接收器；请求验证 parent、project、session、target/generation、World 及 browser generation。子订阅落后于 open 回执时，全新所属方读取可准入 mount。adapter 协调 Scene/asset 放置，在 preview.close 前等待 detach。同文档 Scene surface 可放在正常 DOM 流中，面板释放前恢复原父级、兄弟位置及呈现属性。target/generation 检查独立于放置模式。

只有 Engine 创建的 Play 目标通过 FrontendPlatform.createFrame 获得新文档；连接所有的呈现 Fiber 在 Engine 清理后释放 handle。viewport 面板只借用位置。Browser producer 正常导航，MCP producer 传递隔离源码字节，不导航 loopback。AI Display 不加载 AI 执行 URL。Browser 配置使用普通浏览器，不隐式启动 View 或重复游戏。显式选择的 MCP Apps producer 可在隔离文档承载相同 View；原生平台拥有字节交付和呈现，领域所属方没有 Codex 分支。显式借用 carrier 库接口为独立嵌入消费者保留 broker 权威；需进程内真实调用方 Page，不是 AI run 路径。清理保留借用 Page/browser 资源，不导航用户新页面。

forgeax-view 二进制是轻量工作区 API 客户端，使用显式 endpoint/token，与前端相同操作。独立 AI 控制使用 Engine CLI 及其授权。endpoint 或 URL 不能提供 Page。View Host 从所选 View 包的 @forgeax/view/plugin 入口解析静态 UI；Engine loader chunk URL 不是静态资源根。游戏 PluginAsset 在 Engine Worker 运行，不能使用浏览器 DOM 或前端 App handle；其 UI PluginAsset 拥有前端行为。

### 选择 Engine 与 View 的边界

选择权威所属方，而不是最容易补丁的位置。最小化新增概念和重复权威，不追求最少 Engine 改动行。全部放在 View 若复制 Engine 状态或削弱执行保证，并不是改进；仅因多面板需要就将 UI 策略迁入 Engine，也不是改进。

| 关注点 | 放置与审查规则 |
|:--|:--|
| 交互和呈现策略 | View 产品插件拥有输入绑定、灵敏度、速度与 pitch 偏好、布局、URL 意图、重试及恢复选择。通过 Engine 公开 API 提交语义操作，不重定义通用 Engine 默认值。 |
| 执行正确性与资源生命周期 | Engine 所属领域插件或目标保证已提交帧事实、相机事务、准确身份、原子替换及资源清理。无 View 时也保留保证，不在前端重建 World、相机账本或生命周期权威。 |
| 缺失的可复用机制 | 先在已有公开契约复现缺口。优先已有领域插件；仅为最小领域无关接口修改 Engine core，需明确消费插件，并证明已有 API 无法表达需求。 |

每项 Engine 变更应说明：为何 View 无法通过现有契约正确实现，为何该 Engine 所属方合适，以及哪些仍属 View 策略。验证消费插件存在、缺失或移除、恢复三种情况；保留借用资源及无关游戏和观察行为。修改边界前阅读已安装包契约并复现相关运行时路径；mock 不足以证明浏览器或 GPU 正确。不将 Scene/Play 分支扩散到 App、Host、生成启动代码或面板；所属方已暴露事实时，不增加平行注册表或健康探针。记录合理 Engine 变更，不用 View 绕过或更小 diff 掩盖。

viewport 点击是 View 选择意图，不是 Engine 生成的选择事件。scene.pick 从 target.pick 请求三角形粒度；直接 Engine 调用默认 bounds。Engine 使用已提交帧的矩阵及物理范围，测试所有射线相交 mesh AABB，返回最近三角形。不支持 CPU 几何是普通失败。树选择、拾取和清空共享取消所属方和准确 target/generation 防护。Engine 返回查询事实或请求失败，不改变 View 选定目标。工作区传输 provider 不转发业务专用事件。输入显式绑定借用 Engine surface 和活动 View 页，不要求 owner canvas 是 Dock 后代。

面板查询归属所观察绑定与选择，不依赖 React 延迟清理。工作区投影变化时同步撤销旧请求。转发操作失败前协调实际 Engine 绑定，包括 target disposal 待完成时。不全局抑制错误码：仍为当前目标的失败可见，命令不重放。

**架构变化必须在同次交付更新本共识和所属日期设计，包括替代链接与实现证据。** 保持代码、包契约和快速参考一致；替换过时说明，不追加第二条规则。产品设计和验收证据与实现一起放在所属产品仓库跟踪文档中。Harness 设计链接作为历史参考保留。

## 源码语言契约

src/ 和 packages/*/src/ 产品模块使用 .ts 或 .tsx。Node 构建脚本和测试保持 .mjs，发布的可执行模块编译为 .mjs。运行 pnpm check:packages 检查完整严格源码规则。只使用可擦除 TypeScript 语法，使 Engine 固定 Node 版本上的源码测试保持实际执行路径。

共享 View 契约属于 workspace-core。可通过 import type 复用公开 Engine App 所属方类型；禁止 Engine 领域运行时导入。类型边仍检查依赖方向，并从运行时 Host/Catalog 闭包检查消失。不复制所属方类型，不抑制严格错误。

## 工作规则

- 不切换主检出分支；分支工作使用 .worktrees/，保留两个仓库的无关改动。
- 已安装 View 启动使用 [forgeax-view-start](skills/forgeax-view-start/SKILL.zh-CN.md)。源码准备、本地 Engine 绑定或原生 Codex 集成阅读[贡献者指南](skills/forgeax-view-start/CONTRIBUTOR.md)，两者与 README 启动契约对齐。
- View 动作和演示使用 [forgeax-view-cli](skills/forgeax-view-cli/SKILL.zh-CN.md)，它定义 API/CLI 优先级、公开前缀及准确目标发现。浏览器工具验证呈现和交互。
- 工作流程需显式选择；普通工作直接编辑并执行相关检查。使用流程时阅读已安装技能。
- 修改运行时边界前，阅读所属 Engine 包契约并复现相关路径；浏览器与 GPU 证据和 mock 分开。
- 代码和面向产品的文档使用英文；设计和知识正文可使用中文。CLAUDE.md 只包含英文入口文件。
- 架构关卡 pnpm check:architecture 独立于必需 CI build 检查源码和 manifest 边界。最终 bootstrap 要求架构、构建和全部四个浏览器分片成功后才交付。保持拒绝反例有效，不通过宽泛抑制让功能过关。Host/core/bootstrap 变化需上述公开接口及插件缺失证据，使用 [PR 清单](.github/pull_request_template.md)。参见[关卡范围和限制](README.zh-CN.md#architecture-gate)。
- Bootstrap 检查为 pnpm test、Harness --verify、KB lint、git diff --check。未来运行时变化必须增加真实集成检查。
- 不仅凭 bootstrap 检查声称 View 功能完整、GPU 后端兼容或 CI 通过。报告实际产物及验证边界。
- 修改 packages/view-components/ 中公开 React 组件、overlay 工具或 token 驱动样式时，例如 components.tsx 或放置辅助，同次更新 Storybook：新增或调整 stories，保持 autodocs 描述准确；新增顶层故事时对齐 .storybook/preview.tsx 顺序。不要在包 README 写局部组件 API；该文件仅规范包层级契约，包括 styles 入口、token 流程、Storybook 命令，只有这些变化才修改。运行 pnpm --filter @forgeax/view-components check；stories 变化且 Storybook 属交付边界时，从仓库根运行 pnpm build:storybook。
