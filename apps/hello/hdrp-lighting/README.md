# Standard clustered lighting

This scene is the 256-light Standard profile exercise. It spawns 200 point
lights and 56 spot lights, then runs the clustered lane through the real host,
device, graph, and receipt path.

> [!IMPORTANT]
> The public surface is `standardProfile` on `createApp`. The demo does not
> register a pipeline asset, install a pipeline at runtime, or import a
> private render module.

## Owner map

| Concern | Owner |
|:--|:--|
| 200 point lights and 56 spot lights | ECS producers |
| Direct or clustered lighting choice | Standard profile at host assembly |
| Material and shader identity | `Materials.standard`, `forgeax::default-standard-pbr` |
| Frame lifecycle | `createApp -> attach -> draw -> FrameReceipt` |
| Observation and recovery | receipt-bound `observe` / `recover` |
| GPU evidence | Dawn 60-frame smoke |

The clustered profile is selected in the app options. `renderPath` chooses
only the forward/deferred graph variant; both variants use the same unified
Cluster light transport:

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

The scene's first 32 point lights orbit each frame. That keeps cluster
membership live and proves the producer is not a one-time bootstrap side
effect.

## Smoke gate

Run the real Dawn path:

```bash
pnpm --filter @forgeax/hello-hdrp-lighting smoke
```

The command exercises the clustered lane for 60 frames. A local
`FALSIFY=force-forward` run selects the alternate forward graph while keeping
the same Cluster light transport. A null backend, CPU stand-in, or skipped GPU
path is not accepted as evidence.

The immutable 200x150 pixel reference lives at
`forgeax-engine-assets/smoke-baselines/hdrp-lighting/hdrp-lighting-256-light-dawn.png`.
Its bytes match the previous committed asset reference; the smoke compares with
the existing per-channel tolerance of 0.05 and fails if the fixture is missing.
It never creates a replacement reference from the current frame.

## Related evidence

- `apps/parity/urp-vs-hdrp/` contains the direct-versus-clustered Standard
  parity fixture.
- `packages/render/README.md` documents the public feature and profile
  vocabulary.
- `packages/runtime/README.md` documents host assembly and frame receipts.
