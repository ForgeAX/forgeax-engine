# hero-asset: plasma blaster, exact to game-ready outputs

One sci-fi plasma blaster built from exact B-rep parts (pure TypeScript). Three outputs are derived from
that one source with `deliverAsset` (`src/deliver.ts`): a desktop hero, a mobile hero and a mobile prop. The
example has no hand-rolled mesh, UV or pack route; every output goes through the kernel call.

Regenerate with `run-outputs.sh`. It is slow (the fine desktop mesh and the mobile-prop size sweep).

## Outputs

| Output | Profile | Quad size | Triangles | Vertices | Materials | UV coverage | Exact UV overlap pairs | Verdict |
|:--|:--|--:|--:|--:|--:|--:|--:|:--|
| `desktop-hero` | desktop-hero | 0.35 | 55790 | 31887 | 4 | 0.436 | 0 | ok |
| `mobile-hero` | mobile-hero | 0.9 | 11170 | 7491 | 1 (Atlas) | 0.420 | 0 | ok |
| `mobile-prop` | mobile-prop | 1.2 | 7442 | 5376 | 3 | 0.429 | 0 | ok (after 1.0 and 1.1 failed) |

- `mobile-hero` merges BodyMetal, DarkHardware, Glass and Accent into one `Atlas` slot. Its verdict before the
  merge is `budget-materials` (4 against a limit of 2); after the merge it is ok.
- `mobile-prop` merges DarkHardware into BodyMetal (4 slots to 3, the limit).
- Vertices are the GPU count per corner in `assetStats`. The OBJ shares positions, so its count is lower.
- Pins live in `__tests__/outputs.test.ts`. Vertex counts rose (desktop 31722 to 31887, mobile-hero 7384 to 7491,
  mobile-prop 5148 to 5376) because the export uses the crease normals the bake used: hard edges split vertices
  that the former smooth export shared. `verticesBefore` carries the same counts because the before-merge
  measurement runs the same export path.

## Normal bake (desktop-hero detail onto each mobile base)

`deliverAsset` with `bake: { resolution: 1024, maps: ['normal'] }` and the kernel's default `detailSize`
(`min(sizes) / 2.5`). The bake runs one cage group per part.

| Output | Bake verdict | Clipped samples | Ray misses | Max cage offset | Max ray |
|:--|:--|--:|--:|--:|--:|
| `mobile-hero` | pass | 0 / 455609 | 0 | 0.139 | 0.226 |
| `mobile-prop` | pass | 0 / 454853 | 0 | 0.207 | 1.179 |

The lit pictures compare each mobile output against the fine desktop picture (mean absolute RGB difference inside
the silhouette, 0..255; lower is closer):

| Output | View | flat | normal-mapped |
|:--|:--|--:|--:|
| `mobile-hero` | iso | 2.29 | 0.81 |
| `mobile-hero` | muzzle-fins | 3.90 | 2.20 |
| `mobile-hero` | grip | 1.58 | 0.28 |
| `mobile-prop` | iso | 2.81 | 1.32 |
| `mobile-prop` | muzzle-fins | 5.60 | 3.49 |
| `mobile-prop` | grip | 1.66 | 0.51 |

## Known limits

- The desktop source is the detail: the mobile outputs carry its normal map, not its geometry.
- The `mobile-prop` sweep tries 1.0 and 1.1 first; both fail the triangle budget and the vertex budget.

## Outputs on disk

Per output, under `<GALLERY_OUT>/<output>/`: `<output>.obj`, `checker3d-iso.png`, `checker3d-front.png`,
`checker3d-top.png`, `uv-layout.png` (seams in red), `uv-checker.png`. Mobile outputs add `normal-map.png` and
the `lit-*` pictures. `outputs.json` next to them holds every number above.

## Tests and commands

`__tests__/outputs.test.ts` reads `outputs.json` from `HERO_OUTPUTS_DIR` and skips without it. It pins ids,
order, verdicts, sizes tried, triangles, vertices, material count and exact overlap pair counts. It asserts that
both bakes pass with no clipped sample, no ray miss and bounded cage offsets, and that the normal map lowers every
view's difference to the fine picture.

`__tests__/hero-asset.test.ts` checks the exact model (valid solids, refusal set `['R1']`).
`__tests__/materials.test.ts` checks the source material assignment and the lit rasteriser's normal-map frame.

```
GALLERY_OUT=<dir> bash examples/hero-asset/run-outputs.sh                 # derive, measure, write outputs
HERO_OUTPUTS_DIR=<dir> forgeax-heavy --low ./node_modules/.bin/vitest run --maxWorkers=2 examples/hero-asset
```
