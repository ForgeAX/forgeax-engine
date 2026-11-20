**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文是供人阅读的中文版本；工具入口仍为 `SKILL.md`。

# forgeax-engine-navigation

ForgeAX 有界图、网格及静态 NavMesh 导航。适用于烘焙地面净空、投影路线、避让附近角色，或通过物理系统沿路径移动。

| 需求 | 入口 |
|:--|:--|
| 创作的网络或带权重瓦片网格 | `createNavigationGraph` / `createNavigationGrid`；查询 `findPath` 时提供展开预算 |
| 静态、有限体积的地面导航 | 通过 `@forgeax/engine/import/navigation-bake` 构建所选索引 Mesh 及世界放置；将 POD 作为普通 Pack 输出返回 |
| 固定世界空间表面查询 | 加载 `navigation-mesh`，将 `assets.read(handle)` 传给 `createNavigationMesh`，再用明确限制调用 `project` / `ground` / `findPath`；该复制后的查询保持固定 |
| 物理角色 | 使用 `world.assets` 的托管资产安装 `physics3d` 和 `navigationCharacterPlugin(handle)`；安装后释放调用方引用；创作 NavigationCharacter 和运动学胶囊体；设置 `setNavigationTarget` |
| 本地点跟随 | `NavigationAgent`、`navigationPlugin`、`setNavigationPath`；使用本地 Transform 坐标和速度 |
| 有界附近 Agent 意图 | `solveNavigationAvoidance`；消费实际速度并检查饱和情况；可选候选准入必须有界 |
| 运行时导航编辑 | `assets.update` / `replace` 修订多边形或设置内容；实际查询和 motor 步骤在每次活动版本变化时采用一次；即使 sourceDigest 不变，旧路线也在移动前取消 |
| 暂停、取消、替换 | 切换 idle/following；空 setNavigationPath；调用 `setNavigationMesh(world, handle).unwrap()` 后显式重新指定目标 |

路线提供移动意图。`navigationPlugin` 的点跟随直接写入 Transform，不处理碰撞。实体角色使用物理角色入口，按角色完整占地范围设置碰撞体尺寸和烘焙净空，包括缩放及转向。自定义网格查询必须实施相同的身体净空检查；中心格空闲不代表身体能通过。几何编辑需通过各自所属模块更新碰撞几何和导航内容；只更新渲染网格，两者都不会随之更新。

胶囊体缩放、KCC offset、固定顺序、资产新鲜度和限制见[导航契约](../../packages/navigation/README.md)。观察实际位移及阻塞状态；拥塞的局部求解器不是交通调度器。物理控制器不参与点跟随。无效、不可达或预算耗尽结果都不能证明已到达。通过所属 App 的恢复路径重建故障 World。

运行包测试以及契约中的几何、Catalog、真实 KCC、浏览器与 Worker、性能验证流程。可见输出异常且原因不明时，修改着色器或材质之前先用 RHI Debug 捕获真实帧。
