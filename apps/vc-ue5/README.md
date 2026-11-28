# VC UE5

The current ground-level cloud demo, with live cloud, sun, quality and weather
controls. This is an authoring project for ForgeAX Engine and View.

## Shared assets

| Library | Source in the Engine checkout | Contents |
| :-- | :-- | :-- |
| `@forgeax-assets/volumetric-clouds` | `forgeax-engine-assets/demo-assets/volumetric-clouds` | Procedural textures, cloud materials, material instances and cloud cookers |
| `@forgeax-assets/ue-volumetric-clouds` | `forgeax-engine-assets/demo-assets/volumetric-clouds/sample-ue` | Converted UE textures and the comparison material |

The UE asset library is mounted through `forge.json#assetLibraries`. The app's
Generated Clouds Pack reuses the shared package's GUIDs, parameters and cloud
cookers. Initialize the pinned asset checkout before running the demo.

Generated Clouds, the three Nubis sets and Alpine Valley generate their four
textures during Pack cooking with hardware WebGPU. The CPU seeds the noise
inputs and saves the resulting bytes. A fresh cook needs a hardware WebGPU
adapter on the build host. The browser loads the cooked textures at their
original GUIDs and does not run the generators. The UE set uses its imported
textures.

`assets/build.ts` supplies the app's loading labels and rendering profile while
using the shared cloud cookers. The app retains its ground scene, UI, live
controls, weather presets and interaction checks.
Development, production builds and Web ZIPs use the accepted demo's single-threaded
Engine/Render execution policy.

## Run

Use an Engine containing the cloud day/night fixes and the startup shadow-writer
admission fix. The original `7cae6725aa` alone has a first-frame cloud shadow
dependency failure. Initialize the asset submodule at a revision containing both
libraries above.

From a compatible Engine checkout:

```sh
pnpm install --frozen-lockfile
pnpm --filter @forgeax/app-vc-ue5 exec forgeax project engine use-local ../..
pnpm --filter @forgeax/app-vc-ue5 check
pnpm --filter @forgeax/app-vc-ue5 typecheck
pnpm --filter @forgeax/app-vc-ue5 test
pnpm --filter @forgeax/app-vc-ue5 dev --headless false --rhi-capture false
```

Open this directory in View to inspect and edit the project. The Engine supplies
the View host; no additional host root is authored here.

## Package

```sh
pnpm --filter @forgeax/app-vc-ue5 build
pnpm --filter @forgeax/app-vc-ue5 play:release
pnpm --filter @forgeax/app-vc-ue5 package --output .forgeax/exports/vc-ue5-web.zip
```

The web ZIP is self-contained and can be served over HTTP. The authoring archive
extracts to `apps/vc-ue5/` under an Engine checkout and obtains the two shared
libraries through its relative package dependencies.

Archives exclude `node_modules`, caches, diagnostics, Git history and local
Engine bindings. This machine's standalone `pnpm-workspace.yaml` and
`pnpm-lock.yaml` are local dependency overrides and are also excluded from the
authoring archive; a clean consumer uses the Engine workspace instead.
