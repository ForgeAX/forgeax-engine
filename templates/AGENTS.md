# ForgeAX Game Project Guide

TypeScript game on `@forgeax/engine`. Read a reference only when its task applies.

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

- **Iterate locally:** `pnpm exec forgeax dev start` serves source; Vite/DevKit handles TypeScript and Pack assets as needed. No prior `project build`, separate asset build, or manual TypeScript compilation is required.
- **Build and preview:** `pnpm exec forgeax project build` produces the production `dist/` through Vite and asset producers; `pnpm exec forgeax project preview` serves it. `pnpm typecheck` is a separate check, not a launch prerequisite.

| User intent | Route |
|:--|:--|
| Create, change or locally play (default) | Local playable delivery |
| Publish, deploy or distribute | Game release |
| Engine/SDK change, SDK publication, performance | Owning package, SDK production, performance skill |

```bash
pnpm exec forgeax project check --json          # structure and types
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
the final screenshots and they pass the visual self-review against the intended look. If a check
cannot run, report it as not run.
Serve `release/` with `forgeax project preview` (it sets the COOP/COEP headers and handles
multiple connections).
