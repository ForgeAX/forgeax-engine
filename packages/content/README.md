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
| `water.textures` | normal, river-diffuse, river-normal, foam, foam-normal, noise, volume-noise, impulse-noise | Source PNGs are pinned in `forgeax-engine-assets/water`; `scripts/prepare-water-content.mjs` verifies every provenance digest and copies them beside the unchanged Meta and Pack sources. `volume-noise` is a genuine linear RGBA8 128-cubed 3D texture with the single officially exported mip. `impulse-noise` is the default local-fluid force parent's native 2D sRGB mip chain. |

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

`water/volume-noise.pack.ts` reads a lossless slice atlas through `readByGuid`,
validates its shape, linear format, mip policy and exact RGBA bytes, then repacks
the source slices into a native 3D `TextureAsset`. The atlas is a build input,
not a runtime shader sampling path. Provenance records the official DDS hash,
BGRA-to-RGBA exchange, slice order and both pixel digests. FoamRT is a temporary
RenderGraph target and is never published as a static Content texture.

`water/impulse-noise.pack.ts` reads the verified 256x256 grayscale source by GUID.
Its linear/no-mip Meta preserves the PNG bytes for producer-owned Pow22 decode,
HSV Value exponent 1.2 and legacy Sharpen4 filtering. Each sharpened level reads
the separate 2x2 average pyramid with wrapped taps; the output is nine packed
`rgba8unorm-srgb` mips. The runtime default impulse samples local UV0 with repeat,
linear min/mag and nearest mip filtering. `T=0` makes the parent Panner static;
the connected `Pan Speed=0.5` overrides its inline speeds. Asset LODBias -1 is
cook-time mip stripping, not a shader bias; the installed zero-bias World group
keeps all nine levels. Hashes, source settings, sampler scope and unresolved
upstream platform compression/sample parity stay in `water/provenance.json`.

> [!IMPORTANT]
> Water Content is authored source, not runtime or visual acceptance. Texture
> provenance records the upstream source and unresolved independent redistribution
> permission; mounting or cooking the library does not establish that permission.

## Recovery

`pnpm --filter @forgeax/engine-content build` prepares the eight original PNGs
from the pinned asset checkout before building JavaScript. `ci-core` explicitly
runs the existing pinned asset preparation before its shared package build;
consumer jobs use the same preparation. Public SDK source builds validate the
sealed Water resource closure directly without a private Assets checkout.
Native Node GI also runs the pinned preparer before its fresh full package
build, including when a checkout starts with `submodules: false`.
Missing or changed source bytes
fail preparation; the copy preserves the original filenames, Meta GUIDs and
pixel bytes. Licensing and redistribution uncertainty remain in
`water/LICENSE.water.txt` and `water/provenance.json`.

On a shared contributor checkout, export the pinned Assets commit's `water/`
directory outside the checkout. `pnpm build:engine --assets-source-root <export>`
and `pnpm ci:focus --kind node --select <test> --assets-source-root <export>`
fetch the exact gitlink object and verify every exported Water blob without
checking out the shared Assets repository. The package launcher prepares these
bytes before its existing cache lookup and forwards the Water directory to
`pnpm --filter @forgeax/engine-content build --source-root <export>/water`.
Content retains every provenance digest, Meta, GUID and its normal tsup config.
Omitting these parameters preserves the normal CI and public source behavior.

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
