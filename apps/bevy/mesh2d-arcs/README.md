# mesh2d_arcs

This focused app reproduces the Bevy `mesh2d_arcs` geometry lesson through ForgeaX's
public `Shape2d` path. It renders eight circular sectors and eight circular segments
with one reusable unlit `MaterialAsset`, a generated alpha texture, circular-mask UVs,
an orthographic camera, and `compute2dBounds` debug overlays.

## Run the public gates

```sh
pnpm --filter @forgeax/bevy-mesh2d-arcs typecheck
pnpm --filter @forgeax/bevy-mesh2d-arcs build
SMOKE_MIN_FRAMES=60 pnpm --filter @forgeax/bevy-mesh2d-arcs smoke
pnpm --filter @forgeax/bevy-mesh2d-arcs smoke:browser
```

The Dawn smoke writes a 320x180 PNG and checks backend identity, brightness, colored
coverage in both rows, color diversity, and renderer errors. The browser smoke waits for
the Vite server through a bounded HTTP readiness probe, then requires the page ready marker
and a 320x180 canvas with no page, console, request, or response errors.

This app is a focused geometry/material oracle, not a second game scene: it has no authored
Pack/GUID asset, input action, gameplay/reset owner, or Preview integration. The coherent
`templates/game-3d` game remains the consumer for gameplay-sized compositions.
