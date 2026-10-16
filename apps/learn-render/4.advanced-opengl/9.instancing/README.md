# Instancing (LearnOpenGL 4.9)

[LearnOpenGL: Instancing](https://learnopengl.com/Advanced-OpenGL/Instancing)
draws an asteroid belt with one mesh and many model matrices. This example uses
the same authoring model: one World entity with `Instances.transforms`, plus a
non-instanced planet, a directional light and a first-person camera.

## World-owned layout

```ts
const transforms = buildAsteroidBelt(ASTEROID_COUNT); // 1200 column-major mat4s
world.spawn(
  { component: Transform, data: {} },
  { component: MeshFilter, data: { assetHandle: rockMeshHandle } },
  { component: MeshRenderer, data: { materials: [asteroidMatRes.value] } },
  { component: Instances, data: { transforms } },
).unwrap();
```

> [!IMPORTANT]
> `Instances.transforms` belongs to the World and survives Scene serialization.
> No Renderer, collection ID, or game-owned binding plugin is needed to author
> or reopen the layout. Render owns its derived CPU projection and GPU residency.

Each slot contains 16 finite floats. The holder's world transform multiplies
each local instance matrix. An empty array draws zero instances. Update the
component through World mutation; changing the original input array after
`spawn` does not edit World-owned data.

```ts
quat.fromAxisAngle(rot, [0, 1, 0], theta);
quat.fromAxisAngle(tilt, [1, 0, 0], rng() * Math.PI * 2);
quat.multiply(tumble, rot, tilt);
mat4.compose(m, t, tumble, s);
out.set(m, i * 16);
```

The seeded `mulberry32` generator makes the belt reproducible. The engine
extracts accepted World changes into a persistent projection and selects
GPU-driven, direct-storage or chunked-uniform submission according to the
active backend. Stable frames reuse resident data. These are rendering
choices, not alternative authoring APIs.

## LearnOpenGL mapping

| LearnOpenGL concept | ForgeaX owner |
|:--|:--|
| `glDrawElementsInstanced` | Renderer submission derived from one `Instances` entity |
| Per-instance `mat4` vertex attributes | Packed `Instances.transforms`; GPU layout is internal |
| `glm::translate * rotate * scale` | `quat` and `mat4.compose` from Engine Math |
| Planet and asteroid meshes | Vendored glTF assets loaded by GUID |
| GLFW keyboard camera | `addFirstPersonSystem` from `apps/shared` |

## Run and verify

```bash
pnpm --filter @forgeax/app-learn-render-4-advanced-opengl-9-instancing dev
pnpm --filter @forgeax/app-learn-render-4-advanced-opengl-9-instancing build
pnpm --filter @forgeax/app-learn-render-4-advanced-opengl-9-instancing smoke
pnpm --filter @forgeax/app-learn-render-4-advanced-opengl-9-instancing typecheck
```

The Dawn smoke uses one World with a planet and 12 rocks; the interactive
demo uses 1200 rocks. It requires the WebGPU backend, the requested frame
count, at least one of three mesh sample sites differing from the clear color
by more than 0.05, and no Renderer errors. This is a scene smoke, not an
instance-count differential oracle. Instance PBR, shadow, uniform-chunking and
large-population browser regressions provide the stronger rendering checks.
The smoke uses the Engine's standard 60-frame acceptance window.

| File | Responsibility |
|:--|:--|
| `src/index.ts` | Deterministic matrix generation, World authoring and app assembly |
| `scripts/smoke-dawn.mjs` | Planet/belt scene submission and mesh-site readback |
| `package.json` | Workspace commands and dependencies |

## Troubleshooting

| Symptom | Check |
|:--|:--|
| Invalid matrix payload | Length must be divisible by 16; every value must be finite |
| Rocks overlap at the origin | Verify translation passed to `mat4.compose` and `out.set(m, i * 16)` |
| Whole belt displaced | Inspect the holder's `Transform` as well as local instance matrices |
| No rocks | Check `transforms.length / 16`; an empty array intentionally draws nothing |

See [Render's Instances contract](../../../../packages/render/README.md#world-owned-instances-and-cpu-bounds)
for ownership, projection and recovery semantics.
