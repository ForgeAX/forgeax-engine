# forgeax-engine -- Hello Audio

Spacebar one-shot SFX + movable 3D listener + collision-triggered cleanup --
`createApp({ plugins: [audioPlugin(), physicsPlugin('rapier-3d')] })` declarative ECS example
(input is in the canvas-form default plugin set).

## Quickstart

```bash
pnpm --filter @forgeax/hello-audio dev
# Open http://localhost:5195
# Press spacebar to play the SFX, WASD to move the listener.
```

The browser gate is also runnable directly:

```bash
pnpm --filter @forgeax/hello-audio smoke:browser
```

It launches Chrome with WebGPU and real Web Audio, checks the loaded MP3
through `AudioContext` state and active-source evidence after a spacebar
gesture, waits for a falling Rapier body to trigger spatial audio, verifies
despawn cleanup, then checks listener movement from center pan to right pan.
It saves before/after PNG evidence under `apps/hello/audio/.forgeax-audio/browser/`.

## What this demo exercises

| Surface | Details |
|:--|:--|
| **One-shot takeoff** | `createApp(canvas, { plugins: [audioPlugin(), physicsPlugin('rapier-3d')] })` -- both capabilities are assembled through the app plugin seam. |
| **Declarative ECS audio** | `AudioSource({ clip, playing })` drives `audioTickSystem` edge detection -- no imperative `backend.play()` bypass (AC-07). |
| **Pack-index asset loading** | SFX GUID flows through `assets.load(guid, 'audio')`; the injected audio loader resolves and decodes the Vite catalog publication, returning the managed handle bound directly to `AudioSource.clip`. |
| **Spatial panning** | `AudioSource.spatialBlend=1.0` creates a PannerNode; `syncListenerFromWorldMatrix(l, worldMatrix)` syncs the listener position/orientation each frame from the listener entity's `GlobalTransform.world` mat4. |
| **Collision cleanup** | A dynamic ECS actor reads `CollidingEntities`, starts its own spatial `AudioSource` on contact, then `world.despawn()` removes the Collider and audio source; the browser gate verifies `activeSourceCount` returns to zero. |
| **Playback controls** | Play/pause/resume/stop and 0.25x–3x speed use ECS controls; Host-owned lowpass/highpass chains and a reused FFT drive a canvas and 24 ordinary mesh bars. |
| **Overlay readout** | Left/top overlay shows listener-emitter distance + L/R pan as text (charter F2: text anchors spatial audio verification). |

## Controls

| Key | Action |
|:--|:--|
| **Spacebar** | One-shot SFX (also resumes AudioContext on first press) |
| **W / S** | Move listener forward / back |
| **A / D** | Move listener left / right |

## API surface

The app configures its Catalog and installs Audio before loading clips. The audio handle binds directly to `AudioSource.clip`:

```ts
const clip = (await assets.load(assets.parseGuid(SFX_GUID), 'audio')).unwrap();
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0] } },
  { component: AudioSource, data: { clip, playing: false, spatialBlend: 1, bus: 'sfx' } },
).unwrap();
```

The host owns Web Audio playback and listener synchronization. See [src/main.ts](src/main.ts) for plugin assembly, the visual emitter and interactive controls.

## Caveats

### headless has no AudioContext

dawn-node (used by smoke and CI) has no Web Audio API, so audio playback is
impossible in headless. The smoke gate is structural-only (boot + 60 frames
+ no errors). Browser-based `pnpm dev` is required to hear the SFX and
experience spatial panning.

### One-shot edge mapping (AC-08)

`AudioSource.playing` is a **level semantic** (continuous true means
"playing / keep alive"), not a one-shot trigger. The audio tick system
detects `false->true` edges to start playback and `true->false` edges to
stop. There is no built-in `playOnce()` affordance.

This demo manufactures a one-shot edge per keypress via a re-arm pattern:

1. Spacebar up-edge -> write `AudioSource.playing = true`
2. Next frame -> unconditionally write `playing = false` (re-arms for next press)

This produces a real cross-frame `false->true` transition that the tick
system observes as a play-start edge. Each keypress creates a new
`AudioBufferSourceNode` (overlapping playback, per OOS-5).

This ergonomics gap is **documented honestly**, not hidden. A future engine
iteration may add an explicit `playOnce` / `trigger` affordance on
`AudioSource`.

### Submodule dependency (D-7)

The SFX audio file lives in the `forgeax-engine-assets/` git submodule
(`sfx/dragon-studio-correct-472358.mp3`). Clone without
`--recurse-submodules` and the pack-index will have no entry for the SFX
GUID -- the demo boots without errors but plays no sound. This is the
charter P3 explicit-failure contract: silent demo when assets are missing,
not a crash.

## Audio control evidence

The right-hand panel loops the same Pack-loaded clip. Pause retains decoded
progress and the filter graph; resume recreates only the one-shot native source.
The spectrum tap follows source filters and volume, before spatial/bus mixing.

See [native signal/performance and RHI validation](../../../packages/audio-webaudio/bench/README.md)
for reproducer commands, pinned Three.js/UE references and evidence boundaries.
