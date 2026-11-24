# ForgeAX Game Project Guide

[Simplified Chinese](https://github.com/ForgeAX/forgeax-engine/blob/main/templates/AGENTS.zh-CN.md)

TypeScript game on `@forgeax/engine`. Read a reference only when its task applies.

## Before writing code: know the engine

Do this once per game, before the first edit under `assets/` (a page, minutes not tens of minutes):

1. Read the [engine overview](skills/forgeax-engine-sdk/ENGINE-OVERVIEW.md) (capabilities, boundaries, gaps),
   skim the capability catalog and the API index
   (both become release-local files in the SDK), then the Quick contract of each skill the game touches (frame loop and input: `forgeax-engine-app`;
   camera, lights, sky and post: `forgeax-engine-render-pipeline`; physics; vfx; audio; modeling).
2. Write `docs/engine-plan.md`: one row per feature the game needs, as
   need -> engine capability (skill or API) -> entry point -> limit or gap.
3. Build every feature on the capability named in its row. Before writing a helper, mesh builder,
   shader, camera rig, input handler, particle system, collision test or UI widget, look it up in
   the API index and the catalog. Hand-written code is for confirmed gaps only: mark the row
   "gap" with what the lookup found, keep the custom part minimal, and add it to `docs/feedback.md`.

## Rules

- `forge.json#roots` selects the plugin roots (`engine` runs the game, `frontend` owns DOM/UI);
  stable GUIDs own asset identity. In a `game-3d` project start from its content: edit or
  replace `assets/player`, `assets/ui` (HUD: `ui/player-hud.ts` shows engine state received over
  `gameHost.port`) and the read projection (`gameHost.gameProjection.registerRead`) rather than
  writing a game from scratch.
- Author assets in `assets/` (`*.pack.ts`, `*.pack.json`, `<file>.meta.json`); `dist/`,
  `pack-index.json`, DDC and `.forgeax/` are generated outputs. Content created during play is
  bound with `ctx.assets.create(...)` and released from the effect.
- Game logic is a native Cordis `Plugin`; cleanup belongs to `ctx.effect()`. DOM, Web Audio
  and browser SDKs live in the frontend root; Engine Workers hold game logic.
- The engine locks the pointer on canvas click for mouse look; a cursor-aimed game calls
  `gameHost.setPointerLockAllowed(false)` once at startup.
- Import only `@forgeax/engine` or `@forgeax/engine/<package-directory>`.
- Imports and signatures: the API index
  (look APIs up there first); `pnpm exec forgeax help <command> --json` for commands.
- Record confirmed Engine/SDK problems in `docs/feedback.md` (no secrets).

## HDR

The frame stays HDR end to end: lights (point lights included), emissive and bloom are
unclamped scene-linear values until exposure and tone mapping at the end. Brightness tuned
where output is clamped earlier (an 8-bit target, per-draw tone mapping) does not carry over.

## Run, test, build, and release

- **Open optional View:** for interactive project, scene or asset review, read
  `skills/forgeax-view-start/SKILL.md` or the SDK's
  `tools/view/skills/forgeax-view-start/SKILL.md`. From this game root run
  `node /absolute/forgeax-sdk/tools/view/start.mjs --project .`.
  View is shipped only in the SDK; its launcher initializes its own tool runtime
  and matching Engine. Keep the terminal open and verify the requested project
  in the page. Cold Engine CLI help does not discover this file entry.
- **Iterate locally:** `pnpm exec forgeax dev start` serves source; Vite/DevKit handles TypeScript and Pack assets as needed. No prior `project build`, separate asset build, or manual TypeScript compilation is required.
- **Build and preview:** `pnpm exec forgeax project build` produces the production `dist/` through Vite and asset producers; `pnpm exec forgeax project preview` serves it. `pnpm typecheck` is a separate check, not a launch prerequisite.

| User intent | Route |
|:--|:--|
| Create, change or locally play (default) | Local playable delivery |
| Publish, deploy or distribute | Game release |
| Engine/SDK change, SDK publication, performance | Owning package, SDK production, performance skill |

```bash
pnpm exec forgeax project check --json          # project and dependency checks
pnpm exec forgeax dev start --headless true     # once; keeps a warm page for dev look
pnpm exec forgeax dev look --hide-ui true --json  # look-dev: scene PNG after each visual edit
pnpm exec forgeax project play scripts/playthrough.mjs --json   # real input, state, screenshots
pnpm exec forgeax project build --out-dir release --base ./    # static game: release/index.html + assets, any folder
pnpm exec forgeax project play scripts/playthrough.mjs --release --dist release --json  # final: the built release
```

Look before you play. Once the scene builds, start `dev start` and run `dev look` after
every light, material, fog, sky, post or camera edit. Open the PNG and answer the
[visual self-review](skills/forgeax-engine-sdk/SKILL.md#visual-self-review) questions in one
sentence each; fix every "no" and look again. Check-passing code is not a finished
picture: look-dev comes before writing the playthrough, not after it.

`project play` is for gameplay acceptance: edit `scripts/playthrough.mjs` for the game's own
journey (`play.advance(seconds)` for timers, `play.state()` / `play.waitFor()` for the
projection; the API index's playthrough file lists every helper). Any other browser check
against the built `release/` also counts. Done means: core input works in play, and you opened
the final screenshots and they pass the visual self-review against the intended look.
Serve `release/` with `forgeax project preview` (it sets the COOP/COEP headers and handles
multiple connections).

> [!IMPORTANT]
> If the browser run is blocked, name the delivery target, the first failing command and error,
> the recovery attempted, and the player-visible checks still open. Say whether startup,
> rendering and the requested controls were observed. A successful build with a browser launch
> failure leaves all three unverified, and the game may stop before its first playable frame.
> Report the artifact as built with runtime acceptance blocked until the target passes.
