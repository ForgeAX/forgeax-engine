# X5 design: mesh bevel vs exact fillet agreement report

> [!NOTE]
> Scope: a measurement report and falsifier under `src/brep/__tests__/`. No operator, no public API, and
> no change to `TS_KERNEL_DIGEST`.

## Purpose

The phase-2 plan (X5) asks how far the mesh bevel, including its per-edge width form, agrees with the
exact B-rep fillet operators. The result feeds the B28/B24 ruling. The report gives relative volume
ratios (mesh bevel volume / exact fillet volume) over a small grid of radii and segment counts.

## Owner

| Concern | Owner | Change |
|:--|:--|:--|
| Mesh bevel | `src/bevel.ts`, `src/model.ts` (`bevel`) | none |
| Exact fillet | `src/brep/fillet-box.ts`, `fillet-cylinder.ts`, `fillet-prism.ts` | none |
| Report | `src/brep/__tests__/x5-bevel-report.unit.test.ts` | new |

The owner is unchanged: the report is a test-side consumer of the two existing owners.

## Shape of the report

- Cases: box (r 0.10, 0.25, 0.45), cylinder (r 0.25, 0.50, 1.00), square prism (r 0.25, 0.50, 0.90),
  regular hexagonal prism (r 0.20, 0.40, 0.60); each at segments 2, 4, 8.
- Mesh side: `model().validate().volume` of the bevelled model. A second, independent reading comes
  from the `toMesh()` export (signed volume over the position attribute and index buffer). The two must
  agree.
- Exact side: `measure(shape).volume`, checked against a closed form derived independently of the
  kernel (Steiner for box, Pappus for cylinder, corner-area sum for prisms).
- Tangent width: a 90 degree corner takes width r; a hexagon corner turns 60 degrees, so width is
  r tan(30 degrees), which makes the bevel tangent length equal to the fillet radius.
- Rim selection for the cylinder is `sel.edges.dihedral('>', 30)`, asserted to return exactly 2 x 64
  edges.

## Falsifier

The table builder takes an injectable operator set. Real operators are the default. The falsifier tests
feed constant mocked volumes and expect a throw from one of three checks: the exact side against the
closed form, the mesh export against validate, and a plausibility band on the mesh ratio. A table that
merely reads a constant cannot pass.

## Not measured

- Box per-axis widths: the exact `filletBox` takes one radius, so there is no exact counterpart.
- Prism mixed-radius corners: the exact `filletPrism` accepts per-vertex radii, but the report does not
  build the matching per-vertex mesh widths.

## Concept-count delta

Zero new public concepts. One test file. Builder, closed forms and falsifier are local to the test.
