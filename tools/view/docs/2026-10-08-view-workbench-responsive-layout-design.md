# View Workbench 响应式 Edge 侧栏（v0.8）

| 项 | 说明 |
| --- | --- |
| 对齐目标 | `@forgeax/interface@0.9.5` DockShell |
| 范围 | 每页独立 Dockview + scoped edge drawer |

## 二维断点收纳（`targetSides`）

迁移以 **`targetSides`** 为准（非静态 stage→sides 表）：

| 压力 | 条件（滞回 enter/exit） | 收纳 |
| --- | --- | --- |
| 仅高度紧 | `height` 轴 | **bottom**（如 1280×720） |
| 仅宽度紧 | `width` 轴 | **left + right** |
| 宽高同时极紧 | `width` **且** `height` 均过 all 阈值 | **三侧** |

`stage`（wide/compact/narrow）仅作标签；`applyStageMigration` 对 `targetSides` 做 **delta** tuck/restore。

## UE 拖拽

- **pointerdown**：pending session + `capturePresentation` 基线 + origin index；**不** floating、**不**关 drawer。
- **超过 5px**：`addFloatingGroup` lift（失败则 rollback origin）；edge 拖拽此时才 `forceClose` drawer；`isUeDragging()` 仅 lift 成功后为 true。
- **click / 未过阈值 pointerup**：零 layout 变更。
- **cancel / 无 target**：`restorePanelToGridOrigin` + `GridRestoreSession`（拓扑 split，一次映射原 groupId→runtime group）。

## 多 group 恢复

- `inferSplitRelations`：`moveTo` 方向为相对 anchor（other 在左 → `right`）。
- `GridRestoreSession`：按 anchor 拓扑迭代；每原 group 只 split 一次；后续 tab `within/center` 同组按 index。

## Drawer

- Scoped `EdgeDrawerController`；无 window 事件。
- 打开时将 `.dv-content-container` portal 到 `body.fx-edge-drawer-portal-host`（`display:block` + `position:fixed`），与 interface `edgeDrawer.js` 一致；grid 尺寸不变。
- Pin / 右键「固定」统一走 controller `pinPanel` / `unpinPanel` / `togglePinForPanel`；打开 tab **不**自动 pin。

## Edge 拖拽预览

- Edge hit 时：**仅** native strip 内 `fx-edge-preview-tab` +（grid 目标时）`fx-ue-tab-slot`；`hideUeOverlay()` 清 director/slab/ghost；**不**把 edge rect 交给 UE overlay。
- Lift 后 floating carrier 持续 `fx-ue-lifted--hidden`；split 目标才 `placeLiftedPreview`。
- 离开 edge 清 preview tab；cancel/drop 清全部预览。

## 主题与菜单

- Dockview 语义 token 挂在 `.fx-view-dockview-host`；edge strip 规则为 `.fx-view-dockview-host .dv-groupview-edge`；body portal 为 `.fx-edge-drawer-portal-host` 显式映射同一套 token。
- Tab 菜单：`dockview-core` `PopupService` 将 `.dv-popover-anchor` 挂到 `.dv-shell`（`updateRoot`，仍在 host 内）；样式 scope 为 `.fx-view-dockview-host .dv-context-menu*` + host 内 popover z-index。
- UE lift 仅对 source 容器加 `.fx-ue-lifted--hidden`，不全局隐藏 floating groups。
