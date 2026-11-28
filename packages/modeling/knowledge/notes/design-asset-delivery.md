# Design: deliverAsset, one call from an exact source to a game asset

Status: implemented in steps 1 to 8 on branch feat/fable-deliver (not merged). Evidence: the hero-asset outputs stage
(`examples/hero-asset/outputs.ts`), where both mobile bakes now pass with the steps below.

## Goal

A fine exact (B-rep) source becomes a game asset for a named output profile: low-poly quads,
unique UVs, a baked normal map that keeps the fine detail, and a report the kernel itself
produces. Today an author assembles this from about a dozen calls; the hero-asset example
needed two non-obvious choices (respect sharp B-rep boundaries as seams, one cage group per
part) that a single owner should make once.

## Surface

```ts
deliverAsset(source: DeliverySource, profile: AssetOutputProfileId | AssetOutputProfile,
  options: DeliverOptions): Result<DeliveredAsset, DeliveryError>

interface DeliverySource {
  readonly parts: readonly { name: string; shape: Shape; material: string }[];
}
interface DeliverOptions {
  readonly exact: ExactStage;              // injected, as for model({ exact })
  readonly sizes: readonly number[];       // quad sizes tried in order; first passing verdict wins
  readonly detailSize?: number;            // quad size of the bake detail; default min(sizes) / 2.5
  readonly merge?: Record<string, string>; // source slot -> output slot; default: see Defaults
  readonly bake?: { resolution: number; maps: readonly ('normal' | 'ao')[] };
  readonly lods?: readonly number[];       // coarser quad sizes, each > sizes' delivered size (step 5)
}
interface DeliveredAsset {
  readonly mesh: MeshAsset;
  readonly lods: readonly MeshAsset[];
  readonly textures: readonly { slot: string; map: 'normal'; texture: TextureAsset }[];
  readonly report: DeliveryReport;
}
interface DeliveryReport {
  readonly profile: string;
  readonly size: number;                   // the size that passed
  readonly attempts: readonly { size: number; triangles: number; vertices: number; materials: number; issues: readonly AssetBudgetCode[] }[];
  readonly stats: AssetStats;              // assetStats of the chosen mesh
  readonly budget: { ok: true; issues: readonly Issue<AssetBudgetCode>[] }; // a delivered asset passes
  readonly uv: { islands: number; coverage: number; exactOverlapPairs: number; paddingTexels: number };
  readonly bake?: { maps; detailSize: number; pass: boolean; issues: readonly BakeIssue[]; groups: readonly BakeGroupReport[]; refusal?: { code; expected; hint } };
  readonly steps: readonly { step: DeliveryStep; status: 'ok' | 'skipped' | 'failed'; detail: unknown }[];
}
type DeliveryStep = 'quad' | 'assign' | 'seams' | 'unwrap' | 'pack' | 'budget' | 'bake' | 'lod';
```

Expected failures return a `DeliveryError` (`{ code, expected, hint, detail }`) with a closed
`DeliveryErrorCode` union: `delivery-invalid-argument`, `delivery-part-refused`,
`delivery-no-size-fits`, `delivery-kernel-failed`. A failing bake is data in the report
(`bake.pass === false`), not an error, so the caller can still ship flat.

### Changes from the first draft, with reasons

- **`DeliveryError`, not `ModelingError`.** `ModelingError` carries only the kernel's closed
  `ModelingErrorCode`, and `src/errors.ts` is in the exact digest closure, so it cannot gain
  delivery codes without changing the closure digest. A local type with its own closed union
  keeps the kernel's error vocabulary untouched.
- **`delivery-bake-failed` removed.** The bake already reports `pass` and `issues` as data;
  making a failed bake an error would force the flat-ship path through an exception-shaped
  branch for a result the caller is expected to inspect.
- **`sizes` is required.** A default size list would bake a hidden quality choice into the
  profile. The example and tests pass explicit sizes; a default comes only after measuring a
  profile's real sweep.
- **`detailSize` default is `min(sizes) / 2.5`, not "the finest size".** For single-size profiles
  such as `mobile-hero` (`[0.9]`) the finest size is the only size, which gives no detail
  advantage. `min(sizes) / 2.5` keeps the detail cage finer than the output mesh for every
  profile; the hero example passes `detailSize: 0.35` explicitly so its pinned numbers do not move.
- **`budget.ok` is `true` by construction.** A failing verdict never returns; it becomes
  `delivery-no-size-fits` with every attempt's issue codes in `detail.attempts`.
- **Report carries `profile`, `size` and `attempts`.** The size search needs a record of what
  was rejected; without it a `no-size-fits` failure cannot say which size came closest.
- **AO joins the normal map (step 2).** The brief asks for normal and AO; the first draft
  listed normal only. `bake.maps` takes `'normal' | 'ao'`, and both come from one bake job
  over the same groups, so AO adds no second cage or group pass.
- **The bake refusal is data.** A kernel refusal (measured: `resolution: 0` gives
  `model-invalid-argument`) returns `bake.pass: false` with `bake.refusal`, no textures, and a
  `bake` step with status `failed`. The flat asset still ships, as the first draft intended.
- **The bake detail is built from the same parts at `detailSize`, without merge.** It is
  tagged `bake:<part>` like the base, so each part is its own group. The cage is the kernel's
  automatic cage (`offset` and `maxRay` `'auto'`), which is the offset search: at size 0.1
  with detail 0.04 the measured offsets are 0.0264 m for `body` and 0.0124 m for `barrel`,
  with no clipped or missed rays.
- **Bound correction.** This note said the minified `./brep` bundle must stay under 350000
  bytes. The test (`brep-browser-smoke.unit.test.ts`) enforces 450000 and measured 397029
  for this build; the test is the authority, so the number here is corrected to match it.

### Texture byte budget (step 4)

- **Where the bytes come from.** `textureBytes(width, height, mips)` (in `src/asset-budget.ts`)
  counts RGBA8 texels with the same mip halving the texture writer uses. The bake runs with
  `mips: false`, so the verdict uses the no-mip size. `textureBytes(128, 128, false)` is 65536, the
  real `data.byteLength` of a baked 128 normal map; a unit test pins that equality.
- **The verdict runs before the bake.** The size search picks a size before any texture exists,
  so the estimate is computed from the bake request (`maps.length` x `textureBytes`). The bake
  report carries the measured total in `bake.bytes`.
- **Profile field is optional.** `AssetOutputProfile.maxTextureBytes` is optional, so custom
  profiles keep their shape. It is checked only when the delivery passes a bake estimate.
  `checkAssetBudget` takes the estimate as an optional third argument, so the example's existing
  calls are unchanged.
- **Built-in limits: 12 MiB (mobile-hero, mobile-prop, mobile-scenery) and 32 MiB (desktop-hero).**
  Measured sizes: a 1024 map with mips is 5.33 MiB, so two maps (normal + AO) are 10.67 MiB, and
  the hero bake fits. A 1 or 2 MiB limit would reject every hero bake, so those were not used.
  These are starting estimates, like the other profile numbers; they bound the current bakes and
  make no quality claim.
- Code `budget-texture-bytes`, hint in the table; falsifiers: a 1024-byte limit gives
  `delivery-no-size-fits` with `budget-texture-bytes`; without a bake the limit is not checked.

### LOD chain (step 5)

- **Route.** Each LOD is the coarser quad of the same parts, not a reduction of LOD0. The step
  reruns `quadPart` at the LOD size, then `assemble` with the same merge map, so LOD materials
  match LOD0 slot for slot. UVs come from that run's own unwrap and pack, so LOD1..n carry their
  own UV layout and do not share LOD0's texel map. A shared-UV reduction that keeps seams stays
  the later, stronger route.
- **Contract (refusal as data).** A LOD must be strictly coarser than the delivered size
  (`delivery-invalid-argument` otherwise). It is refused with `delivery-kernel-failed`, step
  `lod`, when `lodTopologyReport` shows any of: an open boundary chain (`freeChains` != 0), a
  boundary edge set different from LOD0's (`boundarySetEqualsLod0` false), or more non-manifold
  edges than LOD0 has. The refusal detail carries these numbers under `cause`.
- **Output.** `DeliveredAsset.lods` holds LOD meshes in the caller's order. A `lod` step with one
  row per size (`size`, `triangles`, `freeChains`, `boundarySetEqualsLod0`, `nonManifoldEdges`)
  is recorded only when `lods` is requested; without it there is no `lod` step and `lods` is empty.
- **Measured (blaster parts, quad sizes).** Triangles: 0.9 gives 11170, 1.2 gives 7442,
  1.6 gives 5974, 2.2 gives 5236. Every LOD has `freeChains` 0 and `boundarySetEqualsLod0` true.
  Non-manifold edges: LOD0 23, LOD1 14, LOD2 40, LOD3 9. The non-manifold count is inherited
  from the quad input, so the gate compares each LOD with LOD0 rather than with zero.
- **Falsifiers in the unit suite.** A `lods` size equal to the delivered size gives
  `delivery-invalid-argument`. A stub `quadrangulate` for the LOD size that removes one face
  leaves an open chain, and the step refuses with `delivery-kernel-failed`, step `lod`,
  `freeChains` > 0. The happy path checks decreasing triangles and the `lod` rows.

### UV overlap repair (step 6)

- **Measured, not the planned snap.** The blaster's `mobile-hero` pack leaves 15 exact UV overlap
  pairs (the unwrap has 0). A snap of corners that share a mesh vertex changed nothing: the pairs
  share no vertex (13 of 15); the other 2 share one vertex, and the corners of that vertex are
  1.3e-3 apart in one measured pair, so they are not one point. In 3D the
  paired faces lie on different planes (for example z = 4.70 and z = 4.85) with no common edge. The
  overlap is a thin sliver about 1e-6 high and 1e-3 to 1e-2 wide: one face's UV edge lies on
  another's within rounding, so the unwrap leaves two faces of one island touching in UV and the
  rotation and scale turn that touch into a crossing. No corner snap can separate them.
- **Decision: the kernel's existing repair.** `uv.pack` already takes `resolveOverlaps` (cut every
  face in a pair, flatten it on its own, pack again). `deliverAsset` now passes `resolveOverlaps: 2`
  (constant `OVERLAP_REPAIR_PASSES`, recorded in the pack step detail). Measured on mobile-hero:
  0 passes leave 15 pairs, 1 pass leaves 1, 2 passes leave 0. The repair adds 58 vertices
  (7326 to 7384) and no triangles (11170 both ways). The budget verdict is unchanged.
- **Falsifier.** `deliverAsset UV overlap repair (step 6)` runs the blaster at mobile-hero and expects
  `uv.exactOverlapPairs` 0, 11170 triangles and `resolveOverlaps` 2 in the pack step. Confirmed red
  before the repair (`expected 15 to be 0`) and green after. The blaster is the only reproducer
  found; primitive pairs, cones and boxes all lay out with zero overlap.
- **Open.** The example's `runItKnownDefect` (`outputs.test.ts`) still describes this as a seam-slit
  defect. Its description and the `it.fails` marker need the step 8 switch; the repair is the fix.

### Material atlas (step 7)

- **Contract.** `deliverAsset(..., { albedo: { size, colors } })` returns `textures.albedo`, an
  sRGB rgba8 texture over the delivered UV layout. Each covered texel takes the linear colour of
  the source slot of its face (before `merge`), encoded to sRGB bytes. Uncovered texels are
  transparent black. The atlas is independent of `bake`, so it works without normal or AO maps.
- **Source slot from the part, not the mesh.** `merge` renames the mesh slot in `assign`, so the
  atlas reads each face's part tag and maps it to the part's source material. This is what keeps
  two colours apart when they share one output slot (`mobile-hero` `Atlas`).
- **Refusal as argument error.** A used source slot with no finite RGB colour, or an invalid size,
  is `delivery-invalid-argument` before any size is tried. A missing colour is never a default fill.
- **Reuse.** Rasterisation is `faceOwners` in `uv-textures.ts` (the same owner map the UV heat map
  uses); `checkSize` gives the texture size limit. No second raster path.
- **Step trail.** An `atlas` step (`status: ok`, slot list) sits between `bake` and `lod`.
- **Falsifiers.** `deliverAsset material atlas (step 7)`: two source slots merged into one output
  slot must yield exactly two distinct colours in the atlas (red if merge collapsed the colours),
  and a missing colour must refuse with `delivery-invalid-argument`.
- **Open.** The atlas is one colour per face slot, not a sampled source texture. Source textures
  (for example a decal or a source image) are not part of this step.

### Hero example switch (step 8): done

- **Session on the result.** `DeliveredAsset.model` (commit 320852aa) is the base-level session that produced
  `mesh`, read-only for pictures and inspection. Editing it after delivery does not change `mesh`.
- **Route.** `examples/hero-asset/outputs.ts` calls `deliverAsset` once per output and reads `delivered.model`
  for the OBJ and pictures. The hand-rolled files are deleted: `quad.ts`, `shelf-pack.ts`, `export.ts`,
  `uv-v3.ts`, `summary.ts`, `stage.ts`, `run.sh`. `run-outputs.sh` is the only runner.
- **Pins.** desktop-hero 0.35 gives 55790 triangles and 31722 vertices, 0 exact overlap pairs. mobile-hero 0.9
  gives 11170 triangles and 7384 vertices (7326 was the pre-repair count; step 6 adds 58), 0 exact overlap
  pairs, 1 material after the Atlas merge. mobile-prop picks 1.2 (7442 triangles, 5148 vertices) after 1.0 and
  1.1 fail the budget. `runItKnownDefect` is a normal test asserting 0 exact overlap pairs.
- **Fixture.** The blaster is one shared file, `src/__tests__/fixtures/hero-blaster.ts`.

#### Bake breakdown, mobile-hero at 1024

Measured with one scratch call per path (same profile, merge and size as the example; `detailSize` defaults to
`min(sizes) / 2.5` = 0.36). One run on this machine:

| Phase | Time |
|:--|--:|
| base delivery, no bake (quad, assign, seams, unwrap, pack, budget) | 9.9 s |
| full `deliverAsset` with `bake: { resolution: 1024, maps: ['normal'] }` | 53.5 s |
| bake share of that call (difference, detail build and `bakeMaps` together) | about 43.6 s |

The step trail does not time the detail build and the `bakeMaps` call separately, so their split is not measured
here. The earlier figure of about 86 s was taken before the step-8 switch and is superseded by this run. The
desktop fine build alone was about 84 s in that earlier run and is not repeated here.

**Optimisation.** Not done. No change is obviously safe and local: the 12 cage groups and the detail mesh are
the work the bake requires, and reducing the detail resolution or group count would change the pinned
evidence. Reporting it as an open item.

#### Known visible finding

The normal map shows vertical streak noise in the bottom band of the baked picture. It likely corresponds to the
thin strip islands at the top of the UV layout (a bake smear on the narrowest islands). Not confirmed; open.

### Defaults decided (step 3)

- **Size search keeps `sizes` required and in caller order.** The first size whose verdict
  passes wins; every size tried is in `attempts`. Measured on the blaster parts with
  mobile-prop `[1.0, 1.1, 1.2, 1.3]`: 1.0 fails `budget-triangles`/`budget-vertices` (10328 tri,
  6849 vert), 1.1 fails `budget-triangles` (8512 tri), 1.2 passes (7442 tri, 5148 vert). Sorting
  the sizes or adding a default list would change which size wins for the caller's stated
  order, so neither is done.
- **Default `merge` when `options.merge` is omitted.** Fold the lightest source slot (by quad
  face count) into the heaviest until the slot count is at most `profile.maxMaterials`; ties
  resolve by material name. An explicit `merge`, including `{}`, replaces the default. The
  applied merge is in the `assign` step detail, so the report shows what was chosen.
- **Why this rule.** The budget limits slot count, not slot names; folding the lightest slot
  costs the least texel-weight of the surviving material. It stops at the limit, so a profile
  with room (mobile-prop, limit 3) keeps the slots it needs.
- **Moved numbers (blaster parts, default merge, measured in step 3).**
  | Output | Hand merge (example) | Default merge | Triangles / vertices |
  |:--|:--|:--|:--|
  | mobile-hero, size 0.9 | 1 slot `Atlas` | 2 slots: `BodyMetal`, `DarkHardware` (Glass, Accent folded into DarkHardware) | 11170 / 7326 both |
  | mobile-prop, size 1.2 | `BodyMetal`, `Glass`, `Accent` | `BodyMetal`, `Glass`, `DarkHardware` (Accent folded) | 7442 / 5148 both |
  | desktop-hero, size 0.35 | no merge | no merge (4 slots within limit) | 55790 / 31722 both |
  The counts do not move; only slot names and the mobile-hero slot count do. The default
  leaves `mobile-hero` at 2 slots where the hand merge reaches 1, because the rule stops at the
  limit. Without any merge the same source is `delivery-no-size-fits` with `budget-materials`.
- Build time for the blaster parts in the probe: 26 s for `buildBlaster()`, excluding delivery.

## Where it lives

- File `src/deliver.ts`, exported from the main entry `.`.
- The main entry must not pull B-rep code, and the `./brep` bundle has a size bound
  (`src/brep/__tests__/brep-browser-smoke.unit.test.ts`, under 450000 bytes minified). The
  exact closure must also never import `model.ts` (`brepViolations` in the digest guard).
  So `deliverAsset` cannot live in `./brep`, and it cannot import `./brep` statically.
- It reaches the exact stage only through the injected `ExactStage`, exactly as `model()` does:
  extend `ExactStage` in `src/model.ts` with `quadrangulate` (a type-only import, already the
  pattern). The main bundle gains no B-rep bytes and `./brep` is unchanged.
- `./tools` (Node only) may later add a parallel variant on `bakeMapsParallel`; the main
  entry stays realm-neutral.

## Reused src modules

| Module | Role |
|:--|:--|
| `brep/quad.ts` `quadrangulate` (via `ExactStage`) | per-part quad mesh, mesher routes |
| `model.ts` `append`, `assign`, `tag`, `uv.plan`, `uv.unwrap`, `uv.pack`, `toMesh` | assembly and UVs |
| `seams.ts` `planSeams` with `respectSharp` | sharp B-rep boundaries become seams |
| `uv.ts` `defaultProtectMip`, `paddingTexels` | pack padding that clears mip bleed |
| `compute/uv-ts.ts` `measureUv`; `uv-overlap.ts` `uvOverlapPairs` | island and exact overlap facts |
| `bake.ts` `bakeMaps` with `tags.groupPrefix`; `compute/bake-cage.ts` | per-part cage, bake checks |
| `asset-budget.ts` `assetStats`, `checkAssetBudget`, `ASSET_OUTPUT_PROFILES` | stats and verdict |
| `lod-topology.ts` `lodTopologyReport` | LOD boundary checks |

## Example files it replaces

| File | Lines | Becomes |
|:--|--:|:--|
| `examples/hero-asset/outputs.ts` | 603 to 493 | profile list, one `deliverAsset` call per output, pictures from `delivered.model` |
| `examples/hero-asset/uv.ts` | 160 to 96 | pictures only (`uvPictures`, `drawSeams`, `checkerViews`) |
| `examples/hero-asset/quad.ts` | 109 deleted | mesher route choice is in the quad step |
| `examples/hero-asset/shelf-pack.ts` | 139 deleted | the kernel pack replaces it |
| `examples/hero-asset/export.ts`, `uv-v3.ts`, `summary.ts`, `stage.ts` | 47, 47, 67, 54 deleted | hand-rolled export, UV, summary and stage code |
| `examples/hero-asset/run.sh` | 13 deleted | `run-outputs.sh` is the only runner |
| `examples/gallery/common.ts` `runQuad`, `quadOptions` | part of 198 | quad step options |

Step 8 net change in `examples/hero-asset/`: 206 lines added and 932 removed (numstat against 320852aa,
the head before the switch).

Pictures (`raster3d.ts`, 352 lines, and `uv.ts`, 160 lines) stay in the example: rendering
evidence is not kernel output.

## What the kernel is missing

- **Material atlas.** Decided and implemented in step 7 (see "Material atlas (step 7)"): a
  base-colour atlas per source slot over the shared UV layout. Source textures are still not
  sampled; that remains open.

## Implementation order (each step one mergeable PR)

1. `ExactStage` gains `quadrangulate`; `deliverAsset` with quad, assign, seams (respectSharp),
   unwrap, pack (mip padding), budget, and the report. Unit test on two primitive parts.
2. Bake step: per-part groups by default (`groupPrefix`), normal map only; report the group
   table. Regression: the hero-asset mobile bakes pass through `deliverAsset`.
3. Size search: `sizes` tried in order until the verdict passes (today's `derive`), and the
   default material merge from the profile slot limit. (Decided: see "Defaults decided".)
4. Texture byte accounting in `AssetStats` and the profile verdict.
5. LOD chain by coarser re-quad, checked with `lodTopologyReport`. (Decided: see "LOD chain (step 5)".)
6. Pack seam snap for the rounding overlap, with a unit test that fails before it.
7. Material atlas (base-colour bake per source slot). (Decided: see "Material atlas (step 7)".)
8. Switch the hero-asset example to `deliverAsset`; delete the replaced example code. (Done: see "Hero example switch (step 8): done".)

Step 1 showed the two choices that must be defaults, not options: sharp B-rep boundaries are
seams even when the thin-island merge would remove them, and the cage is grouped per part.
