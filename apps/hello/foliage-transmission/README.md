# hello-foliage-transmission

Back-lit thin foliage through the Standard diffuse-transmission layer
(`KHR_materials_diffuse_transmission`).

## Scene

Three leaf panels face the camera. A directional sun and a warm point light sit
behind them, so every visible leaf radiance comes from the back hemisphere:

| Panel | Material | Expected |
|:--|:--|:--|
| left | canonical Standard (no layer) | dark control |
| centre | cooked alias, `diffuseTransmission: 1`, green tint | glows green |
| right | same alias with a 64x1 alpha mask bound | left half dark, right half green |

A second scene, the white furnace (`src/white-furnace.ts`), has no punctual light: a uniform
solid-colour Skylight surrounds four white panels, an opaque canonical Standard control followed by the
alias at factors 0, 0.5, and 1. Each must match the control's radiance.

## Model

The layer follows the Khronos extension, which is also the shape of Unreal's
two-sided foliage shading model and the Three.js diffuse-transmission ports:

- direct light: `tint * max(-N.L, 0) / pi * radiance`; shadow visibility scales
  it like the front lobe. Directional, point and spot evaluators carry it, and so
  does rect area, which integrates the LTC cosine form factor over `-N`. Clustered
  and rect-area lighting are not compiled into authored alias roots yet (see
  Performance);
- environment: irradiance sampled along `-N`, weighted by `1 - F`;
- energy: the front diffuse albedo keeps `1 - factor`; the transmitted albedo is
  `factor * (1 - metallic) * tint`.

The factor is a split, not an extra term. Under a white sky of radiance 1, each side of a white leaf
returns `F + (1 - F)(1 - factor) + (1 - F) factor = 1` for any factor, which is what the furnace
measures. `factor = 1` is a lossless frosted diffuser, not clear glass (that is the specular
`transmission` layer). Unreal's raster two-sided foliage keeps the full front diffuse and adds the
transmission on top, reaching about 2 in the same test; see `packages/render/README.md` §Factor
semantics for the conversion to its path tracer's balanced form.

`diffuseTransmissionTexture` reads alpha (linear); `diffuseTransmissionColorTexture`
reads RGB (sRGB).

## Authoring requirement

`forgeax::default-standard-pbr` is layer-free. The layer is selected by a cooked
root contract: `src/leaf-diffuse-transmission.pack.json` declares a Standard alias
whose module id contains `::standard-`, the five canonical user-region textures,
and the diffuse-transmission names including the optional factor texture. An
unbound factor texture falls back to white, so the uniform and masked leaves share
one program. `src/material-contract.ts` binds `Materials.standard(...)` values to
that root. Physical layers are Forward-only.

## Gates

```bash
pnpm --filter @forgeax/hello-foliage-transmission smoke
FALSIFY=no-transmission pnpm --filter @forgeax/hello-foliage-transmission smoke   # must fail
FALSIFY=additive pnpm --filter @forgeax/hello-foliage-transmission smoke          # must fail
CI=1 pnpm --filter @forgeax/hello-foliage-transmission smoke:browser
pnpm --filter @forgeax/hello-foliage-transmission perf
```

- The Dawn smoke reads back the frame and checks each panel against the table above. It then renders
  the white furnace and requires every factor panel within 0.02 sRGB luma of the opaque white
  control (about 0.63). `FALSIFY=additive` restores the removed front diffuse as emission, the Unreal
  composite, and reaches about 0.75 at factor 0.5 and 0.85 at factor 1. A missing back lobe fails too:
  the factor-1 panel would lose all of its diffuse radiance.
- The browser smoke captures an RHI Debug tape of the real frame and checks four things:
  - some shader module contains the transmission lobe;
  - the masked variant's bind group layout exposes bindings 68 and 69;
  - a render pipeline using that module is bound by `setPipeline` in the frame;
  - the live pixels match a replay on a fresh Dawn device.
- Local runs need the lavapipe wrapper from the repository notes.

## Performance

`perf` runs each lane in its own process over a 40x40 leaf grid (1603 leaves).
It times 120 frames, including GPU completion, and runs each lane twice. It
compares these lanes:

| Lane | Grid material |
|:--|:--|
| `standard` | canonical Standard |
| `off` | cooked alias, factor 0 |
| `on` | cooked alias, factor 1 |

Measured on lavapipe (best median of two runs):

| Lane | Frame time | Directional shadow draws per frame |
|:--|:--|:--|
| `standard` | about 57-61 ms | 12 (GPU-driven indirect batches) |
| `off` | about 211 ms | 6412 (1602 per dynamic cascade, CPU lane) |
| `on` | about 205 ms | 6412 |

The lobe cost is `on` against `off`, the same root at factor 1 and factor 0. The
difference is inside run-to-run noise: the lobe is one extra dot product per light
plus one irradiance fetch.

The roughly 3.5x gap between `standard` and the alias lanes has another cause:
authored Standard alias roots, like every authored physical layer, are cooked
over only the storage-buffer and vertex-color axes. They have no `vs_scene_index`
entry and no artifact receipt, so both color and shadow draws take the
per-entity CPU lane (see `packages/render/README.md` §Diffuse transmission).
