# UE Texture Volumetric Clouds

The UE-input comparison material and four converted textures from
`apps/vc-ue5/assets/clouds/sample-ue/`, preserved as a self-contained asset library.
The independent generator is in the parent directory, `../`.

| Output | Source Key |
|:--|:--|
| Cloud material | `material/sample-ue` (`2633e476-6b24-53de-bb5d-bde28fa24b96`) |
| Layout pattern | `texture/layout-pattern` |
| Layout mask | `texture/layout-mask` |
| Height profile | `texture/height-profile` |
| Volume noise | `texture/body-noise` |

The original package ID `019a50a5-0000-7000-8000-000000000006` and every output
key are unchanged. `assets/identity.ts` derives their GUIDs.

## Consume

Install this directory as `@forgeax-assets/ue-volumetric-clouds` and add that name
to `forge.json#assetLibraries`. `forgeax.library.assetRoot` mounts `assets/`;
the Pack imports all four `.raw` payloads through the standard `?bytes` source
snapshot route. Load `material/sample-ue` by its derived GUID and bind it to
`VolumetricCloudLayer.material`, as with the procedural material.

Both variants use the same Engine cloud cookers. Mount
`@forgeax-assets/volumetric-clouds` alongside this library and compose its build
plugin `1d4af749-fdc2-5783-a980-f17772ce317c` into the project's build root once.
The cloud material uses the local `reference-layout.wgsl` marker; the Engine
supplies the density and lighting kernels. No demo app module is required.

> [!IMPORTANT]
> The exported UE pixels retain the upstream license in `LICENSE.md`.
> This is a ForgeAX comparison material, not a native UE material graph.
> No `.uasset` files or original source backups are included.

See `ATTRIBUTION.md` and `assets/texture-definitions.ts` for conversion details
and immutable source hashes.

## Validate

From the Engine checkout containing this asset submodule:

```sh
node node_modules/vitest/vitest.mjs run --config forgeax-engine-assets/demo-assets/volumetric-clouds/sample-ue/vitest.config.ts
```

The test cold-loads the actual Pack through the Engine Worker, checks all five
outputs, verifies every texture's shape, format, byte length and SHA-256, and
checks that the material's four references resolve to those sibling outputs.
