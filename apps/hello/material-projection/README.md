# hello-material-projection

Triplanar texture projection, object-space normal maps, and the non-PBR
material family (`Materials.lambert`, `Materials.matcap`, `Materials.normal`)
in one orthographic frame whose every subject is a fixed pixel rectangle.

## Scene

| Row | Subject | Material | Expected |
|:--|:--|:--|:--|
| top | box pair, left | `triplanar: { space: 'world' }`, every UV zeroed | checker visible; the two boxes differ because the texture stays in the world |
| top | box pair, right | `triplanar: { space: 'object' }`, every UV zeroed | checker visible; the two boxes are identical because the texture travels with the mesh |
| top | rotated, non-uniformly scaled sphere | `normalMapSpace: 'object'`, constant object +X map | the whole disc is one flat facet |
| bottom | sphere 1 | `Materials.standard`, roughness 0.25 | specular peak |
| bottom | sphere 2 | `Materials.lambert`, same base color | same diffuse, no peak |
| bottom | sphere 3 | `Materials.matcap(image)` | red toward view-left, blue toward view-right, green toward view-up |
| bottom | sphere 4 | `Materials.normal()` | encoded view-space normal |

The boxes keep positions and normals but have zero UVs, so a UV-mapped
material paints one constant texel; only projection can show the checker.

## Model

- **Triplanar** (Unreal `WorldAlignedTexture`, Three.js TSL `triplanarTexture`):
  three planar samples blended by `|n|^sharpness`, in world or object space,
  times `scale`. Each tap uses explicit gradients of the projected position,
  so mip selection stays continuous across blend seams. Normal maps use the
  whiteout blend (Golus, "Normal Mapping for a Triplanar Shader"), which keeps
  the tangent-space swizzle per plane without a tangent frame. Object space
  projects on `positionOS` and returns through the object-to-world cofactor.
- **Object-space normal** (Three.js `ObjectSpaceNormalMap`, Unreal
  "Tangent Space Normal" off): the map decodes to an object-space direction and
  transforms by `cofactor(M)`, which stays correct under non-uniform scale and
  mirroring; no vertex tangents are read.
- **Lambert** (Three.js `MeshLambertMaterial`): the Standard surface with the
  specular lobe and physical layers removed, on the same lights and shadows.
- **Matcap** (Three.js `MeshMatcapMaterial`): the image is indexed by the
  view-space normal in a view-direction-aligned basis, so perspective edges
  do not wrap.
- **Normal** (Three.js `MeshNormalMaterial`): `0.5 * n_view + 0.5`.

Triplanar and object-space normals are pipeline specializations
(`standardTextureMask` override bits 29 and 30), so materials without them keep
the unchanged UV program. They are raster-only: the ray reference refuses them
with `ray-material-unsupported` instead of tracing them by UV.

## Gates

```bash
pnpm --filter @forgeax/hello-material-projection smoke
FALSIFY=uv       pnpm --filter @forgeax/hello-material-projection smoke   # must fail
FALSIFY=world    pnpm --filter @forgeax/hello-material-projection smoke   # must fail
FALSIFY=tangent  pnpm --filter @forgeax/hello-material-projection smoke   # must fail
FALSIFY=standard pnpm --filter @forgeax/hello-material-projection smoke   # must fail
FALSIFY=unlit    pnpm --filter @forgeax/hello-material-projection smoke   # must fail
CI=1 pnpm --filter @forgeax/hello-material-projection smoke:browser
pnpm --filter @forgeax/hello-material-projection perf
```

| Falsifier | Swap | Gate it trips |
|:--|:--|:--|
| `uv` | world triplanar → UV mapping | world pair no longer differs |
| `world` | object triplanar → world | object pair no longer matches |
| `tangent` | object-space normal → tangent decode | facet spread, unlit centre |
| `standard` | Lambert → Standard | specular peak present |
| `unlit` | Matcap / Normal → plain unlit | view-normal colour probes |

The browser smoke captures an RHI Debug tape of the live Chromium frame,
replays it on a fresh Dawn device and compares pixels. It also proves from the
tape that the frame binds pipelines whose fragment `standardTextureMask`
(override id `STANDARD_TEXTURE_MASK_OVERRIDE`)
constant carries bit 29 and bit 30 with the projection helpers in their module,
plus an unlit pipeline with the matcap lookup.

`perf` renders a full-screen 6-column sphere grid at 2560 x 1440 (so the frame
is fragment-bound) and compares triplanar, object normal and Lambert against UV
Standard, and Matcap and Normal against plain Unlit. Each pair runs in one
process that swaps the grid material every 8-frame block; a sample is that
block's GPU-complete throughput with one queue sync. Alternating on one device
keeps lane and baseline on the same GPU clock state, which varies more between
processes than the lanes differ. The verdict is the median over `PERF_ROUNDS`
(default 4) processes of the in-process median ratio. It is a local
diagnostic, not a CI gate.
