# 深度 Agent 反馈 focused 基线

该工程是 M1 的唯一 focused evidence carrier。它提供可发现的 Vite 页面、非纯色 canvas、DOM UI，以及 browser、Dawn、capture 和 Pack transform 入口。

## 运行

```bash
pnpm --filter @forgeax/hello-deep-agent-feedback typecheck
pnpm build:app hello/deep-agent-feedback
pnpm --filter @forgeax/hello-deep-agent-feedback smoke
pnpm --filter @forgeax/hello-deep-agent-feedback smoke:instances
pnpm --filter @forgeax/hello-deep-agent-feedback smoke:capture
```

`fixture` 查询参数用于后续里程碑复用同一个页面入口；它不会创建第二套场景或帧循环 owner。历史 repeat/transform 现象在当前基线没有红证据时必须记录为 `unreproduced`。

`smoke:capture` 是对 DevKit 唯一 browser-compositor owner 的薄包装：它在当前项目
目录执行 `forgeax project capture --backend software --require-ui --deterministic`，并校验相邻
`*.json` 报告中的非纯色 Canvas、已挂载 DOM UI、帧号和零页面错误。可用
`--project <dir>`、`--output <png>` 或 `FORGEAX_CLI=<path>` 指向 SDK 生成的 fresh 项目；
脚本不会自行启动第二个 Vite、浏览器或帧循环。

`smoke:instances` 复用 `hello-gltf-instancing` 的真实 Dawn 测试：将 entity
origin 放在视锥外、将一个 local instance 放回视锥内，验证 CPU 派生 union
与 GPU 逐实例 cull 各自负责可见性；它只报告结构性/渲染通过，不声明硬件 FPS。

## Point-shadow recipe

访问 `?fixture=point-shadow-recipe` 会让同一个页面入口安装
`pointShadowPlugin()`，并在既有 caster/receiver 场景中加入一个
`PointLight + PointLightShadow`。它不另起帧循环或场景 owner；渲染器在
每帧抽取/记录后通过 `inspect().pointShadow` 暴露 atlas admission 事实。

```bash
pnpm --filter @forgeax/hello-deep-agent-feedback smoke:point-shadow
```

这个 smoke 同时运行已有 Chromium cube-array gate，并用同一生产
`constructRuntimeRendererHost` 在 Dawn 上完成至少 300 帧、六面
point-shadow pass、inspection 和非黑 readback 断言。输出中的
`browser`/`dawn`、`frames`、`passCount` 和 `inspection` 是证据字段；本机
或 CI 没有可用 WebGPU 时保留 `failed`/`not-run`，不冒充硬件 FPS。超出
`SHADOW_ATLAS_DEFAULT_LAYERS`、缺少 `storageBuffer`、以及无 shadow 请求
的结构化 falsification 也会随证据输出。
