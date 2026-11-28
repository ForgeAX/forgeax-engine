# Design v10 amendments

Part of the [`@forgeax/engine/modeling` reference](../README.md).

Source: plan `phase2-architecture-and-plan.md` §1.6 (the plan lives in the Studio research tree, not in this
repository). This page lists each amendment the plan makes to the design document and what main shows for it at
76581473 (2026-11-13). "Verified" means a file or export on main shows it. "Plan only" means the amendment is text
that has not been checked against code, or depends on a later milestone.

## Amendments

| Section | Amendment | Main status |
|:--|:--|:--|
| 2.2 non-goal | Restate "industrial CAD" as: no STEP, **no 3D assembly/mate solver**, no cross-file tolerance chains. | Plan only (text). No mate/assembly solver module exists under `src/`. |
| 2.2 non-goal | `sketch.solve` exists (2D, 11 constraints, landed with SolidCraft L7). | Verified: `solve` in `src/sketch.ts`; its constraint union includes `coincident`, `distance`, `horizontal`/`vertical`, `parallel`/`perpendicular`/`equal`, `radius`, `tangent`, `angle`, `fix`. The count of 11 was not re-counted here. |
| 2.2 non-goal | Per-entity tolerance growth inside the exact stage is bounded and reported; the opt-in exact stage exists. | Verified in part: the exact stage is opt-in (`reference/exact.md` §Use, §Injection). The bound wording is plan text. |
| 4 diagram | Diagram adds the exact stage. | Plan only (diagram not re-checked here). |
| 4.1 job contract | `tessellate` runs in-process in phase 2 (D-P2-13). | Plan only. |
| 5.10 | New section "Exact form (Shape)". | Plan only. The reference is `reference/exact.md`. |
| 5.7 | "One model, two forms" gets the exact-stage clause. | Plan only. |
| 5.4 | `EDGE_SHARP` written by an exact producer is author intent. The `customNormal` row is corrected because no such channel exists. | Verified: `EDGE_SHARP = 1` in `src/mesh.ts`, used by `src/synthesize.ts`; no `customNormal` symbol in non-test source. |
| 6.1 | Shape faces carry label and role only. | Verified: `label` and `role` on the face type in `src/brep/types.ts`. |
| 13 | "B-rep solids" research item is delivered by E0-E3. | Plan only. |
| 14.2 | `package.json` exports gain `./brep`; the export path is corrected from the manifest's package name. | Verified: `./brep` export exists (`dist/brep/index.mjs`); package name `@forgeax/engine-modeling`. Umbrella forwarding `@forgeax/engine/modeling` is **unverified** here and is checked on `integration/modeling` at B-E0d1. |
| 14.4 / 14.5 | Engine seam rule for `lodFromShape` (X3). | Plan only. |
| 16 | Adds phase P4 "exact stage". | Plan only. |
| 17 | Adds R20-R30 (section 6). | Plan only. |
| Appendix J | v10 record. | Plan only. |

## Same-PR obligations when `./brep` is exported (P2-F5)

The `./brep` export is on main, so these obligations apply to any change to that export:

- AGENTS.md module-map row for the exact stage.
- Capability catalog, feature-lab feature and Harness manual kept in one change.
- `reference/operations.md` and `reference/exact.md` updated with the public surface.
- The `forgeax-engine-modeling` skill updated.

## Follow-ups

- P2-A5b (at B-E0d1): confirm the export path and package name, and check umbrella forwarding on `integration/modeling`.
- The "no 3D assembly/mate solver" non-goal is a scope decision. It is recorded here as the design text; no code gate
  enforces it.
