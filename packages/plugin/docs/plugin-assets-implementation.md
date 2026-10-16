# 插件资产化实现与验收

> 状态：已整合 `main@7a06b414d`，设计及增量合同复评通过；完整验收以 [PR #3345](https://github.com/ForgeaX-Games/forgeax-engine/pull/3345) 当前提交的 CI / SDK PR Preflight 为准，下述历史记录不替代当前验证。未发布。
> 日期：2026-09-22。实现工作树：`.worktrees/plugin-assets`。
> 首次验收的 SDK 验证快照：`1b13db8829e301837dc25a9cc34dd13799e6a410`。该快照早于下述创作入口收敛，不代表本次更新重新封装或发布了 SDK。

## 实现结果

插件的持久定义现在属于 Pack，运行实例仍由原生 Cordis 管理。`pack.ts` 可以同时生成普通资产与插件资产；`pack.json` 表达同一份数据合同。读取资产不执行插件，安装才解析已编译代码并创建原生 Fiber。

| 边界 | 已实现行为 | 入口 |
|:--|:--|:--|
| 作者资产 | 严格 PluginAsset schema、稳定 GUID、配置 `$asset` 引用与生产者派生依赖 | [Pack](../../pack/README.md) |
| 生命周期 | 挂载返回原生 Fiber；安装前记录来源；外部启动屏障处理后代、缺失服务、失败、取消和期限 | [Plugin](../README.md) |
| 项目装配 | `forge.json` schema 3 的 `roots.build/host/frontend/engine` 指向资产；schema 2 一次性迁移 | [Project](../../project/README.md) |
| 代码交付 | 静态程序表、模块加导出身份、同文件 Pack 的运行投影、浏览器与 Worker 构建闭包 | [DevKit](../../devkit/README.md) |
| 构建插件 | 独立 Node 进程持有原始 Importer/Cooker 函数；自举不依赖预建 Catalog/DDC | [构建进程](../../devkit/src/build/build-process.ts) |
| 更新与恢复 | 配置或代码变化编译新会话；校验 publication tuple，拒绝旧会话迟到结果 | [Host](../../host/README.md) |
| 工具 | 冷发现不执行 apply/Cooker；执行器进入交付闭包；原生作用域撤回贡献 | [Tool Runtime](../../tool-runtime/README.md) |
| 源码复用 | 导入/克隆先准备隔离候选，验证 GUID、锁定依赖、源码闭包与编译，再发布 | [源码事务](../../devkit/src/source-transfer.ts) |

程序表通过公开 `@forgeax/engine/tool-runtime` 子路径解析；独立进程回归防止工作区依赖掩盖干净消费端的缺包错误。

源码闭包包含 Meta 身份、UI 必需的 HTML/CSS 配对及其资源、WGSL 模块名与递归 import。克隆同时改写资产身份、项目 shader 模块名及其引用；计算引用若仍逃出克隆目录，会在发布前失败。需要 cooked reads 才能发现闭包的作者程序仍按明确的有限源码合同拒绝迁移。

旧 `definePluginGroup` / `usePlugin`、Engine Entry/CatalogLoader 激活、插件安装事务和 ToolPlugin 作者入口已经删除；模板、示例、技能、包合同与资产 authority audit 同步迁移。DSH 自己的原生边界保持独立。

## 使用路径

```sh
forgeax help asset plugin create --json
forgeax asset plugin inspect --root <project> --json
forgeax project root set --root <project> --realm engine --guid <plugin-guid>
forgeax project root set --root <project> --realm host --guid null
forgeax help asset source import --json
forgeax help asset source clone --json
forgeax project migrate --root <old-project> --json
```

[game-3d 的功能 Pack](../../../templates/game-3d/README.md#behavior-packs) 是可运行的组合示例。[设计方案](plugin-assets-design.md) 保留边界、迁移规则与 AC01–AC18 验收合同。

## 创作入口收敛

`forgeax asset plugin create --path assets/movement/movement.pack.ts --json` 默认生成同文件的原生 Plugin 具名导出和资产定义。指定 `--module` 时引用已有实现；`.pack.json` 要求明确模块。`--input` 接收完整参数对象和配置，`--dry-run` 返回将写入的 `source`；已有文件不会被覆盖。

game-3d 按根装配、物理、场景所有者、玩家、相机和 UI 拆为六个行为 Pack。每个 Pack 拥有自己的 namespace 和配置，跨 Pack 用 GUID 引用；`game.pack.ts` 只负责 Engine 根。小型行为在同文件实现，玩家的复杂逻辑使用普通 `player.ts` 模块，物理 Pack 引用 npm 插件。空模板也采用同文件 Pack，模板不再规定 `plugin.ts` 或 `.plugin.ts` 入口。

Engine 与 Frontend 保持独立的行为依赖闭包，UI Pack 单独搬运不会携带游戏根和玩家行为。SDK 检查通过公开的 `asset plugin inspect` 找到根定义和场景配置，不再假设根行为来自某个 JSON 文件。

## 主线集成修订

四根分别指向 Node host、浏览器 frontend、Engine World 与独立 build 进程。外部 UI 使用明确模块定位；连接投影只接受当前在线调用者及当前报告。后端冻结源码变更需先重启；临时模块保留至原生清理完成。本修订已通过 Astra/high 独立设计复评，评审阻塞项已关闭。外部 frontend 绑定首版拒绝所有非生成目录的 client HMR，普通项目源码修改也需重新绑定并替换页面。设计评审不替代完整实现验收。

本轮浏览器回归还发现页面退出监听晚于 Engine 插件激活：启动中离开页面会漏掉清理。监听已前移，迟到的 App 在发布服务前退出并由原生作用域回收；同一真实浏览器的更新、恢复与退出用例已由失败转为通过。Vite Pack 成功配置更新的显式宿主刷新也已恢复，失败时仍保留旧页面。

CI 复验补齐了 Runtime 类型与截图／独立运行 fixture 的 schema 3 迁移，并修正 Palace 的公开包导入。归档检查还复现了配置无原型对象被 CLI 拒绝的问题；生产者现输出普通 JSON 对象并保留特殊自有键。Palace 暴露的跨 Pack 引用提前校验也已修复：候选暂存可以等待程序化产出，最终发布仍校验完整引用闭包。

Frontend 的工具声明与 CLI 发现遗漏已补齐；模板和 CLI 的根校验复用项目 schema，不再各自维护三根列表。

## 本轮验证记录

| 验证 | 当前证据 |
|:--|:--|
| 原生插件、Pack、Import、资产运行库、Project、Tool Runtime | 186 个文件、1,067 项测试通过；无类型错误 |
| Host 与 App | Host 15 项通过；App 选定集成 15 项通过、2 项既有跳过 |
| DevKit | 整批 80 个文件共 351 项，350 项通过；唯一页面退出失败修复后以同一浏览器路径复验通过。最新主线解析及 Host 绑定 22 项另行通过 |
| Vite Pack | 整批 79 个文件共 275 项，274 项通过；显式刷新失败修复后，包含该用例的 watcher / session 15 项通过 |
| 两套模板 | game-3d 22 项、empty 1 项及类型检查通过；最新真实浏览器 empty / game-3d 全部通过，保留 UI、相机、移动、动画与完整碰撞旅程 |
| CI 回归 | Runtime 22 个类型测试文件通过；配置检查与 Pack 合同 24 项通过；direct Pack 引用与外部暂存 13 项通过，含缺失引用阻止 Catalog 发布 |
| Frontend 创作与发现 | 修正前 CLI 帮助和工具声明均复现失败；修正后创作与工具合同 21 项、包重建及类型检查通过 |
| 截图与独立运行 | 真实截图策略通过；独立快照删除源文件后仍运行，HTML / Shadow DOM 像素、重载、替换与停止全部通过 |
| 300 帧 smoke | 完整 82 个 owner 命令已运行；Bloom 浏览器曾被并行产物重建刷新打断，停止重建后单独执行其完整 300 帧命令通过，含设备丢失恢复。保留原失败记录，不表述为一次全绿 aggregate |
| 构建与静态 | Engine 构建、最新相关包构建与类型检查、格式、资产 authority、公共导入、Catalog 文档、测试布局、英文技能文档及 4 个 Mermaid 图通过 |
| 完整图形与 SDK | 集成基线 `d94def43e` 的远端全部 Browser / Dawn 分片通过；后续生产者修复须以 PR 当前提交检查为准。SDK 不沿用历史归档作为当前验收 |

上述是整批运行加针对修复的重验，不表述为一次未修改源码的全绿运行。原始本地日志为 `/tmp/plugin-assets-merge-*.log`。

## 创作收敛阶段的历史验证记录

| 验证 | 证据 |
|:--|:--|
| 创作、闭包与工具 | DevKit 68 个文件、271 项测试通过；新增回归真实编译 CLI 生成代码并安装/撤回原生 Fiber，检查功能 Pack 的独立源码闭包 |
| 模板与 SDK 合同 | 4 个文件、43 项测试通过；两套模板类型检查通过 |
| 嵌套源码发布 | Import 138 项、Vite Pack 247 项测试通过；新增真实 Vite 开发/构建回归覆盖原件与克隆的不同 GUID、源码路径和 publication |
| 浏览器 | 空模板捕获通过；game-3d 完整 UI、相机、移动、动画和碰撞旅程通过，无页面、控制台或响应错误 |
| 构建与静态约束 | `build:engine` 与后续 DevKit 构建/类型检查、62 包运行依赖闭包、公共导入、asset authority、Catalog 文档与测试布局检查通过；11 个文档图通过 |
| 跨项目交付 | Engine/Host 闭包分别导入，重复身份拒绝，UI 独立克隆；移走源项目后构建、Web ZIP、单 HTML 均通过。修复后的单 HTML 直接打开并持续提交画面，UI 正常，42 次内嵌资源命中，零缺失、外部请求、页面/控制台错误 |

本次跨项目交付使用当前 DevKit 与模板源码，运行依赖来自首次通过验证的不可变 SDK；没有重新封装 SDK ZIP。单 HTML 最终候选为 `game-fixed.html`，原始失败候选和日志保留作诊断证据。

跨项目验证暴露并修复了一个生产者问题：已相对化的 `assets/overlay/assets/ui.pack.ts` 被再次截断，导致原件与克隆共享源码路径并发布重复 GUID。现在路径归一化保留第一层资产根；构建回归先复现 `duplicate.guid`，修复后通过。

单 HTML 浏览器验证还暴露了 preload 重写错误：压缩后的导入别名 `P` 与嵌套 AJV 函数同名，按名字匹配误改了内部函数参数，启动时报 `rules` 缺失。重写器现在使用 TypeScript 的词法绑定识别真正的导入调用；最小回归复现相同错误后通过，并覆盖函数、参数和块级遮蔽。

game-3d 在并行软件 GPU 测试中曾触发碰撞阶段超时；使用既有 320×180 CI 配置、等待其他测试退出后独立运行，通过原有完整旅程与期限。原生指针锁探测不可用时，门禁采用既有模拟模式；不将其计为原生指针锁验收。

## 首次实现的验证记录

| 验证 | 当前证据 |
|:--|:--|
| Pack | 371 项测试、58 个文件通过；类型检查通过 |
| 原生装配、运行资产、项目、Host、构建与工具 | 相关包测试通过；DevKit 260 项、Tool Runtime 60 项、Host 11 项通过；新增冷启动回归所在的 7 项测试通过；`build:engine` 与类型检查通过 |
| Vite Pack | 245 项测试、70 个文件通过；真实 Vite 回归覆盖 direct Pack 与 ScriptablePack 混合目录的发布记录保留 |
| Source transfer | 真实文件事务覆盖依赖准备、GUID 冲突、原生代码零激活、UI/WGSL 闭包、克隆身份与引用；新增 shader 克隆回归 8/8 通过 |
| 浏览器主线程与 Worker | 真实配置/代码/连续更新、失败恢复与隐藏父目录路径通过 |
| Preview 刷新 | 真实配置、文件监听、Catalog 发布与刷新策略 3/3 通过 |
| game-3d | UI、移动、动画、指针锁与完整碰撞旅程通过 |
| 模板消费端测试 | game-3d 的 13 项测试通过；旧 Group / 源码字符串断言替换为真实 Cordis 依赖等待与撤回验证 |
| 捕获启动 | 真实 Chromium 回归覆盖 adapter 读取时页面重载；仅在既有启动期限内重新观察新文档，其他错误仍然失败 |
| Dawn smoke | 23/23 分片场景与 59/59 独立 smoke 通过；保留 300 帧、像素和故障反证要求 |
| Browser / Dawn 测试名单 | 全部名单已分组执行；原有条件跳过保留。冷目录准备超时项使用现有专项配置或独立进程复核通过 |
| 静态约束 | 公共导入、62 包运行依赖闭包、资产 authority audit、Catalog 文档矩阵、旧入口删除审计与变更文件 Biome 检查通过 |
| 最终 SDK ZIP | 原始归档验证通过；两套模板的创建、检查、测试、类型检查、构建、打包、开发启动通过；另验证静态子路径与 Preview |
| SDK 源码模式 | 公开源码安装、Engine 重建、UI、相机、移动与动画的真实浏览器验证通过；该门禁按合同省略长碰撞旅程，完整碰撞旅程已另行通过 |
| npm carrier | 同一组 62 包 tarball 与 carrier 的本地 registry 消费验证通过，两套模板均完成测试、构建、打包与开发启动；没有发布 |
| 跨项目交付 | 源码导入、GUID 冲突拒绝、移走源项目后构建、Web ZIP、单 HTML 和浏览器捕获全部通过；单 HTML 持续提交画面，38 次内置资源命中、零缺失、零外部请求 |

> [!NOTE]
> 上表是本地验证证据，不等同于远端完整 CI 通过。早期整批运行遇到产物重建干扰或冷启动超时，受影响项已单独复核。Browser 名单中的 r32float integration 文件不匹配默认 `*.browser.test.ts`，因此另外用明确 include 的配置在真实浏览器执行了其设备代际断言，没有把“无测试”计作通过。

本地日志与可重跑驱动保存在工作树 `.forgeax/verification/` 和 `/tmp/plugin-assets-*.log`。关键回归保留在各 owner 的测试中；验证生成的图片、缓存与 SDK 归档不作为源码变更。

首次交付证据汇总为 `.forgeax/verification/sdk-final/report.json`。SDK 版本为 `0.0.0-plugin-assets.1b13db882`，ZIP SHA-256 为 `e19ae46577882cd14a84877493218fda2bf2c9eebd474dcb129d61fb55c8dd73`。首次验收阶段，验证快照之后仅调整了 npm 门禁的失败清理及文档：失败启动也停止已发现的 daemon，并保留原始错误和临时项目。npm 复核使用相同 tarball；该阶段的运行代码没有变化。

## 开销记录

独立 SDK 消费端移走 `.forgeax/ddc`、`.assetlib` 和 `node_modules/.vite` 后，目标项目首次重建耗时 45.91 秒，构建通过；Engine 自带的预编译 shader/WASM 仍属于正常 SDK 输入。原始记录见 `.forgeax/verification/sdk-final/cold-build.json`。

本机 Node 24.19.0 诊断：9 个原生 Fiber 的启动树，预热 5 次后采样 100 次，启动中位数 2.97 ms、P95 3.92 ms。500 ms 空闲窗口未创建来自插件入口的定时器；监督器在启动结束时撤回监听与期限定时器，没有逐帧入口。`plugin/dist/index.mjs` 为 12,541 字节，gzip 后 3,720 字节，未包含外部依赖。数据来自共享机器，不作为性能回归阈值；原始记录见 `.forgeax/verification/plugin-cost.json`。
