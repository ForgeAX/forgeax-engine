# ForgeAX Game Project Guide

AI-first TypeScript game on `@forgeax/engine`. Hard rules and routing here;
open a reference only when its task applies. Never read whole large `SKILL.md` files;
stop after their short start section unless the task needs more.

## Start here

1. Imports and signatures: the API index before searching `node_modules`.
2. Effects in an `empty` project: the effects cookbook
   indexes topics; open ONLY one.
3. Commands: the Quick contract atop [`forgeax-engine-cli`](skills/forgeax-engine-cli/SKILL.md);
   exact inputs come from `pnpm exec forgeax help <path> --json`, never guesses.
4. Pick the route in [Run, test, build, and release](#run-test-build-and-release), then edit.
5. Rendering has native equivalents for most Three.js core features: look an effect up in
   the Three.js equivalence guide (with gaps) before simplifying it.

## Hard rules

- `forge.json` owns project configuration and `forge.json#roots` is the sole plugin
  assembly authority; stable GUIDs own asset identity. Never add parallel manifests,
  lifecycles or runtime entrypoints.
- Assets: author source → importer/cooker → DDC → catalog → `assets.load(guid, kind)`.
  Author in `assets/` (`*.pack.ts`, `*.pack.json`, `<file>.meta.json`); never edit `dist/`,
  `pack-index.json`, DDC or `.forgeax/`, or fetch assets manually.
- Content made during play skips Packs: bind `ctx.assets.create(...)` output, release it
  from the effect ([`forgeax-engine-assets`](skills/forgeax-engine-assets/SKILL.md#runtime-identity-and-content)).
- Each Pack `build()` key is a `sourceKey`: lowercase segments matching
  `^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$` (`mesh/crate`). GUID =
  `UUIDv5(packageId, sourceKey)`. ScriptablePack files end in `.pack.ts`.
- Import only `@forgeax/engine` or `@forgeax/engine/<package-directory>`, never
  `@forgeax/engine-*`.
- Add dependencies with `pnpm add <name>`, not by editing `package.json`. If a frozen
  lockfile rejects an edit or `packageManager` change, run `pnpm install --no-frozen-lockfile`.
- Game logic is a native Cordis `Plugin`; cleanup belongs to `ctx.effect()`. DOM, Web
  Audio and browser SDKs belong to the frontend root, never Engine Workers.
- Expected failures return `Result`: branch on `.code`, keep `.expected`/`.hint`/`.detail`.
- Run `pnpm exec forgeax <path> --json`; add `--detail` only for `omitted.fields` you need.
- `game-3d` content is a reference, not the game: record its
  Template Disposition first.
- Before delivery, list each requested requirement; the playthrough asserts each through
  the read projection and saves one named screenshot per requirement (every ending, each
  object type, multi-enemy states, the core input's visible effect; failure and debug
  frames belong in `.forgeax/diag/`, not `artifacts/`). Never bend game code
  for the test (enemies spawned ahead, exposed aim targets). See
  Requirement coverage.
- Append confirmed Engine/SDK issues to `docs/feedback.md` at once (no secrets);
  `project package` ships it.
- Edit this project directly. A ForgeAX closed loop needs explicit user agreement.
- Capture with [`forgeax-engine-rhi-debug`](skills/forgeax-engine-rhi-debug/SKILL.md) only for
  unexplained black frames, missing objects, wrong lighting or flicker, before editing
  shaders; never to deliver.

## Run, test, build, and release

| User intent | Route |
|:--|:--|
| Create, change or locally play (default) | Local playable delivery |
| Publish, deploy or distribute | Game release |
| Engine/SDK change, SDK publication, performance | Owning package, SDK production, performance skill |

```bash
pnpm exec forgeax project check --json
pnpm test && pnpm typecheck
pnpm exec forgeax project play scripts/playthrough.mjs --json
```

Accept local delivery only on the final code: `project play` (or `dev verify`) passes; you opened the PNG, see the requested scene/UI and passed the
[visual self-review](skills/forgeax-engine-sdk/SKILL.md#visual-self-review); you drove
the core input and saw its result; both survive a reload. A build, URL, HTTP 200 or unit
test alone accepts nothing. A blocked check stays unverified: report it, never a pass.

Evidence comes only from these commands' owner browser. Hand over the `dev status` URL;
never open or drive another tab for acceptance (it may be backgrounded; its
`live-bridge-not-owner` warning is expected). Run `project play` and `dev verify` blocking
in one call with a large exec yield (21+ min at default budgets: ~14 per play, +7 when queued),
or lower `--timeout-ms`; never background or poll them. Each prints one JSON result and at
most one stderr progress line per 30 s. The live owner is optional: `dev` observations start
it on demand; upkeep is only `dev start`/`dev stop`. For timers or long waits, call
`play.advance(seconds)`, not `play.wait`/long `waitFor` timeouts. Fix its `layout` warnings (HUD text overlapping
or clipped at 1280x720/1280x600) before committing.

On an unchanged `empty` template, `play-runtime-failed` with reason `flat-canvas` is the
expected start, not an environment failure.

## Task routing

| To | Read |
|:--|:--|
| Layout, SDK setup, skill links, Engine model, View | project guide |
| Asset forms, import, verify | Asset authority, then `forgeax-engine-assets` |
| Roots, plugins, third-party SDK startup | Game code, `forgeax-engine-app` |
| Pick Engine capabilities | [SDK skill](skills/forgeax-engine-sdk/SKILL.md) table; feature catalog on demand |
| Camera, lights, shadows, post | Quick contract of `forgeax-engine-render-pipeline` |
| Materials, textures, WGSL | `forgeax-engine-material`, `forgeax-engine-shader` |
| Input, frame loop, HUD, pointer lock | `forgeax-engine-app`; cursor games call `gameHost.setPointerLockAllowed(false)` once |
| Physics, character motion | `forgeax-engine-physics` |
| Blocked checks, Linux headless, release | delivery guide |
| Scripted playthrough and acceptance | `forgeax project play` in the CLI skill quick contract; edit `scripts/playthrough.mjs` |
