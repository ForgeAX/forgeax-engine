**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具入口为英文 `SKILL.md`。

# ForgeaX View API 与 CLI

本技能用于通过公开 API 和 CLI 操作 View，包括演示与检查、打开资产、控制 Play 或相机、选择场景实体，以及判断请求是否影响已打开的 View 页面。

启动时先使用 [View 启动](../forgeax-view-start/SKILL.zh-CN.md)：运行游戏安装的 `tools/view/start.mjs`，显式传入 `--project`。下述操作面向返回的 Backend 根 H 上已运行的 View。它们不是普通单文件启动路径，可能不会出现在冷启动 Engine CLI 帮助中。从游戏根目录使用其安装的 CLI 执行示例，即 `pnpm exec forgeax ...`，并始终传入返回的 `--root H`。表格将其缩写为 `forgeax`。不要用全局 SDK 的 CLI 操作另一个 Engine 实例。

> [!IMPORTANT]
> 常驻工作区 API 是权威。浏览器和 CLI 是同一所属模块的客户端；CLI 不实现工程、资产、场景或相机行为。Engine 负责工程和目标的执行；View 负责工作区绑定、选择和呈现请求。

对于受支持的动作，包括演示，使用公开 API 或 CLI。浏览器工具用于检查结果 UI 和像素、测试指针与键盘交互，或操作没有公开操作接口的呈现控件。能力缺失必须明确报告；通过 UI 点击不证明 API 或 CLI 已覆盖。

## 查找实时契约

AI 创作、资产预览和捕获继续使用 Engine CLI 或 SDK 命令客户端。其操作回执和图像会显示在 View 的操作历史中，无需第二次调用 View。通过已准入的 View 工程使用 `view.workspace.history.list/get/artifact.read` 查看历史；不使用 View 时使用 `engine.history.*`。这些读取不会重新执行命令或启动游戏。用户确实要求操作 View UI 时，使用下述呈现 API。

回答“View 现在显示什么”时，运行：

```sh
forgeax view workspace presentation get --root <backend-root> --input '{}' --json
```

它返回实际页面、活动页面、原生面板可见性、外观及该准确文档的工作区摘要。使用返回的页面和面板 ID 调用 `presentation.page.open`、`.select`、`.close` 及 `presentation.panel.reveal`。这些相对 ID 的公开前缀为 `view.workspace.`。存在多个文档时，读取 `view.workspace.pages.list` 并传入 `connectionId`；前端调用方只能操作自己。失败或超时的写入可能已经生效：查询当前状态，不得自动重放。

通过以下命令发现运行中所属模块的声明：

```sh
forgeax help view --root <backend-root> --tree --json
```

| 接口 | 示例 | 命名权威 |
|:--|:--|:--|
| 公开 ToolApi ID | `view.workspace.asset.open` | View 所属模块的描述符 |
| 统一 CLI | `forgeax view workspace asset open --root <backend-root> --input '<args>' --json` | 公开 ID 中的点转为命令层级 |
| 工作区客户端或通用调用 | `asset.open` | 相对于已选择的 View 工作区服务 |
| Engine 领域操作 | `engine.asset.open` | Engine 所属模块；View 委托执行 |

公开清单使用完整 ID，普通示例使用统一 CLI。相对 ID 是 `view workspace call --operation` 或 `connectViewWorkspace(...).call` 的参数，不是全局 API 名。`view.display.bind` 等所属模块操作保留其描述符前缀；根据实时帮助派生命名，不机械添加 `workspace`。Backend 无需挂载新插件即可发现描述符。

操作名称和请求结构见 `@forgeax/view/workspace/contract`，本仓库对应 `packages/view-workspace-core/src/contract.ts`。程序客户端调用 `connectViewWorkspace(...).capabilities()`，查看已连接所属模块可执行的能力。契约中的操作列表本身不能证明提供者已经安装且可调用。通过 `view.workspace.tabs.get` 获取当前工程、标签页和准确目标身份。对于 `view.workspace.assets.list` 等领域读取，同时传入 `projectId` 和返回的工程 `targetId`：无页面调用方有自己的 Engine 运行时，仅 `projectId` 不会选择浏览器中的工程。从该结果取得资产 GUID。后续请求保留返回的 `projectId`、`targetId` 和 `targetGeneration`，不要从路径、名称或之前的目标猜测。

| 需求 | 所属模块与入口 |
|:--|:--|
| 打开可选 View | 使用 [View 启动](../forgeax-view-start/SKILL.zh-CN.md)中的文件，不预先启动 Backend |
| 高级实例控制 | `forgeax backend ...` 及 `forgeax view start\|status\|stop`，显式传入 `--root H`；低层 start 要求兼容 Backend |
| 在运行中的 View 分配工程 | `forgeax view project open --root <backend-root> --project <project-root> --json`；打开返回的可见浏览器 URL |
| 通过 Engine CLI 调用一个常驻工作区操作 | `forgeax view workspace call --root <backend-root> --operation <id> --args <json> --json`；要求已选择 View Host Pack，且 View 所属模块运行中 |
| 列出页面并显示 Pack | `forgeax view workspace call --operation pages.list --args '{}' --json`，然后 `--operation pack.reveal --args '{"projectId":"...","sourcePath":"assets/example.pack.ts","revision":"...","connectionId":"..."}' --json` |
| 创作资产或控制独立 AI 运行 | Engine CLI；若已安装则使用 `forgeax-engine-cli` 技能 |

`forgeax help view --tree --json` 从运行中 Backend 所选择的 Host Pack 发现声明。列出命令不证明插件已挂载或提供者可调用。常驻 View 在 ToolApi 注册 `view.workspace.*`；前端和 Engine CLI 到达同一所属模块。Engine CLI 使用 Backend 已有的认证。普通文件启动会选择匹配的 Host Pack；手动 `backend start --host-pack` 是高级集成路径。单独下载工具不会让这些命令变得可发现。仅源码提供的独立工作区客户端接受已签发的 endpoint 和 token；普通 npm 游戏不需要其二进制或手动凭据。不得在报告中粘贴连接秘密。

`pages.list` 提供有界页面清单；`pack.reveal` 等待指定前端显示 Pack。多个页面存在时，选择准确 `connectionId`；过期页面或源码修订会返回未执行动作的结果。

## 通过 API 打开资产

工程目录读取、目录浏览和注册，都通过常驻工作区使用同一套 Engine 所有的目录。`ViewWorkspaceClient` 直接返回成功 DTO；ToolApi 已经消费所属模块的 `Result` 信封。失败通过工作区诊断拒绝。不要再次解包 `Result`，也不要从目录条目推断工程已就绪。

连接一个 Scene 页面时，先读取其身份，列出该准确目标的资产，再打开返回的 GUID。Scene、网格、材质和纹理的打开使用与 Content Browser 双击相同的操作：

```sh
forgeax view workspace tabs get --root <backend-root> --input '{}' --json
forgeax view workspace assets list --root <backend-root> \
  --input '{"projectId":"<project-id>","targetId":"<project-target-id>"}' --json
forgeax view workspace asset open --root <backend-root> \
  --input '{"projectId":"<project-id>","targetId":"<project-target-id>","guid":"<asset-guid>","tabId":"forgeax-user-workspace"}' --json
```

成功后再次读取 `tabs.get`，检查 `openRequest` 和 Scene 目标。如果已经连接的前端拥有 Scene PageType，它会观察新请求并聚焦 Scene 页面。之后才连接的前端会将保留的请求作为基线；单凭 CLI 响应不能证明页面可见或已有渲染帧。目标是视觉结果时，验证浏览器和目标。`view.workspace.tabs.select` 选择 Scene 或 Runtime capture 绑定；资源页面的放置仍由前端策略决定。多个页面连接时，页面操作会以 `view-page-ambiguous` 失败；不要猜测页面或复用其他目标身份。

View 选择使用 `scene.select`、`scene.pick` 或 `scene.clear`；直接调用 Engine `target.pick` 只返回查询事实。`presentation.*` 独立于运行时绑定读取和操作 Shell 的实际页面。Content Browser 过滤器仍是本地 UI 策略。多次调用的相机事务通过 `--batch` 保持在同一客户端连接上；单次 CLI 调用会在 API 响应后关闭连接。
