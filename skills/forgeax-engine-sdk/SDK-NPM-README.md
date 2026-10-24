# @forgeax/engine-sdk

> [!IMPORTANT]
> This package is the npm carrier for the ForgeaX Engine SDK. It contains the
> SDK source payload and Engine byte references under `sdk/`; it is not a game project and it does not
> install dependencies into the current directory by itself.

## Quick start

Use the ForgeaX umbrella CLI to install this carrier into a directory outside
the npm cache:

```bash
pnpm dlx @forgeax/engine@latest sdk install ~/ForgeaX/sdk
cd ~/ForgeaX/sdk
node ./bin/forgeax.mjs project init
node ./bin/forgeax.mjs project new ../my-game --template game-3d  # 3D games
cd ../my-game
pnpm exec forgeax project check --json && pnpm test && pnpm exec tsc --noEmit && pnpm exec forgeax project build --json
pnpm exec forgeax project preview --json
```

The carrier depends on the exact same-version `@forgeax/engine`. Engine-owned
bytes are downloaded once through that dependency; the carrier ships source and
SDK additions plus integrity-checked references for shared files. `sdk install`
materializes the complete source workspace, including prebuilt module outputs and
WASM, before returning. Rebuild changed owners and reuse the other owners' builds.
The full ZIP additionally supplies the offline pnpm store and bare package
inventory for a network-free game handoff.

## What is included

| Surface | Purpose |
|:--|:--|
| `sdk/bin/` | Standalone `forgeax` CLI used to initialise the SDK and create games |
| `sdk/templates/` | Explicitly selected `empty` and source-complete `game-3d` starter projects; the latter keeps procedural packs and a readable imported UI pair |
| `sdk/skills/` | Engine authoring and debugging skills copied into each game |
| `sdk/source/engine/` | Editable source; shared WASM and prebuilt modules are materialized from Engine during `sdk install` |
| `sdk/AGENTS.md` | AI-first workflow, capability map, asset and verification guidance |

The package root README is intentionally short; after installation, read
[`sdk/README.md`](sdk/README.md) and [`sdk/AGENTS.md`](sdk/AGENTS.md) for the
complete workflow and capability tour.

## Choose ZIP or npm

```mermaid
flowchart LR
  A[Need an SDK] --> B{Network available?}
  B -->|Yes| C[pnpm dlx @forgeax/engine sdk install]
  B -->|No or reproducible handoff| D[Download SDK ZIP]
  C --> E[forgeax project init]
  D --> E
  E --> F[forgeax project new ../my-game --template game-3d or empty]
  F --> G[doctor, test, typecheck, build, package, serve]
```

Both surfaces use the same Engine version and pnpm lockfile. A game stays
pinned to the SDK used to create it; when a newer `@forgeax/engine-sdk` is
available, review its release notes and migrate/test the game explicitly.

For browser-compositor screenshots, use `forgeax project capture --backend auto`; use
`--backend software` on a machine without a display or physical GPU. The final
`page.screenshot()` PNG contains the Canvas and HTML/Shadow DOM UI, while the
sidecar separately proves a non-flat Canvas frame and the Engine
`frame-submitted` signal.

Install dependencies in `source/engine/` once, rebuild the changed package and
bind the game to that workspace without changing its manifest. See
[`sdk/README.md`](sdk/README.md#bind-local-engine-source) for the build commands:

```bash
forgeax project engine status --json
forgeax project engine use-local /path/to/sdk/source/engine --json
forgeax project engine check --json
forgeax project engine unlink --json
```

The binding lives in `.forgeax/engine-binding.json`; `doctor` fails closed for
an unbuilt workspace or npm-incompatible `workspace:*` dependencies.

## Requirements and links

- Node.js `>=22.13.0`
- pnpm `12.10.1` or newer in the pnpm 12 line (Corepack can activate it)
- Browser with native WebGPU or the supported WebGL2 downlevel path for rendered previews

For the public entry guide, see [ForgeaX Engine for AI-assisted game
development](https://forgeax.github.io/download/engine-ai.md). The installed
SDK remains the authoritative, versioned documentation for its exact
capabilities and files.

Apache-2.0. © ForgeaXGame.
