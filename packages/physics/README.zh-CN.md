# @forgeax/engine-physics

[English](README.md) · **简体中文**

Physics 定义 ECS 物理组件、PhysicsWorld 资源、错误码和枚举。原生实现分别位于 `@forgeax/engine-physics-rapier3d`、`@forgeax/engine-physics-rapier2d`；项目通过所选后端插件启用模拟。

> [!NOTE]
> 本文提供中文阅读入口，并保留原有实体对隔离说明，不是完整逐段译文。完整 API、组件默认值、单位和生命周期见[英文契约](README.md)。

## 从任务开始

| 任务 | 完整契约 |
|:--|:--|
| 创建动态或静态刚体 | [快速开始](README.md#quick-start)：组合 Transform、RigidBody、Collider，再安装所选后端插件 |
| 配置求解精度 | [求解器精度](README.md#solver-precision) |
| 理解固定步调度 | [三阶段更新](README.md#three-phase-tick-pipeline)与[位姿投影](README.md#transform-pose-projection) |
| 选择刚体和形状 | [枚举与收窄辅助](README.md#enum-constants-and-narrowing-helpers)、[组件 schema](README.md#component-schemas) |
| 读取碰撞实体 | [CollidingEntities](README.md#collidingentities) |
| 驱动角色 | [CharacterController](README.md#charactercontroller)、[moveAndSlide](README.md#character-movement-moveandslide) |
| 传送与同帧移动 | [显式移动语义](README.md#teleport-and-same-tick-movement) |
| 普通关节与身体运动 | [托管关节与运动](README.md#ordinary-managed-joints-and-body-motion) |
| 查询移动能力 | [Mobility 与 RigidBody](README.md#mobility-and-rigidbody) |

项目在 `settings.simulation.physics` 声明求解迭代和异步结果插值。App 在启动玩法插件前插入 `PHYSICS_STARTUP_OPTIONS`，后端分配原生 World 前消费这些输入；显式插件参数不能与项目声明冲突。更改此配置不意味着支持运行中修改求解器。

## 查询、固定步与原生状态

3D 可选 `sweepSphere` 和 `sweepShape` 使用真实原生形状与过滤，返回首次碰撞位姿、唯一身体实体、世界空间见证点和截断标记。静止查询报告当前重叠；非法输入、能力缺失和原生失败不是“没有命中”。2D 后端不宣称具备这些 3D 能力。

`initialOverlap: 'ignore'` 只对本次移动投射排除起始重叠体；默认 `report`，静止查询始终报告重叠。形状旋转不能替换成包围球近似。

`RigidBody.canSleep` 默认 `true`，属于身体创建策略。已经存在的 ECS 身体不能直接更改；要修改需退休并重新生成。显式 sleep/wake 命令与自动睡眠分开。

| 主题 | 完整契约 |
|:--|:--|
| 已提交动力学与力 | [固定动力学与传感器名单](README.md#fixed-dynamics-and-sensor-rosters) |
| 原生或 Worker 求解参与者 | [求解参与者](README.md#solver-participants) |
| 已接纳碰撞体几何 | [已提交碰撞体快照](README.md#accepted-collider-snapshots) |
| 模拟参与边界 | [模拟参与者](README.md#simulation-participant-boundary) |
| 导航角色组合 | [导航与物理角色](README.md#navigation-character-composition) |

已提交快照绑定真实实体 generation、身体身份和完成步。未完成的 Scene 编辑、渲染实体或后端句柄不能代替它。Worker 挂起期间读取最后已提交状态；原生写入仍遵循固定步边界。

## 派生形状与地形

派生形状通过 prepare、admit、cancel 与恢复协议提交完整候选。拒绝保留先前状态；部分原生失败必须明确进入重建路径，不能伪装成已经回滚。

| 主题 | 完整契约 |
|:--|:--|
| 派生形状事务 | [3D 候选](README.md#derived-shape-candidates-3d) |
| 有界冲量 | [交互冲量](README.md#bounded-interaction-impulses) |
| 运行中属性修改 | [3D 属性编辑](README.md#live-3d-property-edits) |
| 网格碰撞 | [源网格碰撞](README.md#source-mesh-collision) |
| 地形高度场 | [地形准入](README.md#terrain-heightfield-admission-3d) |
| 原生简单形状 | [图元事务](README.md#native-primitive-shape-transactions) |
| 体素 | [紧凑体素形状](README.md#compact-voxel-shapes) |
| 谓词保护与激活 | [受保护准入](README.md#guarded-admission-and-explicit-activation) |
| 铰链速度电机 | [派生铰链电机](README.md#owned-derived-hinge-velocity-motors) |

## 精确物理实体对隔离

`PhysicsWorld.acquirePairIsolation` 是可选能力，当前由 Rapier 3D 实现。调用方须检查能力是否存在；缺少能力时明确拒绝，不能返回没有物理效果的成功凭证。

输入 `{ worldIdentity, entityA, entityB }` 使用当前同步或注册的真实 ECS World 对象，以及包含 generation 的两个完整实体 handle。两个实体必须不同、存活、启用，并在该 World 的后端中拥有启用的身体和已接纳 Collider。索引、业务 bodyId、渲染实体和 native handle 都不能替代这个身份。

成功结果为 `PairIsolationLease`，其 `release()` 返回 `Result<void, PairIsolationError>`。相同实体对的正向和反向 acquire 共享计数，每次返回独立 lease；释放任意一个后其他引用仍有效，最后一个释放后恢复符合作者策略的接触。重复 release 幂等。硬限为 128 个不同 pair、512 个未释放 lease；预算拒绝及其他预检失败不改变旧隔离或作者分组。

隔离覆盖两个身体的全部普通及 derived Collider，包含 sensor，并由同一后端的原生 contact／intersection hooks 和 KCC predicate 执行。地面、其他身体和其他玩家仍按原策略参与碰撞。KCC 始终排除自身全部 Collider 和 sensor；没有主体的普通 raycast 不隐式应用 pair 隔离。`collisionGroups` 和 `solverGroups` 始终归作者所有，acquire／release 不写入或恢复历史分组。

成功 acquire 表示策略已接纳，在下一次 native step 或 KCC 查询生效，不是模拟完成收据。接触缓存刷新在 step 前进行，同时唤醒涉及身体；最后 release 也走同一路径，包含已经预热或睡眠的接触。刷新或原生 step 的部分失败进入既有 `getDerivedRecoveryState() === 'rebuild-required'`，调用方应重建 PhysicsWorld，不能把普通拒绝当成已回滚。

同一身体的 Collider 替换保留 lease；身体删除或重建、实体 generation 退休、World 更换或 detach、PhysicsWorld dispose 自动使旧 lease 失效并回收配额。backend generation 和身体 record 的对象身份共同阻止旧 lease 改变新身体；原生 handle 的槽位复用不构成身份继承。原生 step 和配对 derived admission 内的 acquire／release 返回 `pair-isolation-busy`，应在该操作完成后重试。

本轮碎裂策略由交互层在成功碎裂后释放握持，并复用现有失效／清理路径。Engine 不把旧 pair 隐式复制给碎片；源身体删除是最终清理兜底。失败碎裂保持源身体时，原 lease 保持有效。

真实 CPU／Rapier 回归位于 `physics-rapier3d/src/__tests__/pair-isolation.unit.test.ts`；这些证据不替代 Engine 的浏览器、Dawn 和完整 60 帧 smoke 门禁，也不代表调用方已完成绑定或接入。

## 错误与恢复

错误分类见[错误码](README.md#error-codes)。读取结构化恢复信息，保留身体、World、源修订与完成步身份，再在所属固定步边界重试或重建。CPU 或原生数值检查不能替代浏览器、Dawn 和真实帧验收。
