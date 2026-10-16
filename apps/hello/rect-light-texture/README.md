# `@forgeax/hello-rect-light-texture`

> [!IMPORTANT]
> Demo and Dawn witness for `RectAreaLight.sourceTexture`. The app owns only the
> scene and its evidence; `@forgeax/engine-render` owns the component, the shared
> light-texture array and the LTC shading.

## Interactive

Run `pnpm --filter @forgeax/hello-rect-light-texture dev`. A 45-degree tilted
3 x 1.2 panel lights a grey floor, a glossy metal sphere (left) and a rough one
(right). `?source=<name>` picks the initial image and the S key cycles through
them; the HUD shows each image's size and storage format. The visible emitter quad is an ordinary unlit mesh that
shows the same texture; the light itself does not draw its surface.

The light's texture u follows its local +X and v its local -Y, so the image's
top row is the panel's top edge. Diffuse receivers see the texture's mean over
the whole panel footprint (coarse mip), while glossy reflections resolve its
detail (fine mip), as in Unreal's rect-light SourceTexture.

## Source gallery

`src/images.ts` paints each image once in linear float RGB and encodes it into
the storage format it exercises, so the gallery covers every accepted
`sourceTexture` encoding, NPOT sizes and a source larger than the 256 x 256
light slice:

| `?source=` | Image | Size | Format |
|:--|:--|:--|:--|
| `stained-glass` | Voronoi glass with lead came | 512 x 256 | `rgba8unorm-srgb` |
| `sunset` | sky gradient, HDR sun disc (> 1, clamped), ridge silhouette | 384 x 192 | `rgba16float` |
| `tv-bars` | SMPTE-style bars with reverse and PLUGE rows | 300 x 170 | `bgra8unorm-srgb` |
| `neon` | concentric pink rings and a cyan zigzag on black | 1024 x 512 | `rgba8unorm-srgb` |
| `blinds` | window with mullions seen through slats (grayscale) | 256 x 128 | `r8unorm` |
| `rainbow` | hue sweep fading to white | 128 x 64 | `rgba32float` |
| `textured` / `mirrored` | red/green halves with a white top band (smoke falsifiers) | 64 x 32 | `rgba8unorm-srgb` |
| `uniform` | no source texture | - | - |

## Dawn smoke

`pnpm --filter @forgeax/hello-rect-light-texture smoke` renders
uniform -> textured -> mirrored -> uniform on one renderer and gates:

- textured: the floor under the red half is redder than under the green half
  (`log(r/g)` asymmetry >= 0.15);
- mirrored: the asymmetry flips sign with the same magnitude (orientation falsifier);
- final uniform: matches the first uniform phase within 0.05 (no stale slice);
- no floor discontinuity along two floor lines (the mip-border ring regression);
- every gallery image is accepted, moves the floor probes away from uniform
  (a rejected source would leave only the emitter quad changed), stays
  continuous on the floor and differs from every other gallery image;
- BC7 phases (when the device has `texture-compression-bc`): `neon` and
  `stained-glass` are UASTC-encoded with offline mips, transcoded to BC7 and
  bound as sources. Each phase must run exactly one GPU resample on its switch
  frame and none on steady frames, and match the uncompressed render of the
  same image within `SMOKE_BC7_EPSILON` (default 0.01 mean abs diff);
- no renderer or console errors, and a 60-frame receipt.

`SMOKE_ARTIFACT_DIR=<dir>` writes one PNG per phase. `SMOKE_PERF_ROUNDS=<n>`
adds alternating warmed uniform/textured blocks and reports median frame time;
it is diagnostic only. `SMOKE_SIZE=<w>x<h>` changes the 256 x 160 target.

The deeper RHI-debug evidence (upload of all nine mips, slice contents, slot
metadata, replay-vs-live parity) lives in
`packages/runtime/src/__tests__/rect-light-source-texture.dawn.test.ts`; the GPU
resample path (CPU parity, BC7 residual, tape structure, fresh-device replay of
each pack dispatch) lives in
`packages/render/src/__tests__/light-texture-resample.dawn.test.ts`.
