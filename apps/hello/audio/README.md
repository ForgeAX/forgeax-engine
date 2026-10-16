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
| **Pack-index asset loading** | SFX GUID flows through `assets.loadByGuid<AudioClipAsset>`; the injected audio loader resolves the Vite catalog row and decodes it before the demo mints an `AudioSource.clip` shared ref. |
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

```ts
import { audioPlugin } from '@forgeax/engine-audio';
import { physicsPlugin } from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';

// 1. One-shot takeoff -- audioPlugin() auto-attaches the WebAudioBackend;
//    input is in the canvas-form default plugin set.
const app = await createApp(canvas, { plugins: [audioPlugin(), physicsPlugin('rapier-3d')] });

// 2. Load an audio clip through the same GUID path used by generic bindings.
const guidRes = AssetGuid.parse(SFX_GUID);
if (!guidRes.ok) return;
const clipRes = await assets.loadByGuid<AudioClipAsset>(guidRes.value);
if (!clipRes.ok) return;
const clipHandle = world.allocSharedRef('AudioClipAsset', clipRes.value);

// 3. Declarative spawn -- AudioSource with clip handle.
const emitter = world.spawn(
  { component: Transform, data: { pos: [0, 0, 0] } },
  { component: MeshFilter,  data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: {} },
  { component: AudioSource,  data: { clip: clipHandle, playing: false, spatialBlend: 1.0, bus: 'sfx' } },
).unwrap();

// 4. Camera + AudioListener marker as the spatial listener.
const camera = world.spawn(
  { component: Transform, data: { pos: [0, 1, 5] } },
  { component: Camera, data: { fov: Math.PI/4, aspect: 16/9, near: 0.1, far: 100 } },
  { component: AudioListener, data: {} },
).unwrap();

// 5. Per-frame: listener sync via engine.listener getter (D-2). createApp
//    auto-wires propagateTransforms, so GlobalTransform.world is fresh each frame.
app.registerUpdate(() => {
  const worldMatrix = world.get(camera, GlobalTransform).unwrap().world;
  const engine = world.getResource('AudioEngine');
  if (engine instanceof WebAudioEngine) {
    const l = engine.listener; // getter triggers lazy ensureContext()
    if (l) syncListenerFromWorldMatrix(l, worldMatrix);
  }
});
```

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
