# parity-forgeax

> Right fixture for the three.js pixel-parity bench (feat-20260512-threejs-pixel-parity-bench).
> Renders a static unlit cube via `@forgeax/engine-runtime` + ECS (D-P5 case C unlit path
> via `PBR_FALLBACK_WGSL` constant-shading) so it can be diff'd pixel-for-pixel against
> the left fixture in `apps/parity/threejs`.

## Top-line proposition (AI users start here)

> **Prereq**: `pnpm install && pnpm -r build` (first time, or after any
> `@forgeax/engine-*` workspace change). Without the engine packages built,
> the vite Rolldown step at runner entry will fail with
> `failed to resolve @forgeax/engine-ecs` (and friends).

```bash
pnpm bench:pixel-parity   # one command, no args; root npm script
```

What it is: the **right half** of the forgeax-vs-threejs pixel-parity bench
plus the **evaluator SDK** for embedded use. Two complementary surfaces:

| Surface | Entry | Use case |
|:--|:--|:--|
| Browser fixture | `window.__captureRight(): Uint8Array(512 * 512 * 4)` after one `renderer.draw(world)` frame | runner consumes via `scripts/bench/pixel-parity.mjs` |
| Evaluator SDK | `import { evaluateParity } from '@forgeax/parity-forgeax/evaluate-parity'` | custom runners / unit tests: `(leftPixels, rightPixels, opts) -> Result<ParityVerdict, MetricError>` |

Three grep-friendly entrypoints (no README scan needed):

| AI user grep target | What it reveals |
|:--|:--|
| `package.json#forgeax.metrics.bench.pixelDiff.threshold` | declared Layer B integer cap (currently `256`) |
| `package.json#exports['./evaluate-parity']` | SDK entry path (TS thin re-export from `src/evaluate-parity.ts`) |
| `MetricErrorCode` in `packages/types/src/index.ts` | 6-member closed union; the new pixel-parity members carry `ParityThresholdDetail` / `ParityCaptureDetail` discriminated variants |

How to bump the threshold (only path; no manual override):
edit `package.json#forgeax.metrics.bench.pixelDiff.threshold` in a dedicated PR.
Both fixtures declare the same `threshold = 256` independently — the runner reads either side.

## Mid-section detail

### Fixture 8-dimension lock (D-P6) + cross-fixture alignment

| # | Dimension | Locked value | Three.js side (apps/parity/threejs) | ForgeAX side (this) |
|:-:|:--|:--|:--|:--|
| 1 | Canvas | 512 x 512 | `CANVAS_W` / `CANVAS_H` | same constants |
| 2 | Material color | linear `[204/255, 102/255, 51/255]` (`#cc6633`) | `MeshBasicMaterial({color})` | `MeshRenderer.baseColor` |
| 3 | Camera fov | `Math.PI / 4` (45 deg) | `PerspectiveCamera(fov, ...)` | `Camera.fov = Math.PI / 4` |
| 4 | Camera aspect | `1.0` | square canvas | `Camera.aspect = 1.0` |
| 5 | Camera z | `3` | `camera.position.z = 3` | `Transform.position[2] = 3` |
| 6 | Cube rotation | `(0.3, 0.5, 0)` static | one-shot Euler XYZ | Euler -> quaternion converted at spawn, no per-frame delta |
| 7 | premultipliedAlpha | `true` | `WebGLRenderer({premultipliedAlpha: true})` | `canvas.getContext('webgpu').configure({alphaMode: 'premultiplied'})` |
| 8 | ColorSpace lock | r184 default `SRGBColorSpace` | implicit | canvas format `'rgba8unorm-srgb'` (GPU does linear -> sRGB at framebuffer attach, no shader-side encode) |

### D-P5 case C unlit lighting branch

- `0` directional-light components spawned -> `RenderSystem` walks the 0-light branch.
- Shader: `PBR_FALLBACK_WGSL` constant-shading (`fs_main() -> vec4<f32>(material.baseColor, 1.0)`).
- Material `metallic = 0`, `roughness = 1` for future-case-A compat (`PBR_FALLBACK_WGSL` itself does not consume them).
- Readback: `createImageBitmap(canvas)` -> offscreen 2D canvas `getImageData` -> `Uint8Array(W*H*4)` RGBA (research Finding 5 path; avoids raw WebGPU `mapAsync` gymnastics).

### Thresholds in effect

| Layer | Field | Current value | Source |
|:--|:--|:--|:--|
| Layer A (per-pixel YIQ tolerance) | `perPixelThreshold` | `0.1` (pixelmatch upstream default; D-P2) | `src/evaluate-parity.ts` evaluator fallback |
| Layer B (aggregate pixel cap) | `threshold` | `256` | `apps/parity/forgeax/package.json#forgeax.metrics.bench.pixelDiff.threshold` (T-014 placeholder) |

`256 ~= 0.1% of 512 * 512 = 262144 total pixels`. Industry Playwright
`toHaveScreenshot.maxDiffPixels` typically lands in `[100, 500]`; placeholder
sits at the low end (charter proposition 4: explicit failure preferred).

## Bottom-section fallback (deep references)

  carries D-P1..D-P12 decisions (8-dim lock rationale, D-P5 case C unlit
  selection, MetricErrorDetail discriminated union design, naming conventions).
  carries the T-011 spike data section and T-014 placeholder backfill TODO
  (GH Larger workflow_dispatch path to compute `ceil(p95 * 1.10)` from 10
  real samples once the macOS R-1 environment limitation can be bypassed
  on a Linux CI runner).
  Finding 5 anchors the `createImageBitmap` readback strategy; Finding 10
  anchors the industry `maxDiffPixels` band the placeholder maps to.
- `.knowledge-base/wiki/forgeax-vs-threejs-gap.md` §3.13 carries the
  pixel-parity-bench row in the metric-registry capability matrix and
  §7 K6 quotes `epsilon = threshold / (512 * 512)` quantitative phrasing.
