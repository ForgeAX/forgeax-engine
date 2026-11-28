# Gallery

Stamped renders of the B-rep kernel and its quad meshers. Every merged visible feature adds a row here: add it to a
`rows-*.ts` script (or a new script plus its name in `PART_ORDER` of `stamp.ts` and a line in `run.sh`), then re-stamp.

## Regenerate

```
examples/gallery/run.sh            # writes _scratch/viz-out/gallery-1/ (override with GALLERY_OUT)
```

Run it from a committed, clean tree: `stamp.ts` merges the per-script parts into `summary.json` (rows plus the sha256 of
every PNG), writes `provenance.txt` (head SHA, clean check, UTC, command, exit, sha256 of `summary.json`, re-checked
after the last write) and exits non-zero on a dirty tree. A mesher refusal is a row with its `code` and `reason`; it is
drawn as a red "REFUSED" cell and never as an image.

## Rows

| Script | Row | Content |
|:--|:--|:--|
| `before-merge.ts` | 2 | The through-slot and T-union as fragmented by the coplanar merge hook (run with `GALLERY_NO_MERGE=1`, which swaps the merge for an identity stub through `register.mjs`; `src/` is untouched). Feeds `rows-modes.ts`. |
| `rows-modes.ts` | 1, 2, 6 | Bracket chain (wall, groove, boss, gusset, pocket), through-slot, T-union, stepped-L union at one equal size per solid in four modes (iso, quad-dominant, blossom-row, split-3): shaded iso, feature lines (convex / concave / boundary), quad network top and iso, one comparison sheet per solid. Before/after merge sheets (faces, feature lines, quad networks). Hero: bracket end state, feature lines over the quad network, iso and top. Before/after sheets also carry mesh-edge overlays (shaded part + quad edges + feature lines, `overlay.ts`), and `sheets/overlay-mesh-edges.png` shows the same overlay for every solid. |
| `rows-iso.ts` | 3, 5 | plate-grid3x4 at sizes 5 / 3 / 2.2 / 1.5, flange bolt6 and bolt12 (circular outer loops with bolt rings), mode comparison per solid, and the holed faces left by the merge (through-slot top, bracket plate) against the earlier plate-with-hole example. Every cell carries minSJ and the row-only / all-boundary coverage. |
| `rows-ssi.ts` | 4 | NURBS patch x unit sphere, sweep stub and loft flange x planes: marched branches joined by `joinBranches`, end markers colored boundary / junction / gap-over-tol / open. Planar end caps are drawn (tan) next to the NURBS walls. Junction and gap-over-tol do not occur on the real parts; `end-marker-key.png` shows them on a labelled synthetic set. |
| `rows-s2.ts` | S2b2 | The NURBS sweep stub unioned with a placed planar plate (#650) and the plain stub, per-solid row in four modes, plus top views of the union. The union is refused by every mesher (trimmed NURBS wall face). |
| `rows-extras.ts` | a, d | Blind-pocket block, T-intersect, stepped-L intersect, plate with through hole (iso mode), through the same per-solid row. |
| `rows-reruns.ts` | b, c | Current-trunk re-runs of older examples: `quad-feature-baseline/run.ts` (qf-m1 boundary-row statistics and images, run twice: without a fallback and with `QF_FALLBACK=split-3`; `sheets/qf-m1-blossom-fallback-{iso,top}.png` put the blossom-row refusal next to the split-3 all-quad network per case), `e1b-trim`, `e1c-boolean/render.ts`. |

Mode mapping (`common.ts`): iso = `trimmed: 'quad-dominant', isoQuadric: true`; quad-dominant = `trimmed: 'quad-dominant'`;
blossom-row = `trimmed: 'blossom-row'`; split-3 = `trimmed: 'quad-dominant', fallback: 'split-3'`.

Files: `common.ts` (output dir, PNG registry, mode mapping, metrics), `solids.ts` (the planar-boolean solids),
`render-solid.ts` and `solid-row.ts` (the per-solid row), `register*.mjs` / `no-merge.ts` (merge switch), `stamp.ts`.

## Trunk deltas (iso mode, element size 0.8 unless noted)

Measured by the rows scripts at the stated trunk; "before" is the number reported by the owning lane for the merged change. Weak rows stay in the gallery as they are.

| Merge | Solid | Before | After (measured) |
|:--|:--|:--|:--|
| #655 (6917c36a, rectilinear planar faces) | T-union (size 0.4) | minSJ 0.091, 10 tris | minSJ 0.951, q194 t0 |
| | stepped-L union | minSJ 0.272 | minSJ 0.927, q208 t0 |
| | bracket-wall | refused | q272 t0, minSJ 1.0 |
| | bracket-groove | minSJ 0.243 | minSJ 0.821, q306 t0 |
| | bracket-boss | minSJ 0.196 | minSJ 0.798, q480 t0 |
| | through-slot | n/a | minSJ 0.541, q704 t0 (holed top face stays weak) |
| | bracket-gusset | n/a | minSJ 0.339, q229 t22 |
| | bracket-pocket | n/a | minSJ 0.228, q250 t22 |

`rows-s2.ts` optionally reuses the ssi lane's published NURBS wall union planar plate renders as a labelled preview. Set `SSI_S2_DIR` to the directory containing those renders and `summary.json`; without it, the optional preview row is omitted.
