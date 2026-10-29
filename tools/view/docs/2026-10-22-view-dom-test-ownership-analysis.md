# View DOM 测试的代码归属与 CI 分层分析

**范围：**基于 2026-10-22 本地 Engine checkout 与嵌套 `tools/view` checkout 的源码、测试和 workflow。本文分析测试应由哪个代码库维护、CI 如何执行以及跨仓库边界如何验证。它不是对 GitHub Actions run `39595018376` 的完整日志复核，也不宣称本次重新运行过全部 CI。

## 结论摘要

测试代码归属应由它断言的生产事实决定，而不是由 CI 最终在哪个仓库启动决定。

- 对 View 页面 DOM、组件状态、文案、可访问性、布局、交互和 View 侧参数输入转换的断言，应由 View 仓库维护。
- 对 Pack 参数 schema、参数合法性、apply 语义、生成执行、World/AssetRegistry 状态和结果发布的断言，应由 Engine 仓库维护。
- 验证 View 消费真实 Engine API 后是否兼容的浏览器旅程，应作为 View 与 Engine 的配对集成测试。它可以由 View CI 或 Engine 的消费者兼容性 job 调度，但测试代码、页面断言和 View 专属 fixture 应归 View 源码所有。
- 测试脚本归属、实际运行的 Engine/View 版本，以及 GitHub check 的发布仓库是三个不同维度，需要在 CI 中明确标记和固定版本。

## 当前代码结构

### View 已有自己的测试体系

`tools/view/test/` 已包含大量 View 测试，而非仅有参数面板测试。例如：

- `pack-authoring-client.test.mjs` 验证 Pack 参数草稿的请求顺序、保存、预览目标与退役处理；`parameter-contributions.test.mjs` 验证参数插件、详情标签和字段分组。它们不直接断言参数面板的 React DOM。
- `runtime-content.test.mjs` 验证 Content Browser 中另一套 runtime content 控件的文本草稿与类型化值转换，包括默认值、布尔值、数值向量、枚举、零值和非法输入。
- `viewer-panels.test.mjs` 验证 Viewer panel host、插件组合和 panel 状态。
- `play-toolbar.test.mjs` 验证工具栏 DOM 属性、状态文案和行为。
- `preview-surface.test.mjs`、`native-preview.test.mjs` 验证预览 canvas/surface 的挂载、显隐、样式和清理。
- `page-plugins.test.mjs`、`live-integration.test.mjs`、`workspace-*.test.mjs` 覆盖插件装配、页面生命周期、workspace 请求和客户端状态。
- `source-boundaries.test.mjs` 验证 View package 的依赖方向、模块边界和导入约束。

这表明 View 的产品逻辑和大量 UI/DOM 行为本来就在 View 仓库内测试。准确的问题不是“View 的测试整体都在 Engine”，而是少数跨层浏览器旅程的脚本和 fixture 曾经放在 Engine 仓库内。

### 参数面板分别依赖两侧合同

本文讨论的 Pack authoring 参数面板由 `packages/view-plugin-parameters/src/ui/ParametersPanel.tsx` 实现。`packages/view-plugin-parameters/src/frontend.ts` 将它分别以 `generation` 模式注册为 Pack 文件的「Generation Parameters」详情标签，以 `runtime` 模式注册为资产页的「Parameters」面板；字段分组和预览目标选择由同包的 `field-partition.ts` 辅助。`packages/view-plugin-content-browser/src/ui/RuntimePacksPanel.tsx` 是 Content Browser 的另一套 runtime content 控件，不能作为此处 Pack authoring 面板的实现依据。Pack authoring 参数面板涉及的行为至少有两类：

**View 行为：**参数字段怎样映射到输入控件、草稿如何初始化和更新、空值或非法文本如何反馈、按钮何时可用、点击后向哪个 target 发出哪个 operation、错误如何呈现在页面上。这些断言属于 View。

**Engine 行为：**Pack 参数声明是否通过 schema 校验、值是否满足类型与限制、参数如何 apply 到资产、生成是否执行、执行结果如何发布、失败后 last-known-good 状态如何保留。这些断言属于 Engine。

因此，参数面板并非一个单一测试边界。View 单测可以用 stubbed ToolApi 验证请求构造和 UI 反馈；Engine 单测直接验证领域合同；少量配对测试再验证真实请求和真实 Engine 之间的兼容性。

## 之前放在 Engine 树下的浏览器旅程

当前工作区的 Engine runner `scripts/ci/run-view-integration.mjs` 调度以下 View 页面旅程：

- Pack authoring
- Texture preview
- Pack save/reopen
- Diagnostic pages

迁移前，这些脚本和专用 fixture 位于 Engine 树下的 `tools/view-plugins/integration/`。工作区中它们已经迁到 `tools/view/scripts/` 与 `tools/view/scripts/fixtures/`，Engine runner 则调用新路径。这是合理的源码所有权调整，因为这些旅程通过 Playwright 直接操作 View 页面，并对 View DOM 作断言。

这些脚本同时覆盖 Engine 事实。例如 Pack authoring 旅程会真实执行 Pack 生成、参数保存、资产更新和重开；纹理预览旅程会检查预览选项及实际图像数据；诊断页旅程会读取真实 Engine 诊断结果。因此，迁移脚本不等于把 Engine 覆盖删掉。更合适的描述是：**View 拥有用户旅程脚本；Engine 是该旅程调用的真实下游运行时。**

上述四条并非 Engine 树中全部涉及 View DOM 的测试。例如 `tools/forgeax-mcp/test/app-browser.mjs` 在验证 MCP App、真实预览和 Play 生命周期时，也直接定位 View 按钮与 iframe。MCP App 的传输、宿主生命周期及渲染结果仍应由 Engine 验证；View 控件结构和可见性断言应由 View 维护。当前迁移未拆分这条跨产品旅程，后续 View 页面改动仍可能使这项 Engine 测试失败。本轮只修正了其中一处准备阶段 iframe 的等待条件，使其符合已有的“挂载后、就绪前可停止”合同，不把这视为完成所有 DOM 测试归属调整。

### Fixture 与 mock 的区别

`assets/proof.pack.ts` 一类文件是测试输入。若测试创建临时项目，把该 Pack 作为资产源交给真实 Engine 编译、运行并检查结果，它属于集成 fixture，而不是 mock。Fixture 的职责是提供稳定、可复现的输入，不决定其生产行为由谁所有。

Mock 则是替身实现，用来跳过一个边界。例如 View 单测可以 stub ToolApi 并预设 Engine 返回值，以测试 loading、错误展示和命令参数；但这种用例不能证明 Engine 真正接受参数、执行生成或发布了预期资产。真实 Engine 路径应由 Engine 自己的领域测试或配对集成测试覆盖。

Fixture 的维护位置应跟随主要使用它的测试。专门表达 Engine 参数 schema 合同的 fixture 适合 Engine 测试持有；专门支撑 View 页面旅程的 fixture 适合 View 持有。双方共享 fixture 时，应通过明确的共享输入合同或版本化路径进行，而不是让 Engine 测试树依赖 View 页面结构。

## 推荐测试分层

### 1. View 单元与组件测试

**源码所有者：View。**

测试参数草稿转换、默认值显示、operation 与 payload 构造、target 选择、状态更新、错误映射、React/DOM 呈现、可访问名称、用户交互和组件生命周期。尽量在不启动完整 Engine 的情况下完成，保证失败定位快且局部。

UI 断言应优先使用语义角色、可访问名称和稳定的 `data-testid`，避免依赖容易变化的 CSS 层级或实现细节。产品 DOM 有意变化时，应在 View 的同一改动中调整对应 View 测试；CI 因此失败是要求测试与产品契约一起更新，而不是要求 Engine 承担该 DOM 断言。

### 2. Engine 领域与 API 合同测试

**源码所有者：Engine。**

直接验证 Engine 对 Pack 和参数的处理，包括声明解析、schema 校验、合法性边界、apply 结果、执行生命周期、资产版本/发布、错误合同及无 UI 的渲染事实。测试入口应尽量使用 Engine 自己的公开或包内接口，不依赖 Viewer DOM、View 文案或 panel layout。

Engine 测试的通过应说明 Engine 的领域语义成立；它不应被解释为 View 的页面行为也成立。

### 3. View × Engine 配对集成测试

**脚本和页面断言：View 所有。运行环境：两边组合。**

保留少量能发现跨层问题的真实旅程：View 通过真实 ToolApi/公开入口连接 Engine，执行真实参数修改、保存、重开、预览或诊断读取。它们的价值是确认端到端兼容性，不是重复每个控件的所有细节断言。

如果 Engine CI 调度该旅程，应把 job/check 命名为消费者集成或 Engine×View compatibility，并记录测试的 Engine SHA 与 View SHA。发生 UI selector/DOM 预期变化时，修复应落在 View 测试；真实 Engine API/领域行为改变时，修复应落在 Engine；双方版本不兼容时，按触发变化和合同共同处理。check 出现在某个仓库，不足以单独证明代码责任也属于该仓库。

### 4. 发布与打包边界测试

**源码所有者：被验证的生产边界。**

Engine package exports、包内容、运行时闭包、无 View 时的 Engine 初始化属于 Engine；View package exports、View bundle、Viewer 插件组装和 View 依赖方向属于 View。跨边界的消费者构建可以在配对 CI 验证，但不要把产品 DOM 行为放进打包合同测试中。

## CI 的合理安排

View workflow 应在每个 View 改动上运行 View architecture check、package check、View 单测和相应浏览器组件测试。它需要固定或解析目标 Engine 版本，避免“测试通过”实际只代表一个不明确的旧 Engine。

Engine workflow 应始终运行 Engine 自己的领域测试。仅当改动触及 View 消费的 Engine API、Pack 参数合同、渲染或生命周期时，才需要运行相关消费者配对旅程；Engine 可以调度旅程，但脚本及 View 断言仍从 View checkout 取得。

配对 CI 至少应记录：

- Engine commit SHA 和 View commit SHA；
- 该 job 验证的是 View 单测、Engine 领域测试还是消费者集成；
- 若失败，失败阶段属于 View 页面、Engine API/运行时、fixture/项目准备还是浏览器/GPU 环境；
- 可复现需要的输入与证据产物。

固定 SHA 能使结果可复现，但也带来同步责任：Engine runner 路径变化合入后，消费它的 View workflow pin 必须更新；View 页面合同变化应由 View workflow 检出；候选 Engine 改动则需让配对 job 使用候选 Engine，而不应静默沿用旧 pin。

## 对当前工作区改动的评价

将上述四条浏览器旅程及专用 fixture 移入 `tools/view`，从源码维护权看符合其页面交互和 DOM 断言的主要所有者。保留 Engine runner 调度这些脚本，可以继续用 Engine 候选版本验证真实消费者组合。两种安排并不矛盾，但 runner 应保持为 CI 编排层，不复制 View 的页面结构、selector 或产品文案知识。

这个迁移要在远端形成完整且可复现的 CI 链路，还依赖跨仓库版本衔接：Engine runner 改动合入后，View workflow 的 Engine pin 需更新到包含新路径的 commit。本文只分析源码归属和配对验证条件；分支提交或局部检查不能代替最终提交上的两仓 CI 结果。

另有一个独立的测试可移植性问题：`sandbox-storage.test.mjs` 曾使用 `URL.pathname` 得到不适用于 Windows 的路径；当前工作区改为 `fileURLToPath`。这类测试自身路径解析错误应在 View 仓库修复，与 DOM 测试归属无关。

## 代码依据

- Engine 配对 runner：`scripts/ci/run-view-integration.mjs`，尤其是步骤定义和 View 脚本调度。
- View CI：`tools/view/.github/workflows/ci.yml`，包括 Engine commit pin、View checks 和 paired browser shards。
- Pack authoring 参数 UI 与注册：`tools/view/packages/view-plugin-parameters/src/ui/ParametersPanel.tsx`、`tools/view/packages/view-plugin-parameters/src/frontend.ts`。
- Pack authoring 字段分组与客户端测试：`tools/view/packages/view-plugin-parameters/src/field-partition.ts`、`tools/view/test/parameter-contributions.test.mjs`、`tools/view/test/pack-authoring-client.test.mjs`。
- 独立的 Content Browser runtime content 控件及测试：`tools/view/packages/view-plugin-content-browser/src/ui/RuntimePacksPanel.tsx`、`tools/view/packages/view-plugin-content-browser/src/ui/runtime-packs.ts`、`tools/view/test/runtime-content.test.mjs`。
- View 依赖和源码边界测试：`tools/view/test/source-boundaries.test.mjs`。
- View DOM/组件测试示例：`tools/view/test/viewer-panels.test.mjs`、`play-toolbar.test.mjs`、`preview-surface.test.mjs`、`native-preview.test.mjs`。
- 已迁移的 View 浏览器旅程：`tools/view/scripts/verify-pack-authoring-integration.mjs`、`verify-texture-preview-integration.mjs`、`verify-pack-save-reopen-integration.mjs`、`verify-diagnostic-pages-integration.mjs`。
