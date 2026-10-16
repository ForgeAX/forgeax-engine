# hello-triangle

The canonical ECS render bootstrap. The app and its Dawn smoke share one
five-component World recipe:

```text
World.spawn -> await renderer.ready -> renderer.draw(world)
```

The smoke uses `HANDLE_TRIANGLE`, a real shader manifest, a 60-frame Dawn
loop, and three pixel samples. It is a focused first-render and renderer
bootstrap oracle; it is not a gameplay template.

## Run it

```sh
pnpm --filter @forgeax/hello-triangle smoke
pnpm --filter @forgeax/hello-triangle dev
pnpm --filter @forgeax/hello-triangle build
```

The smoke verdict requires `backend=webgpu`, at least 60 frames, and a
non-clear center pixel. `SMOKE_DURATION_MS`, `SMOKE_MIN_FRAMES`, and
`SMOKE_PIXEL_THRESHOLD` tune timing and tolerance only; they do not bypass the
criteria. Failure output has `FAIL`, `rerun`, and `hint` lines for recovery.

## What to inspect

- `src/main.ts` shows `World`, `Transform`, `MeshFilter`, `MeshRenderer`,
  `Camera`, `DirectionalLight`, RHI canvas configuration, and the frame loop.
- `scripts/smoke-dawn.mjs` is the headless producer-to-render proof.
- `scripts/smoke-coverage-gate.mjs` prevents the smoke from becoming a second
  inline shader implementation; it checks the shared ECS symbols and stderr.
- `src/shaders/{view,brdf,pbr}.wgsl` demonstrate Vite shader composition and
  `#import` modules.

## Shader and asset boundary

The Vite shader plugin emits the manifest consumed by `createRenderer`. The
triangle geometry comes from the public `HANDLE_TRIANGLE` asset path, while
the three WGSL files remain build-time composition inputs. Keep this split so
the smoke exercises the same runtime contract as a browser build.

## Relationship to game-default

`templates/game-3d` already owns the richer authored mesh/material,
camera, hierarchy, input, physics, reset, render-evidence, and Preview
lifecycle. Do not copy this static triangle into that game. Reopen the
candidate only when triangle topology or bootstrap changes an existing
gameplay entity through those owners, or when a shared engine/app-shell fix is
needed by both the canonical demo and the template.

The smoke invocation is an SSOT shared with CI and the verification skill:
`pnpm --filter @forgeax/hello-triangle smoke`.
