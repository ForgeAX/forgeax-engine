<!-- LANG-SWITCH -->
**Language**: **English** · [简体中文](README.zh-CN.md)

# ForgeAX Empty Game

This is the SDK's minimal authoring starting point: one asset directory, one native scene Pack with zero entities, and an extensible plugin-composition entry.
It supplies neutral initial content for 2D and other game types.
Add each behavior as a native Cordis Plugin under `assets/` and declare the
project entry in `forge.json#roots`; runtime composes everything through that entry.

> [!NOTE]
> The default scene retains the asset chain with zero entities. No camera is a valid state, not an error. Logic and UI run normally; the game can declare cameras, renderable entities and other capabilities when needed.

```bash
pnpm exec forgeax project check --json
pnpm test
pnpm exec forgeax project build --json
pnpm typecheck
pnpm exec forgeax project package --output release/empty-game-web.zip --json
```

## Optional View

From this game root, open the View included in the installed Engine:

```sh
node ./node_modules/@forgeax/engine/tools/view/start.mjs --project .
```

Keep the terminal open and open the returned URL. The page reports Backend and
project readiness; the URL alone is not readiness. No global SDK or Engine build
is needed. Agent guidance: `skills/forgeax-view-start/SKILL.md`, or the copy under
`node_modules/@forgeax/engine/tools/view/skills/` for older projects.

## Project Boundaries

| Path | Responsibility |
|:--|:--|
| `forge.json` | Authoritative project identity, default scene and persistent plugin composition. |
| `assets/` | Sole content root for scenes, `*.pack.ts`, `*.pack.json`, external files and their `.meta.json`. |
| `assets/__tests__/` | Vitest tests beside authored source. |
| `assets/world/world.scene.pack.json` | Directly loadable zero-entity scene asset for 2D and other game types. |
| `docs/feedback.md` | Confirmed Engine, SDK, build, asset or browser issues found during development. |

Builds regenerate `pack-index.json`, cooked packages, DDC and `dist/` from authored
source. External images, glTF, fonts and audio retain stable identity in sibling
`.meta.json` files. Prefer `*.pack.ts` for procedural GUIDs, dependencies and outputs; reusable logic belongs in ordinary `lib.ts`.

After building, `forgeax project package --format web-zip` includes root `README.md`
and `docs/feedback.md` verbatim. Feedback entries must include scope, reproduction steps, expected/actual behavior, evidence and status, with no sensitive information.

The plugin defined in `assets/scene-owner.pack.ts` instantiates the default scene; its configuration retains the scene GUID.
