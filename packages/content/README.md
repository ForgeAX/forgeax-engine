# @forgeax/engine-content

Engine Content is an ordinary asset library: authored `*.pack.ts` sources for
the Engine's basic meshes, a checker texture with its sampler, and a default
Standard material. A project mounts it explicitly through forge.json:

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
```

Use these GUIDs in Scenes, `MeshFilter`, `MeshRenderer` or material
references. A reference only resolves when the project mounts the library.

## Recovery

- `project-asset-library-unresolved`: the specifier does not resolve to an
  installed package. Install `@forgeax/engine` (or bind a local Engine) and use
  an existing Engine package directory, or remove the entry.
- `project-asset-library-invalid`: the package has no
  `forgeax.library.assetRoot` directory. Only asset-library packages can be
  mounted.

## Tests

`pnpm --filter @forgeax/engine-content test` type-checks the Pack sources and
verifies the exported GUIDs, mesh attribute/bounds/slot facts, the linear mip
averages and sRGB encoding of the checker, and the sampler shape.
