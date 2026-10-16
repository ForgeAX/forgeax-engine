# Deferred shading (LearnOpenGL 5.8)

This lesson keeps the LearnOpenGL 5.8 scene data while using one Standard
pipeline. It renders 32 deterministic point lights and a 3x3 grid of cubes;
the render graph owns the deferred attachments, clustered membership, and
receipt-bound frame evidence.

> [!NOTE]
> The tutorial describes Blinn-Phong. ForgeaX uses `Materials.standard` with
> PBR GGX and Lambert terms, so the pixels are expected to differ while the
> scene layout and light inputs remain comparable.

## Owner map

| Lesson concept | Standard owner |
|:--|:--|
| G-buffer attachments | Standard render graph |
| Deferred lighting | Standard clustered lane |
| Light membership | Render-owned cluster producer |
| Camera and tone | ECS camera plus Standard profile |
| Error and recovery | `Result`, `onError`, and `FrameReceipt` |

The app selects the lane during host assembly:

```ts
const appRes = await createApp(
  canvas,
  {
    standardProfile: {
      ...DEFAULT_STANDARD_PROFILE,
      renderPath: 'deferred',
    },
  },
  forgeaxBundlerAdapter(),
);
```

There is no public pipeline registry or late install step. The scene producer
only supplies ECS data and the host returns receipt-bound frame results.

## Evidence gate

```bash
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-8-deferred-shading smoke
FALSIFY=force-direct pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-8-deferred-shading smoke
```

These commands use the real Dawn 60-frame path. The direct lane is the
falsifier for clustered membership and must produce a measurable lane
difference. CPU, null-backend, manual-loop, and skipped-GPU substitutes are
not accepted.

## LearnOpenGL correspondence

The geometry pass writes the Standard graph's material outputs, the clustered
lighting pass consumes the graph-owned membership buffers, and transparent
light markers use the same Standard material contract. The cube grid and the
seeded light positions are retained so the rendering model can be compared
with the original lesson without preserving its OpenGL resource ownership.

## Commands

```bash
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-8-deferred-shading dev
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-8-deferred-shading build
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-8-deferred-shading typecheck
```
