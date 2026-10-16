# Canvas in the world

Draw on the left canvas and watch the same drawing appear on a framed 3D sign.
The sign is rendered by Engine with an ordinary `MeshRenderer` material.

| Example | What to try | What the model shows |
|:--|:--|:--|
| Drawing board | Pick a color and drag; adjust brush size or clear | Your strokes on the sign |
| Live sign | Watch the station clock and departure countdowns | Updating text on a world-space display |
| Dashboard | Watch the speed gauge and power chart | Animated instruments on a model |

**Pause sync** freezes only the model texture. Keep drawing, or watch the live
canvas continue, then **Resume sync** to apply its latest pixels. Move **View
angle** to see the sign's depth. Selecting Drawing board restores its starter
artwork. The layout stacks vertically on smaller screens.

## Run

From an Engine contributor checkout with its normal setup and Engine build complete:

```sh
pnpm --filter @forgeax/showcase-canvas-texture dev --host 0.0.0.0
```

Use the URL printed by Vite. This example generates its artwork with Canvas 2D
and uses built-in geometry; it needs no downloaded images or private assets.

## Connect a canvas

```ts
import { CanvasTexture, Materials } from '@forgeax/engine/render';

// HANDLE_QUAD uses top-left UVs. Leave the option out for bottom-left UVs.
const texture = new CanvasTexture(canvas, { flipY: false });
const source = world.allocSharedRef('CanvasTextureSource', texture.source);
const material = world.allocSharedRef(
  'MaterialAsset',
  Materials.unlit('#ffffff', { baseColorTexture: source }),
);
// Assign material to MeshRenderer.materials, then call after drawing:
texture.update();
// When the source is no longer needed:
texture.dispose();
```

App owns frame scheduling. An ECS `Update` system paints the live presets at
20 Hz; DOM pointer events paint brush strokes. Both use the same CanvasTexture.
`flipY` belongs to the immutable source and survives native render publication
and device recovery.

## Verify

```sh
pnpm --filter @forgeax/showcase-canvas-texture typecheck
pnpm --filter @forgeax/showcase-canvas-texture build
pnpm --filter @forgeax/showcase-canvas-texture smoke:browser
```

The browser gate starts an isolated Vite server on a free port, or accepts
`FORGEAX_DEMO_URL` for an existing server. It checks at least 60 submitted frames,
actual model pixel changes, vertical orientation, paused/resumed synchronization,
both animated presets, model rotation, narrow-screen layout, drawing after
resize, disposal, and browser errors. It also captures the actual App through
RHI Debug and replays on a fresh WebGPU device. Evidence is written under
`artifacts/canvas-texture/showcase/` at the repository root.

On the software graphics test host, use `xvfb-run -a env CI=1` before the browser
command. These results establish functional behavior, not hardware performance.
