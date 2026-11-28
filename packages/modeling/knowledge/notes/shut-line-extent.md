# Shut-line extent (blind spot b)

> [!IMPORTANT]
> Measured on `feat/fable-failable-checks` with the item 2 change (uncovered stretches reported,
> `unmeasured` status). Before the change, stations outside the other panel's reach were trimmed
> away, so a row could pass with its out-of-reach tail never measured.

## Rule

- A run is the chain of an outer edge, broken at corners where the direction turns more than 45 degrees.
- A run is declared when one of its regular stations faces the other panel squarely (in reach and not past the other panel's end), or when at least half of its regular stations are in reach.
- The rule reads the whole run, never one segment, so it does not depend on how finely the edge is tessellated.
- Each stretch of out-of-reach stations inside a declared run is reported as an uncovered stretch.
- A row with any uncovered stretch longer than the station spacing is `unmeasured`, unless it carries an existing exception.
- `declaredLength`, `measuredLength` and `uncovered` are reported on every row.

## What the first version of the rule got wrong

The first version anchored a run on a single segment with half of its stations in reach. On a
tessellated panel the short boundary segments next to a seam corner are wholly within reach of the
other panel's corner, so each one declared the panel's whole perpendicular edge as seam.

| Case | declared (m) | measured (m) | status |
|:--|--:|--:|:--|
| C-131 cover split, first version | 2.392 | 1.196 | unmeasured (four stretches, 0.18 to 0.42 m, all on the cover's z = +/-0.25 end edges) |
| C-131 cover split, run-level rule | 1.173 | 1.173 | pass, coverage 1 |

Every `split-along` row and the D10 roll-off row read the same way: the uncovered stretches were the
panels' end edges or flat skin, not seam. With the run-level rule they pass again with the
assertions they have on `main`.

## What still fails, as intended

- B15 A1: a 13 mm slot over the last 30 % of a seam leaves an uncovered stretch running to the
  chain's end; the row is `unmeasured`.
- A19 tabs: the stretches between tabs are uncovered; the row fails `coverage` and `unmeasured`.

## Stated choice

An uncovered stretch makes its row `unmeasured` when it is longer than the station spacing
(`gap > step`). This is a stated choice, not a derived bound.

## Open questions

1. **Wholly out-of-reach chains are not declared (deferred: needs a seam declaration in the row schema).** A chain with no station in reach is
   dropped by the run rule, so its whole declared length is absent from `declaredLength` and no row
   reports it. The intended fix is a row with measured length 0, the whole declared length uncovered
   and status `unmeasured`. A reach-only criterion cannot select it: making every run without an
   in-reach station declared fails 23 existing tests (`shut-lines.unit.test.ts`, `split-along`,
   falsifier rows), because far sides and open panel edges have no station in reach either. The
   selection needs a declaration that names the seam's chain (for example an edge of the other part
   or a seam side in `DtsRow`), which is a schema change. Ruling needed; no threshold was invented. Such a declaration must name, for each row, the edge chain of each part that forms the seam (by face tag or edge endpoints), so the gauge declares that chain without a distance threshold.
