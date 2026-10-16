# Saved path following demo

> [!IMPORTANT]
> Rendering, replay and complete GPU acceptance are pending. See the [Path validation contract](../../../packages/path/VALIDATION.md) for the frozen numerical and timing budgets.

This scene loads the ordinary authored [Pack](assets/path.pack.json) through App assets by GUID. Eight patrols retain independent world-distance progress; a camera follows the same rail; a kinematic platform consumes `DesiredPathPose` through the existing physics motor. Meshes show forward orientation and equal-distance markers.

| Route | Command / behavior |
|:--|:--|
| Development | `NODE_ENV=development pnpm --filter @forgeax/path-follow-demo dev --host 127.0.0.1 --port 5416`; ordinary Pack JSON transport and Vite reimport. |
| Static | `pnpm --filter @forgeax/path-follow-demo build`; serve only `dist/`, with COOP `same-origin` and COEP `require-corp` for Worker mode. No private asset files are required. |
| Static recording | `pnpm --filter @forgeax/path-follow-demo build --mode capture`; serve only this `dist/` at port 5417. This explicit diagnostic build retains the existing App recorder flag while using production Pack/Catalog delivery (`DEV=false`). Ordinary production builds keep the default recorder erasure. |
| Normal production evidence | Serve the ordinary build at port 5418 with the same Worker isolation headers. `scripts/production.mjs` verifies recorder erasure, exact-tick canvas pixels against the diagnostic build, movement/pause falsifiers and the physical motor. The complete capture command runs this check after static replay. |
| Worker | Open `worker.html`; the normal App Engine Worker owns both World and Renderer and presents through native OffscreenCanvas. Render Worker is disabled in this fixture. Reload closes the old Worker and creates a fresh realm/App/World. World identity counters are realm-local and may repeat; native Worker events verify replacement. This fixture does not assert poisoned-App execution recovery. |
| Capture | Under the shared physical GPU flock, run `node apps/perf/path-follow/scripts/capture.mjs`. Development defaults to port 5416 and static output to port 5417; environment overrides are in the scripts. |
| Evidence | Fixed-state images/video, tape bytes/digests, normal Catalog publication revisions, missing-GUID failure, motion/pause falsifiers and desired/actual platform positions. Fresh-device replay decodes the exact transform rows selected by the actual mesh draw and its bound camera. |

The debug stepping seam uses App frame ownership and the existing World fixed delta. Worker inspection observes normal frames and freezes authored follower progress. It introduces no second game clock. Reimport replaces the Scene/App instance and restores saved initial distances; runtime `World.set(Path)` changes retain distance before wrapping or clamping.

The custom Vite host installs DevKit `executionWorkerEntries()` so production Worker entries and the URL-loaded bootstrap share Engine component tokens. The retained public-build failure records the missing adapter; `scripts/capture-one.mjs` exercises the real Worker lifecycle and saved Scene loading on both development and static delivery.
