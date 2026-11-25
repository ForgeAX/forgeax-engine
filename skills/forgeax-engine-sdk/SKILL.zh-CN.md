**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具入口为英文 `SKILL.md`。代码示例保持原文。

# 早期 ForgeAX SDK 发行版

已有归档参见[原归档指引](SDK-README.md)。当前 npm 包参见 [Engine 创作指南](../forgeax-engine-authoring/SKILL.zh-CN.md)。

## SDK 生产与发布

PR source cancellation：分别检查 shader admission、两个 cold profile 时长、browser journey、上传。专用 manifest producer 在预留 V8 heap/native memory 后准入 Worker budget，profile packager 保留子进程请求并行度。保留 source job 40 分钟、seed/peer consumer 30 分钟、两个 cold profile publications、全部 browser assertions；下一完整运行重新 qualify。

PR seed 在 `build:engine` 取消：检查实时 stage 输出及同 head Core base/shared point admission 前提。等待 producer 发生在不变的 30 分钟 seed 预算之前。下载在 runner temp 中跨 clean 保留；重建 compiler 后，两份原始 path-bound publications 必须通过当前 source/profile/digest 检查。clean JS 重建前，从同一现有 archive 采用 source-qualified Core native WASM/glue 对，因为独立原生构建可能字节不同；保留匹配派生 browser glue。不能把 point 改称 base、复制 JS compiler outputs、重写 receipt、延长 seed 预算。见 [SDK consumers](../../scripts/ci/README.md#sdk-consumers)。seed 准备变化时跑完整 source-export contract 命令。public-policy owner 在 Core native adoption 前检查 source acceptance，在 SDK production 前检查 provenance，使用实际命令而非已退役独立 native-build step 名称。

cold SDK 在 shader 编译后 heap 失败：分别检查 profile-container/declaration 子进程，其 heap 必须继承 runner 预算；compiler 子进程显式 heap 不会传给父进程。遵循 [CI 内存策略](../../scripts/ci/README.md)，SDK seed packaging 保留一个 compiler worker 与有界 publication verification subprocess。publication verification 的 JSON admission 继承相同 runner-derived child heap；GC 后独立的 128 MiB retained-heap 断言及完整 source/count/digest 检查仍必需，显式 512 MiB Node 参数不能覆盖环境使检查未执行即失败。

SDK carrier 路径失败：在现有 containment owner 比较规范 download 与 resolver-selected Engine roots。同一 installer 验证 alias parent 和 out-of-download package redirect；保留 version、digest、writable-output、empty-target 检查。见 [SDK consumer diagnostics](../../scripts/ci/README.md#sdk-consumers)。

两种 SDK transport 均含可编辑 `source/engine/` 及同发布 prebuilt outputs。专题 Engine 变更安装源码依赖，仅重建变更 owner，经 `project engine use-local` 绑定；未改 owner 复用交付构建。绑定见本地 Engine 指南，局部重建命令见 SDK README。

archive/post-consumer integrity 经既有有界 file-I/O owner 重读字节数和 SHA-256。被取消的 integrity tail 为未验证；保留全部 artifact，仅排除 SQLite 可变 store。见 SDK consumer diagnostics。

source-consumer job 取消先比较完整阶段时长。PR archive consumer 显式用 `--profile core`：保留经 embedded View Host 的单模块编辑、独立 cold Engine build、两个 source templates、完整 integrity checks。第二次 cold View tool build/diagnostic journey 延后，因为 installed View 与 Engine/View matrix 已覆盖。默认 `--profile full` 保留额外 source View build/journey 用于 release qualification。receipt 写明 profile 与延后验证，不能把 core 称为 full evidence。

预编译 Rapier 的 source consumer 意外要求 Rust：把 `SDK_SOURCE_WASM` 闭包与完整 producer receipt 对比，包括 3D SIMD glue/declarations。遵循 [native artifact admission](../../scripts/ci/README.md#native-rapier-artifact-admission)，补导出文件，不绕过 source/inventory/digest 检查。

明确请求 Engine/SDK 变更、归档验证、SDK 发布时读 SDK production。其 exact-ZIP 对象为 SDK 分发；游戏 ZIP 属于游戏 release route，普通游戏创建不进入 Candidate、Promotion、SDK consumers。

channel/source 和发布顺序见发布契约：`main` 发布 `next`，每周 `rc` 测试线发布 `rc`，`stable` 发布 `latest`。镜像 channel 经 source qualification 后 GitHub/npm 独立发布；source mirror 保留正式 GitHub Release identity 检查，推进 public `main`（开发）或 `stable`（稳定）。Stable Promotion 再经 `sdk-release-public.yml` 把原始已验证 Release assets 复制到公开仓库；已有稳定版本可用该 workflow 补齐或重试。交付要求 public Release 和所有其他已启用阶段完成。

Linux x64 可本地执行完整 development Candidate/Promotion：`node scripts/forgeax/local-sdk-release.mjs --stage all`，安装 workspace 别名为 `pnpm sdk:release:local -- --stage all`。在 `artifacts/sdk-local/<version>/local-release-state.json` 固定 version/source SHA，中断后恢复精确同一 Candidate。RC/stable 仍走 GitHub Actions。见仓库[本地发布流程](../../packages/engine/RELEASING.md)。

Candidate gates 通过后，`--stage preflight --version <locked-version>` 只检查 npm access/source-mirror 前提，不发布；`--stage promote` 恢复相同 locked Candidate 并发布。

> [!IMPORTANT]
> 每次 SDK 发布先执行选择发布流程：推 release branch 或 dispatch workflow 前明确 flow（development、rc cut/fix、rc promotion、stable hotfix）、version、source SHA、npm tag。用户未明确时请其选择 channel/version。
