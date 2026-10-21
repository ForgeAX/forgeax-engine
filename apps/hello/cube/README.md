# hello-cube

End-to-end ECS-driven binding exemplar for `@forgeax/engine-runtime`
(feat-20260509-ecs-render-bridge-mvp / M4).

[src/main.ts](src/main.ts) creates the browser App and passes its World and asset owner to the shared `populateDemoWorld` helper. That helper admits Geometry's cube through `assets.create`, then spawns the cube, camera and light.

```ts
const result = await createApp(canvas, {}, forgeaxBundlerAdapter());
const app = result.unwrap();
populateDemoWorld(app.world, app.assets);
app.start();
```

App owns frame scheduling and Renderer assembly. The same asset handle remains valid across renderer recovery.

## Smoke gate (AC-12b)

`pnpm --filter @forgeax/hello-cube smoke` runs the dawn-node harness and evaluates
four criteria (D-S10 / D-S6 / D-S7):

- (a) `[hello-cube] backend=webgpu` console literal observed.
- (b) frames observed >= `SMOKE_MIN_FRAMES` (default 60).
- (c) NDC center pixel distance to black `[0, 0, 0]` > `SMOKE_PIXEL_THRESHOLD`
      (default 0.05); the cube must remain visibly distinct from the clear color.
- (d) `Renderer.onError` accumulated `RhiError` count == 0 (the four
      RenderSystem error codes from D-S6 / D-S7 stay silent on the happy path).

ENV knobs match `hello-triangle/scripts/smoke-dawn.mjs`:
`SMOKE_DURATION_MS=5000` / `SMOKE_MIN_FRAMES=60` / `SMOKE_PIXEL_THRESHOLD=0.05`.

## SSOT (AC-12b self-contained)

The smoke invocation literal `pnpm --filter @forgeax/hello-cube smoke` lives in two
places:

- `.github/workflows/ci.yml` (CI smoke step).
- `apps/hello/cube/package.json#forgeax.smokeInvocation`.

Per D-S10 these two are byte-for-byte identical; they are NOT byte-for-byte
identical with the hello-triangle SSOT (each app owns its own smoke
invocation; K-12 stance is preserved separately for AC-12a).

## D-S1 single-point exemption

`context.configure({ device })` requires a raw `GPUDevice` (the spec couples
`GPUCanvasContext` to canvas, not to the RHI surface). hello-cube reuses
the same four-path allow-list from feat-20260508-rhi-surface-completion
(`apps/hello/triangle/src/main.ts` is the prior single-point exemption);
hello-cube is **not** a new fifth path - it consumes the same
`rawDeviceForContextConfigure` thunk via `RendererOptions` (OOS-12 / AC-11).
