# Hello Tilemap Object Layer

This demo is a directed five-sub-scene oracle for tilemap extraction and the
per-cell transparent render path. It is intentionally a fixture rather than a
complete game loop: the same world graph is exercised by the browser entry and
the Dawn smoke gate.

## What it demonstrates

- multi-cell tiles with non-centre pivots and horizontal/vertical flip bits;
- two atlas handles routed through one `TilesetAsset`;
- chunk-boundary coverage and a unit-cell baseline;
- per-cell Y sorting interleaved with a standalone sprite entity;
- five directed pixel samples plus a derived-entity and renderer-error check.

The atlas handles are deliberate in-process placeholders. This keeps the
oracle independent of the binary asset submodule; the smoke reports sampled
RGBA and a coarse palette family instead of asserting authored art pixels.

## Current public API shape

Shared asset handles are owned by `World`:

```ts
const atlas = toShared<'TextureAsset'>(201);
const tileset = world.allocSharedRef('TilesetAsset', tilesetAsset);
const material = world.allocSharedRef('MaterialAsset', materialAsset);
```

An object-layer fixture must opt into the streaming per-cell path explicitly:

```ts
sortScope: encodeSortScope('per-cell')
```

The default `layer` scope is chunk-batched and is not equivalent to a
per-entity object layer. Tiled tile-entry collision objects (`tile.objectgroup`)
also have different ownership and coordinates from a map-level object layer;
they should not be silently routed through this render fixture.

## Commands

```sh
pnpm --filter @forgeax/hello-tilemap-object-layer dev
pnpm --filter @forgeax/hello-tilemap-object-layer typecheck
pnpm --filter @forgeax/hello-tilemap-object-layer build
pnpm --filter @forgeax/hello-tilemap-object-layer smoke
```

The smoke requires the engine shader manifest produced by `pnpm build:engine`
and defers with an explicit `env-deferred=` message when Dawn cannot create a
GPU device in the current environment.

## Template decision

This fixture remains a canonical feature oracle, not a `game-default` scene.
It has no input, gameplay consequence, state transition, reset/re-entry path,
cleanup contract, or authored Tiled delivery boundary. Promoting it into the
template would add a second orthographic gallery beside the template's
coherent 3D gameplay loop. A future guided adoption should first provide those
game-loop seams and a real map/tileset asset flow.
