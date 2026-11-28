# Timber members: bracket sets and mortise-and-tenon joints

Scope: `dougong` (`src/recipes/dougong.ts`) and `timberJoint` (`src/recipes/timber-joint.ts`).
Pictures: `examples/timber-kit/render-members.ts`, tested by
`examples/timber-kit/__tests__/render-members.unit.test.ts`. The schematic kit
(`render.ts`) and `knowledge/timber-construction.md` are unchanged.

> [!IMPORTANT]
> Labels below: **primary** = read from a source note in the research board;
> **second-hand** = recalled from the Yingzao Fashi summary in that note, not re-checked against
> the text; **design freedom** = a choice this recipe makes inside a declared range.

## Tier table (Song jixinzao, 计心造, double-chao bracket set)

Terms in code and tables use pinyin with the Chinese glyph only where a reader needs it to match
the source: lu dou (栌斗, the cap block on the column), san dou (散斗, small dou), jiaohu dou
(角护斗, the corner-protecting dou), qixin dou (齐心斗, the centre dou), huagong (華栱, the arm
through the axis), nidaogong (泥道栱, the wall arm), manggong (慢栱, the slow arm), guazi
(瓜子栱, the seed arm), linggong (令栱, the order arm), xie (栔, the plate), cai (材, the timber
module), zucai (足材, cai plus xie).

| Element | Value | Label |
|:--|:--|:--|
| fen | grade 6, 0.01264 m | assumption |
| lu dou | 32 x 32 x 20 fen | primary (case7 building note) |
| san dou | 14 x 16 x 10 fen | design freedom inside the brief's band |
| jiaohu dou / qixin dou | 18 x 16 x 10 / 16 x 16 x 10 fen | design freedom |
| cai | 15 fen (member height) | primary |
| xie | 6 fen | primary |
| zucai pitch | 21 fen (cai + xie) | primary |
| jump | 30 fen per tier, two arms per jump | second-hand |
| outer tip reach | huagong tip at 30 fen per tier plus 6 fen past the outer jiaohu centre: 36 fen for tier 1, 66 fen for tier 2 (round 6) | design estimate for the tip overhang; the jump is second-hand |
| dou ratio ear:flat:qi | 4:2:4 | brief-given |
| qi taper | three straight loft bands, inset fractions 1, 0.45, 0.13, 0 of 2 fen | design freedom |
| curl | `fashi` default: 16 fen run and 9 fen rise, each in four equal parts; `parabola` option: 4 facets, 8 fen run, 4 fen drop | fashi second-hand; parabola design freedom |

Round 5 builds each set from two tables instead of per-tier code:

- `bracketMembers(puzuo)`: one row per continuous member (key, role, axis, tier, extent, whether
  it is curled, whether it is the top tier).
- `bracketDous(puzuo, members)`: one row per dou (key, kind, centre, size, tier, the member it sits on).
- `mouthsOf(dou, members)`, `crossingsOf(members)`: the mouths of each dou and the halved crossings.
- `supportReport(members, dous)`: one verdict per member, derived from the same two tables.

The geometry, the designed contacts, the dimensions and the support report all read these tables,
so a dou or member added to one table cannot be missing from another.

| Set | Members | Dous | Halved crossings | Empty mouths | Declared contacts |
|:--|--:|--:|--:|--:|--:|
| puzuo 4 | 5 | 13 (1 lu, 2 jiaohu, 8 san, 2 qixin) | 1 | 12 | 19 |
| puzuo 5 | 8 | 19 (1 lu, 4 jiaohu, 12 san, 2 qixin) | 4 | 16 | 32 |

Stack height is 58 fen (0.73312 m) for puzuo 4 and 79 fen (0.99856 m) for puzuo 5. Projection
(the outer tip from the column axis) is 72 fen (0.91008 m) and 132 fen (1.66848 m).

### The 卷杀 construction

The default `fashi` curl divides the run under the arm tip (16 fen) and the rise at the tip (9 fen)
each into four equal parts. Join i runs from horizontal point i to vertical point i. Those joins
envelope a parabola, and each vertex satisfies sqrt(u / 16) + sqrt(v / 9) = 1. The joins are
not equal in length, so the envelope is the construction, not a chord count. The test asserts the
vertices against that construction and asserts the chords are unequal.

The `parabola` curl differs from it, which the test also asserts.

## Support verdicts (round 5)

Every member gets one verdict from `supportReport`:

| Verdict | Rule |
|:--|:--|
| `ground` | Tier 1, with the lu dou under it as a mouth holder. |
| `two-mouths` | Rests in two dou mouths from the tier below. |
| `mouth-and-crossing` | One mouth, and a halved crossing with a member that rests in two mouths. |
| `declared-exception` | Removed in round 6 (see below); the round-5 rule was: only a top-tier linggong with one mouth and no crossing. |
| `unsupported` | Anything else. |

Results: puzuo 4 has the two tier-1 members `ground`, the manggong `two-mouths`, and both linggong
`declared-exception`. Puzuo 5 has the tier-1 pair `ground`, the tier-2 huagong and manggong
`two-mouths`, the two guazi `mouth-and-crossing`, and the two top linggong `declared-exception`.
No member in either set is `unsupported`.

Round 6 removes this exception: the linggong now derives `mouth-and-crossing` from its shuatou partner.

Falsifier: the test removes one dou from the table and asserts the member it carried becomes
`unsupported`. Removing the upper san dou of the manggong (puzuo 4) leaves it with no support (round 6: the shuatou partner makes it `mouth-and-crossing`; see the round 6 lessons), and
removing the jiaohu under a linggong leaves that linggong unsupported.

## Designed contacts

Two kinds, both declared on the recipe result and checked by `model.validate({ contacts })`:

- `seat`: a dou on the member it sits on, and each halved crossing.
- `fit`: a dou mouth holding a member, with a gap band of `[0, 1e-6]` m.

`validate` reports each designed contact as one `designed-contact` issue at `info` severity, with
`detail.fits[]`. Each entry has a `status`: `within` (the contact is inside its band), `exceeded`,
`mismatch`, `apart` (no penetration pair found, so the contact was not formed), or `unknown-part`.
Every declared contact reads `within` in both sets: 19 for puzuo 4 and 32 for puzuo 5, with no
`apart` and no `exceeded`.

A dou's bottom sits on its member's top to the last bit. The top is the same float sum the member's
top vertices use (`F(CAI) + F(memberBottom)`), not the rounded fen sum. The mutant below shows why.

## Measured results (round 5, default options, grade 6)

| Model | Faces | Triangles (n-2 fan) | Labels | Confirmed crossings | Candidate self-intersections | Declared contacts, all within |
|:--|--:|--:|--:|--:|--:|--:|
| dougong puzuo 4 | 764 | 1648 | 18 | 0 | 0 | 19 |
| dougong puzuo 5 | 1226 | 2716 | 27 | 0 | 0 | 32 |

Round 5 reports no self-intersection issue of any certainty in either set; the only issues are the
`designed-contact` info entries.

Falsifiers (`detail.certainty === 'confirmed'`):

| Falsifier | Confirmed crossings |
|:--|--:|
| dougong puzuo 4, arm 11 fen wide (mouth 10 fen) | 1 |
| dougong puzuo 5, arm 11 fen wide | 1 |
| joint, tenon moved 1 mm in Z (clearance 0.5 mm) | 1 |
| joint, tenon moved 50 mm along -X (through the peg) | 1 |

Mutants run on the round-5 source (each restored and compared byte for byte with a backup):

| Mutant | Red tests |
|:--|:--|
| Support rule without the partner-rests check (`mouths.length === 1` alone) | 3 |
| Dou placed one tier low (`memberTop(d.tier - 1)`) | 8 |
| Reach 72 to 70 fen (`HUA_REACH_FEN`) | 2 |
| `memberTop` as the rounded fen sum (`F(CAI + memberBottom)`) | 2 (some declared contacts stop reading `within` at grade 6; the exact status was not recorded) |

The round-5 test asserts the count is above zero for the falsifiers; the exact confirmed count
depends on how the overlapping pairs are grouped.

## Lessons

1. **Derive the dou height from the same float sum as the member top.** The dou's bottom and its
   member's top must come from one expression. Converting the fen sum instead produced a
   contact that stopped reading `within` at grade 6 (two tests went red under that variant). The
   `memberTop` comment in `dougong.ts` records this.
2. **Probe the checker before bending geometry.** Round 4 saw penetration with zero reach on
   lattice-aligned parts. That was a false positive from the in-plane winding number, not an
   overlap, so the fix belonged in the kernel, not in the geometry. The kernel fix lives in
   `src/geom.ts` with the untracked `src/__tests__/winding-in-plane.unit.test.ts`. Neither is part
   of this round's commits; the round's tests pass with it in the working tree.

## Through tenon

- A through tenon spans the full post width (`tenonLength` = post width). An explicit
  `tenonLength` on a through joint is refused with `model-invalid-argument`.
- `protrusion` defaults to 0.15 x tenon height, ranges 0 to 0.5 x post width, and is refused when
  negative with `model-invalid-argument`.
- `tenonReach` = tenonLength + protrusion; the tenon end stands `protrusion` past the far face.
- The peg crosses the tenon at its centre, runs along Z past both post faces, and sits in
  clearance holes in the tenon and the post walls.
- Blind joints keep a closed back: protrusion 0, and a protrusion above zero is refused.
- Declared fits: tenon-to-post and peg fits sit in [clearance / 2, 2 clearance]; measured
  clearance is 0.5 mm within 1e-9.
- Joint, through and blind at postWidth 0.1: 128 polygons each, 488 and 476 triangles, 3 labels,
  0 confirmed crossings.

## Dou shading: the dark patch

Diagnosis: on the lu dou mouth side faces, fan triangulation of concave faces emitted back-wound
triangles. In the measured run, 31 of 544 triangles on those faces faced inward, which renders as
the dark patch. The first hypothesis, sliver faces, was wrong: every face had area at least
92.1 mm^2.

Fix (commit `8130d5e5`): `examples/brep-kit/mesh-scene.ts` triangulates each face with ear
clipping (`triangulateLoop`) and falls back to a fan only when clipping fails. Regression test
`examples/brep-kit/__tests__/mesh-scene.unit.test.ts` uses a notched square; it asserts 3
triangles, every normal along +Z, and area 10. The test fails when the fan is forced. After the
fix, every lu dou face has 0 flipped triangles.

## Pictures

Round-5 files are under `_scratch/fable-world/renders/timber-kit/` at 768 px: `dougong-4.png`
(front), `dougong-4-iso.png`, `dougong-4-side.png`, `dougong-5-front.png`, `dougong-5-side.png`,
`dougong-5-iso.png`, `dougong-5-exploded.png`, `dougong-5-load-path.png` (front, with the load
path in `dougong-5-load-path.txt`), `dou-block.png`, `dou-profile.png`, `gong-arm.png`,
`joint-{through,blind}-{exploded,side,assembled}.png`, `timber-members-sheet.png`.

The load path is text, not drawn: the listing has one row per member (verdict, mouths, halved
crossings) and one row per dou (what it sits on, what each mouth holds). Seat rings drawn at the
seat planes were culled by the depth test against the face they mark, so the picture cannot show
them. The 0.05 mm seat gap is below what 768 px shows; the support tests assert it numerically.

Iso views fill the frame at `SET_FILL` 1.2 (flat sets). The test asserts at least 70 percent
coverage for both iso sets; front and side views only have to exist.

## Simplifications

- The qi (欹) is three straight loft bands, not a curved sweep.
- The arm is a flat outline with one curled tip, not a carved huagong.
- The peg is a 16-sided prism; the clearance holes are the same polygon with clearance added.
- The joint has one beam and one post; no dovetail, no wedge.
- No butt variant; the halved-vs-butt comparison is not built.
- The render shows no xie plates; round 5 has none in the table.

## Glyph limit

`examples/brep-kit/font.ts` code 103 (`g`) was changed to a descender bitmap so it no longer
matches `9`. At 5 x 7 pixels it still resembles `a` or `o` in the captions. This is a limit of
the pixel font, not fixed. The captions' "dougong" should be read with that caveat.

## Kernel gaps

1. `validate().pass` is false only for error-severity issues; crossings are warnings, so a
   falsifier must check `detail.certainty`.
2. No curved sweep along an arm, so a curved qi is not available.
3. No dovetail operation.
4. `partDistance` needs hand-built identity placements for a two-part measurement.
5. `dimensions` is an untyped record; callers cast each value.
6. The renderer selects parts by label; the round-5 render classifies by the table keys
   (`bracketDous`, member keys) rather than by string matching, because labels such as
   `jiaohu-1-x+` carry no "dou".
7. The Engine biome config includes only `packages/*/src/**`, so `examples/` files are linted
   through a `src/` copy.

## Not built

- Butt variant and its crossing comparison.
- Curved qi (current taper is a straight loft).
- Dovetail joint variant.
- A measured fit gap for the dougong mouth; the `1e-6` m band is a design guess.
- (Done in round 6: the top-tier linggong is supported by its shuatou partner; no exception class remains.)

## Round 6: shuatou, centre linggong, mangong juansha

Commits: `f394cbea` (mangong juansha), `e552a21c` (shuatou and the support rule), and the
render and documentation commit that closes round 6.

### Elements added or changed

| Element | Value | Label |
|:--|:--|:--|
| shuatou | one x-axis member on the top tier, through the centre; tips 25 fen beyond the outer top linggong centre (puzuo 4: +/-55 fen; puzuo 5: +/-85 fen) | structure second-hand (the top-tier nose of the jixinzao set); 25 fen reach is design freedom |
| mazha-tou end | table of [tread, riser] in fen, from the nose inward: nose 12, treads 8 and 8, two 4-fen risers, floor at 16 fen (`MAZHA_TOU_STEPS`) | design estimate: step sizes chosen for legibility, not measured from a source |
| centre linggong-3-c | top-tier z-axis linggong through the centre, half-length 40 fen (80 fen total); rests in the two manggong-2 san dou mouths | design estimate |
| qixin dous | sit on the shuatou (round 5: on the linggong) where it halves over the linggong | design freedom |
| mangong juansha | curled at both ends (`curl: false` before); four segments like the other gongs | defect, fixed in `f394cbea` |

The shuatou halves with each top-tier linggong and with the centre member. At each crossing the
shuatou keeps the upper half, so the linggong top is notched below the qixin seat.

### Support rule without exceptions

| Verdict | Rule |
|:--|:--|
| `ground` | Tier 1, with the lu dou as its mouth holder. |
| `two-mouths` | Rests in two dou mouths. |
| `mouth-and-crossing` | One mouth, and a halved partner that rests in two mouths. |
| `unsupported` | Anything else. |

The `declared-exception` class is removed. The top-tier linggong that round 5 declared an
exception now derive `mouth-and-crossing`, because the shuatou partner rests in two mouths.
No member of either set is `unsupported`.

Measured verdicts:

- Puzuo 4: nidaogong-1 `ground`, huagong-1 `ground`, manggong-2 `two-mouths`, shuatou `two-mouths`,
  linggong-2-x+/- `mouth-and-crossing`.
- Puzuo 5: nidaogong-1 `ground`, huagong-1 `ground`, huagong-2 `two-mouths`, manggong-2
  `two-mouths`, guazi-2-x+/- `mouth-and-crossing`, linggong-3-x+/- `mouth-and-crossing`,
  linggong-3-c `two-mouths`, shuatou `two-mouths`.

### Measured counts (round 6, default options, grade 6)

| Set | Members | Dous (ludou / jiaohu / san / qixin) | Halved crossings | Empty mouths | Labels | Faces | Fan triangles | Declared contacts, all `within` | Candidate self-intersection (total) | Confirmed |
|:--|--:|:--|--:|--:|--:|--:|--:|--:|--:|--:|
| dougong puzuo 4 | 6 | 13 (1 / 2 / 8 / 2) | 4 | 10 | 19 | 848 | 1940 | 24 of 24 | 24 | 0 |
| dougong puzuo 5 | 10 | 22 (1 / 4 / 14 / 3) | 7 | 16 | 32 | 1474 | 3360 | 42 of 42 | 36 | 0 |

Labels count the members and dous (one label each). Triangles are the n-2 fan of each face.
The candidate self-intersection is one issue with `certainty: candidate`. Its `pairs` list is
capped at `MAX_CONTACT_PAIRS` (32, `src/validate.ts`), and `total` counts every pair. Puzuo 4 lists
all 24; puzuo 5 lists 32 of 36, so four pairs are omitted by the cap, not lost. Candidate touches at
designed seats are not penetrations.

Before the merge, puzuo 5 showed two closed-clean failures and `exceeded` fits on the jiaohu/huagong
and jiaohu/shuatou seats. After merging `origin/main` (which includes the in-plane winding fix of
PR #688) every designed contact reads `within` and both tests pass. The cause was not isolated to
that fix alone; no contact tolerance was changed.

### Mutants (round 6)

Both mutants were run one at a time on `src/recipes/dougong.ts`. Each was restored from a backup
and compared with `cmp`, and the file matched its commit afterwards.

| Mutant | Red tests of 45 |
|:--|--:|
| `crossingsOf`: drop the shuatou crossing with the centre member (`x.key === 'shuatou' && z.across === 0`) | 7 |
| Shuatou one tier down (`tier: top - 1`) | 24 |

### Exploded set

Each tier moves up as one rigid group, with its dous and its arms together. The step is two cai
heights per tier, that is 2 x 0.1896 m = 0.3792 m (design choice; one cai height is the minimum).
The ludou stays on the ground.

| Set | Assembled Y extent (m) | Exploded Y extent (m) | Ratio |
|:--|--:|--:|--:|
| puzuo 4 | 0.733 | 1.492 | 2.03 |
| puzuo 5 | 0.999 | 2.136 | 2.14 |

The render test asserts a ratio of at least 1.8 for puzuo 5 and that the exploded pieces keep
every face of the assembled set. Puzuo 4 is not asserted.

A dou is grouped with the tier it sits on, so a jiaohu dou moves with the arm below it and sits
under the arm it holds in the exploded view. The exploded test asserts, for both sets, that every
dou's tier equals its seat member's tier (`sitsOn`), so the dou takes the same lift as its member.
Puzuo 4 now has its own exploded picture.

### Pictures (768 px, re-rendered)

Read from `_scratch/fable-world/renders/timber-kit/` after the merge:

- `dougong-5-iso.png`: the top-tier shuatou reads as the long bar through the top; the top linggong
  and qixin dous are visible; the centre is dense.
- `dougong-5-exploded.png` and `dougong-4-exploded.png`: each jiaohu dou sits with the arm of its
  own tier; the lu dou stays alone at the bottom.
- `dougong-5-front.png`: the stepped shuatou nose shows at both ends of the top bar.
- `dougong-5-side.png`: the top-tier linggong ends show as curled plates.
- `dougong-4-iso.png`: the shuatou nose reads as a notch at its right end.
- `dougong-5-load-path.txt`: 10 members, 22 dous, 7 halved crossings, one row each.
- `dougong-5.png` was stale (05:58) and is deleted; the renderer does not write it.

Remaining defects, as seen:

1. The mazha-tou leaf is 12 fen high with 8-fen treads. At 768 px the front view reads as a short
   ledge at each end of the top bar, not a clear stepped leaf; a finer riser or a larger nose would
   need a design decision.
2. In the iso views the top-tier dous hide much of the arm ends; the dou-to-arm seat is not
   legible at this scale (the round-5 note on culled seat rings still applies).
3. In the exploded view the jiaohu dous sit under the arms they hold, with a gap of one tier step.
   The grouping is correct (see the exploded test); the gap is the explode distance, not a float.
4. The joint pictures were re-rendered but not reviewed in this round.

### Lessons

1. The mangong juansha test was red before the fix. The per-kind envelope test asserts the curl at
   each end of each gong, not a count of members.
2. The first falsifier guess (removing a san dou makes the manggong unsupported) was wrong: the
   shuatou partner rests in two mouths, so the verdict is `mouth-and-crossing`. The falsifier now
   records the measured verdicts.
3. The linggong verdict was also wrong on a first guess: removing a jiaohu gives `unsupported` with
   zero mouths, not `mouth-and-crossing`.

### Not done

- Joint pictures not reviewed this round.
- The 4 pairs of puzuo 5 self-intersection beyond the 32-pair cap are listed only in `total`.
- Anchor counts not re-measured this round.
- `self-contained.unit.test.ts` fails on this branch with three hits this round did not own:
  `examples/brep-kit/mesh-scene.ts:125` (comment from `8130d5e5`, not on main), and the lane's
  wiring symlinks `biome.json` / `tsconfig.base.json` (external `$schema` web links). The notes
  line that named the workspace was reworded in this round. The brep-kit comment is outside the
  bracket-set scope and was not changed.
