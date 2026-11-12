# @forgeax/engine

`@forgeax/engine` is the one package a game author installs. Its root is the
runtime entry, its focused subpaths expose every Engine capability, and its
`forgeax` binary owns project creation, validation, development, build, preview,
and SDK installation.

```bash
pnpm add @forgeax/engine
pnpm exec forgeax project check
```

pnpm projects that use Vite should keep
`public-hoist-pattern[]=@forgeax/engine-*` in `.npmrc`. Generated ForgeAX games
already include it; the focused hoist lets package-owned dynamic imports resolve
from Vite's project-level optimization cache without exposing extra declared
dependencies.

```ts
import { createRenderer } from '@forgeax/engine';
import { World } from '@forgeax/engine/ecs';
import { Transform } from '@forgeax/engine/scene';
```

## Game authoring workflow

For every new or resumed game task, read the game project's `AGENTS.md` before editing.
Its **Run, test, build, and release** section selects the requested delivery scope
and stop condition, defaulting to a local playable handoff.
Continue through project-local `skills/forgeax-engine-sdk/SKILL.md` for capability
selection and `skills/forgeax-engine-cli/SKILL.md` for commands. These installed
documents remain the entrypoints after bootstrap.

For a new project, use the SDK installation below and read its `AGENTS.md` before
creation; `project new` installs the game guide and local skills and reports their
paths in `value.onboarding.read`.

## Import model

| Import | Meaning |
|:--|:--|
| `@forgeax/engine` | Runtime renderer assembly and the usual game entry |
| `@forgeax/engine/app` | App and frame-loop assembly |
| `@forgeax/engine/ecs` | ECS world, components, queries, and systems |
| `@forgeax/engine/<package-directory>` | The matching focused Engine package |

The focused `@forgeax/engine-*` packages remain physical ownership units.
The official npm tarball includes their complete locked runtime dependency graph
through standard `bundledDependencies`, with unpatched, single-version third-party
platform leaves pinned as optional registry dependencies. Installation never needs separately
published focused-package versions. Generated ESM facades retain focused imports;
shipping one tarball does not eagerly import every capability into a game.

Install the stable channel with `pnpm add --save-exact @forgeax/engine`.
Test builds require `pnpm add --save-exact @forgeax/engine@rc`; development builds
require `pnpm add --save-exact @forgeax/engine@next`.
Release producers and hotfix maintainers follow RELEASING.md.
The single-package release report
records the 0.4.0 source, publication and consumer evidence.

The facade build stages the complete forwarding inventory before publishing each
changed file by atomic rename. Existing imports remain readable during a rebuild;
obsolete paths retire afterward. This is a per-file publication guarantee, not an
atomic rebuild of the physical Engine packages behind those forwarding modules.

## SDK

The ordinary npm package is the connected, incremental development path. The
full SDK adds offline templates, Engine skills, a pnpm store, and the complete
public Engine source snapshot:

```bash
pnpm dlx @forgeax/engine sdk install ~/ForgeAX/sdk
cat ~/ForgeAX/sdk/AGENTS.md
node ~/ForgeAX/sdk/bin/forgeax.mjs project init
node ~/ForgeAX/sdk/bin/forgeax.mjs project new ~/Games/my-game --template empty
cat ~/Games/my-game/AGENTS.md
```

The SDK is fetched on demand from the public npm registry at the exact same
version. A private GitHub Release is an internal archive, not a user download
dependency.

## Asset-backed LOD recipe

Import a glTF or FBX through the project importer, keep the format relation and
author overrides in the producer sidecar, and publish all lower-detail meshes
in one Pack closure. The runtime consumes the normalized `MeshAsset.lods`
contract; it does not inspect FBX or glTF extension details.

```mermaid
flowchart TD
  A["glTF MSFT_lod or FBX FbxLODGroup"] --> B["registered importer"]
  B --> C["Meta plus stable GUID closure"]
  C --> D["Pack and Catalog publication"]
  D --> E["Renderer LOD and occlusion lanes"]
```

For a first import with `n` lower levels, use the shared default sequence
`round6(0.5 * 0.4^(i-1))`: two total levels become `0.5`, three become
`0.5, 0.2`, and four become `0.5, 0.2, 0.08`. Existing sidecar coverage is
preserved by `sourceKey`; only an appended suffix receives defaults. Every
lower mesh GUID must be in the root mesh `refs[]`, otherwise publication stops
before DDC or Catalog mutation.

> [!WARNING]
> `smoke` proves the real asset/import route and `RhiNull` proves structural
> fallback. A release-quality silhouette or timing claim additionally needs
> same-device Browser/Dawn readback with matching source, view, slot, and
> generation identity.
