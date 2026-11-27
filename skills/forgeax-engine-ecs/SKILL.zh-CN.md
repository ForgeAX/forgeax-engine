**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具入口为英文 `SKILL.md`。示例代码保留原文。

# forgeax-engine-ecs

> World 模拟调度中，`Update` 处理可变频率工作，`FixedUpdate` 处理固定频率工作。注册时先传 schedule token，再用 `world.update(deltaSeconds)` 推进二者。非模拟领域（renderer）用 `defineSchedule(name)` 声明阶段，显式 `world.run(token)` 执行，不推进时间。

## 一屏起步

```ts
import { defineSystem, FixedUpdate, Time, Update, World, defineComponent } from '@forgeax/engine-ecs';

const Position = defineComponent('Position', { x: 'f32' });
const Velocity = defineComponent('Velocity', { x: 'f32' });
const world = new World({ time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4 } });

world.addSystem(Update, defineSystem({
  name: 'integrate-variable',
  queries: [{ write: [Position], read: [Velocity] }],
  fn: (current, [moving]) => {
    const delta = current.getResource(Time).delta;
    for (const row of moving) {
      row.mut(Position).x += row.get(Velocity).x * delta;
    }
  },
})).unwrap();

world.addSystem(FixedUpdate, defineSystem({
  name: 'simulate-fixed',
  queries: [],
  fn: () => { /* deterministic fixed-rate work */ },
})).unwrap();

world.update(1 / 60).unwrap();
```

保留的 Query 也支持同步 `query.forEach(row => { ... })`，复用借用 cursor，不另分配 iterator。只在回调内读 row，不能挂起或保留。回调失败关闭遍历且不推进 temporal observation，拒绝同 Query 重入。数值 kernel 使用 batch/span；需要挂起遍历或提前退出时使用已有 row iterator。

`Time`、`FixedTime` 由 World 拥有，系统只读，host 不能直接写。owner 包向已有 scratch 读取数值时，使用 `@forgeax/engine-ecs/world-read` 的 `world[worldRead].copyArray`：解析 live row，返回当前 count；字段缺失或 target 不足则返回 undefined 且不写。inline field 避免临时 row view，variable field 保留 live pool lookup。普通玩法继续使用 World/Query。

## Cordis 拥有生命周期，ECS 执行热路径

`createWorldContext(world, plugins?)` 创建原生 DeepSeek Cordis realm，`worldPlugin(world)` 提供唯一 World service。插件用 `ctx.effect` 安装/移除系统、资源、simulation participants、resource descriptors、transform publishers。Context 不复制 component、query row、frame data。

```ts
import { Update, createWorldContext } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

const movementPlugin: Plugin = {
  name: 'movement',
  inject: ['world'],
  apply(ctx) {
    ctx.effect(() => {
      ctx.world.addSystem(Update, Movement).unwrap();
      return () => ctx.world.removeSystem(Update, Movement).unwrap();
    });
  },
};

const context = await createWorldContext(world, [movementPlugin]);
await context.fiber.restart();
```

Fiber 决定 ECS 贡献是否存在；`world.update(deltaSeconds)` 仍直接执行 schedules、queries、SoA access、Commands。不能在系统内查询 Context，也不能把逐实体或逐帧数据注册为 service。

## 保存的路径与按距离跟随

在 World realm 安装 `@forgeax/engine/path` 的 `pathPlugin()`。普通 keyed SceneAsset 中创作 `Path`、`PathFollower`，通过 Pack/GUID 交付。`FixedUpdate` 在 Scene propagation 前推进带符号 world-unit distance。物理实体选择 desired motion，增加 `DesiredPathPose`，由现有 motor 消费。轴、缩放、重新导入、封闭错误恢复见 [Path README](../../packages/path/README.md)。使用独立 accuracy/World performance gates；真实 Pack/browser/RHI 证据见 [path-follow](../../apps/perf/path-follow)。

## 曲线驱动关节链

`@forgeax/engine/animation/spline-ik` 提供由普通保存 `Path` 驱动的明确 root-to-tip chain。在 Scene、Animation 旁安装 `splineIKPlugin()`；保存的 `SplineIK` 实体引用限定当前实例。base-pose 系统放在 `SplineIKRestore` 与 `SplineIKSolve` 之间，Scene/Skin 消费提交的 Transform pose。length/axes/twist/scale/stale-binding 失败见 [Animation 契约](../../packages/animation/README.md#spline-ik)，真实验收状态见[冻结资格记录](../../scripts/dev-verify/roi-24-spline-ik/README.md)。rig 组合由所属 owner 负责，未验证的同关节 spring/physical 顺序不是隐含 Engine service。

## Shared Kernel

独立加载模块同时拥有 query 与具名函数：

```ts
import { defineComponent, type QuerySpan } from '@forgeax/engine/ecs';
export const Position = defineComponent('Position', { x: 'f32' });
function integrate(spans: readonly QuerySpan[]): void {
  for (const span of spans) span.mut(Position).x.fill(1);
}
export default { queries: [{ write: [Position] }], run: integrate } as const;
```

生产者导入模块，复用声明：

```ts
import { Update } from '@forgeax/engine/ecs';
import { defineSharedKernel } from '@forgeax/engine/ecs/shared';
import kernelModule from './movement-kernel';
world.addSystem(Update, defineSharedKernel(kernelModuleUrl, {
  ...kernelModule,
  name: 'integrate-shared',
})).unwrap();
```

Worker binding 携带 query/component slot，不是 component name。同名不同 component 无权访问已声明 component 列。

只有选定的 shared Engine realm 使用 `World({ storage: 'shared' })`。Kernel 必须是独立可加载的具名模块函数，带明确 read/write descriptor 和 numeric table field。optional、change-detection、sparse、object、DOM、GPU、structural access 均不适用。小工作和 dispatch 前 pool 失败走 inline；可能发生 shard write 后任何失败都会 poison World，禁止重试。恢复属于 `app.execution.rebuild()`，不能在旧 World 身份上修改恢复。

## 按 schedule 注册

调度变更的第一个参数是 schedule token。`Update`、`FixedUpdate` 是 nominal token，不是字符串。

```ts
import {
  FixedUpdate,
  Update,
  defineSystem,
  defineSystemSet,
} from '@forgeax/engine-ecs';

const Gameplay = defineSystemSet({ name: 'gameplay' });
const Movement = defineSystem({ name: 'movement', queries: [], fn: () => {} });
const Cleanup = defineSystem({ name: 'cleanup', queries: [], fn: () => {} });

world.addSystem(Update, Movement).unwrap();
world.addSystems(Update, Gameplay, [Movement, Cleanup]).unwrap();
world.removeSystem(Update, Cleanup).unwrap();
world.replaceSystem(Update, Movement, {
  queries: [],
  fn: () => {},
}).unwrap();
```

系统归属由注册时选择的 schedule 决定。`after: [FixedUpdate]`、`before: [FixedUpdate]` 仅用于 Update 内固有 fixed-anchor edge，不能用它们替代注册时 schedule 选择。

### 领域 schedule

非模拟 owner（renderer 的 Render World）通过 `defineSchedule('Name')` 声明阶段，以 token 注册，`world.run(token)` 执行。仅空诊断名被拒绝；同名 token 仍不同。run 只排序自己的 schedule、flush 自己的 commands，不推进 Time，也不由 world.update 驱动。游戏代码使用 Update/FixedUpdate。

## 时间策略与资源

```ts
import { FixedTime, Time, World } from '@forgeax/engine-ecs';

const world = new World({
  time: {
    fixedDeltaSeconds: 1 / 60,
    maxStepsPerUpdate: 4,
    maxDeltaSeconds: 0.1,
  },
});

world.update(0.2).unwrap();
const variable = world.getResource(Time);
const fixed = world.getResource(FixedTime);

console.log(variable.delta, variable.elapsed, variable.maxDeltaSeconds);
console.log(fixed.delta, fixed.tick, fixed.maxStepsPerUpdate);
console.log(fixed.droppedSeconds, fixed.droppedUpdates);
```

`world.update(deltaSeconds)` 验证 finite 非负 delta，按 maxDeltaSeconds clamp，运行 Update 一次，以固定增量排空 FixedUpdate。达到 cap 无法完整追赶时，`FixedTime.droppedSeconds`、`droppedUpdates` 报告丢弃工作，它们是可观察指标，不是错误或 App 级 clamp。

可变积分读 `Time.delta`，绝对时间行为读 `Time.elapsed`，确定性固定模拟读 `FixedTime.delta`。手动 World 可用 `world.update(0)` 运行零 delta 帧。

后端 completion fence 仅在 update 驱动、`catchUp: 'substeps'` 的 FixedUpdate 内使用 `deferFixedStep(world, completion)`，resolve 前采用后端结果。ECS 保留余下 systems、commands、原始 catch-up budget；reject/poison 丢弃保留 commands，不重试部分工作。系统保持同步，不跨边界保留借用 query/arena view。World.run 和 aggregate catch-up 不支持 deferral。见 [ECS 调度契约](../../packages/ecs/README.md#schedules-time-and-resources)。

## 范围错误与 Result

每次 schedule mutation、world.update、world.run 都返回 Result，按封闭 code 联合处理：

```ts
const result = world.addSystem(Update, fixedOnlySystem);
if (!result.ok) {
  switch (result.error.code) {
    case 'schedule-scope-mismatch':
      console.error(result.error.hint);
      break;
  }
}
```

`schedule-scope-mismatch` 表示引用的 system/set/fixed anchor 属于其他 schedule，依赖系统及 set 应处于同一 scope。有效空 domain 运行成功且无工作。

## 数值工作区生命周期

update/run 内同步 scratch 使用 `world.frameArena.alloc(TypedArrayConstructor, count)`，读取前初始化元素。scratch 跨 fixed tick/command drain 保留，在外层 scope 关闭时过期。`withFrameArena` 可分组连续同步 domain runs，不能跨 await、yield、transport、snapshot、GPU completion 携带。系统/scope 返回 Promise 或 iterator 会 poison World；挂起工作交给其现有 owner。

跨帧系统数值 buffer 用 `world.buffers.alloc/view/resize/release`；release 绑定真实插件 owner。独立完成 reader 借用 lease；owner release 使 storage 退役，最后一个 lease 归还后才可复用。resize 要求无 active lease；raw slot 复用不能复活旧 public grant。组件保留 schema/World 写路径。预算、trim、借用 view 限制、观测覆盖见 [ECS 内存契约](../../packages/ecs/README.md#numeric-memory-services)。

## Query 模型

唯一构造入口 `world.query(descriptor)` 返回 `Result<Query, QueryCreationError>`。

| 角色 | 含义 | Row 访问 |
|:--|:--|:--|
| read | 必需数据、只读意图 | `row.get(Component)` |
| write | 必需数据、修改意图 | `row.mut(Component)` |
| optional | 数据可能不存在 | get 返回值或 undefined |
| with / without | 仅过滤存在性 | 不授权数据访问 |
| changed / added | Query 拥有的观测过滤 | 不额外授权数据 |

标准遍历为 `for...of query`。QueryRow 短暂有效，在循环内消费；后续要身份时保留 `row.entity`。结构修改以结构化 ECS error 使 active iteration 失效。

```ts
const query = world.query({ read: [Health], with: [Enemy] }).unwrap();
for (const row of query) console.log(row.entity, row.get(Health).value);
```

`query.spans()` 只用于 dense table-only descriptor，optional/sparse 返回 `query-span-unavailable`；changed/added 支持且只产出匹配的连续区间。span 列为零复制、短暂 TypedArray view，structure epoch 变化后失效。

含 sparse membership 或 optional numeric data 的只读 query 用 `query.batches().unwrap()`。`read(Component, field)`、`stride(Component, field)` 暴露原始物理列。range batch 按 `start <= row < end`，indexed batch 按 `rows[0..count)` 有效前缀；entity/column 均用物理 row 索引。每 batch 解析一次 optional 列，undefined 表示缺失，零是有效值。当前 batch 明确拒绝 write/changed/added descriptor，保留其 row/span/projection 路径。read/index array 均借用，raw loop 禁止结构修改。保留 Query validation 可减少重复 setup allocation，但 traversal/batch allocation 仍存在。

关系 source 可通过 World.set、row mutation 写，使 ECS owner 原子更新 source、物化 target list、backpointer。关系 target 为只读投影。numeric writable span/internal derived writer 只拒绝 write set 中的关系 source/target；只列在 read 的关系仍适用（Scene 读取 ChildOf、写 GlobalTransform）。关系变化用 row 或 World source 写。liveness/cycle/capacity/version/epoch 失败在提交关系事实前由 owner 报告。

```ts
const query = world.query({ write: [Position], read: [Velocity] }).unwrap();
for (const span of query.spans().unwrap()) {
  const position = span.mut(Position).x;
  const velocity = span.get(Velocity).x;
  for (let i = 0; i < span.length; i++) position[i] = (position[i] as number) + (velocity[i] as number);
}
```

成对工作通过 `Array.from(query, row => row.entity)` 收集 handle，在所属系统中按 `i < j` 遍历。

## 存储选择

defineComponent 默认 table，除非 token 明确声明零字段 sparse tag。

```ts
const Enemy = defineComponent('Enemy', {});
const Selected = defineComponent('Selected', {}, { storage: 'sparse' });
```

数据组件和稳定身份 tag 用 table；频繁切换 membership 才用 sparse。sparse tag 仍参与 archetype identity、hooks、cardinality、scene round-trip、inspection、普通 row query；仅 sparse membership 不同的 archetype 共享物理 Table。

sparse tag 无字段，只能放 with/without/changed/added，不能放 read/write/optional。sparse predicate 使 spans 返回 `query-span-unavailable`、reason `sparse-component`，可用时选只读 numeric batches，语义/写入/时间访问用 row。可写 relationship source/target 使 spans/internal derived writer 返回同码、reason `relationship-component`；用 World.set、row.mut、structural commands 原子保持 mirror。`Disabled` 始终为 table tag。

### 数组字段：替换或写区间

World.set 将 array<T> 字段整体替换，成本 O(length)。例如只移动 Instances.transforms 的一行，用窗口原位写：

```ts
world.setArrayRange(entity, Instances, 'transforms', row * 16, matrix).unwrap();
```

长度不变，resize 用 set。越界或非数组字段返回 `array-range-out-of-bounds` 且不修改。消费者用 `@forgeax/engine-ecs/projection` 的 `readArrayRangesChangedSince(world, entity, component, field, since)`，得到 epoch 后合并元素区间，历史不能证明则返回 `'whole'`。renderer 用它使移动一行从 O(N) 变为 O(1)。全字段写报告 whole，不保留区间历史。

多实体 O(changes) 热循环用 setArrayRange 或 scalar set；每帧切换 membership 用 sparse tag，不用 table tag。

## 必需组件

组件 schema 只声明一次固有结构依赖：

```ts
const GlobalTransform = defineComponent('GlobalTransform', { world: 'array<f32, 16>' });
const Transform = defineComponent('Transform', { x: 'f32' }, {
  requires: [GlobalTransform],
});
```

World.spawn、World.addComponent、延迟 Commands materialization 在结构边界传递展开 requires。显式 required component data 优先，缺失身份仅追加一次。这是通用 ECS 行为，scene/import helper 直接依赖，系统不逐帧修补扫描。移除 requirement 不级联；显式这么做的 owner 在下次使用收到所属领域结构化 invariant error。

## 系统与结构修改

系统接收 owning World、持久 Query 元组、deferred Commands。结构修改用 commands，schedule 在定义边界 flush。

```ts
import { Update, defineComponent, defineSystem } from '@forgeax/engine-ecs';

const Health = defineComponent('Health', { value: 'f32' });
world.addSystem(Update, defineSystem({
  name: 'remove-dead',
  queries: [{ read: [Health] }],
  fn: (_world, [health], commands) => {
    for (const row of health) {
      if (row.get(Health).value <= 0) commands.despawn(row.entity);
    }
  },
})).unwrap();
```

Commands.spawn 与 World.spawn 使用相同 `{ component, data }` 条目，返回 pending handle。flush 前验证整批，pending row 只 materialize 一次：

```ts
const pending = commands.spawn(
  { component: Transform, data: { pos: [0, 0, 0] } },
  { component: ChildOf, data: { parent } },
);
void pending;
```

通用 exclusive relationship 的便利签名显式传入关系组件及 source-field data：`world.reparent(child, newParent, RelationshipSource, sourceData)`。sourceData 必须把该 schema source field 设为 newParent，两项均必需。`world.set(child, RelationshipSource, data)` 或 exclusive addComponent 走同 owner 路径。

预期 command/preparation 失败不损坏 World，修正输入后可重试。可能已写 row/derived range 后发生未知异常会 poison World，应停用并由 app.execution.rebuild() 创建替代，不能重试旧身份。

schema/storage/relationship/reflection/errors 见 `packages/ecs/README.md`、`packages/ecs/src/`。调度 token-first，query 构造只有一个入口，无兼容 overload。

## 可见性检查起步

```ts
const render = await _import('@forgeax/engine/render');
const query = world.query({ read: [render.Visibility] }).unwrap();
for (const row of query) console.log(row.get(render.Visibility).state);
const effective = render.resolveVisibility(world).effective(entity);
```

| 观测 | 读取位置 | 不能推断 |
|:--|:--|:--|
| 当前值 | QueryRow.get、Visibility.state | 最终是否参与渲染 |
| 生效值 | resolveVisibility(world) | Camera/picking 状态 |
| 无效写入 | Result.error.code、expected、hint、detail | 不能只看 message |

写失败时用反射枚举标签选合法值，再重试 World.set。effective resolution 报层级诊断时先修 scene relation。App host 仅传输 JSON-safe reflection，ECS 仍拥有组件。

renderer culling、camera、picking、app lifecycle、assets、VFX shadow policy 不在此范围，各自交给 owning package skill。

## Mobility 声明

`@forgeax/engine/scene` 的 `Mobility { kind }` 声明实体是否移动，缺省为 movable。永不移动的已放置关卡几何写 static，运行时生成保持 movable。

```ts
world.spawn(
  { component: Transform, data: {} },
  { component: Mobility, data: { kind: MobilityKindValue.static } },
);
const stop = subscribeMobilityDiagnostics((w, d) => console.log(d.code, d.detail.entity));
```

| 错误码 | 原因 | 修复 |
|:--|:--|:--|
| mobility-static-moved | static 实体 Transform 在声明帧后改变 | 改为 movable；期间渲染仍正确。 |
| mobility-invalid-kind | MeshFilter 实体设置 stationary，它只用于灯 | 用 static 或 movable。 |
| mobility-physics-conflict | static 搭配 dynamic/kinematic RigidBody | 声明 movable，或把 body 设 static。 |

每个 `(World, code, entity)` 只报告一次，含 detail.entity；创作 scene 成员还含 detail.sceneEntityRef。Mobility/RigidBody 不相互推导。详见 Scene README 的 Mobility。

## Render capture 创作边界

CubeCamera/ReflectionProbe 与 Transform 配对，是 ECS 创作事实，携带 update intent、bounds、stable revision，不携带 GPU resource。render owner 推导六面 camera、target generation、有界 PMREM 工作、material selection、recovery。target/source/readback token 与 FrameReceipt observation 保持在 Renderer 契约，不能加到 World component。

## Resource 身份

owner 模块只声明一次 `const Score = defineResource<number>('Score')`。用 world.insertResource(Score, 0)、world.getResource(Score)，token 决定值类型。直接传 resource/system 对象，名称仅用于诊断。对每 World factory 产生的系统排序，用导出 SystemSet 对象。
