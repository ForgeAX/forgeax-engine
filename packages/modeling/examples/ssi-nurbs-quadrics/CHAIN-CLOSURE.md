# Chain-level closure of manifold NURBS cuts

The boolean-facing unit is the **chain**: branches joined by endpoint pairing
(`joinBranches`, eps 1e-6). Per-branch counts (`closed` flags) are the wrong unit:
a closed chain is often assembled from several open branches.

| Cut | Branches | Closed branches | Chains | Closed chains | Open ends |
|---|---|---|---|---|---|
| s-bend sphere | 96 | 0 | 4 | 4 | none |
| s-bend cone | 33 | 1 | 4 | 4 | none |
| s-bend torus | 67 | 0 | 6 | 3 | 6 junction |
| transition sphere | 160 | 0 | 4 | 4 | none |
| transition cone | 42 | 0 | 4 | 4 | none |
| transition torus | 38 | 0 | 8 | 0 | 16 gap-over-tol |

Pinned by `__tests__/chain-closure.test.ts`.

## Transition torus: model seam, not a marcher defect

Measured from one run (`/tmp/seam/ends.txt`): for every open end, the own face, the nearest other
face, and the distance from the end to that other face's surface, with a boundary flag.

- All 76 transition-torus branch ends lie on their own face boundary (on-boundary yes).
- 64 of the 76 ends have distance ~1e-16 to their nearest other face: the neighbour surface passes
  through them.
- 12 ends have a nearest-other distance above 1e-5, listed below. Their gap is 1.25e-2 to 4.10e-2.

| Own face | Nearest other | Distance | Position (x, y, z) |
|---|---|---|---|
| 1 | 2 | 4.10e-2 | (8.0500, 0.8000, 0.1406) |
| 19 | 18 | 3.30e-2 | (8.0500, -0.8000, 0.1406) |
| 21 | 22 | 4.10e-2 | (8.0500, -0.8000, -0.1406) |
| 39 | 38 | 3.30e-2 | (8.0500, 0.8000, -0.1406) |
| 40 | 41 | 2.52e-2 | (8.0500, 0.6500, -0.1747) |
| 40 | 41 | 1.55e-2 | (6.2500, 0.3599, -0.1164) |
| 56 | 57 | 1.25e-2 | (8.0500, -0.6478, -0.1748) |
| 56 | 57 | 1.43e-2 | (6.2500, -0.3592, -0.1161) |
| 60 | 61 | 2.52e-2 | (8.0500, -0.6500, 0.1747) |
| 60 | 61 | 1.55e-2 | (6.2500, -0.3599, 0.1164) |
| 76 | 77 | 1.25e-2 | (8.0500, 0.6478, 0.1748) |
| 76 | 77 | 1.43e-2 | (6.2500, 0.3592, 0.1161) |

Decision rule: an end whose gap to the neighbour exceeds the branch fit tolerance (the cut tol, 1e-7,
scaled by the sampled bound) is model non-conformity along that rim. The 12 ends above are five
orders of magnitude above that tolerance, so those are model non-conformity and the stitcher reports
them correctly.

## Final classification of the 16 gap-over-tol ends

Measured from one run per probe. Full per-end table: `per-end-table.txt`; exact-point and neighbour
evidence: `exact-ends.txt`, `neighbour-crossing.txt`, `branches-5-14.txt` (in `_scratch/viz-out/ssi-stitch/`).

| Group | Ends | Evidence | Class |
|---|---|---|---|
| Model seam, 1.25e-2 to 4.10e-2 from the neighbour | 12 | neighbour surface far from the end | model non-conformity |
| Rim grazing, branches 3 and 12 | 2 | neighbour surface passes the end (d ~1e-16), neighbour face has 0 marched branches, torus touches only the rim (1680 of 1681 grid samples outside) | rim-only contact, model-side |
| Rim grazing, branches 5 and 14, end 1 | 2 | neighbour surface passes the end (d 4.6e-13 to face 17 and face 37, re-measured on 14699bb4); neighbour has 1 of 1681 grid samples inside, at the rim point; nearest branch end 0.12 away | rim-only contact, model-side |

Total 16. Branches 5 and 14 end 0 are not in the failing set: each pairs exactly with a neighbour
branch end (8.9e-16 and 2.8e-17).

Correction to the earlier note: it said branches 5 and 14 were at ~1e-16. That was a pairing error;
the 8.1e-2 figure was the distance to a neighbour that is not the nearest face. Only end 1 of 5 and
14 is a rim contact.

Re-measured on 14699bb4 (closes the last unmeasured item of this table). Probe: a grid of 80x80 plus
pattern-search refinement for each end's distance to every transition face, and a 41x41 grid of the
torus implicit for each neighbour face. Branch numbers are the global index into the `joinBranches`
input.

- Branch 5 end 0 and branch 14 end 0 pair with branch 8 end 1 (8.9e-16) and branch 17 end 1
  (2.8e-17). They are paired, not failing.
- Branch 5 end 1 at (6.2503, -0.4734, 0.1538) lies on face 17 (4.6e-13). Branch 14 end 1 at
  (6.2503, 0.4734, -0.1538) lies on face 37 (4.6e-13). The nearest other branch end is 0.1195 away for
  both (branch 29 end 0 and branch 19 end 0).
- Face 17 and face 37 each have 1 of 1681 grid samples inside the torus, at the rim point. This is the
  same rim-only pattern as branches 3 and 12, so the class stays rim-only contact, model-side.

Merged without independent audit.

## s-bend torus junctions

The 6 `junction` ends each have a join partner at distance 0 (measured to ~7e-16). They are paired
at a join junction; the label reports how the join classified them, not a gap or a failed
continuation.
