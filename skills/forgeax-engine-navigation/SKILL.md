---
name: forgeax-engine-navigation
description: >-
  ForgeaX bounded graph/grid and static NavMesh navigation. Use when baking ground
  clearance, projecting routes, avoiding nearby characters, or following paths through physics.
---

# forgeax-engine-navigation

| Need | Entry |
|:--|:--|
| Authored network or weighted tile grid | `createNavigationGraph` / `createNavigationGrid`; query `findPath` with an expansion budget |
| Static finite-size ground navigation | Build selected indexed Mesh/world placement through `@forgeax/engine/import/navigation-bake`; return the POD as an ordinary Pack output |
| World-space surface query | Load `navigation-mesh` through Catalog, call `createNavigationMesh`, then `project` / `ground` / `findPath` with explicit limits |
| Physical character | Install `physicsPlugin('rapier-3d')` and `navigationCharacterPlugin(mesh)`; author NavigationCharacter + kinematic capsule; assign `setNavigationTarget` |
| Local point following | `NavigationAgent`, `navigationPlugin`, `setNavigationPath`; local Transform coordinates and speed |
| Bounded nearby-agent intent | `solveNavigationAvoidance`; consume actual velocity and inspect saturation; optional candidate admission must remain bounded |
| Pause / cancel / replacement | Idle/following toggles; empty setNavigationPath; setNavigationMesh followed by explicit retarget |

Use the [Navigation contract](../../packages/navigation/README.md) for capsule scale,
KCC offset, fixed ordering, asset freshness and limits. Observe actual displacement
and blocked state; a congested local solver is not a traffic scheduler. Physical
controllers are excluded from the point follower. Invalid/unreachable/budget results
never prove arrival. Rebuild a faulted World through its owning App recovery route.

Run package tests and the contract's geometry, Catalog, real KCC, browser/Worker and
performance recipes. For unexplained visible output, capture the real frame through
RHI Debug before editing shaders/materials.
