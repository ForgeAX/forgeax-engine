# Environment response

This comparison renders the same nine spheres with Three.js r184
`scene.environment` and Forgeax `Skylight`. Skylight retains both diffuse and
specular environment lighting. AmbientLight is not its reference counterpart.

Rows are white metal, colored metal and a blue dielectric. Columns have roughness
0.1, 0.5 and 1. Both engines receive constant linear white radiance 1, use the
same perspective camera and sphere tessellation, and have no direct lights or
post effects. Forgeax's identity linear output mode keeps its HDR observation
available. Metrics use linear HDR before the output transform.

## Changes

| Owner | Previous behavior | Current behavior |
| --- | --- | --- |
| Solid Skylight | A 1x1 BRDF texture contained `[1, 0]`, independent of view angle and roughness. | Uses the existing Three r184 16x16 GGX DFG bytes, transposed once to the IBL UV convention. |
| Panorama BRDF bake | Multiplied two Schlick geometry approximations, despite describing them as height-correlated Smith. | Reuses Standard's `v_smith` visibility function; removes the two obsolete helpers. |
| Panorama LUT coordinates | Divided framebuffer pixel centers by `size - 1`. | Divides by `size`, matching normalized texel-center sampling. |
| Live GI reflections | The constant LUT concealed a missing multiple-scattering term: directional reflections retained only single scattering and metal contributed no diffuse light. | The GI diffuse composite consumes the existing Deferred response, adding cosine-weighted multiple scattering separately from the SSR-replaceable directional reflection. |

The solid environment still needs two white cube texels per face. Only its BRDF
texture grows from 4 to 1024 bytes. It gains no sampler, binding, shader branch,
per-frame upload or asynchronous bake. Resource ownership and retirement stay
with the existing fallback bundle. Absent Skylight still writes zero intensity.
The optional direct-light DFG policy is unchanged.

## Measurement

`environment-response.html` exposes Forward/Deferred and solid/panorama controls.
The verifier measures the central region and a separate grazing region of every
sphere. Each reported error is the largest absolute difference among their mean
linear RGB channels; background pixels are excluded. It is not an overall code
or image similarity percentage.

Before the fix, the solid environment's maximum region error against Three was
0.241708 in Forward and 0.241220 in Deferred. After replacing the constant LUT it
was 0.007269 and 0.006624 respectively on Chromium WebGPU/SwiftShader. The
panorama comparison against Three measured 0.020684 in Forward and 0.021225
in Deferred. The equivalent solid-versus-panorama comparison on Dawn fell from approximately
0.266 to 0.021 on both paths.

The browser gate requires errors below 0.01 for solid and 0.025 for panorama.
Panorama still uses a 256x256 table integrated with 1024 samples per texel, while
Three and the solid environment use the checked 16x16, 4096-sample table. Finite
integration, interpolation and remaining shading differences are not claimed
to be identical. The HDR studio extension below measures nonuniform input separately.

The Dawn regression also requires rough colored metal to absorb more energy,
smooth dielectrics to reflect more at grazing angles, and scenes without
Skylight to remain black. White-metal-only furnace tests cannot detect the old
constant LUT; the existing compensated/single-scatter furnace and fresh-device
RHI replay remain separate energy-conservation gates.

The full Dawn suite exposed the GI omission after the solid LUT was corrected.
At uniform radiance 0.5 and metal roughness 0.7, field reflection increased from
0.338576 to 0.484893, against the exact lane's 0.499557. The original independent
GGX lower bound (0.348875), energy ceiling, transport error and leak gates remain.
RHI replay also checks that the SSR fallback excludes the broad contribution.
This is a GI regression measurement, not an additional Three.js comparison.

```sh
pnpm --filter @forgeax/parity-color-lighting build
pnpm --filter @forgeax/parity-color-lighting preview
node apps/parity/color-lighting/scripts/verify-environment-response.mjs \
  http://127.0.0.1:4176/environment-response.html artifacts/skylight-response/browser
pnpm exec vitest run --project dawn \
  packages/runtime/src/__tests__/skylight-response.dawn.test.ts \
  packages/runtime/src/__tests__/ibl-furnace.dawn.test.ts
```

Use the repository's `ci:graphics` wrapper when the local Vulkan implementation
needs the pinned software driver. The browser verifier always enables Chromium
sandboxing and uses the existing software WebGPU launch configuration.

## Nonuniform HDR studio

The studio input adds three directional Gaussian lights of different colors and
widths to a dim background. Both engines receive identical 512×256 half-float
texels in top-to-bottom image order. The Three texture explicitly uses
HDRLoader's `flipY=true`; a bare DataTexture defaults to false. An initial
diagnostic mixed these conventions and appeared vertically inverted; it was
a fixture error, and no panorama conversion change is part of the repair.
Every case constructs a fresh World/Scene; the renderer persists so source
switching is exercised. Controls include 0° and 90° environment rotation.

This extension found two production differences:

| Difference | Repair |
| --- | --- |
| A second World's image reused the first World's numeric source slot, and materials read the device's last IBL output. | Use resource scope plus complete handle; publish completed IBL with its source, and select that output for material, feature and probe consumers. Solid Skylight discards prior image radiance. |
| Rough surfaces kept the mirror direction, sampling behind the tangent plane at grazing angles. | Share Three r184's roughness⁴ blend toward the normal between Skylight and ReflectionProbe sampling. |

At 0° on Chromium WebGPU/SwiftShader, the maximum material-region mean RGB error
was 0.917590 before source isolation and 0.026046 after source isolation
and reflection-direction correction (Forward).
Final Deferred error was 0.026030. At 90°, the final errors were 0.030386 and
0.030310. These are absolute linear-HDR channel errors, not similarity percentages.
The original uniform thresholds remain unchanged. The studio gate requires
region error below 0.05 and each material's spatial relative error below 0.25;
spatial error sums absolute channel differences over the same core/rim masks,
then divides by reference energy with a 0.01-per-channel floor.

The largest remaining spatial error is about 20% on the medium-rough copper
sample. Forgeax directly convolves GGX into five cube mips at roughness
0/.25/.5/.75/1; Three r184 WebGPU incrementally convolves GGX into CubeUV levels
and uses a nonlinear roughness-to-level mapping. This change does not claim
identical prefiltering or port that storage layout. Both use GGX; describing
current Three WebGPU PMREM as only a Gaussian blur would be inaccurate.

The real-Dawn regression checks a fully rough white-metal plane from frontal
and 60° viewpoints: maximum channel drift fell from 0.154892 to 0.000488.
It also switches images across Worlds with equal numeric handles, returns to
solid lighting, and renders distinct skybox and Skylight images together.
Before/after browser tapes retain the actual material bindings and baked inputs;
the corrected frame is additionally replayed on a fresh Dawn device.

To capture the same selected frame:

```sh
node apps/parity/color-lighting/scripts/verify-environment-response.mjs \
  'http://127.0.0.1:4176/environment-response.html?capture' \
  artifacts/environment-prefilter/browser --capture
```
