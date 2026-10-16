# @forgeax/collectathon

**3D collectathon showcase: a third-person action-collectathon game demonstrating 11 forgeax engine capabilities in a single playable level.**

Run on the ground as a skinned humanoid, collect glowing Cores while dodging
patrolling Guardians, then reach the Portal to win — or lose all your health and
fail. One Vite app, one level, every major engine subsystem wired end-to-end.
This README is the single entry point: each capability below links to the one
file that owns it (grep the anchor term to jump straight there).

```
pnpm --filter @forgeax/collectathon dev            # play it (:5173)
pnpm --filter @forgeax/collectathon smoke          # dawn-node structural smoke
```

## 11 capabilities — single-entry index

Grep the **anchor** term to land in the owning file.

| # | Capability | Anchor (grep) | File |
|:--|:--|:--|:--|
| 1 | One-line bootstrap + four-state game lifecycle | `createApp` / `defineState` | `src/main.ts` |
| 2 | Third-person KCC movement + follow camera | `player-move` | `src/systems/player-move.ts` |
| 3 | Skinned humanoid + animation crossfade (`weights[]`) | `player-anim` | `src/systems/player-anim.ts` |
| 4 | Player parent/child separation (KCC parent + Skin child) | `spawnPlayer` | `src/spawn/spawn-player.ts` |
| 5 | Procedural level + boundary walls | `spawn-level` | `src/spawn/spawn-level.ts` |
| 6 | Sensor pickup via `CollidingEntities` + Score SSOT | `core-collect` | `src/systems/core-collect.ts` |
| 7 | Emissive floating/spinning collectibles | `core-spin` | `src/systems/core-spin.ts` |
| 8 | Win gate (Portal activates on full collection) | `portal-activate` | `src/systems/portal-activate.ts` |
| 9 | Guardian AI sub-state-machine (patrol/chase/attack) | `guardian-ai` | `src/systems/guardian-ai.ts` |
| 10 | Fail path: Health-- on hit + Win/Lose mutual-exclusion | `guardian-hit` / `win-lose-arbiter` | `src/systems/guardian-hit.ts`, `src/systems/win-lose-arbiter.ts` |
| 11 | Presentation: bloom+tonemap+fxaa + IBL skybox + 3D audio + HUD | `Skylight` / `audio-cue` / `hud-sync` | `src/main.ts`, `src/systems/audio-cue.ts`, `src/systems/hud-sync.ts` |

Supporting SSOTs: `src/resources.ts` (GameProgress scoreboard), `src/components.ts`
(tag components), `src/collision-groups.ts` (sensor filtering), `src/systems/debug-overlay.ts`
(`?debug=1` collider/AI visualization).

## Architecture stances

- **GameProgress is the scoreboard SSOT** (`src/resources.ts`). `score` is written
  only by `core-collect`, `health` only by `guardian-hit`, `elapsed` only by the
  HUD timer tick. The HUD (`hud-sync`) is a one-way VIEW — it reads GameProgress
  and writes the DOM, never the reverse (AC-18). Grep `hud-sync.ts` for
  `GameProgress`: every hit is a read.
- **One semantic domain per file + per system** (AC-20). System names are
  `domain-behavior` (`player-move`, `core-collect`, `guardian-ai`, `hud-sync`,
  `audio-cue`) so an LLM grepping a behavior lands in exactly one file.
- **State-scoped entities** (`despawnOnExit`): every Play-state entity auto-
  despawns on Play exit, so a Win/Lose -> Title -> Play replay starts clean.

## Asset license posture (layered, AC-19)

| Asset | License | Distributable? |
|:--|:--|:--|
| `forgeax-engine-assets/vendor/fbx-test/humanoid.fbx` (player model) | Autodesk FBX SDK sample (Autodesk License) | **No** — demo-only fixture, loaded at runtime for demo/screenshot/recording, never shipped in a runtime asset pack (same posture as `apps/hello/fbx-skin`) |
| `forgeax-engine-assets/collectathon-audio/*.wav` (4 cue families) | Apache-2.0 (engine-authored synth) | Yes — commercial-compatible, no CC BY-NC |
| `forgeax-engine-assets/demo-assets/template-game-default/sky.hdr` (IBL) | Apache-2.0 | Yes |
| `forgeax-engine-assets/dejavu-fonts/*` (MSDF font) | DejaVu free font (commercial-compatible) | Yes — wired via pluginPack; used by the floating "+1" pickup text (AC-12, see `src/systems/pickup-text.ts`) |

> [!NOTE]
> The audio cues are **procedurally-generated placeholders** (the implement
> sandbox had no network to fetch curated Pixabay/Freesound CC0 recordings).
> They are real, audible, and license-clean; swapping in hand-picked recordings
> is a follow-up that keeps the GUIDs + wiring identical. See
> `forgeax-engine-assets/collectathon-audio/ATTRIBUTION.md`.

## Known pits (hard-won, do not re-trip)

- **0 lights = all black.** standard PBR needs a `DirectionalLight` AND a
  `Skylight` (ambient=0 without it). The Play OnEnter spawns the light + a
  solid-color Skylight FIRST, before any standard material (D-7).
- **bloom MUST ship with tonemap.** bloom allocates an HDR target and gates on
  `tonemapActive`; a lone bloom renders a white burn-out. The Camera sets both
  `bloom=BLOOM_ENABLED` + `tonemap=TONEMAP_REINHARD_EXTENDED` (D-6).
- **`grounded === true`, never `!== 0`.** A boolean `!== 0` is always true; read
  `CharacterController.grounded === true` (see `player-move.ts`).
- **Physics WASM is async.** `moveAndSlide` before the rapier body exists throws;
  the move system guards the early-frame window (D-9).
- **Boundary walls prevent fall-through.** The level spawns 4 invisible cuboid
  colliders so the player cannot walk off the edge (P-07).
- **FBX is in centimetres.** The humanoid child applies a ~1/90 scale to land in
  world metres (see `spawn-player.ts`).
- **IBL prewarm settles asynchronously.** The cubemap upload completes a few
  frames after Play entry; visual capture must wait for completion.
  The upload is Chromium-gated (WebKit lacks the rgba16float
  attachment the IBL precompute needs).
- **The four-state machine boots via `setNextStateForce('Title')`.** The default
  state is already `Title`, so a plain `setNextState('Title')` is a same-state
  no-op and the Title OnEnter (which advances to Play) never fires.
- **Dawn smoke covers the structural scene.** It does not validate the full
  browser level startup or gameplay. Browser rendering and asset transport have
  focused Engine and template tests; this app has no separate browser boot gate.

## M6 boot notes (judgment-reject fixes - `pnpm dev` started crashing)

A `pnpm dev` playthrough originally exposed three startup failures. Their fixes
established these startup invariants:

- **`render-system-no-camera` is gone - boot now pumps Title->Play before the
  first draw.** The camera spawns in Play's OnEnter, but `setNextState` defers
  one frame each (F-08), so the unconditional frame-loop draw used to run ~2-3
  frames with no Camera and fire `render-system-no-camera`. `main.ts` now pumps
  `world.update()` until Play is live BEFORE `app.start()`, so a Camera exists on
  frame 1. Also: do NOT `app.registerUpdate(() => renderer.draw(world))` - the
  `createApp` frame loop already draws; a second draw is redundant. Locked by
  `src/__tests__/boot-regression.test.ts`.
- **`channel-leaf-mismatch` is gone - the humanoid run clip is channel-stripped.**
  humanoid.fbx's run clip carries animation channels targeting the FBX scene's
  `Camera` / `Light 1` nodes, absent from the player Skin. `spawn-player.ts`
  `stripNonSkeletonChannels` drops them at load time (the crossfade is untouched -
  those channels animate non-human nodes).
- **`MAX_VERTEX_CAPACITY` flood is gone - three latent ENGINE debug-draw bugs were
  fixed.** debug-draw (dev-default-on, `?debug=0` to disable) never actually
  rendered in the browser and leaked vertices unbounded, because the engine
  debug-draw browser path had never executed. Three fixes, all in
  `packages/runtime` + `packages/debug-draw` (human-authorized): (1) the
  debug-draw-glue tsup entry split made `attachDebugOverlayPass` a no-op stub so
  `DebugDraw.flush()` never ran - merged into the main barrel; (2)
  `createDebugDrawOnReady` hardcoded `bgra8unorm` instead of the swap-chain
  `-srgb` view - now derived from `selectSwapChainFormat(...).view`; (3)
  `ensureCapacity` grew CPU staging but never reallocated the GPU vertex buffer -
  now reallocates on growth. The overlay renders and the buffer plateaus.

## Known scope gap

- **MSDF "+1" pickup text (AC-12) is now wired.** On Core pickup, a floating
  world-space `GlyphText` "+1" label spawns at the Core's last-known position
  and rises with a ~0.8s lifetime before despawning. `@forgeax/engine-font` is
  a declared dep; the pre-baked DejaVu Sans Mono MSDF atlas from
  `forgeax-engine-assets/dejavu-fonts/` (same asset as `apps/hello/text`)
  surfaces through pluginPack. See `src/systems/pickup-text.ts` (the sole owner
  of AC-12) and `src/systems/core-collect.ts` (position capture + signal write).
