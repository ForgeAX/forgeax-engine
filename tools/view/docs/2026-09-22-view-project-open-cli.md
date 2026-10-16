# 开发文档：用命令行直接打开 View 项目

状态：已按本文实现。日期：2026-09-22。修订：按评审收紧跳转、broker 取法，以及命令成功和界面打开的边界。

本文只定义 `forgeax view project open`。实现该命令时，同一批改动还要更新 `README.md` 的 Start here、`skills/forgeax-view-start/SKILL.md`，以及 `AGENTS.md` 里“启动不打开项目”的那一条边界说明。

## 问题

`forgeax view start` 只在已经运行的 Engine backend 上提供 View 界面，并返回 URL。浏览器打开后，Shell 被一个不可关闭的 **Open project** 对话框挡住：必须输入 **Project path**，再点 **Open project**。对话框在 `packages/viewer/src/shell/WorkspaceProjectRecovery.tsx`。`snapshot.project?.root` 为空时它一直显示，并且挡住包括 Runtime capture 在内的所有页面。有项目根路径时组件 `return null`，对话框卸载。

这对人是明确的一步。对 AI 则是失败点：代理必须再去驱动浏览器填路径、点按钮。空路径、按钮禁用、截图仍是 `No project`，都不能算项目已打开。`skills/forgeax-view-start/SKILL.md` 现在把这一步写成浏览器操作。

已有的底层客户端不能替代这个命令：

| 现有入口 | 为什么不够 |
|:--|:--|
| `forgeax view start --root <backend>` | `--root` 是 backend 工作区，不是编辑器项目。帮助文本写明启动 View 不打开项目。 |
| `forgeax-view workspace --operation project.open --args '{"root":"..."}'` | 调用方必须自己拿 WebSocket endpoint 和 token。`view start` / `view status` 只返回 `viewerUrl`，不返回这两者。 |
| 同上一次 `project.open` | Broker 会通过 `forgeax.view.workspace.state` 把快照推给已连接的页面，对话框会因为 `project.root` 出现而关掉。跳转到 Engine 项目目标只发生在对话框提交时（`navigateToWorkspaceProjectTarget`）。远程打开后，页面仍停在空 Shell。 |

## 目标

增加一条 host 命令，让 AI 在 View 已经启动后，用项目目录直接打开编辑器项目，不必操作对话框。

```sh
forgeax view project open --root <backend-workspace> --project <project-path> --json
```

完成后分成两段，不要合成一条“编辑器已经显示项目”：

1. **命令成功**：JSON 里的 `project.root` 是请求的项目目录，并且带有 Engine 的 `projectTarget.url`。Engine 在浏览器连接之前就返回这个 URL，只说明 headed 会话已分配。
2. **界面打开**：已打开的空 Shell 收到状态后进入该项目目标页；或者浏览器随后加载 `projectTarget.url`。这两种情况下都不再出现路径输入框。

人手动打开 URL，并在对话框里输入路径，这条路径保持不变。场景预览、像素和 Play 仍是后续独立步骤。

## 非目标

- 不让 `view start`、`backend start` 顺带打开项目。三条生命周期命令的语义不变。
- 不启动浏览器，不安装 Chromium，不接受 `--headless`、`--software`、`--serve`。
- 不启动 Play，不绑定或启动 AI run，不打开场景资源。
- 不切换已经打开的另一个项目。本次不新增关闭命令；失败时当前项目保持打开。
- 不把 workspace API 的 endpoint / token 暴露成这条命令的参数。调用方只使用和 `view start` 相同的 backend `--root`。

## 命令契约

在 `src/commands.ts` 增加一条与 `view.start` / `view.status` / `view.stop` 同级的 host 命令。Engine CLI 按 `argsSchema` 的属性生成 flag，因此 `--project` 必须出现在 schema 里。

| 项 | 值 |
|:--|:--|
| id | `view.project.open` |
| path | `view project open` |
| realm | `host` |
| 参数 | `root`：backend 工作区，规则与 `view start` 相同，可用 `FORGEAX_PROJECT_ROOT`。`project`：要打开的编辑器项目目录，必填。 |
| executor | `src/command-executor.ts` 的新导出，经 `callDevKitBackend(root, 'view.project.open', { project })` 调到已运行的 backend。`callDevKitBackend` 的第三个参数就是这份 args。 |

`--root` 和 `--project` 经常是同一个游戏目录，但它们不是同一个参数。`--project` 省略、空白，或值以 `--` 开头时，命令失败，提示传入 `--project`。不要把 `--root` 当成项目路径。

`--json` 沿用现有 CLI。成功时 stdout 一行 JSON：

```json
{
  "ok": true,
  "alreadyOpen": false,
  "viewerUrl": "http://127.0.0.1:<port>/",
  "project": { "id": "<engine-project-id>", "root": "<absolute-project-path>" },
  "projectTarget": { "url": "http://127.0.0.1:<port>/?...", "targetId": "<id>" }
}
```

`viewerUrl` 来自当前 View owner 的 status（现有 `phase: "ready"` 时的 `url`）。`project` 与 `projectTarget` 来自 `project.open` 返回的 workspace 快照，不在命令里另造一份项目状态。

`projectTarget.url` 是 headed 工作区文档地址，query 里带 `forgeaxWorkspaceToken`。代理可以用浏览器打开它。它不是 workspace API 的 endpoint 或 token，不能拿去调用 `forgeax-view workspace`。

这条 JSON 只证明会话和 URL 已分配。headed 页面尚未连接，渲染也尚未开始。代理还要打开 `projectTarget.url`，或依赖已经开着的空 Shell 自行跳转。打开之后，路径框消失才算界面打开。

### 行为

1. 解析 `--root`。backend 未就绪，或 View `phase` 不是 `ready`：失败，hint 为先执行 `forgeax backend start` 与 `forgeax view start`。本命令不代为启动。
2. 将 `--project` 解析为绝对路径。和已打开项目比较时使用与 Engine `readProjectFacts` 相同的 realpath。目录尚不存在时保留调用方路径，让 Engine 返回原来的失败。不要用原始字符串比较，否则同一目录的不同写法会在“已打开”和“另一个项目”之间判错。
3. 读取本次 View 的 workspace 快照。
   - 已打开的 `project.root` 与请求路径是同一目录，且 `workspaceTargetLost` 不为 true，并已有 `projectTarget.url`：不再调用 Engine，返回当前快照，`alreadyOpen: true`。
   - 已打开的是另一个项目：失败，code `view-project-already-open`，detail 带当前 `project.root`。不调用 Engine。Engine 的 `openProject` 会关掉当前会话，所以这里必须在调用前拒绝。
   - 尚未打开，或同一项目但目标已丢失：调用一次打开。
4. 打开时只调用 `start()` 拿住的那个 workspace core：`openProject({ root, tabId: 'forgeax-user-workspace' })`。这就是对话框提交时走的 `project.open`。View 不实现扫描、烹饪或渲染，也不另建 broker。
5. 返回快照里的 `project` 与 `projectTarget`。没有 `project.root` 或没有 `projectTarget.url` 视为打开未完成，把 Engine 的失败原样返回，不把命令标成成功。有 URL 仍不表示浏览器已加载该页。
6. 与 `start` / `status` / `stop` 共用 `src/plugins/product.ts` 里的那条队列，避免和 `view stop` 交错。`project.open` 在返回前会等待 Vite catalog，默认最长约 120 秒。`view stop` 必须取消这次进行中的打开，然后释放 View；不能等 catalog 超时结束后才停止。

运行时工具注册在 View launcher 插件上，id 为 `view.project.open`。`viewWorkspaceCore` 由 `start()` 里的子插件 `provide`。launcher 在父级，Cordis 的 `get` 只沿祖先查找，`host.context.get('viewWorkspaceCore')` 拿不到它。`createViewBackend` 把插件装在 host context 上，那条路径不能照搬。

`start()` 在子插件 `await` 之后，从该子 context 取出 broker，保存在 launcher 闭包里。工具只使用这份引用。引用不存在时按“View 未启动”失败。`stop()` 清掉引用并取消进行中的打开。工具参数 schema 只接受 `project` 字符串；`tabId` 由插件固定为 `forgeax-user-workspace`，不开放给 CLI。

## 浏览器如何跟上

命令成功之后，空 Shell 还要进入项目目标，否则对话框关掉后视口仍是空的。直接打开返回的 `projectTarget.url` 时，该文档本身就是项目页，不依赖这次跳转。

采纳放在始终执行的 `useWorkspaceRecovery` 里。`WorkspaceProjectRecovery` 在 `snapshot.project?.root` 有值时 `return null`，对话框分支随后不再渲染。写在那个分支里的效果，在远程打开之后不会运行。`ViewerShell` 会一直挂载这个组件，hook 本身仍会执行。

只从还不是该 headed 文档的页面跳转：

- 快照有 `project.root` 和 `projectTarget.url`。
- `workspaceTargetLost` 不是 true。
- 当前文档的 query 里没有与该目标相同的 `forgeaxWorkspaceSession`。

满足时调用已有的 `navigateToWorkspaceProjectTarget`。已经带有相同 `forgeaxWorkspaceSession` 的文档不要跳转，包括整段 href 因编码或参数顺序与快照不一致的情况。目标页里同样挂着 `WorkspaceProjectRecovery`。若按 href 不相等就 `location.assign`，新文档会再次采纳并再次跳转。Engine 把 headed 页面的离开视为会话作废，这种循环会毁掉刚打开的项目。按页面记一次不能挡住跨文档循环。

| 顺序 | 结果 |
|:--|:--|
| 先打开空 Shell，对话框还在，再跑命令 | 状态推送后，空 Shell 跳到项目目标。目标页发现 session 已匹配，停在该页。 |
| 先跑命令，再打开 `viewerUrl` | 首帧 `getState` 已有项目。空 Shell 跳到项目目标，路径框不出现。 |
| 直接打开返回的 `projectTarget.url` | 该页已是 headed 文档，不跳转，路径框不出现。 |

不要自动处理“工作区需要重新连接”。目标丢失时仍只显示现有的重新连接按钮。人手动提交对话框的那一次跳转保持原样。

## 失败

| 条件 | code | 调用方看到的 hint |
|:--|:--|:--|
| 未传 `--project` 或值为空 | `view-project-required` | 传入要打开的项目目录绝对路径 |
| backend 不可用，或 View 不是 `ready`，或 launcher 没有 broker 引用 | `view-not-started` | 先 `backend start`，再 `view start` |
| 另一个项目已打开 | `view-project-already-open` | 当前项目保持打开。本次命令不切换项目 |
| 打开被 `view stop` 取消 | `view-not-started` | View 已停止。需要时重新 `view start` |
| Engine `project.open` 失败 | Engine 原有 code | Engine 原有 hint，不包装成 View 已打开 |

失败时 exit code 为 1。不关闭已有项目，不启动浏览器。`view-project-already-open` 不提示调用方去关闭：本次没有不暴露 API token 的关闭命令，带 token 的 `forgeax-view workspace` 也不是这条路径的替代。

## 代理用法

View 已启动、用户给出了要编辑的项目目录时：

```sh
forgeax view project open --root <backend-workspace> --project <project-path> --json
```

先看 JSON：`project.root` 与请求路径一致，且存在 `projectTarget.url`。然后打开 `projectTarget.url`，或确认已经开着的空 Shell 已经跳到该地址。路径框消失之后，才把项目视为已在界面中打开。场景预览和 Play 仍是后续独立步骤。

未要求打开项目时，停在 `view start` 返回的 URL，不要调用本命令。

## 实现落点

| 文件 | 改动 |
|:--|:--|
| `src/commands.ts` | 声明 `view.project.open`，`argsSchema` 含 `root` 与 `project` |
| `src/command-executor.ts` | 新 executor，把 `project` 传给 `callDevKitBackend` |
| `src/view-project-open.ts` | 解析 `--project`，拒绝浏览器启动类 flag，调用 `view.project.open` |
| `src/cli-contributions.ts` | 把新 executor 挂到 host 命令表 |
| `src/plugins/product.ts` | `start()` 从子 context 保存 broker；工具只调用这份引用；`stop()` 取消进行中的打开并清掉引用 |
| `packages/viewer/src/shell/WorkspaceProjectRecovery.tsx` | 在 `useWorkspaceRecovery` 里按 `forgeaxWorkspaceSession` 从空 Shell 跳转；对话框与重新连接保持原样 |
| `test/view-start.test.mjs` | executor 导出包含新命令；缺 `--project` 与浏览器 flag 被拒绝 |
| `test/plugin-contribution.test.mjs` | host 命令列表包含 `forgeax.view.project.open` |
| `test/workspace-recovery.test.mjs` | 无 session 的文档在出现 `projectTarget.url` 时跳转一次；已有相同 session 的文档不调用 `assign`；`workspaceTargetLost` 不跳转 |
| `README.md`、`skills/forgeax-view-start/SKILL.md`、`AGENTS.md` | 与代码同一批交付。写明本命令分配项目并给出文档 URL；`view start` 仍然不打开。界面打开要另看路径框是否消失 |

不新增第二套项目状态，不把打开逻辑放进 `view-workspace-core` 以外的 UI 插件，也不给 `forgeax-view workspace` 再包一层必须填写 token 的用法。

## 验收

命令：

1. `forgeax view start --json` 之后，空 Shell 仍是 Open project 对话框。
2. `forgeax view project open --root <backend> --project <path> --json` 成功，且该进程没有启动浏览器。
3. 成功 JSON 的 `project.root` 等于 `<path>`，并含 `projectTarget.url`。此时 headed 页面可以尚未连接。
4. 同一路径再执行一次，`alreadyOpen` 为 true，Engine `project.open` 不再被调用。
5. 已打开 A 时用 B 调用，失败且 A 仍打开。
6. View 未 start 时失败，backend 与 View 都不会被这条命令拉起。
7. 打开进行中调用 `view stop`，打开被取消，View 释放，不必等满 catalog 超时。
8. 不出现 Play 目标，已观察的 AI run 绑定不变。

界面：

9. 对话框已打开时执行命令，空 Shell 进入项目目标，不再显示路径框。目标页不再次跳转。
10. 先执行命令再打开 `viewerUrl`，空 Shell 进入项目目标，不出现路径输入框。
11. 直接打开返回的 `projectTarget.url`，不出现路径输入框，且该页不把自己再导航一次。
12. 上述界面检查不要求场景树、像素或 Play。
