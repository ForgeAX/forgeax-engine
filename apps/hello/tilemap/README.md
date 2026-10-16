# hello-tilemap

> **Tilemap extraction oracle** — register one `TilesetAsset`, spawn a
> `Tilemap` plus `TileLayer`, and let the render feature derive one ECS entity
> per non-empty cell through the normal `renderer.draw` path.

## Run locally

~~~bash
pnpm --filter @forgeax/hello-tilemap dev      # Vite browser front door
pnpm --filter @forgeax/hello-tilemap build    # production pack + shader build
pnpm --filter @forgeax/hello-tilemap smoke    # Dawn 120-frame extraction smoke
~~~

The browser and Dawn paths share the same inline 32x32 four-quadrant
TilesetAsset geometry. The browser baseline intentionally uses a shared
placeholder texture handle, so its white cells are an extraction visual rather
than a packed-art preview; the headless smoke uploads the synthetic atlas to
exercise the GPU path and pixel-readback gate.

## One-line tilemap composition

~~~ts
import { ChildOf, Transform } from '@forgeax/engine-scene';

const tilesetHandle = world.allocSharedRef('TilesetAsset', tileset);
const tilemap = world.spawn(
  { component: Tilemap, data: { cols: 8, rows: 8, tileSize: [1, 1], chunkSize: 4, tileset: tilesetHandle } },
  { component: Transform, data: {} },
).unwrap();

world.spawn(
  { component: TileLayer, data: { tiles, layerOrder: 0, dirty: 1 } },
  { component: ChildOf, data: { parent: tilemap } },
);
~~~

`Transform` stores authored local pose and declares `GlobalTransform` as a
required transient world-pose column. The generic ECS structural boundary adds
that requirement for raw spawns, component adds, and deferred commands; scene
asset and mount helpers do not need a second completion path.

`TileLayer.tiles` is a row-major `Uint32Array`; zero is empty and non-zero
values index the tileset entries. The extract system owns derived cell entity
lifecycle, so consumers do not hand-author one entity per cell. Mutate the
array and call `markTileLayerDirty(world, layer)` to rebuild the derived set.

## Evidence and falsifiers

- `scripts/smoke-dawn.mjs` requires 120 frames, two derived cell entities after
  the frame-60 dirty rebuild, zero `RhiError` events, and a pixel delta.
- The browser evidence should include a non-black canvas, zero page/console
  errors, and a successful shader manifest request. The white diagonal is
  expected for this M0 extraction-only browser oracle.
- The smoke is intentionally the stronger atlas consumer: it uploads four
  colored quadrants and checks the rebuild through Dawn readback.

This is a focused tilemap/render-feature oracle. `templates/game-3d`
currently owns a coherent 3D target-range gameplay loop and has no 2D camera,
map input, map state, or authored tileset boundary. It therefore remains a
focused `apps/hello` consumer rather than being copied into the template.

## Source map

| Path | Purpose |
|:--|:--|
| src/main.ts | Browser renderer, tilemap/layer setup, camera, and dirty rebuild |
| scripts/smoke-dawn.mjs | Headless Dawn atlas upload, extraction, and readback gate |
| vite.config.ts | Shader manifest build path |
