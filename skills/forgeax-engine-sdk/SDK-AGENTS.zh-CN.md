**语言**：[English](SDK-AGENTS.md) · **简体中文**

> [!NOTE]
> 本文是 SDK AI 入口的人类阅读译本。命令及代码路径以安装后的 SDK 根目录为基准；本文的相对导航链接以当前源码目录为基准。工具仍读取英文入口。

# ForgeAX SDK：AI 入口

先读本文。两种 SDK 传输形式都在构建完成的 Engine 上附带可编辑源码与该发布版本的预构建模块输出。仅重新构建发生变化的 owner，将游戏绑定到 `source/engine/`；见[源码迭代](SDK-README.md#bind-local-engine-source)。

通过公共 npm 运行 `pnpm dlx @forgeax/engine sdk install <dir>` 安装。私有 GitHub Releases 是内部归档，消费者不需要 GitHub 凭据。安装得到普通目录，不带 npm 包装层。

## 必需的入门步骤

创建或修改游戏前阅读：

1. 本文：SDK/项目所有权、初始化、验证。
2. [SDK 技能](SKILL.zh-CN.md)：能力导览及需求、技能、证据的选择。

`project init` 在 `value.onboarding.read` 返回两个入口路径，文本模式输出 read 行。仅在任务需要更广泛发现时查询功能目录，选择最小且有用的能力集合。

> [!IMPORTANT]
> `sdk-manifest.json` 拥有归档完整性。`packages` 直接提供可读的已构建包，没有 tarball 或嵌套包装层。SDK staging、离线 store、manifest 均为生成输出。

> [!CAUTION]
> 游戏工作默认在当前项目直接编辑。仅在用户明确选择时启动 ForgeAX 闭环；安装技能不构成授权。

## Linux 无人值守测试

容器内初始化 SDK 前阅读 Linux 无人值守验证，其中规定可写 history/pnpm lock 目录、不使用 Xvfb 的无头捕获、虚拟有头捕获、非 root Chromium 沙箱。保留第一次真实失败，安装失败必须报告为失败。静态构建成功但浏览器受阻仍未完成运行时验收。明确报告不支持的能力，不能交付原样模板冒充演示。

## 创建游戏

```bash
node ./bin/forgeax.mjs project init
node ./bin/forgeax.mjs project new ../my-game --template game-3d
cd ../my-game
pnpm exec forgeax project check --json && pnpm test && pnpm exec forgeax project build --json
pnpm exec forgeax project preview --json
```

第一次从 SDK 根目录运行 `project init` 进行预检，再阅读输出的 AGENTS 和 SDK 技能，按需查阅专题参考。3D 游戏明确选择 `game-3d`。创建后完整阅读生成游戏的 `AGENTS.md`；其中运行、测试、构建、发布章节为每个新建或恢复的游戏任务选择交付范围。普通创建和修改默认本地可玩交付；只有明确请求发布或分发时才走发布路线，Engine/SDK 工作才使用 SDK 技能的生产参考。后续以这些本地文档为准。

其他游戏选择 `empty`：通过 `forge.json#roots.engine` 选择场景 owner PluginAsset；初始测试在 `assets/__tests__`，场景事实在 `assets/world`。干净的 3D 光照基线命令：

```bash
./bin/forgeax project new ../game-3d --template game-3d
```

> [!IMPORTANT]
> 目标必须在 SDK 根目录之外。根目录及其子目录会在复制前返回 `project-target-inside-sdk`；使用同级或外部目录。

SDK 根目录的 `project init` 在临时项目中使用 pnpm 12 锁文件安装原生依赖，允许 esbuild/Rapier/Engine WASM 构建脚本，并在 `.forgeax/sdk-init.json` 记录成功的平台元组。创建具有事务性：`new` 复制模板、安装 SDK 中所有 Engine 技能，以 `--ignore-scripts` 安装到 staging；原生二进制复用预检的 side-effects cache，不在每个游戏重复 postinstall。完整 ZIP 使用 `store/pnpm`；npm carrier 在线获取相同锁定依赖。失败回滚目标。成功不能修改 SDK 包 payload；pnpm 可以更新不具权威性的 store `index.db` 缓存。编写代码或资产前完整阅读生成游戏的 AGENTS。

`new` 成功后，尽力执行限时两秒的 registry 查询检查 `engine-sdk` latest tag；只有严格更新的版本才提示，不自动升级。新 SDK 单独安装；现有游戏保留 Engine 版本，阅读说明并测试后分别迁移。离线、超时、registry 失败不回滚创建。确定性自动化可设 `FORGEAX_DISABLE_UPDATE_CHECK=1`；JSON `value.sdkUpdate.status` 区分 `available/current/skipped/unavailable`。

完整 ZIP 游戏在 `pnpm-workspace.yaml` 中把规范化 SDK `store/pnpm` 路径固定为 `storeDir`；后续 doctor/test/dev/build/preview 复用离线闭包，不改用其他默认 store 重新解析。npm carrier 按锁文件访问 registry。

跳过 SDK init，`new` 或外部项目 `init` 会返回 `sdk-not-initialized`，不留下半成品。运行 SDK 根目录的 `project init` 恢复。

> [!TIP]
> macOS 归档可能带有 Gatekeeper quarantine。只有确认可信来源且出现明确隔离失败后，才运行 `xattr -dr com.apple.quarantine /path/to/forgeax-sdk`。CLI 不静默绕过系统策略。

## SDK 目录

| 路径 | 用途 |
|:--|:--|
| `bin/forgeax` | 独立项目创建 CLI。 |
| `packages/name` | 根目录含 manifest/README 的已构建公开包，仅完整 ZIP 提供。 |
| `templates/empty` | 带场景 owner Pack 和 assets 根目录的最小项目。 |
| `templates/game-3d` | 按功能划分的行为 Pack，以及程序化大气、PBR、网格、光照。 |
| `store/pnpm` | 两种模板共享的完整 ZIP 离线闭包，npm carrier 不含此目录。 |
| `skills` | Engine 任务指南、SDK 导览、已审计功能目录；`sdk-manifest.json` 记录文件和字节闭包。 |
| `source/engine` | 两种传输均含可编辑源码、经过检查的 WASM、发布版本的预构建模块输出。 |

## 项目、资产与工具

生成的 AGENTS 提供硬性规则、默认命令和任务路由；经其路由到 `skills/forgeax-engine-sdk/references` 的游戏项目及交付指南拥有布局、source/Pack/Meta 职责、GUID 加载、资产类型、执行域、测试、构建、交付、调试。`skills` 是普通文件；`.agents/.claude/.cursor/.codebuddy/.workbuddy/.forgeax` 技能挂载是可重建的发现链接：

```bash
pnpm exec forgeax project skill verify --json
pnpm exec forgeax project skill install --json
```

使用唯一 `forgeax` 入口和机器可读发现：

```bash
pnpm exec forgeax help --tree --json
pnpm exec forgeax help <command-path> --json
pnpm exec forgeax project build --input request.json --json
pnpm exec forgeax asset verify --json
pnpm exec forgeax shader check --json
pnpm exec a Node or Bun script using the SDK command client inspect.mjs --json
```

Linux 没有显示设备或物理 GPU 时，先读 [DevKit 捕获契约](../../packages/devkit/README.zh-CN.md)，再捕获 Canvas 与 HTML/Shadow DOM：

```bash
pnpm exec forgeax project capture --headless true --backend software --require-ui \
  --output artifacts/capture/game-ui.png --json
```

此路径使用源码开发资产和浏览器合成器截图；保留 adapter/error sidecar 证据。跨机器对比添加 `--deterministic`，在 `forgeaxCapture` 模式固定游戏状态。App 在 `canvas.forgeaxFrameProgress` 保留 submitted/completed 事实，Canvas 的 `forgeax:frame-submitted` 是仅通知未来提交的事件。Capture 读取快照、等待非平坦 Canvas 像素，然后等待游戏 `forgeaxCaptureReady` 检查点。等待时长只能额外稳定画面，不能作为确定性帧或像素证据替代品。

同一会话中的输入、断言、多检查点通过 Node/Bun SDK command-client 场景完成：只打开一次浏览器，驱动原生 `session.page`，每个命名 ready marker 后调用 `session.capture(name)`，最后关闭会话。PNG 追加到同一 schema-v2 manifest；在同一运行中的 World 捕获并返回可序列化结果。SwiftShader 截图不能证明物理 GPU 或发布验收。

- 创作、导入、构建：[资产技能](../forgeax-engine-assets/SKILL.zh-CN.md)。
- CLI、运维、远程 eval：[CLI 技能](../forgeax-engine-cli/SKILL.zh-CN.md)。
- App、World、插件、执行层级：[App 技能](../forgeax-engine-app/SKILL.zh-CN.md)。
- ECS、状态、物理、音频：`skills/forgeax-engine-{ecs,state,physics,audio}/SKILL.zh-CN.md`。
- 材质、WGSL、管线、GPU VFX：`skills/forgeax-engine-{material,shader,render-pipeline,vfx}/SKILL.zh-CN.md`。
- 复杂渲染失败：先用 [RHI Debug](../forgeax-engine-rhi-debug/SKILL.zh-CN.md) 捕获，再诊断 owner。

## Engine 与渲染能力

App 装配 Host、World、Renderer、插件。ECS 拥有游戏状态和时间；Render 拥有 extraction/preparation/recording；类型化 RenderGraph 拥有资源与 pass。RHI 优先浏览器原生 WebGPU，支持 wgpu/WASM WebGL2 回退。单条 adapter-unavailable/WebGPU 信息不能证明整机失败；检查最终 code/hint/detail，将 Asset/Shader/Pack/App 错误路由到对应 owner。暴露启动错误，保留游戏自己的 Canvas。AssetRegistry 消费 importer/cooker GUID 目录。

渲染支持程序化天空/环境光、方向/点/聚光灯、CSM 阴影、PBR/IBL、GPU VFX、HDR/SSAO/TAA/bloom。自定义 GPU 效果和 compute/raster Feature 使用可组合 WGSL 与反射材质 schema。

> [!IMPORTANT]
> 复杂或原因不明的渲染失败先读 [RHI Debug](../forgeax-engine-rhi-debug/SKILL.zh-CN.md)：捕获真实失败帧，检查 work/bindings/resources/目标像素，修复 owner，再跑原路径。不要等到广泛日志、profiler 查询和猜测性着色器修改失败后才捕获。

明确的启动、资产、schema 错误直接交给对应 owner。保留结构化 capture/replay 失败，按技能恢复。修复后通过 Playwright 复现和验证真实输出；HTTP 200、端口、Canvas 存在只证明存活。

生成游戏的交付范围章节拥有本地与发布验收。制作或验证 SDK 分发本身时，使用 SDK 技能的生产指南。

## 修改 Engine 源码

只有 Engine 工作才进入 `source/engine` 阅读其 AGENTS。这是 git-archive 快照，不是嵌套检出。public-distribution 标记跳过私有子模块；已检查的 wgpu/FBX/codec pkg payload 取消默认 Rust/Emscripten 前置要求。

```bash
cd source/engine
pnpm install
pnpm build:engine
```

源码改动需要 owner 测试和真实执行证据，然后从干净提交重建，并验证精确 ZIP。
