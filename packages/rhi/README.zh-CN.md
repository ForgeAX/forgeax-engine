# @forgeax/engine-rhi

[English](README.md) · **简体中文**

RHI 是与具体后端无关的图形接口。它定义不透明句柄、资源描述符、命令、能力和结构化错误；不负责场景、数学或业务策略。

> [!NOTE]
> 本文是中文阅读入口，不是逐段译文。完整接口、能力矩阵与示例见[英文契约](README.md)。

## 接口与能力

| 主题 | 完整契约 |
|:--|:--|
| 设计约束 | [RHI 原则](README.md#charter-propositions-ai-users-read-agentsmd-rhi-guidance-first) |
| 不透明资源身份 | [句柄](README.md#opaque-handles-no-prefix) |
| 设备、队列与命令 | [七个主要接口](README.md#7-main-interfaces-rhi-prefixed--operation-verb-mixins) |
| WebGPU 描述符投影 | [描述符](README.md#descriptor-projections-pickgpuxxxdescriptor---explicitundefined)与[显式 undefined 桥接](README.md#explicitundefined-bridge) |
| 能力读取 | [三层能力](README.md#capabilities-tri-layer)、[RhiCaps 索引](README.md#capabilities--source-backed-rhicaps-index)、[查询矩阵](README.md#query-capability-matrix) |
| 结构化失败 | [闭合错误码](README.md#error-model--22-member-closed-rhierrorcode) |

根据实际设备能力决定可用路径。接口存在不表示某个格式、采样数、storage 用途或硬件查询已被接纳；不支持时必须返回明确失败，不能伪造成功。

## 管线与命令

管线源码和编译动作分别由所属模块拥有；构建时和运行时诊断消费同一份事实，不靠猜测着色器名称决定策略。

| 任务 | 完整契约 |
|:--|:--|
| 定位管线生产者 | [管线源码与动作所有权](README.md#pipeline-source-and-action-ownership) |
| 观察编译 | [管线编译检查](README.md#pipeline-compilation-inspection) |
| 录制命令 | [渲染命令状态](README.md#render-command-state) |
| 重用命令 | [Render Bundle](README.md#render-bundles) |
| 上传缓冲区 | [上传语义](README.md#buffer-upload-semantics) |
| 复制纹素 | [纹素复制资源](README.md#texel-copy-resources) |

## 呈现与格式证据

| 场景 | 完整契约 |
|:--|:--|
| 显示目标 | [显示目标](README.md#display-target) |
| 多画布合成 | [画布合成能力](README.md#canvas-composition-capabilities) |
| 输出色彩空间 | [画布色彩空间](README.md#canvas-colour-space) |
| 外部纹理和视频 | [纹理互操作与零复制](README.md#texture-interop-and-zero-copy-video) |
| 多重采样 | [MSAA 回执](README.md#multisample-render-receipt) |
| r32float Mip | [采样与渲染回执](README.md#r32float-mip-sampled-render-receipt)、[采样与 storage 回执](README.md#r32float-mip-sampled-storage-receipt) |
| 硬件光线查询 | [Hardware Ray Query](README.md#hardware-ray-query) |

格式证据需要匹配实际设备、操作和资源用途，见[可机器读取的格式证据](README.md#ai-readable-format-evidence)。RhiNull 和 CPU 命令检查不能代替 GPU 像素、时间或实际设备能力证据。

## 继续阅读

接口演化遵循[演化契约](README.md#evolution-contract)和[升级路径](README.md#upgrade-path)。使用示例见[完整试用路径](README.md#ai-user-trial-charter-proposition-1-5-walk)。

相关包：[Render](../render/README.zh-CN.md)、[WGPU WASM](../wgpu-wasm/README.zh-CN.md)。
