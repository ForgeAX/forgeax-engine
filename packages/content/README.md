# @forgeax/engine-content

Engine Content is an ordinary asset library: authored `*.pack.ts` sources for
the Engine's basic meshes, checker texture and Standard material, and the
shared Water material family. A project mounts it explicitly through forge.json:

```json
{ "assetLibraries": ["@forgeax/engine/content"] }
```

DevKit resolves the specifier to this package's `forgeax.library.assetRoot`
(`assets/`), scans and cooks it with the project roots, and lists its sources
under the Catalog identity `@forgeax/engine/content/<file>`. The library is
read-only: authoring writes stay inside project asset roots. Both SDK templates
declare it; a project without the entry has none of these assets.

## Assets

| Group | Names | Notes |
|:--|:--|:--|
| `meshes` | `cube`, `sphere`, `cylinder`, `cone`, `torus`, `capsule`, `plane`, `quad`, `nine-slice-quad`, `triangle` | Unit-sized Geometry factory output (bounds within +-0.5), white vertex color, one `Default` slot whose default material is `materials.default`. `plane` faces +Y; `quad` faces +Z. |
| `textures` | `checker` | 256x256 `rgba8unorm-srgb`, 2x2 cells of linear 0.18 / 0.30 gray, full mip chain averaged in linear space. |
| `samplers` | `checker` | Linear min/mag/mip filtering, repeat addressing, `maxAnisotropy: 16`. |
| `materials` | `default` | Standard: white base color, metallic 0, roughness 0.7, `checker` base-color texture tiled 4x. |
| `water.materials` | root, shared instance, four Body children and LOD children, River transitions, far/HLOD, WaterInfo, underwater and Custom underwater | Ordinary Pack MaterialAssets with inherited parameters and static switches; see the [Water contract](../water/README.md#material-family). |
| `water.textures` | normal, river-diffuse, river-normal, foam, foam-normal, noise, volume-noise, impulse-noise | Seeded mathematical fields define the textures. Six generated 2D surface textures request GPU mips. `volume-noise` is a linear, single-channel 128-cubed GPU texture with one mip. `impulse-noise` provides the default local-fluid force's nine-level 2D sRGB mip chain. |

The mip chain and anisotropic sampler keep the checker free of moire at grazing
angles; a no-mip nearest sampler on the same pattern is the falsifier.

## GUIDs

GUIDs derive from each library Pack's `packageId` and `sourceKey` through
`AssetGuid.derive`, exactly like project Packs. `src/ids.ts` is the single
source of both: the Pack sources import it, and the package entry exports the
resulting strings:

```ts
import { EngineContent } from '@forgeax/engine/content';

EngineContent.meshes.cube; // mesh GUID string
EngineContent.materials.default; // material GUID string
EngineContent.water.materials.ocean; // shared Water family child GUID
EngineContent.water.materials['custom-underwater'];
EngineContent.water.textures['impulse-noise'];
```

Use these GUIDs in Scenes, `MeshFilter`, `MeshRenderer` or material
references. A reference only resolves when the project mounts the library.

`checker.pack.ts` owns the checker texture and sampler.
`water/surface-textures.pack.ts` owns six `GpuTextureAsset` declarations.
The cooker publishes their finite shader programs, parameters and output shapes.
At residency the Renderer evaluates periodic fields, wrapped derivatives and GPU
mips. Foam and its normal share one field. The river texture pair shares its warp.
Calibrated color outputs retain their sRGB rendering path and the original alpha.

### Upgrading saved Water references

`EngineContent.water.textures` and the stock Water materials resolve the new
surface namespace. For saved projects that store any of the six GUIDs literally,
rewrite those authored references before re-cooking. Direct asset loads select the
`gpu-texture` kind for these six outputs. The checker, volume and impulse
keep their existing GUIDs. Direct loads of the stock impulse use `gpu-texture`.

| Texture | Previous GUID | Surface Pack GUID |
|:--|:--|:--|
| `normal` | `0c855c2a-7f29-5e28-b30f-c8669de0202e` | `f030e1fd-5b3c-57a1-a60c-018ceef83acd` |
| `river-diffuse` | `ef7f4ae3-f033-5d51-b756-18c8d4a6b40c` | `f9c181e7-9b0a-5297-9799-f2bc20b5f43a` |
| `river-normal` | `b8287107-941e-5335-a055-34d704d458dd` | `7b9c681f-731b-5180-9de3-d01351fffb49` |
| `foam` | `74a9fd75-4f63-5abd-bcc8-7ac02f2a1295` | `19dbdb35-7706-50d8-97c4-b60fdf45bff5` |
| `foam-normal` | `30824247-9646-53fa-909f-77385db8e5cc` | `987bf773-9f95-55ad-b4f4-cd6c9f0f4498` |
| `noise` | `ffe75b88-edb3-5dba-882f-4aa8d17aba3a` | `1f8cd962-b062-5604-94b1-9b7e2137720c` |

### Volume and impulse

`water/volume-noise.pack.ts` publishes an R8 GPU texture and its producer at
separate GUIDs. `forgeax::water_volume_noise` supplies the deterministic noise
field. The Renderer dispatches the entire volume once at residency and copies
the packed scalar values into a native 3D sampled texture.
FoamRT is a temporary RenderGraph target and is never published as a static
Content texture.

`water/impulse-noise.pack.ts` publishes a GPU texture with its original GUID.
Its generator applies gamma 2.2 decode and value exponent 1.2 to the
256×256 grayscale field. Each of the eight reductions writes an
eight-tap separable-kernel result into the sampled sRGB chain and an
unsharpened average into a transient R32F chain. The next level reads that
average with wrapped taps. The fluid renderer consumes the accepted
nine-level allocation with repeat, linear min/mag and nearest mip selection.
Fluid recipes also accept pre-existing byte-backed 2D impulse assets.

## Mounting

All Content sources use the ordinary Pack cook, Catalog and runtime asset
loading path. Edit their Pack or mathematical source to change generated
content. The package uses the standard TypeScript build; source delivery
includes the same Pack and helper files under its Apache-2.0 license.

- `project-asset-library-unresolved`: the specifier does not resolve to an
  installed package. Install `@forgeax/engine` (or bind a local Engine) and use
  an existing Engine package directory, or remove the entry.
- `project-asset-library-invalid`: the package has no
  `forgeax.library.assetRoot` directory. Only asset-library packages can be
  mounted.

## Tests

`pnpm --filter @forgeax/engine-content test` type-checks the Pack sources and
verifies the exported GUIDs, mesh attribute/bounds/slot facts, the linear mip
averages and sRGB encoding of the checker, sampler shape, and Water texture
pixel hashes, native mip policies and tangent-normal bounds.
