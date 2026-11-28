# Design note: surfacing and body-engineering foundation tools

> [!IMPORTANT]
> Status of the claims below: **[C]** read in the current source at 615006fd, **[P]** proposal implemented on
> `feat/kernel-foundation`.

## 1. Why

The car-styling research (Studio `car-styling-theory`, nine handbook chapters) walks one professional pipeline:
package and hard points, feature lines, primary surfaces, blends, panel split, body-in-white engineering,
functional parts, then the game asset. Read against the kernel, most of the surface-quality side already exists
**[C]**: `nurbs.loft / grid / network / fitSurface / match / surface.fair`, variable-radius `blends` with run-out,
setback `corners`, patch layout, `zebraStripes`, `highlightLines`, `curvatureComb`, `checkSurfaceQuality`, draft
analysis, shut lines, sheet-metal flat patterns, mass properties.

What a modeller still has to hand-write **[C]**:

| Gap | Evidence |
|:--|:--|
| A surface from one or two rails and sections | `nurbs` has `loft`, `grid`, `network`; no rail sweep |
| A free-form offset surface | `brep.offsetSurface` covers analytic carriers only; `m.shell` offsets the mesh |
| Deviation of built surfaces from a scan, a point set, a mesh or other surfaces | `fitSurface` reports its own residual; `diffMeshes` compares meshes |
| Plane sections of a patch set as curves (station cuts for combs and fairness) | `highlightLines` has `reflection` and `isophote` fields only |
| Surface-quality views on an exact Shape | `T-v2-shape-diagnostics`, deferred from v2.0 |
| Forming checks on a sheet part | `m.sheet` computes bend allowance; nothing reports springback or minimum radius |
| A bill of materials with mass roll-up | `drawing-table` prints a BOM table of exploded parts; no mass or material data |
| Body fasteners, wheels and tyres, cables | recipes hold machine elements only; `T-v2-cable-kit` deferred from v2.0 |

## 2. Principles

- Extend the owner. A plane section is a third scalar field of `highlightLines`, so fairness gating
  (`checkSurfaceQuality({ highlights })`) covers it with no new check.
- Plain data in, `Result` out. New surface tools take and return `NurbsCurve` / `NurbsSurface`; a report is
  `pass` plus `Issue<Code>[]`.
- Every approximation reports its measured error and whether it converged. None hides a tolerance miss.
- No new session state. Nothing here adds a `Model` operation; `m.surface({ patches })` already consumes the
  surfaces these tools return.
- Deterministic: `dmath` only, no ambient state.

## 3. API **[P]**

### 3.1 Rail sweeps (`src/nurbs-sweep.ts`, on `nurbs.sweep`, `nurbs.birail`)

```ts
interface RailSweepOptions {
  /** Station of each section along the rail, normalized arc length, increasing (default: evenly spaced, 0 to 1). */
  readonly parameters?: readonly number[];
  /** Section frame: rotation-minimizing (default) or a fixed up direction. */
  readonly frame?: 'rmf' | { readonly up: Tuple3 };
  /** Largest distance between the surface and the exactly placed section between stations, meters (default 1e-5). */
  readonly tolerance?: number;
  readonly maxStations?: number; // default 65
  readonly degree?: number;      // along the rail, default 3
}
interface RailSweepResult {
  readonly surface: NurbsSurface;      // u along the section, v along the rail (as `loft`)
  readonly stations: number;
  readonly deviation: number;          // measured between stations, meters
  readonly converged: boolean;
}
function sweepSurface(rail, sections, options?): Result<RailSweepResult, ModelingError>;

interface BirailOptions extends Omit<RailSweepOptions, 'frame'> {
  /** 'uniform' scales the section by the rail distance (default); 'width' scales along the chord only. */
  readonly scale?: 'uniform' | 'width';
}
interface BirailResult extends RailSweepResult {
  readonly railGap: readonly [number, number]; // largest distance of each rail from its boundary isoparm
}
function birailSurface(railA, railB, sections, options?): Result<BirailResult, ModelingError>;
```

Sections are authored in place: section k lies at station `parameters[k]`, and for `birail` it starts on rail A
and ends on rail B (a miss beyond the tolerance is `model-precondition` with the gap). Between sections the
shape blends linearly in the moving frame. Stations double until the deviation holds or `maxStations` is hit
(`converged: false`).

### 3.2 Free-form offset (`src/nurbs-offset.ts`, on `nurbs.offset`)

```ts
function offsetSurface(s: NurbsSurface, distance: number, options?: {
  readonly tolerance?: number;             // default 1e-5 m
  readonly maxNet?: readonly [number, number]; // default [32, 32]
}): Result<{ surface: NurbsSurface; max: number; rms: number; net: readonly [number, number];
             converged: boolean; minRadius: number }, ModelingError>;
```

Positive distance runs along `dS/du x dS/dv`. An offset is not a NURBS in general, so the result is a fit of the
exact offset points with its measured error. A distance at or beyond the smallest radius of curvature on the
side it moves toward is `model-precondition` (the offset would fold over) with the radius and its place; a
singular normal is `model-degenerate`.

### 3.3 Deviation report (`src/surface-deviation.ts`, `surfaceDeviation`)

```ts
type DeviationTarget =
  | { readonly points: readonly Tuple3[] }
  | { readonly mesh: { readonly positions: ArrayLike<number>; readonly indices: ArrayLike<number> } }
  | { readonly surfaces: readonly NurbsSurface[] };
function surfaceDeviation(surfaces: readonly NurbsSurface[], target: DeviationTarget, options?: {
  readonly tolerance?: number;   // pass limit, meters (default 1e-4)
  readonly samples?: number;     // per patch direction for surface sampling (default 24)
  readonly bands?: readonly number[];
}): Result<DeviationReport, ModelingError>;
```

`DeviationReport` is `{ pass, tolerance, toSurfaces, toTarget?, issues }`. Each side holds `count`, `max`,
`mean`, `rms`, `p95`, the signed range along the surface normal, the worst place (`point`, `patch`, `u`, `v`) and
the share of samples inside each band. `toSurfaces` measures target samples against the surfaces; `toTarget`
measures surface samples against a mesh or surface target, so a region the target never covers is not missed.
Codes: `deviation-exceeded` (warn), `nothing-checked`.

### 3.4 Plane sections (`src/highlight-lines.ts`, field `'section'`)

```ts
{ readonly field: 'section'; readonly normal: Tuple3; readonly step: number; readonly origin?: number }
```

Lines where `p · normal = origin + k · step` (meters). `HighlightLine.level` is then the plane offset in meters.
The result feeds `curvatureComb`, `curveFairness` and `checkSurfaceQuality({ highlights })` unchanged.

### 3.5 Exact shape diagnostics (`src/brep/diagnostics.ts`, on `./brep`)

`shapeSurfaces(shape)` returns each face's carrier as a named NURBS patch over the face's parameter bounds
(planes, cylinders, cones, spheres and tori in their exact rational form) plus the faces it skipped with a
reason. Every existing view and check then runs on a Shape: the patches have the shape of `NamedSurface`, so
`checkSurfaceQuality({ surfaces }, { classes: D09_CLASSES })` grades a Shape's edges. `measureContinuity` is
unchanged, and `./brep` does not import the surface checks (they stay out of the exact-stage digest).

### 3.6 Sheet forming (`src/sheet-forming.ts`, `sheetForming`)

```ts
interface SheetMaterial { readonly name: string; readonly youngsModulus: number; readonly yieldStrength: number;
                          readonly minBendRatio: number }
function sheetForming(spec: SheetMetalSpec, material: SheetMaterial, options?): Result<FormingReport, ModelingError>;
```

Per bend: the springback ratio from the elastic recovery relation `Ri / Rf = 4x^3 - 3x + 1`,
`x = Ri Y / (E t)`, the tool radius and tool angle that release to the designed bend, and the minimum inside
radius `minBendRatio x thickness`. Codes: `bend-radius-below-minimum`, `flange-too-short`, `hole-near-bend`
(shop guideline defaults, each an option), `springback-large`. Material presets are typical values and say so.

### 3.7 Bill of materials (`src/bom.ts`, `bom`)

Items carry `id`, `parent?`, `quantity?`, `material?: { name, density }`, `process?` and one geometry form:
`{ solid }` (closed mesh, volume x density), `{ sheet, gauge }` (surface area x gauge x density, for skins that
are modelled as one surface) or `{ mass }`. The report holds one row per item with the rolled-up mass, totals by
material and process, and issues (`bom-open-solid`, `bom-missing-material`, `bom-unknown-parent`, `bom-cycle`,
`bom-duplicate-id`).

### 3.8 Recipes (`src/recipes/`)

- `body-fasteners.ts`: `pushClip`, `weldNut`, `blindRivet`, `grommet`.
- `wheel.ts`: `tyreSize(code)` (ISO metric designation to dimensions), `tyre`, `wheelRim` (width, diameter,
  offset, bolt circle, centre bore, spokes).
- `cable.ts`: `catenary(a, b, { sag } | { length })`, `cable` (bundle, helical wrap, end fittings); closes the
  hose part of `T-v2-cable-kit`.

## 4. Concept delta

| New | Count |
|:--|:--|
| `nurbs` members | `sweep`, `birail`, `offset` |
| Standalone reports | `surfaceDeviation`, `sheetForming`, `bom` |
| `highlightLines` field kinds | `section` |
| `./brep` members | `shapeSurfaces` |
| Recipes | 4 fasteners, 3 wheel, 2 cable |
| `Model` operations, error codes | none |

## 5. Not in this change

| Item | Reason |
|:--|:--|
| Shape-level vertex blend with unequal radii | needs an n-sided exact patch in the B-rep assembler; `corners` covers the patch form |
| Free-form exact booleans beyond the spike corpus | open research (`e3-spike-verdict.md`) |
| M-QF7 guide curves | blocked on a consumer of the constraint set (decision D18) |
| Master-surface panel cutting (K9) | design-first lane of v2.1 |
| UV guide image round trip (`T-genuv`) | owned by the AI-UV experiment |
| Binder and addendum surfaces | die design, outside styling and game delivery |
