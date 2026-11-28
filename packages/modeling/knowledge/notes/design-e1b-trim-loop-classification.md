# E1b: trim span cutting and face-point classification (as implemented on main)

> [!NOTE]
> Describes the code on `main` at 76581473 (2026-11-13). It records what is implemented and tested, not a
> proposal. Sources: `src/brep/trim-span.ts`, `src/brep/trim-face.ts`, `src/brep/__tests__/e1b-trim.unit.test.ts`,
> and the E1 corpus fixture `src/brep/__tests__/e1/fixtures/e1-corpus.json`.

## Scope

E1b has two steps, both pure TypeScript inside the exact stage (`src/brep/`):

1. **Span cutting** (`trim-span.ts`): an intersection branch between two analytic surfaces is cut wherever it leaves
   the principal parameter domain of either surface.
2. **Face classification** (`trim-face.ts`): a 3D point is classified `in`, `out` or `on` against the trimmed domain of
   one face.

## Step 1: span cutting

- Cut kinds (`SpanCutKind`): `u-seam` (the periodic seam half-plane `u = 0`), `v-seam` (the torus `v = 0` half-plane),
  `pole` (sphere poles, where `u` is undefined) and `apex` (cone apex).
- `cutBranch(a, b, branch, tol)` returns the cuts of one branch. Breaks are `t0`, the cut parameters in order, and `t1`.
  A cut closer than `1e-12 * max(1, |t1 - t0|)` to the previous break or to `t1` is not a break. A cut point within
  `tol` of a singular point is reported once, as the singular cut.
- Each resulting `BranchSpan` is evaluated at its midpoint; `shiftA` and `shiftB` (`shiftAt`) give the pcurve offset that
  places it in the principal domain of each surface.
- Branches are sampled at `SPAN_SAMPLES = 1024` points. The source comment says this is enough that two seam crossings
  never share one sample interval in the corpus. That is a corpus statement, not a general proof.

## Step 2: face classification

- `faceTrim(shape, f, band)` builds the trim of face `f`. `band` defaults to the shape tolerance.
- Boundary edges are the coedge edges with `curve >= 0` that the face uses exactly once. Edges used twice (seams) and
  degenerate edges (`curve = -1`, pole or apex) are not boundary, so crossing them stays inside the face.
- `classifyOnFace(trim, p, uv?)` returns `in`, `out` or `on`:
  - `on` when `boundaryDistance` is within `band` (3D) of a boundary edge. The code checks a `2 * band` window first.
  - Otherwise the point is mapped to `(u, v)` and classified by `inFaceUv`.
- `inFaceUv` is a winding number over the loops' pcurves in the periodic cover, using a half-open crossing rule. Ray
  heights within `RAY_HEIGHT_EPS = 1e-11` count as equal, so a closing vertex evaluated at `2 pi` and at `0` is not
  counted on one side only.
- Each curved coedge is split into `CURVED_SEGMENTS` chords; each chord records a deviation `dev`, which feeds the
  trim's bounding box. `boundaryDistance` evaluates the true edge curve (golden-section search over `EDGE_SAMPLES`
  samples), not the chords.

## Corpus behaviour (pinned)

The E1 corpus has 40 surface-pair cases with committed labels (`e1-corpus.json`):

| Label | Count | Pinned behaviour (`e1b-trim.unit.test.ts`) |
|:--|--:|:--|
| `full` | 36 | no partials; seam and pole cut totals match the fixture oracle; u-seam totals agree with an independent reference; every span maps into the principal domain |
| `tangent-partial` | 4 | one partial with code `brep-ssi-tangent`, ids `[3, 7]` |

The test `the corpus splits into full and tangent pairs with the committed labels` asserts that the label of every
pair equals its committed label, and that at least one tangent pair exists.

Known quirk: `QUIRK_SEAM_TOTAL` in the test overrides the expected seam total for a small set of pairs. Those overrides
are explicit in the test source, not derived.

## Not covered by E1b on main

- A general tangent-branch span cut: tangent pairs stay one `brep-ssi-tangent` partial rather than being split.
- Classification tolerance beyond the shape tolerance is the caller's `band`; no separate tangent-band policy exists here.
- Arc-aware cell assembly for chords across circle loops is a boolean concern (see
  `knowledge/notes/boolean-corpus-findings.md`), not E1b.

## Verification

Run `pnpm exec vitest run src/brep/__tests__/e1b-trim.unit.test.ts` from the modeling repository root. The pinned
behaviour above is what that file asserts. On 2026-11-13 at 76581473 it reported 113 of 113 tests passing (one file,
about 4 s, exit 0).
