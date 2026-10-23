# ForgeaX Engine SDK

> [!IMPORTANT]
> The archive contains an immediately usable built SDK and editable Engine source snapshot. sdk-manifest.json owns per-file integrity.

Online users can install the publishable SDK carrier through npm without private GitHub Release access:

```bash
pnpm dlx @forgeax/engine sdk install ~/ForgeaX/1.2.3
```

## Quick start

```bash
node ./bin/forgeax.mjs project init          # Once per downloaded SDK/platform.
# Read the reported AGENTS, capability tour, and feature catalog paths.
node ./bin/forgeax.mjs project new ../my-game --template game-3d  # 3D games.
cd ../my-game
pnpm exec forgeax project check --json && pnpm test && pnpm exec tsc --noEmit && pnpm exec forgeax project build --json
pnpm exec forgeax project preview --json
```

> [!IMPORTANT]
> game-3d is a runnable third-person reference, including scene objects/colliders, procedural character/animation, materials/packs, and UI. These affect initial output, movement space, and asset closure. Read the generated README before retaining/adapting/replacing/removing content; update scene, runtime, and pack references together.

init preflights the SDK in its own temporary project, installing and exercising
esbuild, Rapier, and Engine WASM native setup. It records SDK/Node/platform/
pnpm identity in .forgeax/sdk-init.json. new then requires an explicit template: game-3d
for 3D games, empty otherwise. It copies templates, installs skills,
and creates external games with --ignore-scripts. Multiple games reuse the preflight
instead of repeating native installation.

The SDK pins pnpm 12.10.1. Full ZIPs install offline from store/pnpm/
without npm; generated .npmrc pins that store, so later development,
tests, typechecks, and builds reuse it. npm carriers omit the store and install
the same locked Engine versions from npm. Both surfaces share the pnpm lockfile and
pnpm-workspace.yaml allowBuilds policy. sdk-manifest.json records the store layout
created by the pinned pnpm release.

game-3d is a content-bearing reference, not production artwork. Original/high-fidelity games replace
visible content and forge.json/package/GUID/sourceKey/plugin identity, while reusing runtime code according to
Template Disposition. Generated typecheck runs pnpm exec tsc --noEmit;
use that command first if an older project lacks the script.

New games include docs/feedback.md for confirmed problems, reproduction, evidence, and status, excluding secrets.
Web ZIPs require and preserve root README.md and docs/feedback.md.

> [!TIP]
> On macOS, use project init first to obtain structured diagnostics for downloaded archives.
> Only when the SDK source is trusted and Gatekeeper explicitly reports quarantine blocking should you
> run xattr -dr com.apple.quarantine /path/to/forgeax-sdk.
> The SDK never removes quarantine automatically.

> [!IMPORTANT]
> Game targets must be outside the SDK root. new rejects the root/subdirectories; use siblings or other external absolute paths.

## Browser compositor iteration

> [!IMPORTANT]
> This development evidence path uses available browser adapters. Select software explicitly without a usable physical GPU.
> A missing monitor alone does not require software rendering. It is separate from ordinary player/release acceptance.

For Linux image preparation and writable XDG state, follow
[Linux unattended validation](skills/forgeax-engine-cli/references/linux-unattended.md).
Read the actual OS before choosing Ubuntu apt or TencentOS dnf packages. Use
`--headless true` to capture without X11/Xvfb; the default virtual headed route
requires Xvfb when `DISPLAY` is absent. Run sandboxed Chromium as a non-root user.

Then run from the game root:

```bash
pnpm exec forgeax project capture --backend auto --require-ui \
  --output artifacts/capture/game-ui.png --json
```

The CLI starts source-development asset services, adds Xvfb for a headed capture without DISPLAY on Linux, and uses real browser
full-page composition for Canvas plus HTML/Shadow DOM. The neighboring JSON
records adapter, browser, resolution, UI witness, and errors. Mesa lavapipe serves Dawn/Node
offscreen readback; it does not compose browser DOM.

auto permits software fallback; hardware requires a non-software adapter;
software pins SwiftShader/lavapipe-compatible options.
Software first frames can be slower. The CLI polls canvas crops for non-flat pixels before adding
wait-ms settling; uniform black cannot pass by dimensions alone. require-ui accepts
only game UI mounted below #game-ui, not unrelated ShadowRoots. Sidecar
pixels measure visual liveness with non-canvas elements hidden, preventing HUD content from masking
black 3D output; the final PNG still includes the whole page.

Capture fixes viewport/screen, DPR 1, sRGB, light mode, en-US, UTC, and font readiness.
Bundle the same Web fonts; do not rely on matching system fonts.

For cross-machine color regression, use --deterministic and ?forgeaxCapture=1. Games pin random
seed/logical frame/fonts and set readiness only after Canvas/UI stabilize:
document.documentElement.dataset.forgeaxCaptureReady = 'true'. App also publishes
forgeaxFrameSubmitted after actual Renderer submission and dispatches
forgeax:frame-submitted. The CLI waits for Engine submission/non-flat output before the game marker.
wait-ms adds settling after these handshakes; it does not identify a deterministic frame.

For continuous captures, keep one Vite/Xvfb/Chrome/Page/World session and use named ready markers
through an SDK command-client program:

```js
export default async function playthrough({ browser }) {
  const session = await browser.open({
    backend: 'auto',
    deterministic: true,
    requireUi: true,
    outputDir: 'artifacts/playthrough/boss-flow',
  });
  try {
    await session.page.getByRole('button', { name: 'Start' }).click();
    const spawn = await session.capture('spawn');
    await session.page.keyboard.press('KeyW');
    const arena = await session.capture('arena');
    return { report: session.reportPath, captures: [spawn, arena] };
  } finally {
    await session.close();
  }
}
```

```bash
pnpm exec a Node or Bun script using the SDK command client tests/playthrough.mjs --json
```

Native Playwright handles input/UI assertions; capture(name) waits for the named marker, captures composition,
rejects flat output, and appends to the same schema-v2 run.json. Programs cannot return live Page/session objects.

> [!CAUTION]
> Software screenshots support visual iteration/regression, not physical GPU performance, vendor-driver, HDR-display, or release acceptance claims.

## Bind local Engine source

Generated games normally resolve published @forgeax/engine. To modify Engine source, bind a local checkout
without rewriting project package.json:

```bash
forgeax project engine status --json
forgeax project engine use-local ../forgeax-engine --json
forgeax project engine check --json
forgeax project engine unlink --json
```

Only a local override creates .forgeax/engine-binding.json; absence is the sole default registry/SDK state.
The project manifest remains dependency authority. doctor checks workspace builds,
SDK packages, and invalid workspace:* consumer dependencies. status derives its digest
from real built bytes and reports build time. unlink restores default resolution.

## SDK surfaces

| Surface | Paths | Build Engine first? | Use |
|:--|:--|:--:|:--|
| Full ZIP built SDK | bin, packages, templates, skills, store/pnpm | No | Offline game creation, testing, execution, builds, delivery. |
| npm carrier built SDK | bin, templates, skills | No | Small online bootstrap; locked game dependencies, including Engine, install from npm. |
| Engine source | source/engine (full ZIP only) | After source edits | Inspect/extend packages, CLI, rules, and skills. |

packages/name is a bare built npm package with manifest, README, dist, and resources at its root, without tarballs or a nested package directory.

```text
forgeax-sdk/
├── bin/forgeax
├── packages/<package>/         # Full ZIP only.
├── templates/empty/
├── templates/game-3d/
├── store/pnpm/                 # Full ZIP only.
├── skills/<forgeax-engine-skill>/
├── source/engine/              # Full ZIP only.
├── schemas/
├── toolchain/wasm/             # Full ZIP only.
├── sdk-manifest.json
└── AGENTS.md
```

Read [AGENTS.md](AGENTS.md), then the [SDK capability tour](skills/forgeax-engine-sdk/SKILL.md) and [feature catalog](skills/forgeax-engine-sdk/references/feature-catalog.md). The catalog records a historical audit commit, not current-HEAD proof; match the exact Engine commit and gate receipt before relying on it. It discovers capabilities, not game activation. New games receive ordinary AGENTS/skills files; project skill install/verify manages Agent discovery links.

## Source snapshot

source/engine excludes Git metadata, Harness state, and private assets. It includes public source/docs/rules/skills and prebuilt wgpu/FBX/Basis WASM:

```bash
cd source/engine
pnpm install
pnpm build:engine
```

## Integrity

Deliver ZIP with SHA256SUMS, SPDX, provenance, and sdk-verify-result.json. Verification must consume the final ZIP and cover explicit empty/game-3d creation, doctor/test/typecheck/build/package/dev/preview, and source-template smoke. Game ZIPs must also contain README and feedback documentation.
