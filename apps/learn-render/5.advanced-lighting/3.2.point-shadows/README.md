# Point Shadows

LearnOpenGL section 5.3.2 reproduced with the engine's `PointLightShadow`: one
point light moves inside a textured room, renders six depth faces, and applies
the cube-map shadow to the forward pass.

## Canonical scene contract

The browser demo follows the source sample's scene and controls before any
engine-specific lighting adaptation:

| Part | Canonical value |
| --- | --- |
| Room | extent `[-5, 5]`; shared inward normals/winding mesh at positive scale `10`, ordinary back-face culling and depth writes |
| Camera | position `[0, 0, 3]`, identity rotation (looks down `-Z`), `45°` FOV, near/far `0.1/50` |
| Light | white point light at `[0, 0, sin(t * 0.5) * 3]`, intensity `20`, range/far plane `25`; `t` uses World delta time |
| Shadow map | `1024²` cube map, near/far `1/25`, nearest filtering (`pcfKernelSize=1`) |
| Input | <kbd>Space</kbd> toggles shadows; <kbd>P</kbd> pauses/resumes the light; <kbd>R</kbd> resets light time to zero; buttons expose the same controls |

The five inner cubes use the exact positions and source scales from
`renderScene()`. Because the engine's `HANDLE_CUBE` is 1 unit wide while the
source helper spans 2 units, the transform scales below are doubled to keep
the same world-space sizes:

| Position | Scale | Rotation |
| --- | ---: | --- |
| `[4, -3.5, 0]` | source `0.5` → engine `1.0` | identity |
| `[2, 3, 1]` | source `0.75` → engine `1.5` | identity |
| `[-3, -1, 0]` | source `0.5` → engine `1.0` | identity |
| `[-1.5, 1, 1.5]` | source `0.5` → engine `1.0` | identity |
| `[-1.5, 2, -3]` | source `0.75` → engine `1.5` | `60°` around `normalize([1, 0, 1])` |

> [!NOTE]
> The browser path loads the same `wood.png` asset for the room and all five
> cubes through the scoped Pack catalog. The Dawn smoke uses deterministic
> solid-color materials because it has no dev-server asset transport; its
> transforms, camera, light orbit, and shadow projection remain identical. To
> keep CI feedback bounded, Dawn defaults to a `256²` shadow map; set
> `SMOKE_SHADOW_MAP_SIZE=1024` when a same-resolution replay is required.

> [!IMPORTANT]
> LearnOpenGL adds a direction-independent ambient term of `0.3 * vec3(0.3)`
> in its fragment shader. The engine has no implicit ambient, so the demo
> carries that exact `0.09` baseline through the wood texture's emissive lane;
> the point light remains the only direct/shadowed light. The browser's
> `PointLight.intensity=20` is an engine-scale mapping of the source
> `lightColor=vec3(0.3)` because the engine applies inverse-square attenuation;
> it preserves the source's placement, orbit, shadow range, and visible lighting
> response rather than copying an energy number that would be too dim at this
> room scale. PBR and the source's Blinn-Phong are different shading models:
> matching geometry and shadow placement is not pixel-identical radiometry.
> Dawn uses no emissive or directional fill, so those cannot mask a failed
> point light. The room mesh is shared with the browser, not a negative scale
> or disabled-depth workaround.

## RHI-debug gates

The Dawn-node gate is the semantic witness and falsifier:

```sh
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-3-2-point-shadows smoke:rhi-debug
FALSIFY=no-point-light pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-3-2-point-shadows smoke:rhi-debug
FALSIFY=outward-room pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-3-2-point-shadows smoke:rhi-debug
```

Local, PR and push runs render 60 frames with point-shadow shader variants
enabled, then freeze
World time and read two controls: shadows disabled and point light intensity
zero. The gate still requires a nonzero shadow difference and a wall-light delta
of at least `0.05`; brightness alone is insufficient. `no-point-light` must fail
these witnesses. `outward-room` uses the ordinary outward cube and must fail the
wall-light witness. Control frames reuse the existing device and shader manifest
rather than building another app.

The browser gate remains structural because the light orbit is time-dependent:

```sh
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-3-2-point-shadows smoke:browser
```

For a local visual check, start Vite and open the printed URL:

```sh
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-3-2-point-shadows dev
```

Append `?paused=1` to start with the source light at time zero. Keep the camera
fixed and toggle shadows to compare cast shadows without animation drift.

The reference implementation is [LearnOpenGL 5.3.2 Point
Shadows](https://learnopengl.com/?p=Advanced-Lighting/Shadows/Point-Shadows),
with the auditable [C++ scene source](https://learnopengl.com/code_viewer_gh.php?code=src%2F5.advanced_lighting%2F3.2.1.point_shadows%2Fpoint_shadows.cpp)
and [official reference image](https://learnopengl.com/img/advanced-lighting/point_shadows.png).
