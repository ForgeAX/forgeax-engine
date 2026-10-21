# WebGPU 对齐范围与近期优先级

2026-10-19，参考 Three.js 0.184.0。默认值核对基线为 Engine
`f661ea089de5de070ab8deb74f07a5b08c73a0f2`；本次 UV 支持见下文。
这是一份有版本的审阅记录，参数权威仍是链接中的 schema 和实现。

只对齐 **Three WebGPURenderer 的 WebGPU backend**。WebGLRenderer、WebGL
fallback、WebGL 上下文接口及同步读回桥接不进入待办。Addons 接口移植暂缓；
其 WebGPU 算法仍可作为原生渲染特性的参考。Skylight 保留环境漫反射与环境反射。

## 当前默认行为

> [!NOTE]
> 2026-10-21: Native directional shadows now default to a 200-unit cap.
> Camera clipping and the Three reference defaults remain unchanged.

| 项目 | Three r184 WebGPU | Forgeax 原生 | 当前判断 |
| --- | --- | --- | --- |
| 相机 near / far | 0.1 / 2000 | 0.1 / 2000 | 已对齐。far 是相机裁剪距离，不是阴影贴图尺寸 |
| 曝光 / 色调映射 | 1 / NoToneMapping | 1 / none | 已对齐 |
| 抗锯齿 | 默认关闭 | 默认关闭 | 已对齐；启用算法另行选择 |
| 后处理 | 不隐式添加 Bloom、GTAO 等节点 | Bloom 默认关闭；AO 需显式配置 | 区分裸引擎和显式配置的游戏模板 |
| Bloom 节点参数 | strength=1、radius=0、threshold=0、smoothWidth=0.01 | intensity=1、radius=0、threshold=0、smoothWidth=0.01 | 参数与五层截断高斯已对齐；加入节点才产生效果 |
| Standard | roughness=1、metalness=0、emissiveIntensity=1 | roughness=1、metallic=0、emissiveIntensity=1 | 已对齐 |
| 灯光投影 | 显式开启 | castShadow=false；游戏模板显式开启太阳阴影 | 已对齐裸引擎策略 |
| 网格投射 / 接收阴影 | false / false | 不指定 ShadowParticipation 时为 true / true | 有意区分原生便利行为与 Three 入口的作者值 |
| CSMShadowNode | 3 级；maxFar=100000；覆盖 min(camera.far,maxFar)；fade=false | 3 级；shadowDistance=200；按相机截断；blend=0.2 | Intentional 200-unit default cap; coverage rule matches, cascade blending differs |
| LightShadow 贴图 / 偏移 | 512×512；bias=0、normalBias=0 | 方向光 2048；depthBias=0.00001、normalBias=0.05 | 不能混用传统 WebGL CSM addon 的 2048 默认；修改偏移前验证接触与自阴影 |
| GTAO | 原始 AO；去噪显式连接 DenoiseNode | 已对齐作者默认参数，保留 bilateral 去噪；要求 Deferred | 核心输出、去噪和灯光合成分别比较 |
| Canvas alpha | WebGPURenderer 默认 alpha=true | 原生 Camera.clearColor alpha=0；兼容入口仍拒绝 alpha=true | 属于兼容入口待接通能力，不能沿用 WebGL 的默认结论 |

原生来源：[Camera](../../../packages/render/src/components/camera.ts)、
[DirectionalLight](../../../packages/render/src/components/directional-light.ts)、
[ShadowParticipation](../../../packages/render/src/components/shadow-participation.ts)、
[Standard schema](../../../packages/types/src/material/standard-schema.ts)。
Three 来源：[WebGPURenderer](https://github.com/mrdoob/three.js/blob/r184/src/renderers/webgpu/WebGPURenderer.js)、
[CSMShadowNode](https://github.com/mrdoob/three.js/blob/r184/examples/jsm/csm/CSMShadowNode.js)、
[LightShadow](https://github.com/mrdoob/three.js/blob/r184/src/lights/LightShadow.js)。

## 按风险推进

| 顺序 | 工作 | 风险与边界 | 验收 |
| --- | --- | --- | --- |
| 本批 | 修正 WebGPU 范围和过期默认说明；接通原生可表示的 UV 变换及 WebGPU 相机投影解析 | 低：不改原生材质数据结构、shader、GPU 布局和提交路径 | 原生投影、共享资源稳定性、Three WebGPU 像素对照与 Dawn 回放 |
| 后续小批 | 分别接通已有背景、Fog、阴影参与等作者值 | 逐项检查输出与阴影相机语义；原生有同名能力不代表直接等价 | 每项独立场景、运行时开关及清除、资源释放 |
| 后续 | 完整 UV 仿射、Physical 程序组合和最低 16 纹理预算 | 中：涉及公共材质表达或 GPU 绑定布局；不与本批混合 | 所有坐标消费者、玻璃/清漆真实资产、最低设备能力 |
| 后续 | BRDF 提供方和近光衰减、透明/后处理组合 | 中：会改变画面；固定 WebGPU 输入后分别测量能量和合成 | HDR 数值、运动与反遮挡画面、实际硬件成本 |
| 后续 | 离屏目标/清屏/逐 draw 调度、动画资产、WebGPU 输出管线与公共入口 | 中至高：涉及时序与生命周期，单独设计和验证 | 同帧目标依赖、异步读回、动态资产与恢复 |
| 暂缓 | Addons 接口扩展 | 不影响当前批次交付 | 恢复该项时再按真实项目依赖选择 |

## 本批 UV 支持的准确范围

兼容入口读取 Three 的 UV matrix，映射到现有原生每贴图槽的
offset/rotation/scale。支持平移、非均匀平铺、绕任意中心的等比旋转、镜像，
以及线性部分列向量正交的手动矩阵。零缩放轴也可表示。
坐标变化不要求 `texture.needsUpdate`，不重传图片、不更换采样器，静止帧不发布新值。

Three 的非均匀缩放叠加一般角度旋转可能产生原生模型不可表示的剪切。
此时继续报告结构化错误，保留上次成功投影；不丢掉剪切或烘焙共享图片。
投影矩阵、非有限值和非默认 Matcap 坐标也未开放。

当前兼容入口的历史导出名仍为 `WebGLRenderer`，实际使用 Forgeax WebGPU。
这不是已完成 WebGPURenderer 公共接口对齐的声明；更名和输出合成迁移单独处理。
旧 WebGL API audit 与旧画面记录可保留为历史诊断，不作为 WebGPU 完成率。

既有像素数据见 [Rendering response](RENDERING_RESPONSE.md)。软件 GPU 数据
只证明对应场景正确性，不能推导真实硬件性能。
