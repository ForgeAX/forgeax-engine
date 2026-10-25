# Game delivery, release, and live debugging

On-demand reference for the game-root `AGENTS.md` **Run, test, build, and release**
routes. That section selects the route and lists the default commands; this file holds
the complete acceptance, blocked-check, release, and debugging contracts.

## Choose the route

Choose the delivery scope from the user's request before running tools:

| User intent | Route | Stop when |
|:--|:--|:--|
| Create, change, or locally play a game (default) | [Local playable delivery](#local-playable-delivery) | The user can open it, the requested core interaction and result work, and known limitations are stated |
| Publish, deploy, or distribute a game artifact | [Game release](#game-release) | The actual target artifact and host pass release checks |
| Engine/SDK changes, SDK publication, or performance work | The owning package/CI, [SDK production](sdk-production.md), or performance guide | The explicitly selected acceptance contract passes |

## Local playable delivery

```bash
pnpm exec forgeax project check --json
pnpm test
pnpm typecheck
pnpm exec forgeax dev start --json
```

`project check` validates Node/pnpm, manifest, and dependencies; `pnpm test` runs Vitest.
New/init projects provide `typecheck`; older games can use `pnpm exec tsc --noEmit`,
reporting the missing script as onboarding debt. Select relevant tests and asset checks.
Accept the final game only with evidence from the actual entry and host handed to the user:

| Required evidence | Passing condition |
|:--|:--|
| Startup and errors | Run `project play <script> --json` (its final-frame gate is `dev verify`'s), or `dev verify --revision <current-revision> --json` against a live delivery execution; inspect its runtime report and artifacts. A failed or blocked gate cannot establish runtime acceptance. |
| Appearance | Open the captured screenshot and confirm the requested scene and UI are visible; a saved image path alone is insufficient. Enemies and other actors must contrast with the background in luminance (pale or saturated on dark, emissive rims or eyes at night); fades and deaths stay visible ([cookbook 10](gameplay-cookbook.md#10-fade-out-one-enemy-per-entity-tint-and-opacity)). Scenes sit on a sky, not on a grey slab or void: a `GradientSky` preset, fog for 3D horizons ([cookbook 0](gameplay-cookbook.md#0-content-pack-and-composition)). |
| Core interaction | Drive the requested controls with the playthrough's real input and assert their gameplay result through the game's read projection; data/unit tests do not exercise this path. |
| Restart/reload | Repeat startup and a core interaction after `play.reload()`; use evidence from the final code and build. |

Before the first real input after a page load or reload, wait for the generated host's
input readiness signal when it publishes one
(`document.documentElement.dataset.forgeaxInput === 'open'`); a game state or HUD read
alone can precede the first ready frame. The CLI skill owns the playthrough details.

Acceptance evidence comes from the browser these commands own (`dev start` owner page,
`dev verify`, `project play`). The deliverable is the URL that `dev start`/`dev status`
returns; do not open or drive an extra tab in an interactive browser tool to accept or
"hand over" the game. Such a tab may be backgrounded (`document.hidden`), so its input
gate can stay closed and waits time out; it is never evidence. The owner refuses a second tab's live
bridge by design, so its `live-bridge-not-owner` warning is expected, not a defect.

Run `dev verify`, `project play`, tests and builds in the foreground and wait for the
result. If the harness backgrounds a command, poll its output no faster than every 30 s.

Each successful check qualifies only the subject and execution it observed. Service
availability, transport readiness and build success do not establish runtime health
or gameplay. Missing observations remain unverified. A visible fatal or failed Engine
startup fails acceptance even when other checks pass.
Fix the failing owner and verify a fresh session; never suppress the error or remove the
required plugin to obtain a pass.

### Requirement coverage

Before delivery, list every requirement the user stated (objects, mechanics, controls,
enemies, UI, endings). The playthrough reaches each one with real input, asserts it
through the game's read projection, and saves one named screenshot per requirement:
every ending or result screen, every requested object type in view, multi-enemy states
with several enemies on screen, and the core input's visible effect (the rotated shape,
not only a state change). A requirement without both stays unverified in the report.
`artifacts/` holds only accepted screenshots: failure frames, startup-error pages and
rejected or provisional captures go to `.forgeax/diag/`, so never hand those over as evidence;
save debug probes there too.
Production code never bends the game for the test: no enemies spawned directly ahead,
no screen targets or aim helpers exposed for the script, no test-only shortcuts.

Use `project build` and `project preview` to verify served `dist` when delivery or
changed build/asset paths require production output. Local delivery provides a usable
local URL. ZIP packaging, HTTPS hosting, full-board/stress runs, fixed frame counts,
performance counters, and unrelated shortcut regressions need an explicit requirement
or observed risk. Hand over the working game without expanding the acceptance loop.

Report the playable entry, observed interaction/result, viewed screenshot reference,
reload result, and limitations. A build, URL, HTTP 200, canonical-template test, or service
handshake alone cannot accept the authored game. Say "complete" or "fixed" only when
all required evidence above passes; retain each missing check as unverified.

### Blocked checks

When a check is blocked, diagnose its owner and attempt supported recovery or another
available observation route. `dev verify` can use the Engine browser owner when the
interactive browser tool is unavailable; `dev status`/`dev capture` retain diagnostics.
A different execution can diagnose the owner but cannot accept the failing or unobserved
delivery target. If recovery remains blocked, report the concrete error, attempted remedies, completed checks, and
missing evidence to the user; never turn an unavailable check into a pass.
For Linux batch jobs, follow [Linux unattended validation](../../forgeax-engine-cli/references/linux-unattended.md)
before retrying: explicit headless needs no Xvfb; virtual headed capture does.
A blocked browser is not a completed runtime acceptance. If the requested capability
has no supported entry, report that finding; an unchanged template is not its demo.
After repair, recheck affected paths; unchanged bytes need no repeated packaging or unrelated validation.

For Engine/SDK compatibility defects, reproduce on the pinned Engine, compare the selected
newer release, and retest after repair; never silently upgrade during diagnosis. Discover
`dev start/status/capture/reload/stop` through `forgeax help dev --tree --json`;
the CLI skill owns session/capture details.

## Game release

Enter this route when the user requests publication, deployment, or a distributable
artifact. Local preview and handing a local URL to the user remain local delivery.

```bash
pnpm exec forgeax project build --json
pnpm exec forgeax project preview --json
pnpm exec forgeax project package --output release/game-web.zip --json
```

The production gate serves the final `package`/`dist` over HTTPS, drives the target
scene for 300 frames, and fails on App, browser, uncaptured GPU, or static-resource
errors. Inspect the actual game picture, core inputs and reload; validate asset paths
and the shipped closure. Record resolution, browser and device. Add gameplay-peak
stress, entity/candidate/draw counts and median/p95 timing when performance is part
of the requested goal or a measured risk; use the owning performance guide.

`package` emits a Web ZIP and `.sha256`; its root contains `index.html` and the static
Engine/game closure in `forgeax-dist.json`, excluding SDK source, `node_modules`
and author source. Validate those final bytes once. A subsequent source repair
invalidates the affected evidence and artifact; writing a report alone does not.
ESM, WASM, fetch and asset indexes require HTTP(S), so `file://` is not a player
runtime. Offline desktop packaging requires a separately requested OS-specific
browser shell or local HTTP launcher.

The package also carries the root `README.md` and `docs/feedback.md`; update both
before release (see the [project guide](game-project-guide.md#issue-feedback-and-game-archives)).

The SDK verifier proves the SDK archive can create and run canonical projects.
It cannot replace verification of the authored game. SDK archive integrity,
Candidate/Promotion and Engine publication belong to the SDK skill's
[production guide](sdk-production.md).

## Live debugging: RHI Debug first for difficult rendering issues

RHI capture is a diagnosis tool, not a delivery step: do not record tapes while the
screenshot and checks pass. Enter this section only for an observed rendering failure.

> [!IMPORTANT]
> For unexplained black screens, missing objects, lighting/shadow defects, flicker, post-processing errors,
> or browser/backend divergence, read [`forgeax-engine-rhi-debug`](../../forgeax-engine-rhi-debug/SKILL.md) first.
> Capture the actual failing frame and use draw/dispatch, bindings, resources, and render-target pixels
> to locate the owner before editing. Do not wait to exhaust logs, remote/profiler queries, or speculative material/shader tweaks.

- Follow explicit startup, asset, or schema `.code/.detail` failures directly to their owner; run only relevant `doctor`, `asset verify`, or `shader check` diagnostics.
- Reproduce the target image and interaction in the original browser/backend with Playwright. Screenshots establish the symptom; RHI tapes explain GPU work.
- Enable recording with `dev start --rhi-capture true`, reproduce, then run `rhi capture`; capture does not create a live instance. Follow the RHI Debug skill's wiring/recovery path and retain `.rhitape`, digest, `workIndex`, and failure detail. If recording is unavailable, preserve blocker evidence and continue feasible focused diagnosis. If `rhi inspect`/`rhi read` return `replay-backend-unavailable` (for example no native replay on the host), keep `rhi summary` structure and continue with live capture: `dev capture` screenshots, `dev eval` state and debug draw; do not retry replay.
- Let tape evidence determine additional World/Renderer/resource queries or debug-draw spatial visualization. Fix Engine gaps in the owning Engine subsystem and record them in `docs/feedback.md`, without hiding them behind game-side substitutes.
- Recapture and verify the same scene/backend after repair, and add the failing path to regression coverage. Offline replay does not replace real-browser appearance and interaction checks.
