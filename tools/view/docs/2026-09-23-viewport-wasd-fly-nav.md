# 开发文档：视口漫游相机的 WASD 移动

状态：排查完成，待实现。日期：2026-09-23。约束：本文只制定方案，不修改代码。

## 问题

视口漫游相机只有旋转（按住右键拖动），没有 WASD 的前进/后退/左移/右移。用户期望像常见编辑器一样用 WASD 移动相机。

## 排查结论

WASD 移动在 View 和 Engine 两侧都已实现，且 CI 的 `verify-workspace-experience.mjs` 里 "RMB navigation and combination release" 用例一直验证着它。用户看不到它的原因是**触发门控**：WASD 只在"按住右键"的 look 手势里生效。

### 链路现状

| 层 | 位置 | 行为 |
|:--|:--|:--|
| View 按键捕获 | `packages/view-plugin-viewport/src/workspace-shell.ts` 的 `keydown`/`keyup` | `if (!gesture || gesture.mode !== 'look') return;` —— 没有手势或手势不是 look 时，WASD 直接丢弃。`gesture.mode` 在 `pointerdown` 时确定：右键（button 2）无 Alt 才是 `look`；中键是 `pan`，Alt+左键是 `orbit`，Alt+右键是 `dolly`。 |
| View 移动合成 | 同文件 `queueInput` 的 `movement()` | key-down/key-up 时按 `held` 键集合算 `{ type: 'move', velocity: [x, y, z] }`（KeyD−KeyA、KeyE−KeyQ、KeyS−KeyW，按 `this.speed` 归一化），经 `enqueueUpdate` → `api.updateCamera` 发给 Engine。 |
| Engine 积分 | `packages/app/src/workspace.ts` 的 `createDefaultWorkspaceCameraInputController` | `sample.type === 'move'` 存 velocity；World Update 的 `tick` 按 `velocity * deltaSeconds` 沿相机 right/forward 移动 `observation.camera`。 |
| Engine 自带适配器 | `packages/app/src/workspace-camera-events.ts` | Engine 自己的 canvas 输入适配器也有同样的 held→move 逻辑（供非 View 宿主使用）。 |

所以"按住右键 + WASD"是设计好的飞行导航，并且在 CI 里是绿的。裸按 WASD（不按右键）什么都不发生，这是 `keydown` 里那行 `gesture.mode !== 'look'` 提前返回的直接结果。

### 用户场景的两种解释

1. **引导缺失**：用户不知道要按住右键。裸按 WASD 无反应，于是报告"没有 WASD 功能"。
2. **真实 bug**：用户按住右键再按 WASD 仍不动。若是这种，需要拿到当时的页面状态再定位（本次实测环境因一个无关的 `app-canvas-detached` 时序问题未能完成 RMB+W 的端到端实测；该问题与 WASD 链路无关）。

注意一个真实存在的边缘缺陷：裸按 WASD 时 `held` 集合不清理的副作用不存在（裸按键被提前 return，不进 `held`）；但 look 手势中窗口失焦/`stop()` 时 `held.clear()` 会清空，行为正确。真正的风险在方案 B 的实现里（见下）。

## 目标

让 WASD/QE 在视口里可用，且不破坏现有手势语义与文本输入。

## 方案

推荐 **方案 B（裸键也可移动）+ 保留 RMB 飞行**，因为它直接回应用户期望；方案 A（仅加引导提示）作为最小替代。

### 方案 A：只补引导（最小）

在视口工具栏或首次聚焦时提示"按住右键旋转，按住右键 + WASD 移动"。不改输入逻辑。适用于确认用户只是不知道门控的情况。

### 方案 B：裸键 WASD 也可移动（推荐）

`keydown` 里去掉 `gesture.mode !== 'look'` 的提前返回，让 WASD/QE 在无手势时也产生 `move` 输入。需要同时处理：

| 风险 | 处理 |
|:--|:--|
| 焦点在输入框/按钮上时劫持按键 | 沿用 `shouldCapture(event)`；确认它已排除 `input`/`textarea`/contenteditable。若没有，补上 `event.target` 的表单控件判断。 |
| 与 `f` 键聚焦选中项的冲突 | 现有逻辑里无手势时 `f` 触发 `onFocusSelection`。WASD 不含 f，无冲突；保持 f 分支在前。 |
| 无手势时事务生命周期 | 现状：`begin()` 在 pointerdown/wheel 时启动，`finish()` 在 `stop()` 时提交。裸键没有手势，需要决定事务边界：建议第一个 WASD key-down 时 `begin()`，所有键松开（`held` 为空）后延迟 `finish()` 提交，避免每个键都开一个 camera 事务。 |
| 键卡住 | 窗口失焦/`visibilitychange`/`blur` 已有 `abort()` 路径，会清 `held`；裸键路径要确认同样走到 `abort()`（现状 `stop()` 只在有手势或 abort 时跑）。 |
| 与 RMB 飞行的叠加 | RMB 按住时 WASD 已是 move；裸键与手势中的 move 共用同一 `movement()` 合成，无需分叉。 |

实现触点集中在 `packages/view-plugin-viewport/src/workspace-shell.ts` 的输入适配器（`keydown`/`keyup`/`stop`/`finish`），Engine 侧无需改动。

## 验收

1. 裸按 W/A/S/D/Q/E，相机按对应方向连续移动；松开即停。
2. 按住右键拖动仍旋转；按住右键 + WASD 仍飞行移动（CI 现有用例不破）。
3. 焦点在路径输入框等文本控件里时，WASD 正常输入字符，相机不动。
4. 窗口失焦后松键，相机不继续漂移（`held` 被清理）。
5. `verify-workspace-experience.mjs` 的 RMB 导航用例继续通过；新增裸键移动的用例覆盖方案 B。

## 待确认

- 用户场景到底是"不知道要按右键"还是"按了右键也不动"。若是后者，需要当时的页面状态（是否 Play 中、是否有对话框遮挡、视口是否聚焦）再定位；方案 B 的裸键移动在两种情况下都能消除报告。
