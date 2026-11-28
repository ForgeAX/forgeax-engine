# Timber construction: fen units, brackets, joints and roofs

This note records what the timber recipes take from Chinese timber construction and what they
decide for the designer. It separates source facts that were checked from secondary summaries
and from design choices. Chinese terms are given in pinyin; the recipe reference
(`reference/detail.md`, "Timber construction") carries the characters.

## Status of each fact

| Fact | Status | Where it is used |
|:--|:--|:--|
| cai section 15 fen wide, 10 fen deep | Verified against Yingzao Fashi vol. 4 in earlier recipe work | `caiFen`, `dougong` |
| xie section 6 by 4 fen | Verified, same source | `caiFen`, `dougong` |
| zu-cai height 21 fen = cai + xie | Derived from the two verified sizes | `caiFen`, `dougong` |
| lu dou 32 by 20 fen; huagong 72, nidaogong 62, mangong 92 fen | Verified, same source | `dougong` |
| Grade table 1 to 8 and cun conversion | Secondary (zh.wikipedia summary) | `caiFen` |
| Cun = 0.0316 m for the fen length | Assumption, not from a source | `caiFen` |
| Juzhe ridge rise 1/3 of run (pavilion), 1/4 (hall) | Secondary summary, not checked against text | `juzheRoof` |
| Purlin heights by halving rule | Secondary summary | `juzhePurlins` |
| Puzuo 4 and 5 give 1 and 2 steps | Secondary pairing, not checked | `dougong` |

Verified rows state the source only, not the page. Re-check them against the text before a
claim leaves the repository. Secondary rows must not be presented as source values.

## Design freedom

These are not historical values. They are parameters the recipe owner chose, and each has a
declared range:

- Joint clearance (`timberJoint`, default 0.0005 m, range 0.0002 to 0.002 m).
- Juansha chamfer on huagong tips (`dougong`, default 4 fen).
- San dou and jiao hu dou use the lu dou footprint (32 by 20 fen). Their own source sizes were
  not checked, so this equality is a choice.
- Equal runs per jia (`juzheRoof`).
- Tile width, exposure, lap and thickness (`tileRows`).
- Lattice pattern names, cell, bar and border (`latticePattern`). The names bubujin, guibeijin,
  binglie and huiwen are labels for the four generators, not catalogue values.

## Recipes

| Recipe | Output | Derived fields that matter |
|:--|:--|:--|
| `caiFen(grade)` | Fen length and member sizes in meters | `fen`, `width`, `depth`, `xieWidth`, `xieDepth`, `zuCai` |
| `timberJoint({ kind, ... })` | Post with mortise, beam with tenon, fit contact | `kind` `through` or `blind`; blind refused when the tenon does not fit |
| `dougong({ puzuo, grade, juanshaFen })` | Closed-form bracket set, touching members declared as seats | `steps = puzuo - 3`, `stackHeight = (41 + 41 * steps) fen` |
| `juzheRoof({ kind, run, spans, length })` | Closed prism over the purlin polyline | `ridgeHeight`, `firstDrop`, `eaveUpturn` (always 0) |
| `tileRows({ purlins, ... })` | Sawtooth pan rows mitred at each fold, cover strips over the joints, ridge cap, seat contacts | `pans`, `covers`, `rows`, `columns`, `tileLength = pitchMax + lap` |
| `latticePattern({ pattern, ... })` | Pierced rectangular panel | `openRatio`, `minBar`, `openings` |

## Verification practice

- Each recipe checks its parameters against declared ranges and returns a structured
  `model-invalid-argument` error before building.
- Each recipe's tests build the defaults and check closure and absence of blocking issues.
- Joint and bracket recipes state their touching faces as `seat` or `fit` contacts so that
  `validate` reports them as designed rather than as self-intersection.
- Open area of the lattice panel is checked against the kernel's own volume, not a second
  formula derived from the same polygons.

## Limitations

- Hip roof ends are not modeled. Gable ends are flat.
- Eave upturn is not located in the checked sources, so `juzheRoof` records 0.
- `tileRows` lap is a layout dimension. The covered tail under the next row is not modelled, so
  no overlapping shell is built. Eave end caps (瓦当, 滴水) are not modelled.
- Appended coplanar touching shells are reported as self-intersection unless declared as
  `seat` contacts. Dougong members rely on this declaration.
- Grade-dependent sizes depend on the cun assumption above and are not verified.
