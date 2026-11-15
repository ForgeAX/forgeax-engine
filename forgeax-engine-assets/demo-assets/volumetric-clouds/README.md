# Volumetric Cloud Assets

Two build-time cloud material and texture libraries migrated from
`apps/vc-ue5/assets/clouds/` are grouped in this folder.

| Variant | Package Directory | Material Input | License |
|:--|:--|:--|:--|
| Procedural | `.` (`@forgeax-assets/volumetric-clouds`) | Seeded Perlin/Worley texture recipes in `assets/` | Apache-2.0 |
| UE texture-input | `sample-ue/` (`@forgeax-assets/ue-volumetric-clouds`) | Four exported `.raw` textures and material adapter in `sample-ue/assets/` | See `sample-ue/LICENSE.md` |

The procedural package generates every texture sample without reading UE pixels.
Its package payload contains only its own `assets/` and README; the UE variant
has its own package entry and asset root. Both keep their original package IDs
and share the same Engine cloud cookers. Neither includes `.uasset` files,
runtime network fetches or generated DDC files.

| Asset | GUID / Source |
|:--|:--|
| Sky Scene | `7b2bb2eb-218f-5745-8c81-481b083f5a76` / `scene/sky` |
| Reference cloud material | `4c77c4c0-ef1e-515d-9da9-aec256aca42d` / `material/reference-layout` |
| Build plugin | `1d4af749-fdc2-5783-a980-f17772ce317c` / `cloud-build.pack.ts` |
| Texture recipes | Layout pattern, layout mask, height profile, 3D body noise |
| Additional outputs | Uniform and band materials; three material instances |
| Public generation parameters | Seed, resolution and ten layout/shape controls in `assets/clouds.pack.ts` |

The cloud package retains `019a50a5-0000-7000-8000-000000000004` and the original
texture/material source keys. The added Sky Scene supplies a full Atmosphere and
one VolumetricCloudLayer. Its consumer supplies the selected sun and camera.

## Consume

Mount this package as `@forgeax-assets/volumetric-clouds` in `forge.json#assetLibraries`.
The package's `forgeax.library.assetRoot` selects `assets/`; consumers reference the
Sky Scene through the native `SceneEntity.instance.source` GUID. Compose the build
plugin GUID with the consumer's existing build root to register the cloud cookers.
All shader compilation and texture generation stay in the ordinary Pack producer.

The Engine contributor template uses a local package link to this submodule.
Initialize `forgeax-engine-assets` at the Engine commit's pinned revision before
installing that template's dependencies.

## Validate

From the Engine checkout containing this asset submodule:

```sh
node node_modules/vitest/vitest.mjs run --config forgeax-engine-assets/demo-assets/volumetric-clouds/vitest.config.ts
node node_modules/vitest/vitest.mjs run --config forgeax-engine-assets/demo-assets/volumetric-clouds/sample-ue/vitest.config.ts
node packages/devkit/dist/cli.mjs project play ../../forgeax-engine-assets/demo-assets/volumetric-clouds/scripts/game3d-playthrough.mjs --root templates/game-3d --json
```

The playthrough imports the unchanged Game3D journey, then captures the sky after
real mouse input and again after reload. It is a contributor acceptance script,
not a runtime dependency of the library.
