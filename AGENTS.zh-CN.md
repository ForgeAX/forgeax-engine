**语言**：[English](AGENTS.md) · **简体中文**

> [!NOTE]
> 本文供人阅读。工具识别的入口为英文 `AGENTS.md`；本文与其保持相同的工作约束。

# Engine 工作规则

这是以 AI 为主要用户的 TypeScript 游戏引擎。减少读者需要同时理解的概念，而不是追求更少的代码行数。优先采用单一权威、派生状态和封闭联合类型。修复负责该功能的子系统，不要添加演示专用绕过方案或平行注册表。优先采用更好的 API，而不是兼容垫片；已发布的传输协议和 API 变更仍须遵循版本规则。

## 从任务出发

- 阅读受影响包的 README 和已实现的契约。`@forgeax/engine` 是公开运行时与 CLI 的统一入口；实现仍由 `packages/<owner>` 负责。不要根据架构摘要推断 API。
- 不得切换主检出目录的分支。在隔离的 `.worktrees/<branch>` 工作树中提交；保留无关改动、活动会话和共享资源。交付后删除自己的干净工作树。

## 实现

- 仅使用 ESM TypeScript，遵循 `tsconfig.base.json` 的严格选项。通过 schema 声明组件、资源和事件。预期失败返回结构化 `Result`；封闭错误码联合与可辨识详情由源码所属模块维护，并进行穷尽处理。
- 运行时模块使用显式 Host 输入和 Engine 所有的诊断，不从打包器元数据或隐式进程环境推断开发模式。工具和平台适配器负责提供这些输入。交付前运行 `pnpm check:runtime-boundaries` 及其构建产物对应检查。
- 源码和 Agent 指引使用英文。遵循 Biome、包命名规则及 `packages/runtime/README.md` 的命名约定。避免冗余包装、状态副本和兼容路径；传输协议与错误码兼容性遵循已记录的版本边界。
- 测试放在最近的所属模块 `__tests__/` 中；运行器专用文件名和 `bench/*.bench.ts` 遵循参考文档。可复现缺陷必须有同路径回归关卡：先复现失败，再修复所属模块，最后通过相关检查。
- 在所属 manifest、版本策略和锁文件中修复漏洞，不修改安装产物或缓存；通过全新消费者验证。保持 `pnpm-lock.yaml` 和 `bun.lock` 同步；这些输入变化时运行 `pnpm sync:check` 和渠道对齐检查。

## 证据与检查

> [!IMPORTANT]
> 被阻塞的必需检查仍属于未验证。保留失败记录，尝试受支持的恢复方式，并报告缺失的证据。不得用更弱的 mock 或 CPU 结果替代运行时、像素、GPU、浏览器或设备验收。

- 难以定位的渲染失败从 [RHI Debug](skills/forgeax-engine-rhi-debug/SKILL.zh-CN.md) 开始：先捕获实际失败帧，再考虑着色器修改。明确的启动、资产或 schema 错误交给其所属模块。
- 基础初始化、`pnpm build:engine` 和 CPU 测试不需要 Dawn 工具链。Engine、RHI 或 hello 变更保留维护中的 **60 个已完成帧**核心冒烟测试、`pnpm test:browser` 和 `pnpm test:dawn`；浏览器路径失败需要浏览器证据。更长的持续测试需明确选择。参见 [CI 操作](scripts/ci/README.md)及 `scripts/ci/dawn-smoke-roster.json`。
- 启动 Chromium 必须设置 `chromiumSandbox: true`；修复无特权运行器，不要传递禁用沙箱的参数。连接运行器时使用用户提供的准确 SSH 端点，不猜测嵌套容器。
- CI 保持约 80% 的核心验证，每个矩阵最多四个实际作业，执行目标为 30 分钟，排队时间单独报告。修复 CI 时，发布前用相关 `pnpm ci:focus` 检查在本地验证最终候选，再对最终 PR 提交完成资格验证并取得受保护审查后正常合并。不要求先提供独立 Linux 测试主机才能发布；必需的 Linux 执行仍由 PR CI 完成。不得直接推送 main、使用管理员绕过合并或禁用规则集。仅对已证实的外部传输失败重试失败作业。CI 变化需更新操作指南和受影响的技能路由。
- 大型变更应询问开发者能否提供与 CI 环境和资源预算相似的测试主机。PR CI 运行期间，用该主机复现和修复失败检查，并验证尚未通过的相关检查。保留原有工作负载和限制。等待当前运行结束后，才发布已在本地验证的修复，并通过下述修复流程复用合格的成功检查。
- **PR 创建后的每一次更新，都必须采用 [PR CI 修复流程](skills/forgeax-engine-debug/SKILL.zh-CN.md#pr-ci-repair-workflow)。** 必需的 `ci-repair-policy` 状态由已有 `ci-core` 作业在昂贵的准备工作之前发布；缺少此状态的旧工作流成功记录不能取得合并资格。首次 CI 修订建立基线。后续每次推送前，在 PR 描述中设置且仅设置一行 `CI-Repair-From:`，指向前一次已完成的 CI 运行，并复用符合条件的成功检查。声明缺失、无效、过期或历史不可用都会阻塞 CI 和正常合并；改动类型、目的、大小、标签或额外批准都不构成豁免。即使某些检查不能复用证据，也保留声明，让这些检查按 CI 资格规则重新执行。基线准备、合格的手动恢复、全新检查、产物和来源记录均遵循该技能。最终提交的 CI 资格包括有效继承的成功记录，并保留受保护审查和正常合并要求。
- 从相关构建、类型、单元和 lint 检查开始；捷径不能替代必需验收。移动或新增测试时使用 `pnpm test:layout`。指标遵循 `schemas/forgeax-metrics.schema.json`；质量基线和完整命令见 CI 指南及参考。

## 按需阅读细节

| 任务 | 契约 |
|:--|:--|
| 包所有权或生命周期变化 | 模块设计映射，然后阅读所属包 README |
| 资产创作与发布 | [资产权威 schema](schemas/asset-authority.schema.json)、Pack README 和[资产技能](skills/forgeax-engine-assets/SKILL.zh-CN.md) |
| SDK 与 npm 发布 | 发布契约和 [SDK 技能](skills/forgeax-engine-sdk/SKILL.zh-CN.md)：Candidate → Promotion；晋升只消费已封存的字节，不重新构建或预先创建版本标签 |
| 公开 SDK 源码 | `.forgeax-public-distribution`：不要求私有资产或子模块；已检查的 WASM 载荷和 `pnpm build:engine` 足以完成源码构建；参见源码模式细节 |
| View 与工具集成 | View 源码契约；View 使用固定 gitlink，Harness 浮动；运行时包不依赖 View 或 React |
| 游戏与 CLI 工作 | [CLI 技能](skills/forgeax-engine-cli/SKILL.zh-CN.md)；`forgeax` 是公开入口，必需模板以 SDK 根目录之外的目录为目标 |
| 构建设置、命令与测试命名 | 贡献者参考和 CONTRIBUTING |
