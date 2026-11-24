# ForgeAX Game 3D

A small runnable third-person demo to start your game from, with a transforming red-and-blue
armored robot built by the native modeling toolchain. Click the game to lock the camera;
move with <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>, look with the mouse (or hold the
right mouse button), jump with <kbd>Space</kbd>, run with <kbd>Shift</kbd>, release with
<kbd>Esc</kbd>. Press <kbd>T</kbd> (touch: **Transform**) to become a truck; then
<kbd>W</kbd>/<kbd>S</kbd> throttle and <kbd>A</kbd>/<kbd>D</kbd> steer.

**Read single files on demand; do not cat the whole template.** This page is the index. Per-folder
details, deletion steps, packs, UI realms, lighting, materials and coordinates are in
[`docs/guide.md`](docs/guide.md); open only the section you need.

## Skeleton index

| Path | Purpose |
|:--|:--|
| `forge.json` | Plugin roots: `roots.engine` (game), `roots.frontend` (UI) and `roots.build` (modeling asset job). |
| `assets/game.pack.ts`, `physics.pack.json` | Engine root: composes physics and the scene. Keep. |
| `assets/world/world.pack.ts` | Scene instance; lists feature plugins by GUID. |
| `assets/scene.pack.ts` | Level: ground, obstacles, sun, sky, ambient, camera and player entities, colliders. |
| `assets/player/` | Movement, transform and walk animation, `game-3d.player` read projection, HUD state; `convoy-*.ts` and `modeling-build.pack.ts` author the robot. |
| `assets/camera/` | Pointer-lock third-person camera. |
| `assets/player/character.pack.ts`, `assets/shared/player-rig.ts` | Placeholder robot character (asset job sources, joint hierarchy); reshape it into your game's hero. See "Procedural character" in the guide. |
| `assets/materials.pack.ts`, `assets/shaders/` | Materials and one import-first Surface shader. |
| `assets/geometry.pack.ts` | Primitive meshes for the level. |
| `assets/ui/` | HUD and touch controls (frontend realm). |
| `assets/shared/` | Ids, port messages and math shared by features. |
| `scripts/playthrough.mjs`, `scripts/convoy-playthrough.mjs` | `project play` journeys (the second drives transform, driving and reload); PlayContext API in [`api/play.md`](skills/forgeax-engine-sdk/references/api/play.md). |

## Shortest paths

- **Replace the player:** edit `assets/player/player.ts` (logic) and `assets/player/character.pack.ts`
  (model; the robot is a placeholder for your own hero); or delete `assets/player/` and remove its GUID from `assets/world/world.pack.ts`.
- **Replace the camera:** edit how `eye` and `look` move in `assets/camera/camera.pack.ts`; or delete `assets/camera/` and
  remove its GUID from `assets/world/world.pack.ts`.
- Edit `assets/scene.pack.ts` to replace the level. Keep collision for walkable and blocking
  surfaces. See [Remove or hide starter content](docs/guide.md#remove-or-hide-starter-content).
- After deleting a feature, run `project check`, then adapt and run the playthrough against the new scene.

## Commands

```bash
pnpm exec forgeax project check --json
pnpm exec forgeax project play scripts/playthrough.mjs --require-ui --json
pnpm exec forgeax project play scripts/checkpoint-playthrough.mjs --require-ui --json
pnpm exec forgeax project build --json
pnpm exec forgeax project play scripts/playthrough.mjs --release --require-ui --json
```

While iterating, `project play` takes `--from <step>` for a top-level step with a `setup`.
`--time-scale` runs game time in lockstep (faster), so tune difficulty and pass/fail in
real time; final acceptance runs without either.

Use **Save checkpoint** after moving. The same game restores position and view on its next launch. Music starts when the Host has an audio output, and a chime follows a committed save.

## Optional View

From this game root, open the optional View shipped in the SDK:

```sh
node /absolute/forgeax-sdk/tools/view/start.mjs --project .
```

Keep the terminal open and open the returned URL. The page reports Backend and
project readiness; the URL alone is not readiness. The launcher initializes the
SDK tool runtime and uses its matching Engine. View is absent from this game's
npm dependencies. Read `skills/forgeax-view-start/SKILL.md` or the SDK copy at
`tools/view/skills/forgeax-view-start/SKILL.md` for instance controls.

To look at a scene without playing, list its GUID with `pnpm exec forgeax asset list --type scene --json`
and render it through its authored camera with
`pnpm exec forgeax asset preview --kind scene --guid <guid> --json`.

Append confirmed Engine/SDK issues to [`docs/feedback.md`](docs/feedback.md); it ships in the
release archive with this README.
