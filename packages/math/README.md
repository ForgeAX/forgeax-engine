<!-- LANG-SWITCH -->
**Language**: **English** · [简体中文](README.zh-CN.md)

# @forgeax/engine-math

Pure-function SoA-friendly Vec / Mat / Quat / Color / Euler math library for forgeax-engine.
**branded** `Float32Array` storage — Vec3 ≢ Vec4 ≢ Quat at compile time, zero runtime cost.

Color delegates scalar sRGB transfer functions to `@forgeax/engine-types`, a declared runtime dependency built before Math. Math retains its negative-channel and alpha behavior.

## Affine matrices

`mat4.compose(out, position, rotation, scale, shear?)` composes `T * R * H * S`.
H has unit diagonal and dimensionless upper-triangular XY, XZ, YZ shear entries;
omission retains the ordinary TRS path. `mat4.decomposeAffine(position, rotation,
scale, shear, matrix)` recovers this representation using QR decomposition and
puts a reflection sign on scale Z. It returns false without changing outputs
for singular, non-affine or Float32-unrepresentable input. The homogeneous W
coefficient must round to 1 at native Float32 precision, admitting inversion
roundoff from double-precision sources. Both routines retain
caller-owned output storage; decomposition outputs must not overlap each other.
`mat4.decompose` retains its existing best-effort TRS semantics.

Functions that write output storage require the caller to provide it. Returning that same
output is supported and does not allocate another result. Output parameters must
not be optional or fall back to newly allocated storage. Pure allocation factories
without an output parameter remain explicit allocation sites. `ray.create` and
`ray2.create` initialize caller-provided six/five-float storage respectively.

## 30-second self-introduction

- **ABI**: Seven `Float32Array & { readonly __<dim>: void }` types (`Vec2 / Vec3 / Vec4 / Quat / Mat3 / Mat4 / Color`) plus plain-object `Euler`. Brands prevent dimension mixing at compile time; TypedArrays upload directly to the GPU at runtime.
- **Surface**: 20 namespaces and 217 functions (vec2:20 / vec3:21 / vec4:18 / mat3:10 / mat4:35 / quat:23 / euler:6 / color:12 / curve3:4 / easing:4 / noise:1 / frustum:4 / ray:9 / ray2:11 / box2:13 / box3:7 / circle2:10 / sphere:5 / f32-to-f16-bytes:3 / rng:1), through one entry: `import { Vec3, vec3, ... } from '@forgeax/engine-math'`.
- **Style**: Pure-function namespaces in the gl-matrix / wgpu-matrix style, with mandatory first-position output parameters (`func(out, ...args)`), zero allocation and safe aliasing (`add(v, v, v)` is valid).
- **Errors**: Silent fallback throughout: no throws, `null`, `Result` or `console.warn`. Degenerate behavior is documented by JSDoc `@degrade`, this README's fallback table and `*.test-d.ts`.

### 30-Second Example (CPU Transform Baking to Two Clip-Space Projections)

```ts
import type { Mat4, Quat, Vec3 } from '@forgeax/engine-math';
import { mat4, quat, vec3 } from '@forgeax/engine-math';

// 1. Create a triangle vertex, two projection matrices and a 45-degree Y quaternion.
const v: Vec3 = vec3.create(1, 0, 0);
const projWebGL: Mat4 = mat4.perspectiveNO(mat4.create(), Math.PI / 4, 16 / 9, 0.1, 100);     // WebGL [-1,1]
const projReverseZ: Mat4 = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 4, 16 / 9, 0.1, 100); // far→0
const q: Quat = quat.fromAxisAngle(quat.create(), vec3.create(0, 1, 0), Math.PI / 4);

// 2. CPU baking includes perspective division (x/w, y/w, z/w); w'=0 yields (0,0,0).
const clip: Vec3 = vec3.create();
mat4.transformPoint(clip, projWebGL, v);          // transformPoint aliases transformVec3.
mat4.transformPoint(clip, projReverseZ, v);       // Dual-projection smoke: apps/hello/triangle.

// 3. Normalizing a zero vector silently yields zero; callers add diagnostic guards.
vec3.normalize(v, vec3.create(0, 0, 0));          // v = (0, 0, 0)
```

> This example covers 90% of typical v0.1 PBR transform, projection and shader-uniform preparation paths, connecting concepts, signatures and workflows in one read (charter proposition 1).

## Quick Reference: 20 Namespaces and 217 Functions

Within each namespace, functions roughly follow construction, comparison, arithmetic, geometry and advanced operations. Complete signatures are authoritative in `.d.ts` JSDoc.

| Namespace | Functions (n) |
|:--|:--|
| **`vec2`** (20) | `create / clone / copy / set / equals / add / sub / scale / negate / dot / lengthSq / length / distance / normalize / lerp / smoothDamp / catmullRom / min / max / perp` |
| **`vec3`** (21) | `create / clone / copy / set / equals / add / sub / scale / negate / dot / cross / lengthSq / length / distance / distanceSq / normalize / lerp / smoothDamp / catmullRom / min / max` |
| **`vec4`** (18) | `create / clone / copy / set / equals / add / sub / scale / negate / dot / lengthSq / length / distance / normalize / lerp / smoothDamp / min / max` |
| **`mat3`** (10) | `create / clone / identity / equals / multiply / transpose / invert / scale / fromMat4 / normalMatrix` |
| **`mat4`** (35) | `create / view / clone / identity / equals / multiply / transpose / invert / scale / translate / rotate / lookAt / compose / decompose / decomposeAffine / fromQuat / fromTranslation / fromScaling / fromRotation / perspective / perspectiveNO / perspectiveReverseZ / orthographic / orthographicNO / orthographicReverseZ / transformVec3 / transformPoint / transformDirection / getTranslation / getForward / getUp / getRight / unproject / projectPoint / computeViewProj` |
| **`quat`** (23) | `create / clone / identity / fromAxisAngle / fromEuler / fromRotationMatrix / fromLookAt / fromUnitVectors / multiply / rotateAxis / slerp / nlerp / invert / conjugate / dot / length / lengthSq / normalize / transformVec3 / eulerY / right / up / forward` |
| **`euler`** (6) | `create / clone / set / toQuat / fromQuat / fromRotationMatrix` |
| **`color`** (12) | `create / clone / srgbToLinear / linearToSrgb / rgbToXyzMatrix / rgbGamutMatrix / linearSrgbToLinearDisplayP3 / linearDisplayP3ToLinearSrgb / displayP3ToLinear / fromHex / fromCss / toHex` |
| **`curve3`** (4) | `catmullRom / catmullRomTangent / arcLengths / parameterAtDistance` |
| **`easing`** (4) | `cubicInOut / smoothstep / smootherstep / elasticInOut` — scalar time-remaps (clamp t to [0,1]; Bevy `EaseFunction`; slow-in/slow-out with elastic overshoot). Growable home for further ease variants |
| **`noise`** (1) | `perlin1d` — 1D Perlin noise returning [-1,1]. Deterministic, smooth (nearby inputs → nearby outputs); canonical permutation table matching Bevy's `2d_screen_shake`. Growable home for 2D/3D/Simplex variants |
| **`rng`** (1) | `create` — seeded sfc32 stream `Rng { seed, next, int, range, pick, fork }` for deterministic procedural content; see [rng](#rng-seeded-procedural-streams) |
| **`frustum`** (4) | `create / fromViewProjection / intersectsBox / intersectsSphere` |
| **`ray`** (9) | `create / getOrigin / getDirection / setOrigin / setDirection / rayAabbIntersects / screenToRay / worldToScreen / rayTriangleIntersects` |
| **`ray2`** (11) | `create / getOrigin / getDirection / getMaxDistance / setOrigin / setDirection / setMaxDistance / rayAabbIntersects / rayCircleIntersects / aabbCastIntersects / circleCastIntersects` |
| **`box2`** (13) | `create / fromCenter / fromPoints / center / halfSize / closestPoint / containsPoint / containsBox / intersectsBox / intersectsCircle / merge / grow / shrink` |
| **`box3`** (7) | `create / expandByPoint / containsPoint / intersectsBox / fromPoints / fromPositions / transformBox3` |
| **`circle2`** (10) | `create / fromPoints / toBox / center / radius / closestPoint / containsPoint / intersectsCircle / intersectsBox / merge` |
| **`sphere`** (5) | `create / expandByPoint / containsPoint / intersectsBox / fromPoints` |
| **`f32-to-f16-bytes`** (3) | `f32ToF16`, `f32ToF16Bytes`, `f16ToF32` |

> [!NOTE]
> The surface derives from AST counts in `packages/math/scripts/count-math-exports.mjs` (`node packages/math/scripts/count-math-exports.mjs`). Keep the function inventory and counter synchronized when changing the surface (M5 verification).

`mat4.view(storage, index = 0)` returns a branded 16-float window of packed `Float32Array` storage. Matrix indices address disjoint windows, including when storage itself has a byte offset; writes share the caller-owned backing buffer. An invalid window follows the math degradation contract and returns a detached zero matrix.

## rng (seeded procedural streams)

`rng.create(seed: number | string): Rng` returns a deterministic stream: the same
seed yields the same sequence on every JavaScript engine, so Pack builds and
"same seed, same world" games reproduce exactly. Use it instead of `Math.random()`
in any generator whose output must be repeatable.

| Member | Result | Notes |
|:--|:--|:--|
| `seed` | uint32 | Seed identity this stream derives from |
| `next()` | float in [0, 1) | Multiples of 2^-32 |
| `int(min, max)` | integer in [min, max] | Inclusive; bounds round inward; empty interval returns `ceil(min)` |
| `range(min, max)` | float in [min, max) | |
| `pick(items)` | element or `undefined` | `undefined` only for an empty array |
| `fork(label)` | child `Rng` | Derived from `seed` and `label` only: independent of parent draw position, does not advance the parent |

Algorithm: sfc32 (128-bit state, Small Fast Chaotic generator) seeded by four
splitmix32 outputs. String seeds and fork labels hash with FNV-1a over UTF-16
code units plus the murmur3 fmix32 finalizer. All steps are int32 arithmetic, so
output is platform-independent. Number seeds follow ToUint32 (`seed >>> 0`):
fractions and bits above 2^32 are dropped and NaN / Infinity become 0; pass a
string for wider seeds. The seed space is 32 bits; it identifies worlds, it is
not a cryptographic source.

```ts
import { rng } from '@forgeax/engine/math';

const world = rng.create('island-7');
const trees = world.fork('trees'); // adding a 'rocks' fork later never shifts trees
for (let i = 0; i < 40; i++) placeTree(trees.range(-50, 50), trees.range(-50, 50));
const biome = world.pick(['forest', 'desert', 'tundra'] as const);
```

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
| `ray.screenToRay(out, sx, sy, vpW, vpH, view, proj)` | `(Ray, number, number, number, number, Mat4Like, Mat4Like) => Ray` | Unproject a screen coordinate into a world-space ray | Projection-aware two-point unproject (forward or Reverse-Z, including infinite far); y-flip: DOM y-down to NDC y-up; NaN/Inf input falls back to centre ray |
| `ray.worldToScreen(out, worldPos, viewProj, canvasW, canvasH)` | `(Vec2, Vec3Like, Mat4Like, number, number) => WorldToScreenResult` | Project a world-space point to screen-space pixel coordinates | Returns `{ onScreen, behind }` flags; `behind=true` means the point is behind the camera and `out` is meaningless; degenerate viewport returns `{ onScreen: false, behind: false }` |
| `ray.rayAabbIntersects(r, aabb)` | `(RayLike, Box3Like) => RayAabbResult` | Slab-method ray-AABB intersection | Returns `{ hit, tmin }`; six degenerate cases handled per research Finding 2; NaN-safe edge/corner via `Number.isNaN` guard |
| `ray.rayTriangleIntersects(r, a, b, c)` | `(RayLike, Vec3Like, Vec3Like, Vec3Like) => RayTriResult` | Moller-Trumbore ray-triangle intersection | Returns `{ hit, t, u, v }` (t=ray parameter, u/v=barycentric); double-sided (`abs(det) < epsilon`); degenerate/collinear triangles return `hit=false` to prevent NaN propagation; `t <= 0` rejected (behind ray origin); NaN guard on all inputs |

```ts
import { ray } from '@forgeax/engine-math';
import { mat4 } from '@forgeax/engine-math';

// Screen coordinate to world-space ray (for picking)
const r = ray.create(new Float32Array(6));
ray.screenToRay(r, mouseX, mouseY, canvasW, canvasH, view, proj);

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
const ray = ray2.create(new Float32Array(5), [-80, 0], [1, 0], 200);

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

### Four Cross-Type Transform Functions (M1, mat4 / quat Surface After K-1/K-2)

| Function | Signature | Semantics | Degenerate behavior |
|:--|:--|:--|:--|
| `mat4.transformVec3` | `(out, m, v)` | Multiply (x,y,z,1) by a 4x4 matrix and apply perspective division | `w' = 0` yields `out = (0, 0, 0)` |
| `mat4.transformPoint` | `(out, m, v)` | **Alias of `transformVec3`**, sharing its implementation (OQ-1) | Same as above |
| `mat4.transformDirection` | `(out, m, v)` | Use the upper-left 3x3 without translation, then `vec3.normalize` | `\|out\| = 0` yields `out = (0, 0, 0)` |
| `quat.transformVec3` | `(out, q, v)` | Optimized Rodrigues formula: `t=2*cross(q.xyz,v); out=v+q.w*t+cross(q.xyz,t)` (18 multiplications and 12 additions, 3-5x faster than via mat4) | `q` must have unit length to avoid implicit scale; `q=(0,0,0,0)` naturally yields `out = v` |

## Naming Style

| Dimension | Style | Rationale |
|:--|:--|:--|
| Namespace | Lowercase (`vec3`, `mat4`, `quat`) | Matches **gl-matrix / wgpu-matrix** and familiar LLM training examples (charter proposition 2). |
| Function | Mathematical English camelCase (`fromAxisAngle`, `slerp`) | Matches **wgpu-matrix / Three.js / glam-rs**; prefer the common `from*` form over gl-matrix's `setAxisAngle`. |
| Output parameter | Mandatory first position (`func(out, a, b)`) | Matches **gl-matrix**. Consistency over brevity reduces imitation costs compared with wgpu-matrix's optional last `dst?`. |
| Brand field | Double underscore `__<typename>: void` | `Float32Array & { readonly __vec3: void }` follows the TypeScript handbook brand idiom: a compile-time phantom, never assigned at runtime. |
| NDC suffix | Short name: WebGPU `[0,1]`; `*NO`: WebGL `[-1,1]`; `*ReverseZ`: far to 0 / near to 1 | Follows gl-matrix `*NO` and wgpu-matrix `*ReverseZ`. |

## Degenerate Inputs: Silent Fallback and Caller Guards

> [!IMPORTANT]
> The library **never throws, returns `Result` or a `null` sentinel, or logs `console.warn`**. JSDoc `@degrade`, this table, `*.test-d.ts` and property tests jointly make failures understandable (charter proposition 3).

### Fallback Table (AC-07 Requires At Least 8 Entries; 17 Listed)

| # | Function | Degenerate input | Silent fallback |
|:--:|:--|:--|:--|
| 1 | `vec*.normalize(out, v)` | Zero vector (`lengthSq < EPS_NORMALIZE`) | `out = (0, ..., 0)` |
| 2 | `vec*.normalize(out, v)` | `v` contains NaN | Propagate NaN in the same vector shape |
| 3 | `mat4.invert(out, m)` (D-P1) | `m` singular (`|det| < EPS_DET`) | `out = identity` |
| 4 | `mat4.lookAt(out, eye, target, up)` (D-P17) | `eye === target` | `out = identity` |
| 5 | `mat4.lookAt` with `up` collinear with the view direction | - | Automatically choose an alternative up |
| 6 | `mat4.decompose` with shear in `m` | - | Best-effort decomposition, matching Three.js |
| 7 | `mat4.perspective*` / `*NO` / `*ReverseZ` | `near >= far`, `fovy <= 0` or `aspect <= 0` | Undefined numerical result, without throwing |
| 8 | `quat.fromAxisAngle(out, axis, rad)` | Zero `axis` | `out = identity` |
| 9 | `quat.fromEuler(out, x, y, z, order)` (D-P2) | `order` outside `EulerOrder` | Use `'XYZ'` silently |
| 10 | `quat.slerp(out, a, b, t)` (D-P6) | `dot(a, b) ≈ -1` | Set `b' = -b`, then slerp normally |
| 11 | `quat.slerp` with `dot(a, b) ≈ 1` | - | Fall back to `nlerp` |
| 12 | `quat.fromUnitVectors(out, v, w)` (D-P18) | `v ≈ -w` | Choose axis (0,1,0) or (1,0,0) for a 180-degree rotation |
| 13 | `quat.fromUnitVectors` `v ≈ w` | — | `out = identity` |
| 14 | `color.srgbToLinear(NaN)` / `linearToSrgb(NaN)` | NaN | Propagate NaN |
| 15 | `color.fromHex(...)` (D-P7) | Invalid hex / short `#RGB` form | Black: `out = (0, 0, 0, 1)` |
| 16 | `euler.fromQuat(out, q, order)` | Near gimbal lock | Choose an equivalent branch near the pole |
| 17 | `euler.fromRotationMatrix(out, m, order)` | Near gimbal lock | Same as #16 |

### Caller Guard Pattern

The library stays silent. Callers needing diagnostics add their own EPSILON guard and `console.warn`. This optional pattern is shown for reuse:

```ts
import type { Vec3 } from '@forgeax/engine-math';
import { vec3 } from '@forgeax/engine-math';

const EPS = 1e-12;
function safeNormalize(out: Vec3, v: Vec3): Vec3 {
  if (vec3.lengthSq(v) < EPS) {
    console.warn('vec3.normalize: zero-length input, returning 0-vec');
  }
  return vec3.normalize(out, v); // Silent fallback; diagnostics belong to the caller.
}
```

> [!NOTE]
> Silent library behavior, documented caller guards and JSDoc `@degrade` examples together satisfy charter proposition 3's understandable-failure requirement, without throws, Result or library logging.

## Three NDC Projection Conventions

WebGPU, WebGL2 and reversed-Z use different NDC conventions, exposed explicitly in function names:

```ts
import { mat4 } from '@forgeax/engine-math';

// Main WebGPU path: clip-z in [0, 1].
const projWebGPU = mat4.perspective(mat4.create(), Math.PI / 4, 16 / 9, 0.1, 100);

// WebGL / OpenGL: clip-z in [-1, 1]; gl-matrix's *NO means Negative-One.
const projWebGL = mat4.perspectiveNO(mat4.create(), Math.PI / 4, 16 / 9, 0.1, 100);

// Reversed-Z: far to 0, near to 1, for PBR / large-world depth precision.
const projReverseZ = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 4, 16 / 9, 0.1, 100);
```

`orthographic / orthographicNO / orthographicReverseZ` share the positional signature
`(out, left, right, top, bottom, near, far)`. `orthographicReverseZ` is a library-specific extension; see the comparison note below.

## Non-Goals

| Excluded | Reason |
|:--|:--|
| Three.js-style cross-type `vec*` methods applying matrices/quaternions on vectors | K-1/K-2 dropped that surface; semantics remain through `mat4.transformVec3 / transformPoint / transformDirection` and `quat.transformVec3` (plan-decisions D-12). |
| `Result<T, E>` / `Option<T>` wrappers | Conflict with mandatory first-position output parameters and silent fallback. JSDoc and `*.test-d.ts` document failures (charter proposition 3). |
| Library `console.warn` / error codes | Callers own diagnostics (`safeNormalize`); library hot paths incur no observation overhead. |
| High-precision `Float64Array` variants | WebGPU/WebGL2 shader uniforms use `f32`; callers doing high-precision work convert at the f32 boundary. |
| `Vec*.iter()` / iterator protocol | TypedArrays already provide it; wrappers violate the SoA-friendly zero-allocation contract. |
| Pretty matrix/vector `toString` | No such API is promised; callers can use `Array.from(v)` and `console.log`. |

## Roadmap

| Version | Scope |
|:--|:--|
| **v0.0 (initial delivery)** | 19 namespaces, 214 functions, including four mat4/quat cross-type transforms, 2D bounds/raycast/cast, scalar easing and 1D Perlin noise; branded ABI; three NDC conventions; M1-M6 passed all 19 acceptance criteria. |
| v0.1 (PBR) | `mat3.fromMat4Scale` normal-matrix optimization, GPU-upload-specific `Color.linearToSRGB`, advanced PBR helpers. |
| v0.2 (animation) | `quat.squad` Catmull-Rom spherical interpolation, natural `euler.lookAt` mapping; direction follows animation consumers. |
| v1.0 (stable ABI) | No further ABI breaks, no coverage regression, official `@forgeax/engine-math` npm publication. |

## Comparison With gl-matrix / wgpu-matrix / glam-rs

| Concept | gl-matrix | wgpu-matrix | glam-rs (Rust) | **@forgeax/engine-math** |
|:--|:--|:--|:--|:--|
| Storage | `Float32Array` | `Float32Array` (`Float32ArrayLike`) | Stack-allocated `Vec3 / Mat4` structs | `Float32Array & { __vec3: void }` (branded) |
| Output parameter | First `out` | Optional last `dst?` | Return value | First `out`, matching gl-matrix |
| Type separation | None (`vec3 = vec4` allowed) | None | Rust compile-time types | Compile-time brands (`Vec3 ≢ Vec4`) |
| `fromAxisAngle` | `setAxisAngle` | `fromAxisAngle` | `Quat::from_axis_angle` | `quat.fromAxisAngle`, following wgpu-matrix |
| `lookAt(eye, target, up)` | `lookAt(out, eye, center, up)` | `lookAt(eye, target, up, dst?)` | `Mat4::look_at_rh(eye, center, up)` | `mat4.lookAt(out, eye, target, up)` |
| WebGPU `[0,1]` | Short `perspective` | Short `perspective` | No direct equivalent (Rust glam follows wgpu/Vulkan conventions) | Short `perspective` |
| WebGL `[-1,1]` | `perspectiveNO` | `perspectiveNO` | — | `perspectiveNO` |
| Reversed-Z | None | `perspectiveReverseZ` | `Mat4::perspective_infinite_reverse_lh` (similar) | `perspectiveReverseZ` |
| **Orthographic reversed-Z** | None | None | None | `orthographicReverseZ`, **library-specific extension** |
| invert(singular) | Returns `null` | Unspecified | `Some(...)` / `None` | Writes `out = identity`, returns `out` (D-P1) |

> **`orthographicReverseZ` is a library-specific extension.** None of the three comparison libraries provides it. It supports reversed-Z 2D / large-world orthographic projection (plan-strategy D-P3). Use this library's signature when needed; there is no mainstream direct equivalent (charter proposition 2).

## Knowledge References

Cross-vendor conceptual mappings for developers and contributor LLMs:

### Reverse-Z camera consumers

`frustum.fromViewProjection` extracts the WebGPU `0 <= z <= w` volume for
forward and Reverse-Z matrices. Plane slots 4/5 are the lower/upper Z clip
boundaries, respectively; their near/far roles reverse with the projection.
`screenToRay` derives depth direction from the perspective/orthographic
projection matrix and uses an interior unprojection point, so infinite far planes
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

`halfFloat` owns CPU binary16 encoding and decoding for import, uploads and readback.
Scalar and bulk encoding first round to float32, then round to the nearest binary16
value with midpoint ties away from zero. Signed zero, subnormals, infinity and
quiet NaN are preserved; overflow becomes signed infinity.

Color conversion uses the Types IEC sRGB transfer functions. The Math Color API
keeps its existing negative-channel pass-through policy; alpha is unchanged.
