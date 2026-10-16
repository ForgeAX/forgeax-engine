# Forbidden City architectural study

A maintained code-authored showcase for architectural modeling, lighting and continuous CLI inspection. One world unit is one meter.

> [!IMPORTANT]
> This is an approximate study, not a measured reconstruction. Whole-palace 85% visual resemblance has not been established. Context buildings, vegetation, carving and surface details remain work in progress.

## Run and inspect

From the Engine root, install workspace dependencies and build the Engine first:

```bash
git submodule update --init forgeax-engine-assets
pnpm install
pnpm build:engine
cd apps/showcase/palace
pnpm exec forgeax help --tree
pnpm exec forgeax dev start --backend auto --headless false --json
pnpm exec forgeax dev focus --name taihedian --json
pnpm exec forgeax dev capture --output artifacts/taihedian.png --json
pnpm exec forgeax dev camera release --json
pnpm exec forgeax dev stop --json
```

WASD moves the authored camera; Q/E moves vertically, Shift accelerates, and right-drag rotates it. CLI camera control is temporary. `focus` fits a building and its children but does not avoid foreground occluders; use `dev camera set` for an explicit viewpoint. TAA accumulates over time, so a submitted frame is not a promise of converged pixels.

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:browser
pnpm package -- --output release/palace-web.zip --json
```

`smoke:browser` opens the project through the Engine browser-capture API, exercises keyboard/mouse input and checks 60 additional submitted frames. It writes PNGs and a report under `artifacts/`. The backend defaults to auto; set `FORGEAX_BROWSER_BACKEND=hardware` or `software` explicitly when required. Final release testing must use the exact packaged bytes.

## Author source

| Source | Responsibility |
|:--|:--|
| `forge.json` | Plugin assembly and default scene |
| `assets/palace.pack.ts` | Pack identity, materials, scene hierarchy, camera and lighting |
| `assets/architecture.ts` | Architectural geometry |
| `assets/environment.pack.ts` | Procedural daylight environment |
| `assets/navigation.ts` | App-input-driven camera movement |
| `assets/footprints.ts`, `waterways.ts` | Attributed projected map data |
| `tools/roof-authoring/generate.mjs` | Offline roof partition generation; `pnpm roofs` regenerates from footprints |

Ordinary SceneAsset parent keys group architectural subjects such as `taihedian` and `corner-tower-376-435`; material parts such as `taihedian/roof` remain addressable. Edit the source and let the normal asset pipeline publish its projection. No private SDK path or local binding is required in this workspace.

See [source attribution and uncertainties](docs/sources.md), [known issues](docs/feedback.md) and [authoring intent](docs/authoring-plan.md). Museum photographs are research references, not shipped textures. OpenStreetMap-derived data remains under ODbL; preserve its attribution when distributing the example.

Texture inputs and editable plaque SVGs live in `forgeax-engine-assets/demo-assets/palace`. Local sidecars retain their GUIDs and resolve those sources directly; no copied texture cache is an authoring authority.
