# @forgeax/engine-input

[English](README.md) · **简体中文**

Input 在帧起点扫描设备，并在用户系统运行前发布冻结的 `InputSnapshot`。游戏系统读取快照，不重复调用后端采样，也不另装一套游戏 DOM 监听器。

> [!NOTE]
> 本文是中文阅读入口，不是逐段译文。完整调用示例、默认阈值、边界和错误表见[英文契约](README.md)。

## 接入与所有权

使用[四步示例](README.md#four-step-recipe)装配浏览器后端、资源、帧起点扫描系统与退出清理。后端必须先于扫描系统插入，用户系统在 `InputFrameStartScan` 之后读取本帧快照。

`inputBackendPlugin(backend)` 借用宿主后端，不接管生命周期；`ownedInputBackendPlugin(backend, dispose)` 用于拥有画布输入的 App，DOM 监听清理由同一提供者 Fiber 退出触发。World 快照资源和扫描系统仍是独立消费者能力。

`attachBrowserInputBackend(canvas, { uiRoot })` 将组合 UI 事件排除在游戏输入之外；进入 UI 根的事件会清除已取得的游戏输入。同源 iframe 的节点身份使用所属文档 realm 检查。

## 设备与动作

| 读取面 | 用途与完整契约 |
|:--|:--|
| `keyboard` | [逻辑键与物理键](README.md#keyboard-6-read-points)：按住、按下、释放；物理 `code` 不受键盘布局影响 |
| `mouse` | [鼠标](README.md#mouse-six-read-points)：位置、移动、按钮边沿和滚轮 |
| `gamepad` | [手柄](README.md#gamepad-seven-read-points)：按钮值、边沿、轴、映射和连接状态 |
| `pointer` | [指针](README.md#pointerper-pointerid-reader)：按 pointerId 读取位置、压力、位移与阶段事件 |
| `virtualAxis` | [虚拟轴](README.md#virtualaxis-separate-namespace)：独立命名空间中的摇杆读取 |
| `capabilities` | [能力探测](README.md#capabilities-one-time-probe)：附着时冻结可用能力 |
| `action` | [设备无关动作](README.md#action-declarative-device-independent-semantics)：统一按键、手柄按钮和轴的语义 |
| `gesture` | [手势](README.md#gesture-five-touch-recognizers)：缩放、旋转、滑动、长按和双击；阈值见[默认值](README.md#default-gesture-thresholds) |

键盘和鼠标的按下、释放边沿在后端收到事件时记录，而不是从扫描时的按住状态猜测。因此，两次扫描之间完成的按下再释放会在下一快照保留两个边沿；边沿只持续一次扫描。

## 焦点、指针锁与预览

`InputSnapshot.focused` 表示本帧取得的宿主焦点。`focusReset` 表示上次扫描后发生过焦点重置，包括失焦、页面隐藏和消费者所有权转移；即使采样前焦点已恢复，重置仍然可见。失焦或重置时取消持续手势，不要将其解释为玩家释放命令。

`createCanvasInputBoundary(source)` 将一个采集生产者分配给 `preview` 与 `game` 后端。`grantGame()`、`revokeGame()` 转移所有权并清除旧采样；各消费者保留自己的输入门控。

| 主题 | 完整契约 |
|:--|:--|
| 注入指针锁能力 | [PointerLockProvider](README.md#pointerlockprovider-type-ssot)与[浏览器注入点](README.md#browserinputbackendoptionslockprovider-injection-point) |
| 允许或撤销锁定 | [命令门控](README.md#inputbackendsetpointerlockallowed-command-gate) |
| 读取实际锁状态 | [pointerLocked](README.md#inputbackendsamplepointerlocked-readpoint) |
| 模拟输入 | [模拟边界](README.md#simulation-input-boundary) |
| 手柄反馈 | [手柄反馈](README.md#gamepad-feedback) |

## 失败与清理

不支持设备的中性读取、焦点变化、移除设备和动作缺失有明确语义，见[不变量](README.md#invariants)、[边界行为](README.md#boundary-behavior)和[错误模型](README.md#error-model-charter-p3-explicit-failures)。退出时释放所属后端和监听器，避免多个 Engine 实例泄漏处理器。
