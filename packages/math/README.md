# @forgeax/engine-math

Pure-function SoA-friendly Vec / Mat / Quat / Color / Euler math library for forgeax-engine.
**branded** `Float32Array` storage — Vec3 ≢ Vec4 ≢ Quat at compile time, zero runtime cost.

## 30-second self-introduction

- **ABI**: `Float32Array & { readonly __<dim>: void }` 七件套（`Vec2 / Vec3 / Vec4 / Quat / Mat3 / Mat4 / Color`）+ `Euler` plain-object；branded 维度互斥（编译期）+ TypedArray 即时上传 GPU（运行期）。
- **Surface**: 19 namespace × 213 函数（vec2:20 / vec3:21 / vec4:18 / mat3:10 / mat4:34 / quat:23 / euler:6 / color:12 / curve3:4 / easing:4 / noise:1 / frustum:4 / ray:9 / ray2:11 / box2:13 / box3:7 / circle2:10 / sphere:5 / f32-to-f16-bytes:1）；单 entry `import { Vec3, vec3, ... } from '@forgeax/engine-math'`。
- **Style**: gl-matrix / wgpu-matrix 风纯函数 namespace + out-param-first（`func(out, ...args)`）；零分配；aliasing-safe（`add(v, v, v)` 合法）。
- **Errors**: 全库静默回退（不抛错、不返回 `null`、不返回 `Result`、不 `console.warn`）；退化语义靠 JSDoc `@degrade` + 本 README §退化策略表 + `*.test-d.ts` 三层共担。

### 30s 上手示例（CPU pre-bake transform → 双投影 clip-space）

```ts
import type { Mat4, Quat, Vec3 } from '@forgeax/engine-math';
import { mat4, quat, vec3 } from '@forgeax/engine-math';

// 1. 建一个三角形顶点 + 双投影矩阵 + 绕 Y 转 45° 的方位四元数
const v: Vec3 = vec3.create(1, 0, 0);
const projWebGL: Mat4 = mat4.perspectiveNO(mat4.create(), Math.PI / 4, 16 / 9, 0.1, 100);     // WebGL [-1,1]
const projReverseZ: Mat4 = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 4, 16 / 9, 0.1, 100); // far→0
const q: Quat = quat.fromAxisAngle(quat.create(), vec3.create(0, 1, 0), Math.PI / 4);

// 2. CPU 端 pre-bake：透视除自动处理 (x/w, y/w, z/w)；w'=0 静默退化为 (0,0,0)
const clip: Vec3 = vec3.create();
mat4.transformPoint(clip, projWebGL, v);          // 同函数体（transformPoint 是 transformVec3 的 alias）
mat4.transformPoint(clip, projReverseZ, v);       // 双投影 smoke：apps/hello/triangle 兑现 dual signal

// 3. 静默回退：零向量 normalize → 零向量（不抛错；调用方如需诊断自建守卫）
vec3.normalize(v, vec3.create(0, 0, 0));          // v = (0, 0, 0)
```

> 上述代码覆盖 v0.1 PBR 渲染管线 90% 的典型 transform / projection / shader-uniform 准备路径——LLM 一次扫读即可拿到 "概念→签名→典型流程" 完整闭包（charter 命题 1）。

## quick-ref：19 namespace × 213 函数

每 namespace 内函数顺序粗略按 "构造 → 比较 → 算术 → 几何 → 高级" 分组。完整签名以 `.d.ts` JSDoc 为 SSOT。

| Namespace | 函数 (n) |
|:--|:--|
| **`vec2`** (20) | `create / clone / copy / set / equals / add / sub / scale / negate / dot / lengthSq / length / distance / normalize / lerp / smoothDamp / catmullRom / min / max / perp` |
| **`vec3`** (21) | `create / clone / copy / set / equals / add / sub / scale / negate / dot / cross / lengthSq / length / distance / distanceSq / normalize / lerp / smoothDamp / catmullRom / min / max` |
| **`vec4`** (18) | `create / clone / copy / set / equals / add / sub / scale / negate / dot / lengthSq / length / distance / normalize / lerp / smoothDamp / min / max` |
| **`mat3`** (10) | `create / clone / identity / equals / multiply / transpose / invert / scale / fromMat4 / normalMatrix` |
| **`mat4`** (34) | `create / view / clone / identity / equals / multiply / transpose / invert / scale / translate / rotate / lookAt / compose / decompose / fromQuat / fromTranslation / fromScaling / fromRotation / perspective / perspectiveNO / perspectiveReverseZ / orthographic / orthographicNO / orthographicReverseZ / transformVec3 / transformPoint / transformDirection / getTranslation / getForward / getUp / getRight / unproject / projectPoint / computeViewProj` |
| **`quat`** (23) | `create / clone / identity / fromAxisAngle / fromEuler / fromRotationMatrix / fromLookAt / fromUnitVectors / multiply / rotateAxis / slerp / nlerp / invert / conjugate / dot / length / lengthSq / normalize / transformVec3 / eulerY / right / up / forward` |
| **`euler`** (6) | `create / clone / set / toQuat / fromQuat / fromRotationMatrix` |
| **`color`** (12) | `create / clone / srgbToLinear / linearToSrgb / rgbToXyzMatrix / rgbGamutMatrix / linearSrgbToLinearDisplayP3 / linearDisplayP3ToLinearSrgb / displayP3ToLinear / fromHex / fromCss / toHex` |
| **`curve3`** (4) | `catmullRom / catmullRomTangent / arcLengths / parameterAtDistance` |
| **`easing`** (4) | `cubicInOut / smoothstep / smootherstep / elasticInOut` — scalar time-remaps (clamp t to [0,1]; Bevy `EaseFunction`; slow-in/slow-out with elastic overshoot). Growable home for further ease variants |
| **`noise`** (1) | `perlin1d` — 1D Perlin noise returning [-1,1]. Deterministic, smooth (nearby inputs → nearby outputs); canonical permutation table matching Bevy's `2d_screen_shake`. Growable home for 2D/3D/Simplex variants |
| **`frustum`** (4) | `create / fromViewProjection / intersectsBox / intersectsSphere` |
| **`ray`** (9) | `create / getOrigin / getDirection / setOrigin / setDirection / rayAabbIntersects / screenToRay / worldToScreen / rayTriangleIntersects` |
| **`ray2`** (11) | `create / getOrigin / getDirection / getMaxDistance / setOrigin / setDirection / setMaxDistance / rayAabbIntersects / rayCircleIntersects / aabbCastIntersects / circleCastIntersects` |
| **`box2`** (13) | `create / fromCenter / fromPoints / center / halfSize / closestPoint / containsPoint / containsBox / intersectsBox / intersectsCircle / merge / grow / shrink` |
| **`box3`** (7) | `create / expandByPoint / containsPoint / intersectsBox / fromPoints / fromPositions / transformBox3` |
| **`circle2`** (10) | `create / fromPoints / toBox / center / radius / closestPoint / containsPoint / intersectsCircle / intersectsBox / merge` |
| **`sphere`** (5) | `create / expandByPoint / containsPoint / intersectsBox / fromPoints` |
| **`f32-to-f16-bytes`** (2) | `f32ToF16Bytes`, `f16ToF32` |

> [!NOTE]
> Surface 由 `packages/math/scripts/count-math-exports.mjs` AST 计数（`node packages/math/scripts/count-math-exports.mjs`）SSOT 派生；表格中函数清单与计数器同步（M5 verify 已锁；surface 增减需同步本表）。

`mat4.view(storage, index = 0)` returns a branded 16-float window of packed `Float32Array` storage. Matrix indices address disjoint windows, including when storage itself has a byte offset; writes share the caller-owned backing buffer. An invalid window follows the math degradation contract and returns a detached zero matrix.

## frustum (feat-20260528-frustum-culling)

View-frustum plane extraction and intersection tests. Planes are extracted from a combined view-projection matrix using the Gribb/Hartmann method. Each plane is stored as 4 f32 (nx, ny, nz, d) with `nx*x + ny*y + nz*z + d > 0` meaning inside the frustum. Import via `frustum` namespace from `@forgeax/engine-math`.

| Function | Signature | Purpose | Notes |
|:--|:--|:--|:--|
| `frustum.create()` | `() => Frustum` | Allocate zero-initialized 6-plane frustum (`Float32Array(24)`) | Local brand `{ readonly __frustum: void }`; zero fill |
| `frustum.fromViewProjection(out, vp)` | `(out: Frustum, vp: Mat4Like) => Frustum` | Extract 6 frustum planes from view-projection matrix | Left/right/bottom/top/near/far in order; each plane auto-normalized internally (D-6) |
| `frustum.intersectsBox(f, box)` | `(f: Frustum, box: Box3Like) => boolean` | Conservative AABB-frustum intersection test | Returns true if box straddles any plane; p-vertex per-plane nearest-point test |
| `frustum.intersectsSphere(f, center, radius)` | `(f: Frustum, center: Vec3Like, radius: number) => boolean` | Conservative sphere-frustum intersection test | Signed-distance per-plane; outside when distance < -radius |

```ts
import { frustum } from '@forgeax/engine-math';
import { mat4 } from '@forgeax/engine-math';

const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
const vp = mat4.create();
mat4.multiply(vp, proj, view);
const f = frustum.fromViewProjection(frustum.create(), vp);

const sceneBox: Box3 = new Float32Array([-2, -2, -2, 2, 2, 2]) as Box3;
if (frustum.intersectsBox(f, sceneBox)) {
  // Object inside or straddling the frustum
} else {
  // Object entirely outside — safe to cull
}
```

## ray (screen/ray/AABB/triangle intersection primitives)

Pure-function ray primitives for screen-ray unprojection, ray-AABB slab intersection, ray-triangle Moller-Trumbore intersection, and world-to-screen projection. Import via `ray` namespace from `@forgeax/engine-math`.

| Function | Signature | Purpose | Notes |
|:--|:--|:--|:--|
| `ray.create(out?, origin?, direction?)` | `(out?, origin?, direction?) => Ray` | Allocate a Ray (6 floats: rx,ry,rz,dx,dy,dz) | Direction auto-normalized; zero-length dir falls back to `(0,0,0)` |
| `ray.screenToRay(out, sx, sy, vpW, vpH, view, proj, kind)` | `(Ray, number, number, number, number, Mat4Like, Mat4Like, 'perspective' \| 'orthographic') => Ray` | Unproject a screen coordinate into a world-space ray | Projection-aware two-point unproject (forward or Reverse-Z, including infinite far); y-flip: DOM y-down to NDC y-up; NaN/Inf input falls back to centre ray |
| `ray.worldToScreen(out, worldPos, viewProj, canvasW, canvasH)` | `(Vec2, Vec3Like, Mat4Like, number, number) => WorldToScreenResult` | Project a world-space point to screen-space pixel coordinates | Returns `{ onScreen, behind }` flags; `behind=true` means the point is behind the camera and `out` is meaningless; degenerate viewport returns `{ onScreen: false, behind: false }` |
| `ray.rayAabbIntersects(r, aabb)` | `(RayLike, Box3Like) => RayAabbResult` | Slab-method ray-AABB intersection | Returns `{ hit, tmin }`; six degenerate cases handled per research Finding 2; NaN-safe edge/corner via `Number.isNaN` guard |
| `ray.rayTriangleIntersects(r, a, b, c)` | `(RayLike, Vec3Like, Vec3Like, Vec3Like) => RayTriResult` | Moller-Trumbore ray-triangle intersection | Returns `{ hit, t, u, v }` (t=ray parameter, u/v=barycentric); double-sided (`abs(det) < epsilon`); degenerate/collinear triangles return `hit=false` to prevent NaN propagation; `t <= 0` rejected (behind ray origin); NaN guard on all inputs |

```ts
import { ray } from '@forgeax/engine-math';
import { mat4 } from '@forgeax/engine-math';

// Screen coordinate to world-space ray (for picking)
const r = ray.create();
ray.screenToRay(r, mouseX, mouseY, canvasW, canvasH, view, proj, 'perspective');

// Ray-AABB intersection (coarse entity culling)
const hit = ray.rayAabbIntersects(r, entityWorldAabb);
if (hit.hit) { /* entity may contain a vertex hit */ }

// Ray-triangle intersection (per-vertex precision)
const tri = ray.rayTriangleIntersects(r,
  [ax, ay, az], [bx, by, bz], [cx, cy, cz]);
if (tri.hit) { /* intersection at origin + tri.t * dir */ }

// World-space point to screen pixel (for vertex distance sorting)
const res = ray.worldToScreen(pixelOut, worldPos, viewProj, canvasW, canvasH);
if (!res.behind) { /* pixelOut holds screen-space (x,y) */ }
```

## 2D bounding volumes (`box2` / `circle2` / `ray2`)

The P12 `bounding_2d` surface maps Bevy's `Aabb2d` and `BoundingCircle` to the
same branded `Float32Array` + out-param idiom as the existing 3D `box3` and
`sphere` namespaces. `box2` stores `[minX, minY, maxX, maxY]`; `circle2` stores
`[centerX, centerY, radius]`; empty point clouds use the same inverted-box or
negative-radius sentinels as their 3D counterparts.

```ts
import { box2, circle2, ray2, vec2 } from '@forgeax/engine-math';

const aabb = box2.fromCenter(box2.create(), [0, 0], [20, 20]);
const circle = circle2.create(35, 0, 12);
const ray = ray2.create(undefined, [-80, 0], [1, 0], 200);

const aabbHit = ray2.rayAabbIntersects(ray, aabb);       // { hit, t }
const circleHit = ray2.rayCircleIntersects(ray, circle); // { hit, t }
const moving = box2.create();
box2.fromCenter(moving, [0, 0], [8, 8]);
const sweepHit = ray2.aabbCastIntersects(ray, moving, aabb);

const center = vec2.create();
box2.center(center, aabb);
```

`ray2.create` normalizes its direction and carries a finite `maxDistance` (the
default is `Infinity`). `ray2.aabbCastIntersects` and
`ray2.circleCastIntersects` use the Minkowski-sum reduction, so a moving volume
is tested without allocating a temporary volume. All boundary contacts are
inclusive; a ray that starts inside a volume returns `{ hit: true, t: 0 }`.

### 跨类型 transform 4 函数（M1 落地，K-1/K-2 撕毁 Three.js 风承诺后由 mat4 / quat 反向 surface 提供）

| 函数 | 签名 | 语义 | 退化 |
|:--|:--|:--|:--|
| `mat4.transformVec3` | `(out, m, v)` | (x,y,z,1) 乘 4×4 + 透视除 | `w' = 0` → `out = (0, 0, 0)` |
| `mat4.transformPoint` | `(out, m, v)` | **alias of `transformVec3`**（OQ-1 裁决，共用函数体） | 同上 |
| `mat4.transformDirection` | `(out, m, v)` | 取左上 3×3（不含平移列），末尾 `vec3.normalize` | `\|out\| = 0` → `out = (0, 0, 0)` |
| `quat.transformVec3` | `(out, q, v)` | Rodrigues 优化 `t=2*cross(q.xyz,v); out=v+q.w*t+cross(q.xyz,t)`（18 mul + 12 add，比绕 mat4 快 3-5×） | `q` 必须单位长，否则隐式缩放；`q=(0,0,0,0)` → `out = v`（公式自然） |

## 命名风格

| 维度 | 风格 | 说明 |
|:--|:--|:--|
| namespace | 全小写 (`vec3`, `mat4`, `quat`) | 借自 **gl-matrix / wgpu-matrix**——LLM 训练语料一致，"猜得对"概率最高（charter 命题 2） |
| 函数名 | 数学英文 camelCase (`fromAxisAngle`, `slerp`) | 1:1 对齐 **wgpu-matrix / Three.js / glam-rs**；与 gl-matrix `setAxisAngle` 偏离取 `from*` 主流形式 |
| out-param | 首位强制 (`func(out, a, b)`) | 与 **gl-matrix** 一致；与 wgpu-matrix `dst?` 末位可选偏离——换得"一致性 > 简短"对 LLM 模仿成本最低 |
| brand 字段 | `__<typename>: void` 双下划线 | `Float32Array & { readonly __vec3: void }`——TS handbook brand idiom；视觉提示"编译期 phantom，运行时禁赋值" |
| NDC 后缀 | 短名 = WebGPU `[0,1]`；`*NO` = WebGL `[-1,1]`；`*ReverseZ` = far→0 / near→1 | 借自 gl-matrix `*NO` 缩写 + wgpu-matrix `*ReverseZ` 风 |

## 退化策略：全库静默回退 + 调用方守卫范式

> [!IMPORTANT]
> 本库**不抛错、不返回 `Result`、不返回 `null` 哨兵、不 `console.warn`**。"错得明" 通过 JSDoc `@degrade` tag + 本节表 + `*.test-d.ts` 类型测试 + property test 共同实现（charter 命题 3）。

### 退化策略表（AC-07 ≥ 8 条；本表 17 条 buffer）

| # | 函数 | 退化输入 | 静默回退值 |
|:--:|:--|:--|:--|
| 1 | `vec*.normalize(out, v)` | `v` 零向量 (`lengthSq < EPS_NORMALIZE`) | `out = (0, ..., 0)` |
| 2 | `vec*.normalize(out, v)` | `v` 含 NaN | NaN 传播（同形向量） |
| 3 | `mat4.invert(out, m)` (D-P1) | `m` singular (`|det| < EPS_DET`) | `out = identity` |
| 4 | `mat4.lookAt(out, eye, target, up)` (D-P17) | `eye === target` | `out = identity` |
| 5 | `mat4.lookAt` `up` 与视线共线 | — | 自动选替代 up |
| 6 | `mat4.decompose` `m` 含 shear | — | 静默尽力分解（与 Three.js 同行为） |
| 7 | `mat4.perspective*` / `*NO` / `*ReverseZ` | `near >= far` 或 `fovy <= 0` 或 `aspect <= 0` | 数值结果未定义但不抛错 |
| 8 | `quat.fromAxisAngle(out, axis, rad)` | `axis` 零向量 | `out = identity` |
| 9 | `quat.fromEuler(out, x, y, z, order)` (D-P2) | `order` 不在 `EulerOrder` | 静默按 `'XYZ'` 计算 |
| 10 | `quat.slerp(out, a, b, t)` (D-P6) | `dot(a, b) ≈ -1` | 取 `b' = -b` 后正常 slerp |
| 11 | `quat.slerp` `dot(a, b) ≈ 1` | — | 退化为 `nlerp` |
| 12 | `quat.fromUnitVectors(out, v, w)` (D-P18) | `v ≈ -w` | 选 axis = (0,1,0) 或 (1,0,0) 做 180° 旋转 |
| 13 | `quat.fromUnitVectors` `v ≈ w` | — | `out = identity` |
| 14 | `color.srgbToLinear(NaN)` / `linearToSrgb(NaN)` | NaN 输入 | NaN 传播 |
| 15 | `color.fromHex(...)` (D-P7) | 非法 hex / `#RGB` 短形式 | `out = (0, 0, 0, 1)` 黑色 |
| 16 | `euler.fromQuat(out, q, order)` | gimbal lock 临界 | 极角附近选取等价分支 |
| 17 | `euler.fromRotationMatrix(out, m, order)` | gimbal lock 临界 | 同 #16 |

### 调用方守卫范式

库内静默；上层调用方需要诊断时**自建** EPSILON 守卫 + `console.warn`（本库不强制，但文档展示一次让 LLM 复用）：

```ts
import type { Vec3 } from '@forgeax/engine-math';
import { vec3 } from '@forgeax/engine-math';

const EPS = 1e-12;
function safeNormalize(out: Vec3, v: Vec3): Vec3 {
  if (vec3.lengthSq(v) < EPS) {
    console.warn('vec3.normalize: zero-length input, returning 0-vec');
  }
  return vec3.normalize(out, v); // 库内静默回退；上层自建诊断
}
```

> [!NOTE]
> 这是"承诺与运行期诊断闭环"——库内静默 + 调用方守卫范式文档化 + JSDoc `@degrade` 含 `@example` 三者合起来满足 charter 命题 3 的"错得明"要求，**不依赖** throw / Result / 库内 `console.warn`。

## 三档 NDC 投影示例

WebGPU / WebGL2 / reversed-Z 各自的投影矩阵选择对应不同的 NDC 约定。本库在命名层显式暴露三档：

```ts
import { mat4 } from '@forgeax/engine-math';

// WebGPU 主路径：clip-z ∈ [0, 1]
const projWebGPU = mat4.perspective(mat4.create(), Math.PI / 4, 16 / 9, 0.1, 100);

// WebGL / OpenGL：clip-z ∈ [-1, 1]（gl-matrix 命名惯例 *NO = Negative-One）
const projWebGL = mat4.perspectiveNO(mat4.create(), Math.PI / 4, 16 / 9, 0.1, 100);

// reversed-Z（深度精度优化：far → 0, near → 1；典型 PBR / 大世界场景）
const projReverseZ = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 4, 16 / 9, 0.1, 100);
```

`orthographic / orthographicNO / orthographicReverseZ` 三档同形，位置参数统一为
`(out, left, right, top, bottom, near, far)`（`orthographicReverseZ` 为本库自创扩展，详见末尾对照表脚注）。

## 非目标（Non-goals）

| 不做 | 原因 |
|:--|:--|
| Three.js 风的 `vec*` 跨类型方法（vec 实例上挂 mat / quat 应用） | K-1/K-2 撕毁 Three.js 风承诺；语义保留——跨类型 transform 由 `mat4.transformVec3 / transformPoint / transformDirection` + `quat.transformVec3` 反向 surface 提供（D-12 撕毁登记，详见 plan-decisions §D-12） |
| `Result<T, E>` / `Option<T>` 包装 | 与 out-param-first + 全库静默回退冲突；charter 命题 3 文本优先错得明靠 JSDoc + `*.test-d.ts` |
| 库内 `console.warn` / 错误码 | 调用方诊断自建（`safeNormalize` 守卫范式）；库 hot-path 零观测开销 |
| `Float64Array` 高精度版 | WebGPU/WebGL2 着色器 uniform 一律 `f32`；高精度计算调用方自行裁剪到 f32 边界 |
| `Vec*.iter()` / 迭代器协议 | TypedArray 已自带；额外封装违反 SoA-friendly 零分配承诺 |
| 矩阵 / 向量的 `toString` 漂亮打印 | 文档面无承诺；调试调用方自行 `Array.from(v)` + `console.log` |

## 路线图

| 版本 | 范围 |
|:--|:--|
| **v0.0 (本闭环)** | 19 namespace × 213 函数（含 mat4 / quat 反向 surface 跨类型 transform 4 函数、2D bounds/raycast/cast，以及 easing 标量缓动 + noise 1D Perlin）；branded ABI；3 档 NDC 投影；M1-M6 全 19 AC pass |
| v0.1 (PBR 闭环) | `mat3.fromMat4Scale` 法线矩阵优化路径；`Color.linearToSRGB` GPU 上传专用变体；高级 PBR 工具 |
| v0.2 (动画闭环) | `quat.squad` Catmull-Rom 球面插值；`euler.lookAt` 自然映射；动画系统消费方向定 |
| v1.0 (稳定 ABI) | 不再 breaking ABI；coverage 阈值不退步；`@forgeax/engine-math` 正式 `npm publish` |

## 与 gl-matrix / wgpu-matrix / glam-rs 对照表

| 概念 | gl-matrix | wgpu-matrix | glam-rs (Rust) | **@forgeax/engine-math** |
|:--|:--|:--|:--|:--|
| 存储 | `Float32Array` | `Float32Array` (`Float32ArrayLike`) | `Vec3 / Mat4` 结构体（栈分配）| `Float32Array & { __vec3: void }` (branded) |
| out-param | `out` 首位 | `dst?` 末位（可省）| 返回值 | `out` 首位（与 gl-matrix 一致） |
| 类型互斥 | 无（`vec3 = vec4` 不报错）| 无 | 编译期靠 Rust 类型 | 编译期靠 brand（`Vec3 ≢ Vec4`） |
| `fromAxisAngle` | `setAxisAngle` | `fromAxisAngle` | `Quat::from_axis_angle` | `quat.fromAxisAngle` (借 wgpu-matrix) |
| `lookAt(eye, target, up)` | `lookAt(out, eye, center, up)` | `lookAt(eye, target, up, dst?)` | `Mat4::look_at_rh(eye, center, up)` | `mat4.lookAt(out, eye, target, up)` |
| WebGPU `[0,1]` | 短名 `perspective` | 短名 `perspective` | 无（Rust glam 走 wgpu/vulkan 风）| 短名 `perspective` |
| WebGL `[-1,1]` | `perspectiveNO` | `perspectiveNO` | — | `perspectiveNO` |
| reversed-Z | 无 | `perspectiveReverseZ` | `Mat4::perspective_infinite_reverse_lh` (近) | `perspectiveReverseZ` |
| **正交 reversed-Z** | 无 | 无 | 无 | `orthographicReverseZ` ⭐ **本库自创扩展** |
| invert(singular) | 返回 `null` | 不定 | `Some(...)` / `None` | 写 `out = identity`，返 `out`（D-P1）|

> ⭐ **`orthographicReverseZ` 为本库自创扩展**——主流三件套均无此函数；用于 reversed-Z 配套的 2D / 大世界正交投影场景（plan-strategy §D-P3）。LLM 调用时知晓此函数无主流对应物，必要时按本库签名调用即可（charter 命题 2 诚实告知）。

## 知识库引用

跨 vendor 阅读认知配套——开发者 / 贡献者 LLM 切换 vendor 时的认知映射：

### Reverse-Z camera consumers

`frustum.fromViewProjection` extracts the WebGPU `0 <= z <= w` volume for
forward and Reverse-Z matrices. Plane slots 4/5 are the lower/upper Z clip
boundaries, respectively; their near/far roles reverse with the projection.
`screenToRay` derives depth direction from the perspective/orthographic
projection and uses an interior unprojection point, so infinite far planes
still produce a finite forward ray. Engine rendering selects the existing
`perspectiveReverseZ` / `orthographicReverseZ` functions; the Math functions
with short names retain their forward-Z mathematical meaning.

## License

Same as workspace root.

## Curves and distance sampling

`vec2.catmullRom` and `vec3.catmullRom` remain **uniform**, fixed tension 0.5,
four-control-point segment kernels. They match Three.js explicit `catmullrom`
mode; Three.js defaults to **centripetal**.

| `curve3` operation | Contract |
|:--|:--|
| `catmullRom(out, points, t, options?)` | Whole path; default centripetal, explicit `uniform` / `chordal`; open extrapolated neighbours or `closed: true` without a duplicate control point. Clamped `t`. |
| `catmullRomTangent(out, points, t, options?)` | Analytic normalized tangent; constant curves write zero. |
| `arcLengths(out, sample)` | Caller-owned cumulative chord-length table; `out.length - 1` controls subdivisions; two Vec3 scratch allocations per build. |
| `parameterAtDistance(lengths, distance)` | Binary-search distance inversion; clamps to endpoints, handles repeated/zero lengths; no allocation. |

```ts
import { curve3, vec3 } from '@forgeax/engine/math';
const controls = [[0, 0, 0], [0.1, 0, 0], [2, 1, 0], [4, 1, 0]];
const sample = (out: vec3.Vec3, t: number) => curve3.catmullRom(out, controls, t);
const lengths = curve3.arcLengths(new Float32Array(4097), sample);
const position = vec3.create();
const travelledDistance = 1;
sample(position, curve3.parameterAtDistance(lengths, travelledDistance));
```

> [!IMPORTANT]
> Arc length is a sampled approximation. Rebuild the explicit table after
> changing controls and converge subdivisions against your distance/speed
> budget. The math owner adds no Scene, camera or animation authority. Inputs
> are finite controls; empty curves write zero, singleton curves are constant,
> and repeated/nearly coincident controls remain finite. Sampling/tangents are
> aliasing-safe and allocate no per-call scratch.
