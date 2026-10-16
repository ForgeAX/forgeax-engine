# 开发文档：内容文件原地刷新目录

状态：已实现。日期：2026-09-24。

Codex 改了内容浏览器里的文件之后，View 要在同一条连接上换掉资源列表。Engine 页面、预览目标和 WebSocket 保持不动。

## 问题

内容浏览器画的是工作区快照里的 `assets`，不是磁盘目录。这份列表只在 View 连上时通过 `assets.list` 拉一次，缓存在 broker 的 `this.assets`。

资源根下的文件变化今天会进入生成宿主的会话替换：`packages/devkit/src/host.ts` 的 `hotUpdate` 做候选构建并 `server.restart()`。Pack 以 `watch: false` 启动，不会原地重建目录。服务一重启，Engine 页面和当前预览目标就被换掉。

只改 View 不够。页面里的 `enumerateCatalog()` 在第一次拉取之后返回内存中的 `CatalogReplica`。`createCatalogSource` 没有订阅 `forgeax:catalog-delta`，重复调用 `assets.list` 读到的仍是启动时的目录。

## 现状

生成宿主在 `pluginPack({ watch: false })` 下提供目录。`watch: false` 时 `setSourceRefresh` 直接拒绝，并要求换一次宿主会话。Vite 已经用 `server.watcher.add` 看着资源根；`hotUpdate` 对资源根下的路径和插件源走同一条重启队列。

目录重建的实现已经在 `createWatchBatchApplier` 里：更新 catalog 投影、发出 `forgeax:catalog-delta`。同一条路径在重建成功且不是 sidecar 时还会 `sendFullReload`，或者调用宿主传入的 `refresh`。现成的 `reloadAssetHost()` 就是发 Vite `full-reload`。工作区 serve 不能改成不带约束的 `watch: true`，否则页面仍会卸掉。

生成页模板 `hostSource` 里的目录源只有 URL：

```ts
createCatalogSource({
  url: runtimeScopeBinding.catalogUrl,
  expectedScope: runtimeScopeBinding,
})
```

`CatalogSource.subscribe` 在没有传入 `subscribe` 时是空函数。Vite 把 `forgeax:catalog-delta` 发到 `import.meta.hot` 之后，已经打开的副本收不到。

`snapshotEngineWorkspace` 不含目录版本。`devKitWorkspacePlugin` 在目标变化时向 `engine.workspace.state` 发布这份快照。View broker 的订阅忽略载荷，只调用 `changed()`，用旧的 `this.assets` 再发一遍 View 快照。

内容浏览器 `ContentBrowserPanel` 已经订阅 View 快照。`assets` 指纹变化时它会换列表。`setSnapshot({})` 只发生在 client 或连接身份变化时。

## 目标

1. 资源根下的内容文件变化不进入候选构建，不调用 `server.restart()`，不发送 Vite `full-reload`，不升高 `target.generation`。
2. 同一次服务进程里重建目录，更新 `catalog.json` 对应的投影，向已经打开的页面发出 `forgeax:catalog-delta`。
3. 页面把 delta 折进当前 `CatalogReplica`。随后的 `enumerateCatalog()` 返回新行，页面不导航。
4. 目录发布成功后，宿主经现有 `engine.workspace.state` 带上新的 `catalogEpoch`。这个事件只表示目录变了。
5. View 在同一条连接上对当前 project 再调用一次 `assets.list`。失败时留下原来的列表和连接。

## 非目标

- 不把工作区 serve 改成现成的 `watch: true`，不启动第二套会 `full-reload` 的 Pack watcher。
- 不放宽 `setSourceRefresh` 的拒绝。Pack body 仍要求新的宿主会话。内容目录走一条单独的入口。
- 不调用 `resetPageSession()`，不关闭 View WebSocket，不清空已打开的预览。
- 不改 `ContentBrowserPanel` 的刷新方式，也不把它的连接 effect 绑到 `catalogEpoch` 上。
- 不在这次里重装已打开场景的世界。场景文件作为内容文件只更新目录行；视口里已经实例化的场景保持原样。
- 插件源、`forge.json`、锁文件和 `sourceInventory` 模块仍走现在的候选构建和 `server.restart()`。

## 方案

### 1. Engine：把内容文件从会话替换里拆出来

`packages/devkit/src/host.ts` 的 `hotUpdate` 先分类，再决定是否进入现有重启队列。

| 类别 | 判定 | 行为 |
|:--|:--|:--|
| 会话源 | 项目根上的 `forge.json`、`package.json`、`pnpm-lock.yaml`、`bun.lock`、`package-lock.json`；`sourceInventory.sourceInputs`；插件定义、cooker `watchFiles`、工具模块；以及 `belongsToPlugin` 为真的模块 | 保持现在的候选构建和 `server.restart()` |
| 内容文件 | 位于 Pack `roots` 之下，并且不是会话源 | 不进入重启队列。调用下一节的原地目录重建，然后 `return []` |
| 其他 | 现有提前返回条件 | 保持不变，不重启，也不重建目录 |

同一路径同时命中两类时按会话源处理。内容文件的重建失败不启动候选构建，不重启服务，目录停留在上一份已发布投影。

Vite 现有的 `server.watcher.add(roots)` 继续负责发现这些文件。不要为此再开 `watchDevRoots`。

### 2. Engine：原地重建目录

在 Pack 上增加只换目录的入口，供 `hotUpdate` 在 `watch: false` 时调用。它复用 `createWatchBatchApplier` 里已经会做的生产重建：

- 更新服务端 catalog 投影，使目录路由上的 `catalog.json` 变为新快照。
- 通过现有 `sendCatalogDelta` 发出 `forgeax:catalog-delta`。
- 不调用 `sendFullReload`。
- 不调用宿主 `refresh`，也不使用 `reloadAssetHost()`。
- 不升高 Pack runtime generation、Vite 会话代次或工作区 `target.generation`。

`setSourceRefresh` 在 `watch: false` 时继续以 `stale-generation` 拒绝。这条新入口不经过 `setSourceRefresh`。

重建进行中又来一批内容文件时，沿用现有重建排队，只发布最后一次成功的投影。失败批次不发布 delta，也不增加 `catalogEpoch`。

### 3. Engine：页面折进 delta

生成页模板 `hostSource` 里的 `createCatalogSource` 传入 `subscribe`，把 `import.meta.hot` 上的 `forgeax:catalog-delta` 交给当前源。校验使用现有的 catalog delta 校验。合法 delta 由 `CatalogReplica` 折进已有基线，使下一次 `enumerateCatalog()` 返回新行。

非法 delta 不导航、不整页重载、不更换 target。副本保持折入前的快照。

`import.meta.hot` 不存在时，`subscribe` 仍是空函数，生产和现有的一次性枚举行为不变。

### 4. Engine：通知 View

目录 delta 已经交给页面并且投影更新成功之后，宿主进程里看到这次重建完成的那一层通知工作区插件，由它现有的 `publish` 再发一次 `engine.workspace.state`。

`snapshotEngineWorkspace` 增加一个数字字段 `catalogEpoch`：

| 项 | 值 |
|:--|:--|
| 初值 | 打开项目时的 `0` |
| 增加 | 只有内容目录重建成功并已发出 delta |
| 不增加 | 目标变化、相机、预览开关、重建失败 |
| 伴随发布 | 目标变化引起的原有 publish 带上当前计数，避免 View 把旧计数当成新一代 |

这次发布不关闭 target，不改 `targetId`，不改 `target.generation`，不改预览里的 asset 绑定。载荷里除 `catalogEpoch` 外仍是现有快照。

### 5. View：同一条连接上重拉列表

`packages/view-workspace-core/src/broker.ts` 里 `engine.workspace.state` 的订阅读取载荷中的 `catalogEpoch`。

| 条件 | 行为 |
|:--|:--|
| `catalogEpoch` 是大于上次已应用值的数字，且当前有 project | 记下该值，对当前 project 调用已有的 `assets.list`。不传新的 target，不调用 `resetPageSession()` |
| 计数不变，或载荷没有该字段 | 保持现在的 `changed()` |
| 没有打开的 project | 只记下计数，不列举 |

`invoke('assets.list')` 成功时写入 `this.assets` 并 `changed()`，View 快照因此换上新列表。不要把 `catalogEpoch` 放进 View 快照；面板继续只看 `assets` 指纹。

同一次连接上的重复计数只列举一次。和面板初次 `listAssets` 重叠时，多一次成功的列举可以发生，但不得清空快照或预览。

`assets.list` 失败时：

- 留下失败前的 `this.assets`。
- 不关闭 WebSocket，不标记 `workspaceTargetLost`，不清空预览、inspection 和 open request。
- 不把失败转成服务重启。

面板自己的刷新按钮仍走它现有的 `loadFailed`。后台这次列举失败不改面板的连接 effect。

`ContentBrowserPanel` 不改。它的 `subscribe` 会在 `assets` 指纹变化时换列表。`setSnapshot({})` 的 effect 依赖保持为 client 与连接身份，不能加上目录计数。

## 验收

1. 修改资源根下的网格、纹理、材质或场景文件后，Engine 页面的 WebSocket 不断，预览 `targetId` 与 `generation` 不变，Vite 不收到 `full-reload`。
2. 同一次修改之后，内容浏览器出现新的目录行，或已有行的路径、名称、种类与新投影一致。不需要手动点刷新，也不需要重新连接 View。
3. 修改 `forge.json`、锁文件或插件源时，仍然走候选构建和 `server.restart()`。
4. 内容目录重建失败时，列表保持上一次成功的内容，连接和预览目标保持不变。
5. `assets.list` 在 `catalogEpoch` 前进时失败，列表和连接仍保持失败前的状态。
6. 已打开场景的视口和场景树不因这次目录刷新而重载。
7. 内容浏览器在 client 未变、连接未断时不会先被清空成空快照再填回。

## 实现触点

| 仓库 | 位置 | 改动 |
|:--|:--|:--|
| forgeax-engine | `packages/devkit/src/host.ts` 的 `hotUpdate` 与 `hostSource` | 内容文件不进重启队列；生成页订阅 `forgeax:catalog-delta` |
| forgeax-engine | `packages/vite-plugin-pack` 的目录重建入口 | `watch: false` 时仍可原地重建；不 `full-reload`，不升高 generation |
| forgeax-engine | `packages/app/src/workspace-tools.ts` 的 `snapshotEngineWorkspace`，以及 `packages/devkit/src/workspace-plugin.ts` 的 publish | 成功发布后增加 `catalogEpoch` |
| forgeax-view | `packages/view-workspace-core/src/broker.ts` | `catalogEpoch` 前进时在当前连接上调用 `assets.list` |

## 待确认

无。内容文件只换目录并通知 View；会话源仍整次替换；已打开场景的世界不在这次重装。
