# 开发文档：材质页视口的漫游相机与复原视角

> Superseded for the Material page by [2026-10-22 material preview navigation](2026-10-22-material-preview-navigation.md).
> Material now rotates the object with left drag, pans with middle drag and
> dollies with right drag/wheel. Scene look/WASD controls below are historical
> Material policy. Reset uses the existing camera transactions and the native
> Material orientation reset; no `camera.restore` operation was introduced.

状态：已实现。日期：2026-09-24。修订：复原视角用 View 侧记录的开场姿态加现有 camera.begin/commit 写回，不新增 Engine 操作。

## 问题

双击材质进入材质页之后，预览区只有 Engine 画出来的球体，不能转、不能飞。场景视口里已经有的漫游相机没有接到这块画布上。用户在材质页里把视角转开以后，也没有办法一键回到打开材质时的那一帧。

## 现状

材质页插件 `forgeax.view.page.material.frontend` 只注册页面和两个面板。预览面板 `MaterialPreviewPanel` 通过 `bindWorkspacePreviewSurface` 把 Engine 的 type-preview 表面放进 `.fx-asset-preview-surface`。这个面板不监听指针和键盘。

漫游输入只挂在场景编辑视口上。`packages/view-plugin-viewport/src/workspace-shell.ts` 里的 `ViewWorkspaceInputController` 仅在工作区标签为 `VIEW_WORKSPACE_TAB_ID` 时，绑到场景那块表面上。手势是：

| 输入 | 行为 |
|:--|:--|
| 右键拖动 | look，绕相机旋转 |
| W/A/S/D/Q/E | 沿相机朝向飞行；松开即停。聚焦在该表面时不必按住右键 |
| Shift | 按住时加快当前移动 |
| 中键拖动 | pan |
| Alt + 左键 / Alt + 右键 | orbit / dolly |
| 右键按住时滚轮 | 调整飞行速度 |

View 只采样输入，经 `camera.begin` / `camera.update` / `camera.commit` / `camera.abort` 发给对应 `targetId`。Engine 在 `createEngineWorkspaceAppTarget` 里为每个预览目标装了 `createDefaultWorkspaceCameraInputController`，积分发生在该预览自己的 `observation.camera` 上。Broker 按 `targetId` 把 `camera.*` 送到对应预览，不总是场景编辑目标。

材质预览已经是这样一个独立目标。`prepareResourcePreview` 在材质自己的 App 里生成单位球（包围盒 `[-1,-1,-1,1,1,1]`），并把相机放在球心正前方（位置为球心沿 +Z 偏移 `radius * 2.5`，默认朝向看向 -Z，垂直 FOV 为 π/4）。这一姿态就是本文说的初始视角。它没有被记下来，工作区 API 里也没有把它写回去的操作。

所以缺的是两件事：把现有输入控制器接到材质预览表面，以及让 Engine 能把该预览相机设回开场姿态。不需要再写一套飞行数学。

## 目标

1. 用户单击材质页预览表面并使其获得焦点之后，该表面接受与场景视口相同的漫游相机。飞的是这块材质预览的相机，不是场景编辑相机。
2. 预览区有一个按钮。点击后，进行中的相机事务先中止，然后相机回到本次打开该材质时的初始视角。

## 非目标

- 不改场景视口的手势、速度和快捷键。
- 不给网格页、纹理页加漫游或复原。
- 不把左键拖动变成旋转。单击只负责聚焦；旋转仍是右键。
- 不保存用户转过的视角。再次打开同一材质时，初始视角仍是 Engine 这次生成的开场姿态。
- 不改材质属性面板。它继续只读展示 `asset.inspect`。
- 不把初始距离、FOV 写死在 View 里重算。复原使用 Engine 在预览打开时记下的姿态。

## 方案

### 1. 单击预览表面后启用漫游

在 `MaterialPreviewPanel` 的实时预览里，表面绑定成功之后，对 Engine 放进容器的那块表面调用 `ViewWorkspaceInputController.attach`。

| 项 | 值 |
|:--|:--|
| `targetId` / `targetGeneration` | 当前材质预览目标，来自 `selectWorkspaceResourcePreview`。禁止使用场景编辑目标的 id。 |
| `tabId` | `VIEW_WORKSPACE_TAB_ID` |
| 捕获范围 | 仅当事件发生在这块预览表面内，且表面已聚焦。复原按钮、属性面板、文本框不捕获。 |
| 生命周期 | 预览目标变化、表面卸载、材质页不再是当前页时 `dispose`，并 `abort` 未结束的事务。 |

聚焦规则：

- 表面可聚焦（控制器现有的 `tabindex` 即可）。
- 第一次在表面上的主键点击让它获得焦点，同时不产生 look / pan / orbit。
- 获得焦点之后，上表里的场景视口手势原样生效。
- 焦点离开表面（点到复原按钮、属性面板、其他页面）时中止事务并清空按键，相机停止。

未聚焦时，在材质页按 WASD 不移动材质相机，也不移动场景相机。

### 2. 一键复原初始视角

Engine 在材质 type-preview 的相机生成完成、交给 `createEngineWorkspaceAppTarget` 之前，记下当时的观察相机快照。快照只服务这次预览目标，随 `preview.close` 丢弃。

快照内容：

- 变换：`pos`、`quat`
- 镜头：`fov`、`near`、`far`、投影类型
- 不记录 `aspect`。复原后的宽高比仍由现有的预览 resize 按当前画布决定，避免把开场时的 `aspect: 1` 冻住。

新增工作区操作 `camera.restore`：

| 项 | 值 |
|:--|:--|
| 参数 | `targetId`、`targetGeneration`、`tabId`。与 `camera.get` 相同，不接受调用方传入的位置或旋转。 |
| 行为 | 若该目标有未结束的相机事务，先以原因 `camera-restore` 中止，并清掉飞行速度和 orbit 枢轴。再把观察相机设回快照，镜头宽高比保持当前值。版本号递增。 |
| 返回 | 与 `camera.get` 相同形状的 `{ camera, version }`，并带上该预览 `target`。 |
| 重复点击 | 第二次调用后姿态与第一次复原后的姿态相同。 |
| 失败 | 目标不匹配、预览已关闭、或该目标没有材质开场快照时失败。不改相机。 |

调用链与现有相机操作一致：`client.restoreCamera` → broker 按 `targetId` 选中材质预览 → `engine-adapter` → 该预览目标上的 `restoreCamera`。操作名加入 `contract.mjs` 的工作区操作表。

View 在材质预览面板上放按钮，不放进属性面板，也不放进会被漫游捕获的表面内部。

| 项 | 值 |
|:--|:--|
| 文案 | 中文「复原视角」，英文 “Restore view” |
| i18n | `material.restoreView`，补 `locales/zh.json` 与 `locales/en.json` |
| 位置 | 预览面板右上角，盖在画面之上 |
| 标记 | `data-testid="material-restore-view"` |
| 可用 | 当前有材质预览目标时可用。没有目标、表面绑定失败、或请求未返回时禁用。 |
| 点击 | 先让按钮拿走焦点（从而停下飞行），再调用 `camera.restore`。失败时在预览面板上显示已有的工作区错误，不改画面外的页面。 |

## 验收

1. 打开材质页后，未点击预览表面时按 W，材质相机和场景相机都不动。
2. 单击预览表面后：右键拖动旋转；W/A/S/D/Q/E 按对应方向连续移动，松开即停；Shift 加速；中键平移；Alt 拖动仍是 orbit / dolly。
3. 上述操作期间，场景编辑视口里的相机姿态不变。
4. 把材质相机飞开之后，点「复原视角」，球体回到打开该材质时的取景（球心在画面中心，相机在球心正前方）。再点一次，画面保持这一姿态。
5. 按住右键旋转的同时点「复原视角」，旋转停止，相机回到初始视角，不会在松手后继续转。
6. 换一个材质再打开，复原回到的是新材质这次的开场姿态。
7. 焦点在属性面板或任意文本框时，WASD 不推动材质相机。
8. 材质属性面板仍为只读。场景视口原有漫游用例保持通过。

## 实现触点

| 层 | 位置 | 改动 |
|:--|:--|:--|
| 材质预览 | `packages/view-plugin-material/src/ui/MaterialPreviewPanel.tsx`、`material.css`、`i18n/locales/*.json` | 绑定输入控制器；复原按钮 |
| 输入复用 | `packages/view-plugin-viewport/src/workspace-shell.ts` 的 `ViewWorkspaceInputController` | 只复用。材质页传入自己的 `targetId` 和捕获判断，不改场景视口的挂载条件 |
| 工作区 API | `view-workspace-core` 的 `contract.mjs`、`client.mjs`、`broker.mjs`、`engine-adapter.mjs` | 增加 `camera.restore` |
| Engine 预览 | `Forgeax-engine/packages/devkit/src/host.ts` 的 `prepareResourcePreview`，以及 `packages/app/src/workspace.ts` 的预览目标 | 材质预览记下开场快照；目标实现 `restoreCamera` |

## 待确认

无。单击只聚焦、漫游手势与场景视口相同、复原目标是本次打开时 Engine 记下的姿态。这三项按上文实现。
