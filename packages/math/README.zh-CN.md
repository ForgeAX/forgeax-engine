# @forgeax/engine-math

[English](README.md) · **简体中文**

Math 提供适合 SoA 数据的纯函数向量、矩阵、四元数、颜色、曲线、随机流和几何查询。`Vec2`、`Vec3`、`Vec4`、`Quat`、`Mat3`、`Mat4`、`Color` 使用带类型品牌的 `Float32Array`，编译期区分维度，运行时可直接上传 GPU；`Euler` 使用普通对象。

> [!NOTE]
> 本文是中文阅读入口，不是逐段译文。完整函数表、数值退化表和示例见[英文契约](README.md)；准确签名以所属类型声明和 JSDoc 为准。

## 调用约定

写入型函数要求调用方提供输出存储，通常是第一参数 `func(out, ...args)`。函数可以返回同一个 `out`，不会为此分配新结果。输出参数不是可选参数；明确分配对象的工厂函数单独承担分配。

```ts
import { vec3 } from '@forgeax/engine-math';

const value = vec3.create(1, 0, 0);
vec3.add(value, value, value);
```

一般运算允许安全别名，但多个分解输出不得互相重叠。详细命名约定见[命名风格](README.md#naming-style)，完整表见[命名空间与函数索引](README.md#quick-reference-20-namespaces-and-217-functions)。

## 按任务选择

| 任务 | 命名空间与入口 |
|:--|:--|
| 向量、矩阵与旋转 | `vec2`、`vec3`、`vec4`、`mat3`、`mat4`、`quat`、`euler`；见[快速示例](README.md#30-second-example-cpu-transform-baking-to-two-clip-space-projections) |
| 带剪切的仿射变换 | [仿射矩阵](README.md#affine-matrices)：`mat4.compose` 使用 `T * R * H * S`，`decomposeAffine` 通过 QR 分解恢复，反射符号放在 scale Z |
| 颜色 | `color`：sRGB、线性色、Display-P3、十六进制和 CSS 转换；标量 sRGB 传递函数由 Types 提供 |
| 可重复的程序化内容 | [rng](README.md#rng-seeded-procedural-streams)：固定种子在各 JavaScript 引擎中产生相同序列 |
| 视锥剔除 | [frustum](README.md#frustum-feat-20260528-frustum-culling) |
| 屏幕射线与相交 | [ray](README.md#ray-screenrayaabbtriangle-intersection-primitives) |
| 二维包围体与形状投射 | [box2、circle2、ray2](README.md#2d-bounding-volumes-box2--circle2--ray2) |
| 曲线和距离采样 | [curve3](README.md#curves-and-distance-sampling) |
| 缓动与噪声 | `easing`、`noise`；见[完整索引](README.md#quick-reference-20-namespaces-and-217-functions) |

`mat4.view(storage, index)` 返回调用方缓冲区中的 16 浮点矩阵窗口，索引以矩阵计数。窗口写入共享原缓冲区；无效窗口按数值退化契约返回脱离原存储的零矩阵。

`ray.create` 和 `ray2.create` 分别初始化调用方提供的六浮点和五浮点存储。不要把这些写入函数当作隐式分配工厂。

## 投影与失败边界

投影区分 WebGL `[-1, 1]`、常规 `[0, 1]` 与 Reverse-Z。按目标和相机契约选择对应函数，不在渲染外层手动补深度映射。详见[三种 NDC 投影](README.md#three-ndc-projection-conventions)与[Reverse-Z 相机消费者](README.md#reverse-z-camera-consumers)。

Math 的退化输入按文档静默返回约定值，不抛异常、不返回 `Result`，也不发警告。例如零向量归一化得到零向量。需要拒绝输入的调用方先做守卫，见[退化表](README.md#degenerate-inputs-silent-fallback-and-caller-guards)与[守卫示例](README.md#caller-guard-pattern)。

`decomposeAffine` 遇到奇异、非仿射或 Float32 无法表达的输入时返回 `false`，不改变输出。普通 `decompose` 保留既有尽力分解 TRS 的语义，两者不能互换。

范围与对比见[非目标](README.md#non-goals)、[库对比](README.md#comparison-with-gl-matrix--wgpu-matrix--glam-rs)、[参考资料](README.md#knowledge-references)和[许可证](README.md#license)。
