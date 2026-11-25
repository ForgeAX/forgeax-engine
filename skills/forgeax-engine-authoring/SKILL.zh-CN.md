**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具入口为英文 `SKILL.md`。代码示例保持原文。

# ForgeAX Engine 创作

## 游戏工作从这里开始

游戏根目录 `AGENTS.md` 已提供硬规则、默认命令与路由。先用短路径完成第一次正确编辑，不必预读大技能：

0. 能力与边界：先看 [Engine 概览](ENGINE-OVERVIEW.md)，把游戏需求映射到 Engine 能力，识别 Engine 不负责的部分。
1. 签名和导入：先查 [API 索引](references/api-index.md)，再搜 node_modules README 或 .d.ts。
2. 命令见 [`forgeax-engine-cli`](../forgeax-engine-cli/SKILL.zh-CN.md)，相机和灯光见 [`forgeax-engine-render-pipeline`](../forgeax-engine-render-pipeline/SKILL.zh-CN.md)。
3. 交付以游戏根目录 `AGENTS.md` 为准。视觉改动先运行 `forgeax dev look` 查看画面，再运行 playthrough。

### 一个 Engine 插件与一个 HUD 的完整路径

Engine root 构建场景、拥有游戏状态，frontend root 拥有 DOM。二者经 `gameHost.port` 通信，`project play` 读取注册的 projection。每个插件从 `*.pack.ts` 导出为 `kind: 'plugin'` output，再由 `forge.json#roots` 选择，和模板一致。

```ts
import type {} from '@forgeax/engine/app';
import type {} from '@forgeax/engine/assets-runtime';
import { Update, defineSystem } from '@forgeax/engine/ecs';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import type { Plugin } from '@forgeax/engine/plugin';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';

// Engine root: builds the scene, pushes HUD state and exposes a read projection.
export const game: Plugin.Object<{}> = {
  name: 'my-game/engine',
  inject: ['world', 'assets', 'gameHost'],
  apply(ctx) {
    const { world, assets, gameHost: host } = ctx;
    ctx.effect(function* () {
      host!.setPointerLockAllowed?.(false); // cursor-aimed game: no mouse-look lock
      const mesh = assets!.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
      yield () => assets!.release(mesh).unwrap();
      const material = assets!.create(Materials.standard({ baseColor: [0.8, 0.3, 0.2, 1] })).unwrap();
      yield () => assets!.release(material).unwrap();
      const box = world.spawn(
        { component: Transform, data: { pos: [0, 0.5, 0] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      ).unwrap();
      yield () => world.despawn(box).unwrap();
      let score = 0;
      const updateHud = defineSystem({
        name: 'my-game/hud', queries: [],
        fn: () => host!.port?.postMessage({ channel: 'hud', state: { score: ++score } }),
      });
      world.addSystem(Update, updateHud).unwrap();
      yield () => world.removeSystem(Update, updateHud).unwrap();
      const unregister = host!.gameProjection?.registerRead({ id: 'my-game.state', title: 'Score', read: () => ({ score }) });
      if (unregister) yield unregister;
    });
  },
};

// Frontend root: owns the DOM and listens on the same channel.
export const hud: Plugin.Object<{}> = {
  name: 'my-game/hud',
  inject: ['gameHost'],
  apply(ctx) {
    const host = ctx.gameHost!;
    ctx.effect(function* () {
      const port = host.presentationPort ?? host.port;
      const label = host.uiRoot?.appendChild(document.createElement('div'));
      const receive = (event: MessageEvent) => {
        if (event.data?.channel === 'hud' && label) label.textContent = `Score ${event.data.state.score}`;
      };
      port?.addEventListener('message', receive);
      port?.start();
      yield () => { port?.removeEventListener('message', receive); label?.remove(); };
    });
  },
};
```

`forgeax-engine-cli`、`forgeax-engine-render-pipeline`、`forgeax-engine-debug`、`forgeax-engine-material`、`forgeax-engine-app` 是大型参考：搜索所需标题，不要整篇预读；上下文中已有文件直接复用。

<a id="visual-self-review"></a>

## 视觉自查

每次 light/material/fog/camera 编辑后，用 `forgeax dev look --hide-ui true --json` 做 look-dev：对正在运行的 `dev start --headless true` 耗时数秒，等待编辑，仅标记 renderer error 或 flat frame，PNG 由你判断。`project play` 只用于玩法验收。无运行 owner、仅看场景时用 `forgeax asset preview --kind scene --guid <guid> --json`，通过创作相机渲染 SceneAsset。首次查看及交付前打开 PNG，对每项用一句话作答，任何“否”均修复再看：

1. 亮度：是否符合目标时段，白天明亮、夜晚暗而有受光区域，没有爆白或死黑？使用 `--hide-ui true` 判断，菜单遮罩会压暗并掩盖问题。
2. 饱和度：是否达到目标鲜艳程度？发灰发白常来自主体前的雾、冷色 `Skylight` fill 或 AgX。
3. 对比：主体是否突出？平板或空洞背景应添加创作 sky asset 的 `SkyboxBackground` 或场景陈设。
4. 氛围：调色与光照是否匹配温暖、诡异、霓虹、舒适等目标？
5. 构图：主体是否约占半幅，没有近裁剪或遮挡，相机/HUD 不挡主体？跟随相机还要从树、石、墙处于相机与玩家之间的位置观察。
6. 主体：玩家与关键道具是否体现游戏主题？模板角色只是占位机器人，其他英雄应在 `character.pack.ts` 重建网格、材质。

## 前五分钟：先理解，再创作

先看 [Engine 概览](ENGINE-OVERVIEW.md)，了解能做与不能做什么。`forgeax project init`、`forgeax project new` 在 `onboarding.read` 返回本地 `AGENTS.md` 和本技能；阅读入口、在游戏指南选交付范围，仅加载当前所需专题技能/包契约。按需查[能力目录](references/feature-catalog.md)，历史审计快照不等于当前 HEAD 证明或启用清单。

新建或恢复游戏任务，编辑前先读游戏本地 AGENTS，其运行、测试、构建、发布章节选择本地可玩、游戏发布或专门任务。遵循所选范围和停止条件，Engine 包验证不能替代游戏验收。

> [!IMPORTANT]
> 可用不等于启用。Engine 中的能力可供选择；游戏经 `forge.json`、插件组合、ECS 组件、资产、renderer features 或 build 配置才启用它。只安装注册实际使用的能力。

首次编辑前，把需求转成能力采用计划，存入 `docs/engine-plan.md`；每项功能一个块，总计约一页：

```text
Need: <玩家可见或生产需求>
Use: <一项 ForgeAX 能力及其 owner>
Entry: <专题技能、CLI 操作或包 README>
Proof: <测试、资产验证、浏览器证据或包输出>
Defer: <目前不需要的可用能力>
Gap: <Engine 未覆盖的部分及最小手写内容>
```

按各块指定能力构建。对于目录/API 索引已列出的 mesh、camera rig、input、particle、collision、UI、post effect，只有先查无匹配后才可自行实现，标记 `Gap`，保持最小，并在 `docs/feedback.md` 记录。省略计划通常导致重复实现和能力闲置。

| 需求 | 从哪里开始 | 声称可用前的证据 |
|:--|:--|:--|
| 帧循环、执行层级、输入、插件装配 | App，再 ECS 或 State 技能 | 真实浏览器交互；只有游玩无法触及才加单元测试。 |
| Scene、导入文件、代码 Pack、GUID 加载 | Assets；通过 CLI 发现操作 | `asset verify`、构建 catalog、运行时 GUID 加载。 |
| 代码道具、硬表面、套件网格 | Modeling | `m.validate()` closed/volume 事实、导出 MeshAsset、浏览器像素。 |
| PBR、纹理、自定义 WGSL | Material，再 Shader | Shader check、material readiness、浏览器像素。 |
| 湖、波浪、水查询、浮力（显式 opt-in） | [Water](../forgeax-engine-render-pipeline/SKILL.zh-CN.md#water) | 添加交互前先在 completed browser frame 验证湖面。 |
| 光照、阴影、天空、雾、AA、后处理、自定义 pass | Render Pipeline | 请求管线生效与真实 GPU/浏览器证据。 |
| 可编程体积云、云材质实例、移动云影 | [体积云](../forgeax-engine-render-pipeline/SKILL.zh-CN.md#volumetric-clouds) | 材质 adoption 完成、云与阴影可见、时间运动及回退。 |
| 雨雪火花尘火（`Points`、effects/particles-core.md）、GPU 粒子/轨迹/条带/光束 | VFX | 路径选择、cooked effect、运行时播放、浏览器像素。 |
| Body、Collider、角色运动 | Physics | fixed-step/碰撞测试及可玩行为。 |
| BGM、SFX、空间音频 | Audio | Host 播放、intent/cleanup 证据、用户手势处理。 |
| 黑帧、错误 binding、GPU 分歧 | RHI Debug；Debug 路由症状 | 一个 capture artifact、inspect/replay 或配对差分。 |
| 创建、检查、开发；按需 build/preview/package | CLI | 所选游戏交付范围通过。 |

创建前明确模板：所有 3D 游戏用 `forgeax project new <dir> --template game-3d`，其余用 `--template empty`。缺选择返回 `sdk-template-required`。

> [!IMPORTANT]
> `game-3d` 是可运行、有内容的第三人称参考，不是空白 3D 场景。复制到新项目的 scene/physics、character/animation、material/mesh、UI 示例会影响构图、碰撞空间和资产闭包。创建后读生成项目 README，按目标保留、调整、替换或删除初始内容；删除时同步 scene、runtime、Pack 引用。

动画/蒙皮、UI/字体/视频、picking、networking、intelligence、profiler、Remote、自定义 RenderGraph/RHI、源码模式 Engine 开发等少见领域查[完整能力目录](references/feature-catalog.md)，再只读专题技能与 owner README。目录是发现索引，不能替代精确契约。

浏览器截图和本地 Engine 绑定见 CLI 技能对应章节。

默认游戏消费者路径：

```mermaid
flowchart LR
  A["安装 @forgeax/engine"]
  B["阅读 onboarding 路径"]
  C["创建外部游戏"]
  D["选择最小能力集合"]
  E["创作代码与资产"]
  F["测试与资产验证"]
  G["浏览器开发与视觉证据"]
  H["本地可玩交付"]
  I["游戏发布路线"]
  A --> B
  B --> C
  C --> D
  D --> E
  E --> F
  F --> G
  G --> H
  H -. "用户请求发布" .-> I
```

猜测创作操作输入前先运行 `forgeax help --tree --json`，再 `forgeax help <command-path> --json`。命令边界用 CLI 技能。仅用户明确授权当前任务时才启动七阶段 ForgeAX 闭环。

创建项目会检查 `@forgeax/engine` 对应的发布渠道，并返回 `engineUpdate`。每个项目固定自己的引擎版本，升级前先阅读发布说明，再显式升级和验证。

修改引擎时，获取匹配的源码版本并通过 `forgeax project engine use-local` 绑定。打包见[引擎发布流程](../../packages/engine/RELEASING.md)。

## PluginAsset 创作

创建按功能组织的 Pack：小型原生行为可从同文件导出，复杂实现拆到普通 TypeScript module。遵循 [Plugin 契约](../../packages/plugin/README.md)：持久定义在 Pack，schema-v3 项目 `roots` 选择 GUID。用 `asset plugin inspect` 检查 sourceKey/definitions，再检查 native Fiber state 确认激活。代码或配置变化后验证新会话；engine/frontend effects 分别拥有 scene/DOM cleanup。源码复用先读 `help asset source import` 或 `help asset source clone`，转移作者闭包。
