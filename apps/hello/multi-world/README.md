# hello-multi-world

Composited multi-world rendering exemplar for `@forgeax/engine-runtime`
(feat-20260708-composited-multi-world-rendering / M5 / AC-12).

`apps/hello/multi-world/src/main.ts` is the canonical demonstration of the
merged-world draw signature AI users discover via `@forgeax/engine-runtime`:

```ts
renderer.draw([worldA, worldB], { cameraOwner: 0, resourceOwner: 0 });
```

## Scene

Two deliberately asymmetric worlds, composited into one frame:

- **world A** (owner, index 0) — perspective `Camera` + `DirectionalLight` +
  one lit green box on the left. It owns the only camera and the only light.
- **world B** (index 1) — two lit boxes on the right (red + blue), and **no
  camera, no light** of its own.

The asymmetry is the point:

- If the engine rendered only the owner world you would see the green box
  alone. Seeing world B's boxes proves `renderables` are merged across all
  worlds (**AC-06 both-worlds-geometry-visible**).
- World B has no light and the scene has no skylight, so ambient is 0. If
  lights were not merged across worlds, B's boxes would render black. Seeing
  them lit proves `lights` are merged across worlds (**AC-04
  cross-world-lighting**).

The direct `createRenderer` bootstrap is the smallest feature oracle. Hosts
that discover the secondary World during a normal `createApp` bootstrap use the
same routing contract through `app.setDrawSource(...)`; that setter changes
only the per-frame world list and keeps one App lifecycle and one measured
delta. `templates/game-3d/assets/plugin.ts` is the composed
consumer of that host seam.

## Smoke gate (AC-12)

`pnpm --filter @forgeax/hello-multi-world smoke` runs the dawn-node harness
with **two** pixel-readback probes:

- **Probe B** samples world B's projected geometry. It must be non-clearColor
  (both-worlds-geometry-visible) AND its brightness must exceed a lit floor
  (cross-world-lighting — B is only lit by world A's light).
- **Probe A/B** samples world A vs world B geometry and asserts the two worlds
  render distinct dominant colours (A green vs B red), confirming both worlds'
  materials reach the frame.

The smoke's discriminating power is verified via two falsification variants
during development (owner-only renderables, and per-world lights) — both must
FAIL the corresponding probe. Variants never ship (charter F2: pixel-readback
numerical assertions, not eyeballed screenshots).

## CI

The smoke is wired into the `smoke-fleet` job in `.github/workflows/ci.yml`
(explicit per-demo enumeration, not auto-discovered). The ci.yml step literal
pairs with `package.json#forgeax.smokeInvocation` as the SSOT.
