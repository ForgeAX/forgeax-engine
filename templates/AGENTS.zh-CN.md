**语言**：[English](AGENTS.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具入口为英文 `AGENTS.md`。命令、API 和工程约束与英文版一致。

# ForgeAX 游戏工程指南

基于 `@forgeax/engine` 的 TypeScript 游戏。只有在任务相关时才阅读对应参考。

本项目在 `package.json` 中固定 `@forgeax/engine` 的确切版本。通过 `pnpm exec forgeax` 使用项目里的 CLI。

## 编写代码前先了解引擎

每个游戏执行一次，在首次编辑 `assets/` 之前完成；阅读量约一页，花费几分钟，而不是几十分钟：

1. 阅读[引擎概览](skills/forgeax-engine-authoring/ENGINE-OVERVIEW.md)，了解能力、边界和缺口；浏览[能力目录](skills/forgeax-engine-authoring/references/feature-catalog.md)及 [API 索引](skills/forgeax-engine-authoring/references/api-index.md)，这两份资料由已安装的 Engine 版本生成；然后阅读游戏涉及的每个技能的快速契约。帧循环和输入对应 `forgeax-engine-app`；相机、灯光、天空和后处理对应 `forgeax-engine-render-pipeline`；其他按物理、VFX、音频、建模选择。
2. 编写 `docs/engine-plan.md`，每项游戏功能一行：需求 → 引擎能力（技能或 API）→ 入口 → 限制或缺口。
3. 每项功能都基于该行标明的能力实现。编写辅助函数、网格构建器、着色器、相机装置、输入处理器、粒子系统、碰撞测试或 UI 控件前，先查 API 索引和能力目录。仅对已确认的缺口手写实现：在该行标记“gap”，记录检索结果，保持自定义部分最小，并记入 `docs/feedback.md`。

## 规则

- `forge.json#roots` 选择插件根：`engine` 执行游戏，`frontend` 负责 DOM 和 UI；稳定 GUID 拥有资产身份。在 `game-3d` 工程中从现有内容开始，编辑或替换 `assets/player`、`assets/ui`（HUD：`ui/player-hud.ts` 显示通过 `gameHost.port` 收到的引擎状态）和读投影 `gameHost.gameProjection.registerRead`，不要从零重写游戏。
- 在 `assets/` 创作资产，包括 `*.pack.ts`、`*.pack.json` 和 `<file>.meta.json`；`dist/`、`pack-index.json`、DDC 和 `.forgeax/` 都是生成产物。游玩期间创建的内容通过 `ctx.assets.create(...)` 绑定，并在 effect 中释放。
- 游戏逻辑是原生 Cordis `Plugin`；清理由 `ctx.effect()` 负责。DOM、Web Audio 和浏览器 SDK 放在 frontend 根；游戏逻辑由 Engine Worker 承载。
- 点击画布时，引擎会锁定指针用于鼠标视角；需要光标瞄准的游戏在启动时调用一次 `gameHost.setPointerLockAllowed(false)`。
- 仅导入 `@forgeax/engine` 或 `@forgeax/engine/<package-directory>`。
- 导入路径和签名先查 [API 索引](skills/forgeax-engine-authoring/references/api-index.md)；命令使用 `pnpm exec forgeax help <command> --json`。
- 将已确认的 Engine 问题记录在 `docs/feedback.md`，不得包含秘密信息。

## HDR

帧从头到尾保持 HDR：灯光（包括点光源）、自发光和 bloom 在最终曝光与色调映射前，始终是未钳制的场景线性值。如果在更早已钳制输出的路径上调亮度，例如 8 位目标或逐 draw 色调映射，这些参数不能直接沿用。

## 运行、测试、构建与发布

- **打开 View**。在游戏根运行 `pnpm exec forgeax project view --json`，打开返回的 URL 并确认当前项目及就绪状态。

| 用户意图 | 路由 |
|:--|:--|
| 创建、修改或本地游玩（默认） | 运行下方项目检查和 playthrough |
| 发布、部署或分发 | 构建正式产物并运行下方发布验收 |
| 引擎变更、性能 | Engine 所属包和适用的性能技能 |

```bash
pnpm exec forgeax project check --json          # 工程和依赖检查
pnpm exec forgeax dev start --headless true     # 执行一次，保留用于 dev look 的预热页面
pnpm exec forgeax dev look --hide-ui true --json  # 每次视觉编辑后获取场景 PNG
pnpm exec forgeax project play scripts/playthrough.mjs --json   # 真实输入、状态和截图
pnpm exec forgeax project build --out-dir release --base ./    # 静态游戏：release/index.html 和资产，可放任意目录
pnpm exec forgeax project play scripts/playthrough.mjs --release --dist release --json  # 最终验收构建后的发行版
```

先看画面，再游玩。场景可构建后启动 `dev start`，每次修改灯光、材质、雾、天空、后处理或相机后运行 `dev look`。打开 PNG，对[视觉自审](skills/forgeax-engine-authoring/SKILL.zh-CN.md#visual-self-review)的每个问题用一句话回答；修复每个否定项并重新观察。通过代码检查不代表画面完成：look-dev 应在编写游玩脚本之前进行。

`project play` 用于玩法验收：为游戏自己的流程编辑 `scripts/playthrough.mjs`，计时使用 `play.advance(seconds)`，投影使用 `play.state()` 或 `play.waitFor()`；API 索引的 playthrough 文件列出了所有辅助方法。针对构建后的 `release/` 进行其他浏览器检查也可计入验收。完成意味着：核心输入在游玩中有效，且已打开最终截图，确认其通过针对目标视觉效果的自审。使用 `forgeax project preview` 提供 `release/`，它设置 COOP/COEP 响应头并支持多个连接。

> [!IMPORTANT]
> 如果浏览器运行被阻塞，说明交付目标、首个失败命令与错误、尝试过的恢复，以及仍待完成的玩家可见检查。明确是否观察到启动、渲染和所要求的操作。构建成功但浏览器启动失败时，这三项仍未验证，游戏可能在第一个可玩帧之前就已停止。在目标通过前，将产物报告为“已构建，但运行时验收被阻塞”。
