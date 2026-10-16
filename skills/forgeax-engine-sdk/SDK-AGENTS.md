# ForgeaX SDK: AI entry

Read this first. The directory provides an immediately usable browser-game SDK and public Engine source snapshot; build Engine only when modifying it.

Install through pnpm dlx @forgeax/engine sdk install <dir> from public npm.
Private GitHub Releases are internal archives; consumers need no GitHub
credentials. Installation produces ordinary directories without npm's package wrapper.

## Required onboarding

Before creating or changing a game, read:

1. This file for SDK/project ownership, initialization, and verification.
2. [SDK skill](skills/forgeax-engine-sdk/SKILL.md): capability tour and need-to-skill-to-evidence selection.

project init returns these two paths in value.onboarding.read and prints read lines
in text mode. Consult the [feature catalog](skills/forgeax-engine-sdk/references/feature-catalog.md)
only when the task needs broader discovery; select the smallest useful capability set.

> [!IMPORTANT]
> sdk-manifest.json owns archive integrity. packages contains directly readable built packages without tarballs or nested package wrappers. Do not hand-edit SDK staging, offline stores, or manifests.

> [!CAUTION]
> Game work defaults to direct edits in the current project. Start a ForgeaX closed loop only when the user explicitly selects it; installed skills do not authorize it.

## Create a game

```bash
node ./bin/forgeax.mjs project init          # Preflight the downloaded SDK once.
# Read the reported AGENTS and SDK skill; consult focused references as needed.
node ./bin/forgeax.mjs project new ../my-game --template game-3d  # 3D games.
cd ../my-game
pnpm exec forgeax project check --json && pnpm test && pnpm exec forgeax project build --json
pnpm exec forgeax project preview --json
```

After creation, read the generated game's `AGENTS.md` in full. Its **Run, test, build,
and release** section selects the delivery scope for every new or resumed game task.
Ordinary creation/modification defaults to a local playable handoff. Use its separate
release route only for requested publication/distribution, and the SDK skill's
production reference only for Engine/SDK work. Continue from these local documents.

Select game-3d explicitly for 3D games and
empty otherwise. empty selects its scene-owner PluginAsset through forge.json#roots.engine,
starter tests in assets/__tests__, and scene facts under assets/world. For a clean
3D lighting baseline:

```bash
./bin/forgeax project new ../game-3d --template game-3d
```

> [!IMPORTANT]
> Targets must be outside the SDK root; root/subdirectory targets fail with project-target-inside-sdk before copying. Use sibling or external directories.

Run project init from the SDK root first. It installs native dependencies in a temporary project using
the pnpm 12 lockfile, permits esbuild/Rapier/Engine WASM build scripts, and records the successful
platform tuple in .forgeax/sdk-init.json. Creation is transactional: new copies templates,
installs all Engine skills from the SDK, and installs into staging
with --ignore-scripts. Native binaries reuse the preflight side-effects cache,
without per-game postinstall repetition. Full ZIP uses store/pnpm; npm carriers
fetch the same locked dependencies online. Failures roll back the target. Success must not mutate SDK
package payloads; pnpm may update non-authoritative store index.db caches.
Read the generated game's complete AGENTS guide before authoring
code or assets.

After new succeeds, a best-effort two-second registry query checks the
engine-sdk latest tag. A strictly newer version produces a notice without upgrading. Install new SDKs
separately; existing games retain their Engine version and migrate individually after reviewing notes
and testing. Offline/timeouts/registry failures do not roll back creation. Deterministic automation can set
FORGEAX_DISABLE_UPDATE_CHECK=1. JSON value.sdkUpdate.status distinguishes
`available/current/skipped/unavailable`.

Full-ZIP games pin the normalized SDK store/pnpm path as storeDir in pnpm-workspace.yaml;
later doctor/test/dev/build/preview reuse the offline closure instead of
re-resolving against another default store. npm carriers use registry resolution from the lockfile.

Skipping SDK init makes new or external-project init return
sdk-not-initialized without a partial project. Run SDK-root project init
to recover.

> [!TIP]
> macOS archives may carry Gatekeeper quarantine. Only after confirming a trusted source and an explicit
> quarantine failure should you run xattr -dr com.apple.quarantine /path/to/forgeax-sdk.
> The CLI does not silently bypass system policy.

## SDK map

| Path | Purpose |
|:--|:--|
| bin/forgeax | Standalone project-creation CLI. |
| packages/name | Built public package with manifest/README at its root. |
| templates/empty | Minimal project with a scene-owner Pack and an assets root. |
| templates/game-3d | Feature-owned behavior Packs plus procedural atmosphere, PBR, meshes, and lighting. |
| store/pnpm | Full-ZIP offline closure shared by both templates; omitted by npm carrier. |
| skills | Engine task guides; SDK tour and audited feature catalog. sdk-manifest.json records file/byte closure. |
| source/engine | Public source/contracts/rules/skills and prebuilt WASM. |

## Project, assets, and tools

Generated AGENTS owns project layout, source/Pack/Meta responsibilities, GUID loading, asset types, realms, testing, builds, delivery, and debugging. skills contains ordinary files; .agents/.claude/.cursor/.codebuddy/.workbuddy/.forgeax skill mounts are rebuildable discovery links:

```bash
pnpm exec forgeax project skill verify --json
pnpm exec forgeax project skill install --json
```

Use the single forgeax entry and machine-readable discovery:

```bash
pnpm exec forgeax help --tree --json
pnpm exec forgeax help <command-path> --json
pnpm exec forgeax project build --input request.json --json
pnpm exec forgeax asset verify --json
pnpm exec forgeax shader check --json
pnpm exec a Node or Bun script using the SDK command client inspect.mjs --json
```

For advanced Linux development without a display/physical GPU, read the
[DevKit capture contract](packages/devkit/README.md), then capture Canvas and HTML/Shadow DOM:

```bash
pnpm exec forgeax project capture --software --require-ui \
  --output artifacts/capture/game-ui.png --json
```

This uses source-development assets and browser compositor screenshots; retain adapter/error sidecar evidence.
For cross-machine comparison, add --deterministic and pin game state in forgeaxCapture mode.
App's actual frame-submitted event projects to
document.documentElement.dataset.forgeaxFrameSubmitted and the Canvas
forgeax:frame-submitted event. Capture waits for Engine submission and non-flat Canvas pixels,
then the game's forgeaxCaptureReady checkpoint. Elapsed waiting is
only extra settling, not a deterministic frame or substitute for pixel evidence.
Use a Node/Bun SDK command-client scenario for input, assertions, and multiple checkpoints in one session.
Open browser once, drive native session.page, and call session.capture(name)
after each named ready marker, then close the session. PNGs append to one
schema-v2 manifest; do not restart World with repeated one-shot capture or return live Page/session objects.
SwiftShader screenshots are not physical-GPU or release-acceptance proof.

- authoring/import/build: [`skills/forgeax-engine-assets/SKILL.md`](skills/forgeax-engine-assets/SKILL.md)
- CLI, operations, remote eval: [`skills/forgeax-engine-cli/SKILL.md`](skills/forgeax-engine-cli/SKILL.md)
- App, World, plugins, execution tiers: [App skill](skills/forgeax-engine-app/SKILL.md).
- ECS/state/physics/audio: `skills/forgeax-engine-{ecs,state,physics,audio}/SKILL.md`
- Materials, WGSL, pipelines, GPU VFX: skills/forgeax-engine-{material,shader,render-pipeline,vfx}/SKILL.md.
- Difficult rendering failures: [RHI Debug first](skills/forgeax-engine-rhi-debug/SKILL.md), capture before owner diagnosis.

## Engine and rendering capabilities

App assembles Host, World, Renderer, and plugins. ECS owns game state/time; Render owns extraction/preparation/recording; typed RenderGraph owns resources/passes. RHI prefers browser-native WebGPU and supports wgpu/WASM WebGL2 fallback. A single adapter-unavailable/WebGPU message cannot establish whole-machine failure; inspect final code/hint/detail and route Asset/Shader/Pack/App errors to their owner. Do not swallow startup errors or inject another Canvas game. AssetRegistry consumes importer/cooker GUID catalogs.

Rendering capabilities include procedural sky/ambient, directional/point/spot lights, CSM shadows, PBR/IBL, GPU VFX, and HDR/SSAO/TAA/bloom. Custom GPU effects and compute/raster features use composable WGSL and reflected material schemas.

> [!IMPORTANT]
> Start difficult or unexplained rendering failures with
> [RHI Debug](skills/forgeax-engine-rhi-debug/SKILL.md): capture the actual failing frame,
> inspect work/bindings/resources/target pixels, repair the owner, and repeat the original path.
> Do not defer capture until broad logging, profiler queries, and speculative shader edits fail.

Concrete startup/asset/schema errors route directly to their owner. Preserve structured capture/replay failures and follow skill recovery.
Use Playwright to reproduce and verify real output after repair; HTTP 200, ports, or Canvas existence prove only liveness.

The generated game's delivery-scope section owns local and release acceptance.
For producing/verifying the SDK distribution itself, use the SDK skill's
[production guide](skills/forgeax-engine-sdk/references/sdk-production.md).

## Modify Engine source

Enter source/engine and read its AGENTS only for Engine work. It is a git-archive snapshot, not a nested checkout. The public-distribution marker skips private submodules; checked wgpu/FBX/codec pkg payloads remove the default Rust/Emscripten prerequisite.

```bash
cd source/engine
pnpm install
pnpm build:engine
```

Source edits require owner tests and real execution evidence, then a clean-commit rebuild and exact-ZIP verification.
