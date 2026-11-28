# Constraint sketches

Part of the [`@forgeax/engine/modeling` reference](../README.md).

`sketch.solve(spec, options?)` turns a profile stated as relations into exact 2D coordinates and
returns it as a `region2d` (outlines counter-clockwise, holes clockwise), the shape
`extrudePolygon`, `revolve` profiles and the `region2d.*` operators take. It is a pure function
with no session: the result is `Result<SketchSolution, ModelingError>`.

```ts
const solved = sketch.solve({
  points: { a: [0, 0], b: [0.11, 0.004], c: [0.119, 0.061], d: [0.01, 0.058] },
  curves: {
    base: { kind: 'line', a: 'a', b: 'b' },
    right: { kind: 'line', a: 'b', b: 'c' },
    top: { kind: 'line', a: 'c', b: 'd' },
    left: { kind: 'line', a: 'd', b: 'a' },
  },
  constraints: [
    { kind: 'fix', point: 'a', at: [0, 0] },
    { kind: 'horizontal', line: 'base' },
    { kind: 'distance', a: 'a', b: 'b', value: 0.12 },
    { kind: 'perpendicular', a: 'base', b: 'right' },
    { kind: 'distance', a: 'b', b: 'c', value: 0.06 },
    { kind: 'parallel', a: 'base', b: 'top' },
    { kind: 'angle', a: 'base', b: 'left', degrees: 70 },
  ],
});
if (solved.ok) m.extrudePolygon({ points: solved.value.region[0].outer, depth: 0.01 });
```

## Spec

| Part | Contract |
|:--|:--|
| `points` | Named `[x, y]` start coordinates. The solver moves each the least it can, so a rough drawing is a good start and a far one can diverge |
| `curves` | `{ kind: 'line', a, b }` or `{ kind: 'arc', center, from, to }`. An arc runs counter-clockwise about `center`; its two end points sit on one circle (implied). `from` equal to `to` is a full circle |
| `constraints` | The closed kinds below, in any order |

| Constraint | Names | Meaning |
|:--|:--|:--|
| `coincident` | points `a`, `b` | one location (the loops treat them as one corner) |
| `fix` | point, optional `at` | pinned (default: where it starts) |
| `horizontal`, `vertical` | line | axis-aligned |
| `parallel`, `perpendicular` | lines `a`, `b` | direction relation |
| `angle` | lines `a`, `b`, `degrees` | line b's direction is `degrees` counter-clockwise from line a's |
| `equal` | two lines or two arcs | equal length, or equal radius |
| `distance` | points `a`, `b`, `value` | meters between them |
| `radius` | arc, `value` | meters |
| `tangent` | line, arc | the line touches the arc's circle |

Loops come from the curves: closed chains of curves sharing points (or `coincident` points).
A loop nested inside another is a hole, alternating by depth. Open chains are
`model-precondition` (`profile-not-closed`); a zero-area loop is `model-degenerate`.

## Result

`SketchSolution { region, points, residual, dof, free }`.

- `points` are the solved coordinates of every named point, including arc centers.
- `residual` is the largest remaining violation as a fraction of the sketch size; the default
  acceptance is `options.tolerance` 1e-8.
- `dof` is the number of coordinates the constraints leave free (columns minus the rank of the
  constraint Jacobian), and `free` names the points that can still move. A sketch is fully
  constrained at `dof` 0. An under-constrained sketch still solves: free coordinates stay near
  where they started, so the answer is one valid choice and `dof` says there are more.
- `options.arcTolerance` (default 1e-4 m) bounds the sagitta of the sampled arcs in `region`.

## Failure

- `model-solver-diverged` (`residual`, `iterations`): contradictory constraints (two different
  lengths for one segment, parallel and perpendicular), or a start so far that no solution is
  reachable. Move the start nearer, or drop the constraint the residual points at.
- `model-invalid-argument` (`option` names the failing path, e.g. `constraints[3].line`): an
  unknown point or curve name, a curve of the wrong kind, a non-finite or non-positive value.

## Considerations

- Constraints pay off when relations are the natural statement (tangent slot, equal radii,
  a slanted edge at an angle). Plain dimensions with a known construction are shorter as
  coordinates derived in code; use whichever the drawing states.
- Pin the sketch with one `fix` (or two for a rotation lock); otherwise a fully dimensioned
  profile still slides and rotates, and `dof` counts that.
- Start points decide which of several valid solutions you get (a line flipped across a pivot is
  also valid). Draw them in the intended arrangement, within a few percent of the sketch size.
- A redundant but consistent constraint is accepted and does not change `dof`; a contradiction
  is what diverges.
- Read `dof` and `free` before extruding when a parameter change must not move anything else.

Rows are solved with the rig loop closure's `leastSquares` (Levenberg-Marquardt), so there is no
second solver; the solve is deterministic and uses no ambient state.

Example: [sketch-bracket](../examples/sketch-bracket/): a trapezoid with a stadium slot and a bore,
extruded to a plate; the slant angle, lengths and thickness are Pack parameters.
