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
| `water.textures` | normal, river-diffuse, river-normal, foam, foam-normal, noise, volume-noise, impulse-noise | Seeded mathematical fields produce ordinary Pack TextureAssets. Six 2D textures request generated mips; `volume-noise` is a linear 128-cubed 3D texture with one mip, and `impulse-noise` provides the default local-fluid force's nine-level 2D sRGB mip chain. |

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

`checker.pack.ts` owns the checker and six Water 2D outputs under the shared
textures package identity. `water/texture-pixels.ts` provides pure seeded
periodic fields, channel calibration and wrapped tangent-normal derivatives.
Gray source fields share one ordered calibration statistic across channels and
produce RGBA bytes directly; normal fields retain independent channel statistics.
This avoids an expanded floating-point RGBA intermediate without changing texel
identity or the published mip contracts. The Water Volume and Impulse Packs
retain their own package identities.
`water/volume-noise.pack.ts` directly produces native 3D RGBA8 texels.
FoamRT is a temporary RenderGraph target and is never published as a static
Content texture.

`water/impulse-noise.pack.ts` applies gamma 2.2 decode, value exponent 1.2 and
eight-tap sharpening to its generated 256x256 grayscale field. Each sharpened level reads
the separate 2x2 average pyramid with wrapped taps; the output is nine packed
`rgba8unorm-srgb` mips. The runtime default impulse samples local UV0 with repeat,
linear min/mag and nearest mip filtering.

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
