# ForgeaX Game Project Guide

AI-first TypeScript game on `@forgeax/engine`. This file holds hard rules and routing;
open a reference only when its task applies. Never read whole large `SKILL.md` files up
front: each opens with a short start section; stop there unless the task needs more.

## Start here

1. Imports and signatures: `skills/forgeax-engine-sdk/references/api-index.md` before searching `node_modules`.
2. Gameplay in an `empty` project: copy from
   `skills/forgeax-engine-sdk/references/gameplay-cookbook.md`.
3. Commands: the Quick contract atop [`forgeax-engine-cli`](skills/forgeax-engine-cli/SKILL.md);
   exact inputs come from `pnpm exec forgeax help <path> --json`, never guesses.
4. Pick the route in [Run, test, build, and release](#run-test-build-and-release), then edit.

## Hard rules

- `forge.json` owns project configuration and `forge.json#roots` is the sole plugin
  assembly authority; stable GUIDs own asset identity. Never add parallel manifests,
  lifecycles or runtime entrypoints.
- Assets: author source → importer/cooker → DDC → catalog → `assets.load(guid, kind)`.
  Author in `assets/` (`*.pack.ts`, `*.pack.json`, `<file>.meta.json`); never edit `dist/`,
  `pack-index.json`, DDC or `.forgeax/`, or fetch assets manually.
- Each Pack `build()` key is a `sourceKey`: lowercase segments matching
  `^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$` (`mesh/crate`). GUID =
  `UUIDv5(packageId, sourceKey)`. ScriptablePack files end in `.pack.ts`.
- Import only `@forgeax/engine` or `@forgeax/engine/<package-directory>` (for example
  `@forgeax/engine/render`), never `@forgeax/engine-*`.
- Add dependencies with `pnpm add <name>`, not by editing `package.json`. If a frozen
  lockfile rejects an edit or `packageManager` change, run `pnpm install --no-frozen-lockfile`.
- Game logic is a native Cordis `Plugin`; cleanup belongs to `ctx.effect()`. DOM, Web
  Audio and browser SDKs belong to the frontend root, never Engine Workers.
- Expected failures return `Result`: branch on `.code`, keep `.expected`/`.hint`/`.detail`.
- Run `pnpm exec forgeax <path> --json`. If a result lists `omitted.fields`, add
  `--detail` only when you need them.
- `game-3d` content is a reference, not the game: record its
  [Template Disposition](skills/forgeax-engine-sdk/references/game-project-guide.md#game-3d-template-disposition) first.
- Append confirmed Engine/SDK/build/asset/browser issues to `docs/feedback.md` at once
  (no secrets); `project package` ships it with `README.md`.
- Edit this project directly. A ForgeaX closed loop needs explicit user agreement.
- RHI capture is for difficult rendering failures, never a delivery step: only when a
  screenshot shows unexplained black frames, missing objects, wrong lighting or flicker, use
  [`forgeax-engine-rhi-debug`](skills/forgeax-engine-rhi-debug/SKILL.md) before editing shaders.

## Run, test, build, and release

| User intent | Route |
|:--|:--|
| Create, change or locally play (default) | [Local playable delivery](skills/forgeax-engine-sdk/references/game-delivery.md#local-playable-delivery) |
| Publish, deploy or distribute | [Game release](skills/forgeax-engine-sdk/references/game-delivery.md#game-release) |
| Engine/SDK change, SDK publication, performance | Owning package, [SDK production](skills/forgeax-engine-sdk/references/sdk-production.md), performance skill |

```bash
pnpm exec forgeax project check --json
pnpm test && pnpm typecheck
pnpm exec forgeax dev start --json
pnpm exec forgeax dev verify --revision <revision from dev status> --json
pnpm exec forgeax dev capture --json
```

Accept local delivery only on the final code: `dev verify` passes for the current
revision (or `project play <script>` where available); you opened the PNG and see the
requested scene/UI; you drove the core input and saw its result; both survive a reload.
A build, URL, HTTP 200 or unit test alone accepts nothing. A blocked check stays
unverified: report it, never call it a pass.

Evidence comes only from these commands' owner browser. Hand over the `dev start`/`dev status` URL;
never open or drive another tab for acceptance (it may be backgrounded, and its
`live-bridge-not-owner` warning is expected). Run long commands in the foreground and
wait; if the harness backgrounds them, poll at most every 30 s.

## Task routing

| To | Read |
|:--|:--|
| Layout, SDK setup, skill links, Engine model, View | [project guide](skills/forgeax-engine-sdk/references/game-project-guide.md) |
| Asset forms, import, verify | [Asset authority](skills/forgeax-engine-sdk/references/game-project-guide.md#asset-authority-and-formats), then `forgeax-engine-assets` |
| Roots, plugins, third-party SDK startup | [Game code](skills/forgeax-engine-sdk/references/game-project-guide.md#game-code-and-plugins), `forgeax-engine-app` |
| Pick Engine capabilities | [SDK skill](skills/forgeax-engine-sdk/SKILL.md) table; feature catalog on demand |
| Camera, lights, shadows, post | Quick contract of `forgeax-engine-render-pipeline` |
| Materials, textures, WGSL | `forgeax-engine-material`, `forgeax-engine-shader` |
| Input, frame loop, HUD, pointer lock | `forgeax-engine-app`; cursor games call `gameHost.setPointerLockAllowed(false)` once |
| Physics, character motion | `forgeax-engine-physics` |
| Blocked checks, Linux headless, release | [delivery guide](skills/forgeax-engine-sdk/references/game-delivery.md) |
