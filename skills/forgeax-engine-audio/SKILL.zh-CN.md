**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具入口为英文 `SKILL.md`。

# forgeax-engine-audio

ForgeAX 跨 realm 的 ECS 音频，播放由 Host 所有。适用于 BGM/SFX、空间监听器与总线、Worker 音频传输，以及解码和清理诊断。

> **玩法拥有 `AudioSource`；Host 拥有 `AudioContext`。** `@forgeax/engine-audio` 在所有执行层级产生相同的封闭音频意图；`@forgeax/engine-audio-webaudio` 在 Host realm 消费它们。

## 起步

```ts
import { createApp } from '@forgeax/engine-app/browser';
import { createHostAudioConsumer } from '@forgeax/engine-audio-webaudio';
import {
  AUDIO_ENGINE_RESOURCE_KEY,
  AudioListener,
  AudioSource,
  audioPlugin,
  type AudioBackend,
  type AudioClipAsset,
} from '@forgeax/engine-audio';

const created = await createApp(canvas, { plugins: [audioPlugin()] }, {
  createHostAudio: options => createHostAudioConsumer(undefined, options),
});
if (!created.ok) throw created.error;
const app = created.value;

const loaded = await app.renderer.assets.load(clipGuid, 'audio');
if (!loaded.ok) throw loaded.error;
const clip = loaded.value;

app.world.spawn({
  component: AudioSource,
  data: {
    clip,
    playing: true,
    loop: true,
    volume: 0.8,
    spatialBlend: 0,
    bus: 'music',
  },
}).unwrap();

const backend = app.world.getResource(AUDIO_ENGINE_RESOURCE_KEY);
backend.setBusVolume('music', 0.3);
app.start().unwrap();
```

为空间 `AudioSource` 实体附加 `Transform`，为相机实体附加 `AudioListener`。场景传播提供发声位置及归一化的本地 -Z 方向；姿态变化通过相同 POD 路径到达待解码任务和暂停的 panner。通过源上的 `coneInnerAngle`、`coneOuterAngle`、`coneOuterGain` 设置方向性增益。源无 Transform 时，空间播放使用原点和 -Z。插件在 Transform 传播后同步监听器，以九个数字标量发送位置、前方及上方。

## Realm 契约

| 所属方 | 数据 | 规则 |
|:--|:--|:--|
| ECS World | `AudioSource`、`AudioListener`、playing 边沿、源与监听器姿态 | 跨 realm 的玩法权威 |
| Engine Worker | `createAudioIntentBackend()` 和逐帧意图批次 | 不持有 Web Audio 对象；首次播放携带有界字节或流索引，后续播放复用 owner/handle/revision 发布 |
| Host | `createHostAudioConsumer()` 和 `WebAudioEngine` | 拥有解码缓存、`AudioBuffer`、节点、总线、手势恢复和 `AudioContext` |
| Kernel Worker | 无 | 音频不属于 Shared Kernel |

`main-serial`、`engine-worker` 和 `shared` 使用同一 `audioPlugin()` 及意图词汇。App 报告在 `app.execution.report().audio` 投影 Host 状态。Worker 查询观察最后获准的 Host 快照；收到反馈前返回 `unavailable`，活动数量为 null。不要根据不可用观察诊断自动播放。Host 音频在延迟创建 Context 前监听首次手势；借用的 Context 仍由调用方所有。使用可信浏览器输入验证手势顺序；验证自动播放策略时，不传入放宽自动播放限制的启动参数。

## 组件与控制

| 接口 | 用途 |
|:--|:--|
| `AudioSource.playing` | false → true 播放，true → false 停止；重播一次性声音前先切为 false |
| `AudioSource.paused` / `playbackRate` | 暂停保留位置；正速度倍数也改变音高 |
| `AudioSource.fromPosition` / `AudioBackend.seek(entityId, seconds)` | 从已解码片段的指定秒数开始；编辑只 seek 一次；显式 backend seek 支持重复相同请求和待解码状态 |
| `AudioSource.loop` / `volume` / `bus` | 源播放和已接受的总线 ID 路由 |
| `AudioSource.coneInnerAngle` / `coneOuterAngle` / `coneOuterGain` | 完整锥角，单位度，以及外部增益；播放时采样，默认全向 |
| `AudioSource.spatialBlend` | `0` 直接路由总线；大于 `0` 创建 panner |
| `AudioListener` | 首个监听器实体上的标记，其世界 Transform 驱动姿态 |
| `AcousticRegion` | 保存的盒或球区域：最高优先级归一化源路由，加独立的首监听器 wet/send 覆盖；先配置现有总线和效果引用。本地混合单位、容量及恢复见 Audio 契约 |
| `AudioBackend` | 源音量、总线音量与静音、状态、活动数量及销毁 |

## 片段与异步安全

`AudioClipAsset` 是 POD：缓冲字节或经过验证的 PCM16 流描述。播放接受资产所属方与 handle；所属方提供 revision。Host 按 owner/handle/revision 缓存，`sourceKey` 保留为来源信息。每次播放和音乐准备使用固定内容；编辑影响后续播放，不使已有声部失效。停止、实体替换和释放会隔离待完成解码。实现自定义传输时，保留 Host 发布拒绝反馈，使重播可以重新发布被拒绝的字节。

默认预算不适合工程时，通过 `createHostAudioConsumer(engine, options)` 设置 Host 缓存预算；单位及拒绝行为由 `packages/audio-webaudio/README.md` 定义。总线设置在首次 Context 创建之前也生效。

通过 `backend.getState().lastError` 或 `app.execution.report().audio.lastError` 检查解码或 Context 恢复失败。消费 `.code`、`.expected`、`.hint`、`.detail`，不解析 message。

声音不可闻时，先证明预期角色确实触发了 playing 边沿，且拥有有效片段。再检查 Host Context 与错误状态、源生命周期、总线、静音、音量、发声者与监听器姿态及距离衰减。叠加枪声前先测试独立源；保持同一源位置对比监听器朝向。资产已加载、活动源数量或控制台零错误，都不证明实际可闻。

## 清理

`app.stop()` 只停止帧调度。`app.dispose()` 排空 Cordis realm，并恰好释放一次 Host consumer：停止源、断开节点、清除源和待播放映射、移除手势监听器、关闭 Context。中毒 World 不再持续产生意图。显式 Worker 重建创建全新 Host consumer，旧异步解码任务无法影响新 World 身份。

## 权威来源

| 契约 | 所属模块 |
|:--|:--|
| 组件、插件、意图联合、tick、backend 协议 | [`packages/audio/README.md`](../../packages/audio/README.md) |
| Host 解码、缓存、节点实现 | [`packages/audio-webaudio/README.md`](../../packages/audio-webaudio/README.md) |
| App 执行选择及报告 | [`forgeax-engine-app`](../forgeax-engine-app/SKILL.zh-CN.md) |
| 资产 GUID 加载 | [`forgeax-engine-assets`](../forgeax-engine-assets/SKILL.zh-CN.md) |

## 模拟参与者

使用跨 realm 的音频参与者提供可移植的意图和状态证据。ECS 拥有 `record`、`restore`、固定 tick 的 `trace`、语义 `report`、数字 `tolerance` 和封闭 `error` 值。Host consumer 仍拥有 `AudioContext`、`AudioBuffer`、源节点和清理。

仅通过 App、Preview 或 Remote 暴露检查摘要。按 `code` / `expected` / `hint` / `detail` 诊断，再用全新目标重试。这不是 RHI tape 或游戏重放接口。

## Host 滤波与频谱控制

使用 `webAudioPlugin(engine)` 和一个 Host `WebAudioEngine`，提供原生用户滤波及显式选择的频率分析。解码后，`setFilters` 拥有有序链；`createAnalyser` 准入 FFT 大小，`readFrequencyData` 将 dB 写入调用方复用的缓冲，暂停时也写入静音数据。这些原生控制保留在 Host。所有权、边界、失败和借用 Context 规则见[包契约](../../packages/audio-webaudio/README.md#source-controls-and-spectrum)。

## 配置总线与长音频

通过 `AudioBackend.configureBuses` 声明一个无环 parent/send 图，再将源 `bus` ID 路由进去。使用 Host 的 `WebAudioEngine.setBusEffects` 安装共享原生链；接受图之前读取其 Result 和 backend 状态。支持的 PCM16 WAV 在源 Meta 中设置 `importSettings.playback: 'stream'`，通过普通 GUID 加载。验证 Range 服务、`getStreamState` 和 `AudioState.streaming`；播放请求或活动源数量本身不是输出证据。边界、格式及恢复见 [Host 契约](../../packages/audio-webaudio/README.md#long-audio-through-source-meta-and-guid)。

通过 `AppHostAdapter.createHostAudio` 安装共享 Host 图，包括没有 bootstrap 的本地 App。将解析后的 options 转给 `createHostAudioConsumer(engine, options)`，每次重建返回全新 consumer。玩法保留 `audioPlugin()`；生成的 `GameHost.audio` 指向同一 consumer 的 engine。旧 execution 字段在 0.7 失效；同时提供两字段会被拒绝。遵循[组装契约](../../packages/audio-webaudio/README.md#app-host-effect-assembly)。

## 量化分层音乐

保存有界 `MusicScore`，包含 BPM、拍号、循环拍数和普通缓冲片段 GUID。通过公开 `loadMusicScore` 解析，再在 Host 音频工厂调用 `consumer.prepareMusic(requestId, preparedScore)`。每次重建为全新 consumer 准备。玩法通过 `AudioBackend.music` 在拍或小节边界发送完整 stem 增益向量，并消费 `AudioState.music.receipts`；scheduled 回执表示原生准入，applied 回执观察共同 Context 目标。Worker 命令只携带 POD 控制，不能准备编码字节或原生缓冲。

后续 mix、cancel、pause、resume、tempo 控制使用返回的 epoch。迟到请求显式拒绝或移至下一边界。速度变化保留节拍相位并改变音高；不支持流式 stem 和时间拉伸。边界、目标回执、生命周期及普通公开示例见 [Audio 音乐契约](../../packages/audio/README.md#quantized-layered-music)和 [Host 传输契约](../../packages/audio-webaudio/README.md#native-musical-transport)。不要创建第二个 Context、时钟或逐 stem 游戏定时器。
