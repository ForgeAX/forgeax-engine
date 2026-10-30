<!-- LANG-SWITCH -->
**Language**: **English** · [简体中文](README.md)

<p align="center">
  <img src="https://forgeax.github.io/logo.svg" width="96" alt="ForgeAX" />
</p>

<h1 align="center">ForgeAX Engine</h1>

<p align="center">
  <strong>AI-native TypeScript game engine — turn ideas into playable games.</strong>
</p>

<p align="center">
  AI agents are its primary users. Data, lifecycles, APIs, and tools serve one goal:<br/>
  help AI understand the system, act precisely, inspect results, and repair failures.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
  <a href="https://github.com/ForgeAX/forgeax-engine/actions/workflows/public-source.yml"><img src="https://github.com/ForgeAX/forgeax-engine/actions/workflows/public-source.yml/badge.svg" alt="CI" /></a>
  <a href="https://forgeax.github.io/"><img src="https://img.shields.io/badge/docs-forgeax.github.io-brightgreen.svg" alt="Docs" /></a>
  <img src="https://img.shields.io/badge/TypeScript-ESM-3178c6.svg" alt="TypeScript ESM" />
  <img src="https://img.shields.io/badge/rendering-WebGPU-ff6a00.svg" alt="WebGPU" />
</p>

<p align="center">
  <a href="#made-with-forgeax">Showcase</a> ·
  <a href="#features">Features</a> ·
  <a href="#get-started">Get started</a> ·
  <a href="#ai-efficiency">AI efficiency</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#explore">Explore</a>
</p>

> [!IMPORTANT]
> **Efficiency is the goal; design is the method.** Complete more verified game-development work with less context, fewer failed attempts, and shorter feedback cycles.

<a id="made-with-forgeax"></a>
## Made with ForgeAX

Games built on the engine, authored through the `forgeax` CLI and an AI-first workflow.

<table>
  <tr>
    <td width="50%" align="center">
      <a href="https://forgeax.github.io/games/hellforge/"><img src="https://forgeax.github.io/assets/readme/games/hellforge.jpg" alt="Hellforge" width="100%" /></a><br/>
      <strong>Hellforge</strong> · ARPG / 3D
    </td>
    <td width="50%" align="center">
      <a href="https://forgeax.github.io/games/planet-snake/"><img src="https://forgeax.github.io/assets/readme/games/planet-snake.jpg" alt="Planet Snake" width="100%" /></a><br/>
      <strong>Planet Snake</strong> · 3D Survival
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <a href="https://forgeax.github.io/games/go-karts/"><img src="https://forgeax.github.io/assets/readme/games/go-karts.jpg" alt="Pet Go-Karts" width="100%" /></a><br/>
      <strong>Pet Go-Karts</strong> · Racing / 3D
    </td>
    <td width="50%" align="center">
      <a href="https://forgeax.github.io/showcase/"><img src="https://forgeax.github.io/assets/readme/games/ai-weapon-spirit.jpg" alt="AI Weapon Spirit" width="100%" /></a><br/>
      <strong>AI Weapon Spirit</strong> · ARPG / 3D
    </td>
  </tr>
</table>

<p align="center"><a href="https://forgeax.github.io/showcase/">Browse the full showcase →</a></p>

<a id="features"></a>
## Features

- **Rendering** — Materials, lights, shadows, post-processing, GPU particles, trails, and beams on WebGPU
- **Gameplay** — ECS world, 2D/3D physics (Rapier), animation, input, audio, and network sync
- **Asset pipeline** — Import glTF / FBX / images, or generate assets in TypeScript with parameterized variants
- **AI-first debugging** — Query live entities, record / replay render frames, and inspect draws down to pixels
- **CLI workflow** — Create, run, inspect, and package games with `forgeax` commands
- **Multi-platform** — Web, WeChat Mini Game, Steam, Steam Deck, Switch, and Kubee

<a id="get-started"></a>
## Get started

Install the engine and its AI toolchain into your editor:

```bash
npx -y @forgeax/game install
```

Available for Claude Code · Cursor · ChatGPT · Kimi Code · DeepSeek · VS Code.

Or start a project from the engine directly:

```bash
pnpm dlx @forgeax/engine project new my-game --template game-3d
cd my-game
pnpm exec forgeax dev start --headless false
```

`game-3d` is a third-person reference; `empty` is a minimal start. Read the generated README and skills, then see [Engine](packages/engine/README.md) and the [CLI guide](skills/forgeax-engine-cli/SKILL.md).

<details>
<summary>Run and verify</summary>

```bash
pnpm exec forgeax help --tree --json
pnpm exec forgeax project check
pnpm exec forgeax dev status --json
pnpm exec forgeax dev capture --json
pnpm exec forgeax dev stop --json
pnpm exec forgeax project test
pnpm exec forgeax project package --format web-zip
```

Observations carry a `revision`; captures return PNG and report references. For entity lookup, camera control, and runtime identity constraints, see [persistent live control](packages/devkit/README.md#persistent-live-control).

</details>

<details>
<summary>Build from engine source / SDK</summary>

Toolchain versions are defined in [`.nvmrc`](.nvmrc), [`.pnpm-version`](.pnpm-version), and [`.bun-version`](.bun-version).

```bash
pnpm install
pnpm build:engine
pnpm test
```

| Scenario | Entry |
|:--|:--|
| Install the SDK | `pnpm dlx @forgeax/engine sdk install ./forgeax-sdk` |
| SDK `source/engine/` | Independent public source with `.forgeax-public-distribution` and prebuilt WASM; run the install / build commands above without private submodules |
| Full contributor checkout | Clone with `--recurse-submodules` for authorized private asset access; run `pnpm build` for the complete application fleet |
| Single demo iteration | `pnpm build:app hello/triangle`; broader acceptance follows the Smoke gate |

The SDK includes built packages, templates, skills, and Engine source. See the [SDK guide](skills/forgeax-engine-sdk/SKILL.md) for release and acceptance contracts.

</details>

<a id="prerequisites"></a>
## Prerequisites

- **Node.js** ≥ 22.13.0 — [`.nvmrc`](.nvmrc) pins `22.22.3`
- **pnpm** `12.10.1` via Corepack (`corepack enable`)
- **Bun** ≥ 1.2.0
- A **WebGPU-capable browser** (latest Chrome / Edge)

<a id="ai-efficiency"></a>
## AI efficiency

Efficiency means **verified useful work**, accounting for diagnosis and rework, context, and tool round trips.

| Capability | How it improves AI efficiency |
|:--|:--|
| **Transparent rendering** | [RHI-debug](packages/rhi-debug/README.md) records and replays self-contained frames, exposing draw/dispatch work, bindings, resources, and pixels to locate incorrect inputs |
| **Transparent runtime logic and data** | [ECS](packages/ecs/README.md) makes components, queries, and schedules explicit; [Remote](packages/remote/README.md) queries live instances to locate failures from actual state |
| **Authorable, traceable assets** | [ScriptablePack / Pack](packages/pack/README.md) generate content in TypeScript or declare it in JSON; stable GUIDs connect sources and artifacts, with repair routed through the producer |
| **Reversible plugin changes** | [Native Cordis](packages/plugin/README.md) unifies dependencies, activation, and cleanup; failed configuration updates can restore the last working Fiber |
| **Measurable performance and results** | [Profiler](packages/profiler/README.md) provides bounded CPU captures and offline comparison; [Preview](packages/preview/README.md), browser captures, and project tests supply runtime evidence |
| **CLI-first operation** | [DevKit](packages/devkit/README.md) unifies `forgeax` discovery, JSON input/output, and persistent instances for repeatable, composable operations |
| **Context on demand** | [Skills](skills/), package contracts, and tool descriptions reveal only the knowledge needed for the task |
| **Structured failure and recovery** | [`Result` and closed error unions](packages/types/README.md) provide codes, expectations, hints, and details; capabilities, execution tiers, and recovery state are explicit |

> [!NOTE]
> Screenshots, structural checks, and real GPU execution answer different questions. CPU captures cannot substitute for GPU performance measurements.

<details>
<summary><strong>Design principles</strong></summary>

**Compression is intelligence: reduce the concepts needed to understand local behavior.** Avoid duplicate state, extra lifecycles, and implicit branches.

| Design principle | How ForgeAX applies it |
|:--|:--|
| **AI is the primary user** | Prioritize discoverable, callable, verifiable machine contracts; AI usability takes precedence over human convention |
| **One source of truth** | World owns game state, Renderer owns render projections, and source assets plus Meta own author facts; other layers consume or derive |
| **Derive from declarations** | Material `paramSchema` derives layouts; RenderGraph derives dependencies and lifetimes from accesses; project declarations generate the Catalog |
| **Compose within domain boundaries** | Physics, rendering, assets, and audio own their execution data; plugins assemble capabilities and ECS schedules frame work |
| **Native lifecycle and unified cleanup** | Cordis `Context / Entry / Fiber` manage capability existence; `inject / provide / effect` express dependencies, services, and cleanup |
| **Explicit states and failures** | Closed unions, structured errors, and reported capability absence and fallback reduce hidden branches |
| **Prepare at build time, consume at runtime** | Import, WGSL composition and reflection, and VFX compilation produce published content for runtime loading |

See the AI-first design axiom and module ownership map for the full constraints.

</details>

<a id="architecture"></a>
## Architecture

**One authoritative World.** Runtime assembles services, Render maintains render projections, and build tools produce resources.

```mermaid
flowchart TB
    PROJECT["Game project<br/>forge.json · code · asset sources"]
    DEVKIT["DevKit / CLI<br/>project operations · build · inspect"]
    COOK["Build-time production<br/>import · cook · shader / VFX compilation"]
    ASSETS["AssetRegistry<br/>GUID → published content"]
    APP["App + native Cordis<br/>realm assembly · input · frame pacing · lifecycle"]
    WORLD["ECS World<br/>state · time · Update / FixedUpdate"]
    DOMAINS["Domain systems<br/>scene · animation · physics · audio intents · net"]
    RUNTIME["Runtime<br/>select backends and services · assemble Renderer"]
    RENDER["Render<br/>persistent projection · extract / prepare / record"]
    GRAPH["RenderGraph<br/>resource accesses · pass dependencies · lifetimes"]
    RHI["RHI<br/>opaque handles · capabilities"]
    GPU["rhi-webgpu / rhi-wgpu<br/>browser WebGPU / wgpu WASM"]
    NULL["rhi-null<br/>structural validation"]
    DEBUG["RHI-debug<br/>capture · replay · inspect"]
    PROJECT --> DEVKIT
    DEVKIT --> COOK
    COOK --> ASSETS
    DEVKIT --> APP
    APP --> WORLD
    APP --> RUNTIME
    WORLD <--> DOMAINS
    RUNTIME --> RENDER
    WORLD -->|"Change evidence and scene data"| RENDER
    ASSETS --> RENDER
    RENDER --> GRAPH
    GRAPH --> RHI
    RHI --> GPU
    RHI --> NULL
    RHI -.->|"Optional recording"| DEBUG
```

<details>
<summary><strong>Rendering and GPU</strong></summary>

| Subsystem | Key design and responsibility | Read more |
|:--|:--|:--|
| **Render / RenderGraph** | Persistent CPU projection and capability-gated GPU Scene; programmable pipelines and RenderFeatures; derived dependencies, usages, and lifetimes with raster / compute / copy passes executed in declaration order | [Render](packages/render/README.md) · [RenderGraph](packages/render-graph/README.md) |
| **Shader / Material** | Schema-derived parameter and binding layouts; WGSL composition, Naga validation and reflection; runtime lookup of content-addressed compiled artifacts | [Shader](packages/shader/README.md) · [Compiler](packages/shader-compiler/README.md) |
| **GPU VFX** | GPU simulation and indirect rendering; code authoring and build-time compilation; particles, ribbons, trails, beams, billboards, and meshes | [VFX](packages/vfx/README.md) · [VFX render](packages/vfx-render/README.md) |
| **RHI / Backends** | Capability-gated operations across browser WebGPU, wgpu WASM, and null backends; a spec-aligned, math-free interface with opaque handles | [RHI](packages/rhi/README.md) · [wgpu](packages/rhi-wgpu/README.md) |

</details>

<details>
<summary><strong>ECS and multiple Workers</strong></summary>

[ECS World](packages/ecs/README.md) owns entities, components, relationships, resources, and time. Systems declare access and scheduling in `Update` / `FixedUpdate`. [Scene](packages/scene/README.md) owns hierarchy and transforms; [State](packages/state/README.md) owns state-scoped entity lifetimes. Renderer consumes World changes into a persistent projection.

```mermaid
flowchart LR
    HOST["Host<br/>DOM / UI · input · Web Audio · frame credit"]
    ENGINE["Engine Worker<br/>World + Renderer + Assets + game plugins"]
    KERNEL["Kernel Worker pool<br/>QuerySpan shards over shared numeric columns"]
    HOST -->|"Input and one frame credit"| ENGINE
    ENGINE -->|"Results and audio intents"| HOST
    ENGINE -->|"Eligible numeric work"| KERNEL
    KERNEL -->|"Completion barrier"| ENGINE
```

| Execution tier | Placement | Constraints and scope |
|:--|:--|:--|
| `shared` | Engine Worker plus persistent Kernel Worker pool | Requires cross-origin isolation, SharedArrayBuffer, and related capabilities; only eligible numeric work runs in parallel |
| `engine-worker` | World, Renderer, assets, and game plugins in one Worker | Host retains DOM, input, and audio; requires Worker rendering capabilities |
| `main-serial` | World and Renderer on the main thread | The direct serial execution path |
| `auto` | Selects an available tier from capabilities | Reports the actual selection and reason; explicitly requesting an unavailable tier returns an error |

> [!NOTE]
> Multiple Workers preserve **one logical World** with serial structural changes, no live-object transfer, and no split RenderGraph. Partial shared writes require World rebuild. See [App execution](packages/app/README.md#execution-tiers) and the [multithreaded example](apps/hello/multithreaded-execution/README.md).

</details>

<details>
<summary><strong>Text and scripted assets</strong></summary>

**Procedural generation and parameter reuse bring content into the code workflow.** AI can generate assets in batches, edit text directly, review diffs, and validate automatically.

| Authoring form | Purpose |
|:--|:--|
| **ScriptablePack · `.pack.ts`** | Generate asset collections with functions, loops, and composition; reuse scene and geometry logic |
| **Parameterized instances** | Independent package identity, parent source, and sparse overrides for reusable variants |
| **Pack · `.pack.json`** | Declare assets, references, and instance parameters for direct field editing and diff review |
| **Imported assets and sidecars** | External glTF / FBX / image sources and metadata share the identity and cooking path |

> [!IMPORTANT]
> **Sources and artifacts are separate.** `.pack.ts` executes at build time; runtime loads cooked content by stable GUID. Textures, models, and audio can still use binary sources. Repair source inputs, then cook again. See the [Pack authoring contract](packages/pack/README.md).

</details>

<details>
<summary><strong>Game and engine plugins</strong></summary>

Game and engine plugins share native Cordis dependencies, activation, updates, and disposal.

| Plugin layer | Typical responsibility | Composition |
|:--|:--|:--|
| Project assembly | Installed plugins, configuration, and realm placement | `forge.json#roots` references one plugin asset GUID per engine / frontend / build / host root; DevKit compiles the plugin programs for native Loader activation |
| Engine plugins | Scene, input, physics, audio, and ECS capabilities | Native `inject / provide` declare dependencies and services; `effect` registers contributions and their inverses |
| Game plugins | Player movement, camera, game UI, and gameplay systems | The reference template composes child plugin assets with `mountPluginAsset` in `assets/game.pack.ts` (the engine root); the frontend root mounts game UI |

Effects unwind when their Fiber exits. ECS schedules frame work; plugin assembly stays outside hot paths. See the [plugin contract](packages/plugin/README.md) and [`game-3d` root plugin](templates/game-3d/assets/game.pack.ts).

</details>

<details>
<summary><strong>Simulation and interaction</strong></summary>

| Subsystem | Key design and responsibility | Read more |
|:--|:--|:--|
| **Networking** | Sessions own replication, ACKs, retries, baselines/deltas, and connection recovery; WebSocket supplies transport | [Net](packages/net/README.md) · [WebSocket](packages/net-websocket/README.md) |
| **Physics** | ECS physics contracts separated from Rapier 2D / 3D backends; input synchronization, simulation stepping, and state writeback | [Physics](packages/physics/README.md) |
| **Animation / Skinning** | Renderer-independent animation graphs, clips, and playback; Skin binding and joint-path resolution | [Animation](packages/animation/README.md) · [Skinning](packages/skinning/README.md) |
| **Runtime intelligence** | Optional provider-neutral Activity / Session; bounded output, cancellation, and polling; asynchronous services stay outside the ECS frame loop | [Intelligence](packages/intelligence/README.md) |
| **Input / UI / Audio** | Frozen frame-start input snapshots; Shadow DOM UI; realm-neutral audio intents played by Host Web Audio | [Input](packages/input/README.md) · [UI](packages/ui/README.md) · [Audio](packages/audio/README.md) |

</details>

<a id="explore"></a>
## Explore

| Entry | Purpose |
|:--|:--|
| [AGENTS.md](AGENTS.md) | Design axioms, module ownership, errors, source-work rules, and verification constraints |
| [Packages](packages/) | Package READMEs defining APIs, lifecycles, and capability contracts |
| [Schemas](schemas/) / [CI guide](scripts/ci/README.md) | Machine-readable contracts and verification workflows |
| [Engine skills](skills/) | Task-oriented capability discovery and operating paths |
| [Apps](apps/) / [Templates](templates/) | Examples, regression scenarios, and game starting points |
| [Forbidden City showcase](apps/showcase/palace/README.md) | `pack.ts` architecture, lighting, and continuous CLI inspection; visual quality remains a work in progress |

<a id="contact"></a>
## Community

- 🌐 Website — [forgeax.github.io](https://forgeax.github.io/)
- 📧 Email — forgeax@outlook.com
- 🐧 QQ group — [join here](https://qun.qq.com/certify-share/s/kRjlj8fNt7?_nsp=1)

> [!NOTE]
> The repository's default README is Simplified Chinese; see [README.en.md](README.en.md) for English. Keep both language versions in sync. Linked package contracts define precise capabilities and limitations.

## License

[Apache-2.0](LICENSE).
