**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具入口为英文 `SKILL.md`。

# 打开 ForgeaX View

本技能适用于从已安装的 Engine 启动可选 ForgeaX View、交互浏览游戏资产或场景，以及诊断 View 启动。

View 是可选工具。在用户要求或需要交互检查资产、场景时打开，包括创作期间。普通 Engine 命令无需 View 即可执行。本文件和 [View 操作](../forgeax-view-cli/SKILL.zh-CN.md)由 View 维护，并随匹配的 Engine 分发；不需要额外的全局 SDK。

## 已安装 npm 依赖的游戏

阅读游戏的 `AGENTS.zh-CN.md`；工具入口仍是 `AGENTS.md`。从游戏根目录运行其安装的 View 文件：

```sh
node ./node_modules/@forgeax/engine/tools/view/start.mjs --project .
```

从其他工作目录运行时，脚本和游戏都使用绝对路径。解析游戏自身安装的 `@forgeax/engine`，不得悄悄替换为全局 SDK 或其他游戏的 Engine。支持 pnpm 链接，文件会解析其规范安装路径。不要给游戏添加启动包装器或 npm 脚本。

```sh
node /absolute/game/node_modules/@forgeax/engine/tools/view/start.mjs --project /absolute/game
```

已发布的产物已经构建完成。此路径无需执行 `build:engine`、单独安装 View 包或手动启动 Backend。启动文件缺失表示该安装不包含 View：报告包路径及版本，并使用完整且匹配的发行版。构建产物缺失表示安装不完整，不要改用贡献者构建辅助脚本。

需要显式打开 SDK 范围的选择器时，使用 `node "$SDK_ROOT/tools/view/start.mjs"`。针对游戏，应优先使用其安装的 Engine，并始终传入 `--project`。省略该参数会打开选择器或保留实例现有工程，不会选择当前工作目录。

## 选项与生命周期

使用 `--help` 查看该文件的准确参数；帮助命令不会启动服务。文件直接输出 JSON，不接受 Engine CLI 的 `--json` 参数。

- `--project G` 选择游戏；含空格的路径需加引号。
- `--root H` 选择显式 Backend 工作区，而不是游戏目录。
- 默认 H 是由 Engine 与 View 的规范安装路径派生的共享系统临时目录。指纹确定，不是随机值。
- `--new-instance` 分配独立临时 H；显式 `--root` 优先。

保持前台终端打开，并打开返回的普通 URL。启动器通过 Engine 公开 API 异步准备 Backend 和工程。出现 URL 表示 Shell 已监听，不代表工程或渲染器已就绪。核对请求的工程身份、就绪状态、资产和实际场景。Play 需要单独操作，并完成一个可见的游戏帧。不要自行构造工程查询 URL，也不要根据单张截图推断全部 View 功能已通过。

Ctrl+C 关闭当前呈现并取消其启动调用方。Backend 维持自己的生命周期。后续实例控制必须显式使用返回的 H，不得从 cwd 或 G 推断。Backend 停止后，Shell 仍保留供显式重启。只停止本任务拥有或要求停止的资源。

初始 JSON 标识 `enginePackage`、`viewRoot`、`hostPack`、所请求的 `project`、URL 和 H（`root`）。其中 `phase: preparing` 是启动通知，不是实时状态报告；应在页面中查看已接受的工程和就绪状态。

就绪后，用 [View 操作](../forgeax-view-cli/SKILL.zh-CN.md)发现所选 Host 的能力。低层 `view start` 要求兼容 Backend 已运行，是独立的高级操作。冷启动 `forgeax help` 中缺少 View 命令，不代表启动文件不可用。

## 失败与交付

保留失败阶段和原始诊断。使用同一个已安装的 Engine，针对返回的 H 检查 Backend 和 View 状态。不得替换其他任务的 Backend、重写游戏的 Engine 绑定，或静默重试已经终止的工程失败。修复源码后显式重新打开。浏览器和渲染器失败与 Shell 是否可用分别判断。

返回实际 URL、H、所选 Engine 安装位置和工程身份。未进行浏览器验证时明确说明。启动 View 不替代游戏正常的构建、捕获或玩法验收。源码贡献和原生 Host 集成需遵循各自仓库的贡献者指南。

## 现有游戏指引

npm 升级更新包内指引，不会更新复制到游戏中的技能或 `AGENTS.md`。对于旧游戏，先阅读已安装包中的技能。用户要求刷新指引时，将这两份官方 View 技能与游戏跟踪的版本比较，更新未被定制的官方内容并保留自定义编辑。将过时的手动 Backend 或构建辅助脚本建议替换为已安装文件命令；保留有效的 Engine 开发、捕获和验收路径。仅在游戏现有 Agent 指南中增加 View 路由。单独安装已有技能挂载不会刷新复制内容。冲突需明确报告，不覆盖整份指南，也不引入新的启动包装器。
