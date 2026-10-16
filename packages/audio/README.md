# @forgeax/engine-audio

> **Realm-neutral declarative audio subsystem.** Owns `AudioSource`, `AudioListener`, the ECS tick/plugin, the `AudioBackend` protocol, POD clip publications, and the closed intent vocabulary. Browser playback lives in `@forgeax/engine-audio-webaudio` and always remains Host-owned.

## Core surface

```ts
import { AudioSource, AudioListener, audioPlugin, type AudioClipAsset } from '@forgeax/engine-audio';
```

Layer 1 (play now): spawn `AudioSource` with `playing: true`. Layer 2 (mix): bus volume/mute via `AudioEngine` Resource. Layer 3 (3D): `spatialBlend: 1` + `AudioListener`.

## Minimal BGM playback

```ts
import { AudioSource, AudioListener, audioPlugin, type AudioClipAsset, type AudioBackend } from '@forgeax/engine-audio';
const created = await createApp(canvas, { plugins: [webAudioPlugin(), audioPlugin()] });
if (!created.ok) throw created.error;
const app = created.value;

// Load clip via asset system
const loaded = await app.renderer.assets.loadByGuid<AudioClipAsset>(bgmGuid);
if (!loaded.ok) throw loaded.error;
const clip = app.world.allocSharedRef('AudioClipAsset', loaded.value);

// Spawn BGM source
app.world.spawn({
  component: AudioSource,
  data: { clip, playing: true, loop: true, volume: 0.8, spatialBlend: 0, bus: 'music' },
}).unwrap();

// Spawn listener on camera entity
app.world.spawn(
  { component: Transform, data: {} },
  { component: Camera, data: {} },
  { component: AudioListener, data: {} },
).unwrap();
```

## Realm boundary

| Tier | Engine-side backend | Host-side owner |
|:--|:--|:--|
| `main-serial` | Direct intent adapter | `WebAudioEngine` in the Host realm |
| `engine-worker` | `createAudioIntentBackend` batches POD intents with frame completion | `createHostAudioConsumer` owns decode, cache, nodes, and `AudioContext` |
| `shared` | Same Engine Worker intent path | Same Host consumer; Kernel Workers never receive audio state |

`AudioClipAsset` carries either encoded `bytes` or a Cook-validated PCM16 `stream` manifest and HTTP locator. The latter publishes only its bounded index across Workers. The first play intent for a `sourceKey` carries bytes; identical later plays reuse the Host decode cache, while changed bytes under the stable key are republished. Intents cover play, stop, per-source volume, playback rate, pause and seek, bus volume/mute, source pose, listener pose, and destroy. Stale async decode completion is fenced by both the entity play epoch and the current source-key content, so it cannot resurrect a stopped, replaced, or superseded source.

## ECS component schema

### AudioSource

| Field | Type | Default | Description |
|:--|:--|:--|:--|
| `clip` | `Handle<'AudioClipAsset', 'shared'>` | required | World shared-ref handle for the loaded POD clip |
| `playing` | `boolean` | `false` | Edge-detected: false->true starts playback, true->false stops |
| `paused` | `boolean` | `false` | Pauses an admitted source while `playing` remains true; false resumes its retained clip position |
| `playbackRate` | `number` | `1` | Positive sample advance multiplier; speed and pitch change together |
| `fromPosition` | `number` | `0` | Initial decoded clip seconds; edits while `playing` seek once, including while paused; this is a request, not live playback progress |
| `loop` | `boolean` | `false` | When true, AudioBufferSourceNode.loop is set; one-shot otherwise |
| `volume` | `number` | `1.0` | Per-source GainNode gain.value; range 0..+Inf (amplification allowed) |
| `spatialBlend` | `number` | `0` | 0 = 2D (direct to bus), 1 = 3D (PannerNode with equalpower model) |
| `coneInnerAngle` / `coneOuterAngle` | `number` | `360` | Full cone angles in degrees; omnidirectional by default |
| `coneOuterGain` | `number` | `0` | Gain outside the outer cone, in 0..1 |
| `bus` | `string` | `'sfx'` | Accepted bus ID; edits reroute an admitted or pending source |

### AudioListener (marker component)

| Field | Type | Description |
|:--|:--|:--|
| _(none)_ | -- | Marker component. Attach to the entity whose `GlobalTransform.world` (16-float column-major mat4, written by propagateTransforms) drives Web Audio listener position/orientation. Only the first `AudioListener` entity in the World is synced per frame (E-3). |

## Bus control via AudioEngine Resource

```ts
const audio = world.getResource<AudioBackend>('AudioEngine');
audio.setBusVolume('music', 0.3);
audio.setBusMute('sfx', true);
audio.setBusMute('sfx', false); // restores previous volume
const { contextState, activeSourceCount } = audio.getState();
```

## Configurable routing

`AudioBackend.configureBuses()` publishes one closed POD graph. IDs are unique strings; exactly one bus has `parent: null`. Parent and send references must exist and the combined graph must be acyclic. Defaults are `sfx/music -> master`.

```ts
audio.configureBuses([
  { id: 'master', parent: null },
  { id: 'voice', parent: 'master', volume: 0.8,
    sends: [{ bus: 'room', gain: 0.2, tap: 'pre-fader' }] },
  { id: 'room', parent: 'master' },
]);
audio.setBus(entityId, 'voice');
```

Read [the Host routing and streaming contract](../audio-webaudio/README.md#configurable-buses-and-shared-effects) for effect ownership, publication limits and actual playback status. Configuration/control intents express requests; `getState().lastError` reports Host refusal. `validateAudioBuses()` can validate a declaration before publication. Worker publication retention defaults to 64 MiB and 256 source keys; identical content sends no repeat bytes/index, while replacement republishes it.

## Acoustic regions

`audioPlugin()` installs regional selection after Scene propagation. Import the
component through the public SDK:

```ts
import { AcousticRegion, AcousticShapeValue } from '@forgeax/engine/audio';
import { Transform } from '@forgeax/engine/scene';

world.spawn(
  { component: Transform, data: { pos: [0, 0, 0], scale: [2, 1, 1] } },
  { component: AcousticRegion, data: {
    shape: AcousticShapeValue.box, halfExtents: new Float32Array([3, 2, 3]),
    priority: 10, blendDistance: 0.5, sourceBus: 'room',
    listenerWetBus: 'echo', wet: 1,
    listenerSendBus: 'room', listenerSendTarget: 'echo', sendGain: 0.3,
  } },
).unwrap();
```

The same fields belong in an ordinary keyed `SceneAsset`. A `.pack.ts` producer
declares `sceneComponents: [Transform, AcousticRegion, AudioSource, AudioListener]`;
Import/Cook externalizes clip GUIDs and Catalog loading/Scene instantiation restores
them. Bus/send IDs name the existing configured graph. Configure that graph and its
Host effect factory before regional activation; regions never create buses or
native effects. See the [saved public consumer](../audio-webaudio/bench/acoustic/rooms.pack.ts).

| Field | Semantics |
|:--|:--|
| `enabled` | Defaults true; false removes this region's contribution |
| `shape` | `AcousticShapeValue.box` (default) or `.sphere` |
| `halfExtents`, `radius` | Positive local dimensions; box defaults `[1,1,1]`, sphere radius defaults `1` |
| `priority` | Signed integer, default `0`; only the highest priority with positive point weight contributes |
| `blendDistance` | Nonnegative local interior transition distance, default `0.25`; zero gives a hard boundary |
| `sourceBus` | Empty (default) leaves source selection unaffected; otherwise routes sources at their propagated position |
| `listenerWetBus`, `wet` | Empty bus disables wet control; existing effect bus blends toward wet `0..1`, default `1` |
| `listenerSendBus`, `listenerSendTarget`, `sendGain` | Both IDs empty disables send control; otherwise blends an existing edge toward a nonnegative gain, default `1` |

Inverse world transforms preserve rotation, parent transforms, reflection, scale
and shear. Blend distance uses local shape units. Finite affine transforms with
absolute linear determinant above `1e-8` are required. Box weight is the minimum
local distance to an interior face divided by blend distance; sphere weight uses
radial interior distance. Outside weights are zero. Same-priority regions sort
by entity ID and share normalized weights: divide by `max(1, sum)`. Residual
source weight goes to the latest explicit `AudioSource.bus`; source volume and
musical stem gain remain independent.

Source routing and listener environment select independently. The first
propagated `AudioListener`, matching existing pose sync, controls shared wet/send
parameters. Missing listener restores the latest explicit wet/send settings.
Removing/disabled regions restores fallback; stop/despawn releases source taps.
`AudioBackend.setBusWet()` and `setBusSendGain()` update explicit values beneath
the automatic layer. Changing them while inside a region takes effect as its
weight recedes. Host uses its existing context clock and 10 ms native ramps.

> [!IMPORTANT]
> Limits are 128 enabled regions and 256 playing sources while regions exist.
> Compiled inverse transforms and native bus/send gains must remain finite f32 values.
> Region validation/capacity failures publish no spatial batch and retain the
> previous Host controls; ordinary playback remains independent. Missing graph
> references fail through `getState().lastError`, without a Master substitution.
> Repair the author reference and publish a changed region/control explicitly;
> requests are not Host acknowledgments and no automatic retry is promised.

`createAcousticRegionSystem().update(world, backend)` is the same projection for
hosts that schedule Audio directly. The plugin owns one projection per World;
rebuild creates a fresh one. Unchanged weights/environment publish no regional
intents. Queries scan at most the declared capacities with cached inverses; no
physics trigger, BVH, reverb preset asset, occlusion solver, multiple-listener
mixing or geometry-derived impulse response is added.

[The frozen acceptance contract](../audio-webaudio/bench/acoustic-contract.md)
records geometry/PCM oracles, negative controls and performance/resource budgets.

## Error model (charter P3 explicit failure)

Immediate audio failures use `Result<T, AudioError>` or the existing audio state. Musical admission and execution report bounded `MusicFailure` receipts; GUID resolution preserves the asset owner failure. Consume each closed code union with an exhaustive switch; its source owns the member list.

| code | trigger | hint |
|:--|:--|:--|
| `context-creation-failed` | `new AudioContext()` threw or returned null | check browser supports AudioContext; verify no privacy extension blocks audio |
| `decode-failed` | `decodeAudioData(arrayBuffer)` rejected | ensure audio file is a valid wav/mp3/ogg/flac at the GUID path |
| `context-suspended` | play() called while AudioContext is suspended and gesture listener failed | call play after user gesture (click/tap/keydown) to trigger resume() |
| `invalid-clip-handle` | AudioSource.clip handle is dangling | verify clip was registered via AssetRegistry.register() before spawning |
| `bus-not-found` | AudioSource.bus is outside `'sfx' \| 'music'` | use 'sfx' or 'music' bus literal; custom bus names not supported in v1 |

Each error carries 4-field structured surface: `.code` / `.expected` / `.hint` / `.detail`. `.detail` is narrowed per-code via discriminated union (e.g. `decode-failed` carries `reason: string`).

## Known limitations

- **bounded live gain transitions** -- WebAudioEngine `setVolume`, `setBusVolume`, and `setBusMute` cancel prior automation at `AudioContext.currentTime` and schedule one 10 ms linear transition to each finite, non-negative target. Initial pre-start gain setup remains immediate.
- **Long source formats** -- streaming currently accepts PCM16 RIFF/WAV; compressed sources retain explicit buffered playback.
- Speed changes also change pitch; independent time stretching is outside this contract.
- **No audio-specific Inspector method** -- use `app.execution.report().audio` or the existing Remote execution root.

## Related packages

- [`@forgeax/engine-audio-webaudio`](../audio-webaudio) -- Host implementation (`createWebAudioBackend`, `createHostAudioConsumer`)
- [`@forgeax/engine-ecs`](../ecs) -- `defineComponent`, World, Entity, System, Resource
- [`@forgeax/engine-app`](../app) -- `createApp({ plugins: [audioPlugin()] })` injection
- [`@forgeax/engine-types`](../types) -- `AudioErrorCode`, `AudioError`, `AudioClipAsset` type definitions SSOT

## Simulation participant boundary

The realm-neutral audio package may contribute a ready participant whose state
is portable data. ECS remains the single owner of `record`, `restore`, `trace`,
comparison `report`, numeric `tolerance`, and closed `error` values.

Use the minimum path with a source World and a fresh target. Compare semantic
audio intent counts and cleanup invariants; never serialize `AudioContext`,
`AudioBuffer`, source nodes, or a host consumer. The Web Audio package remains
Host-owned and consumes intents after the simulation boundary.

When restore or comparison fails, switch on the returned code and follow its
`expected`, `hint`, and `detail`; do not parse messages or silently drop audio.
This seam is not RHI tape replay and does not define a game replay format.

## Spatial source pose

Attach `Transform` to a spatial `AudioSource`. After Scene propagation, audio
reads the optional `GlobalTransform.world`: translation becomes the emitter
position and normalized local **-Z** becomes its forward direction. Parenting
and scale therefore use the same Scene authority as rendering. A spatial source
without a transform uses the origin and -Z; removing its transform resets to
that pose. No separate audio transform is authored.

The first play carries `sourcePose`; later `set-source-pose` intents carry only
changed poses, including during decode and pause. Stationary and 2D sources emit
no pose updates. The Host owns retained panners and applies the latest pending
pose before starting a decoded source. Stop/despawn/replacement/disposal keep
the existing async fencing and cleanup.

```ts
world.spawn(
  { component: Transform, data: { pos: [4, 0, -2] } },
  { component: AudioSource, data: {
    clip, playing: true, loop: true, spatialBlend: 1,
    coneInnerAngle: 60, coneOuterAngle: 120, coneOuterGain: 0.1,
  } },
).unwrap();
```

`spatialBlend > 0` selects spatial routing; fractional values do not crossfade.
Routing, loop, bus and cone settings are sampled on the playing edge; stop and
restart to change them. Live pose, volume, rate, pause and seek controls remain live.
The native inverse-distance model uses reference distance 1 and rolloff 1.
Directional cones affect gain, not obstruction, diffraction, Doppler or room
acoustics. [Native measurements and reproduction](../audio-webaudio/bench/spatial-results.md).

## Quantized layered music

`MusicScore` is saved author data referencing ordinary buffered audio GUIDs. Use the
same Import/Cook/Pack/Catalog route as `AudioSource`; `loadMusicScore` resolves those
GUIDs through the caller's existing asset service. It creates no music catalogue.
Game section policy is a complete stem weight vector, rather than another FSM.

```ts
import { loadMusicScore, type AudioBackend, type AudioClipAsset } from '@forgeax/engine/audio';

const prepared = await loadMusicScore(savedScore, guid =>
  assets.loadByGuid<AudioClipAsset>(assets.parseGuid(guid)));
if (!prepared.ok) throw prepared.error;
// This preparation runs on the Host, before Worker game controls are admitted.
const audio = hostAudioBackend;
audio.music({ kind: 'prepare', requestId: 1, score: prepared.value });

// In ordinary Update work, wait for Host decode admission and consume its epoch.
const music = audio.getState().music;
if (music?.phase === 'ready') {
  audio.music({ kind: 'mix', requestId: 2, epoch: music.epoch,
    boundary: 'bar', late: 'next-boundary', gains: [1, 0, 0.5, 0], fadeBeats: 1 });
}
// Inspect the receipt before advancing game policy; request IDs increase once.
const receipt = audio.getState().music?.receipts.find(row => row.requestId === 2);
```

For an execution-bootstrap project, load clips with the existing Host asset service
and call `consumer.prepareMusic(1, prepared.value)` in `execution.createHostAudio`.
Return that same consumer. Engine Worker game code reads its epoch and sends only
`mix`, `cancel`, `pause`, `resume` and `tempo`; the music wire union excludes
preparation. A prepare request through `createAudioIntentBackend` returns a structured
`invalid-command` receipt before publication. Encoded music bytes never enter
bootstrap data or Worker music intents; native buffers and nodes stay on the Host.

The Host rounds absolute targets to its existing Context sample grid and schedules
all stems and envelopes natively. Frame delivery changes admission latency, never
individual stem onset. Worker game code receives bounded music state in the next
accepted frame; Host consumers observe the same state through the existing audio
report. An `applied` receipt means the Context crossed the admitted target, rather
than an assertion about physical speaker latency.
The `ready` receipt records `targetBeat: 0` and its native epoch origin in
`targetTime`; sources remain silent until a mix is admitted. A tempo/resume receipt
records the preserved beat at its new native anchor.

| Command / bound | Contract |
|:--|:--|
| `prepare` | BPM 20..400, quarter-note beats/bar 1..16, loop beats 1..1024, 1..16 buffered stems. Offsets round to native samples; every resampled buffer must enclose its declared loop. Adoption waits for all decodes and fences content replacement |
| `mix` | Complete 0..1 gain vector; beat/bar boundary. Omitted `atBeat` selects the next boundary; explicit beat rounds upward to the chosen boundary. Zero vector audibly stops layers; muted stems retain phase |
| `late` | A target requires 20 ms native margin. `reject` reports `missed-boundary`; `next-boundary` records the deferred target. No silent immediate fallback |
| `fadeBeats` | 0..16 beat linear native gain ramp. Overlapping envelopes or equal targets reject; cancel the previous request before replacing it |
| `cancel` | Removes an unstarted envelope using its original request ID and the same margin. Already started work refuses cancellation |
| `pause` / `resume` | Pause freezes beat and releases sources; resume preserves beat/weights, creates common-time sources, and retires the previous epoch |
| `tempo` | Preserves beat/weights, retires queued old-epoch work, and restarts after the native margin. Sample advance and pitch change together; rounded loop duration is compensated so the musical period does not accumulate rounding drift |
| Lifetime | Preparation replacement, pause/resume/tempo and disposal retire epochs. Duplicate IDs cause no second execution and preserve the original receipt. IDs monotonically increase for one consumer lifetime |
| Retention | 128 pending envelopes, 256 latest receipts, 16 sources plus 16 stem gains. Shared publication/decode budgets also cover ordinary SFX. Capacity refuses native changes |

Music is routed through the existing `music` bus, multiplying its manual and automatic
controls. Context suspend freezes this same clock; gesture resume continues native
schedules without a second timer. Context close and World rebuild retire the Host
owner and its nodes. Streaming stems return `unsupported-stream`; MIDI and independent
time stretching are outside this capability. The closed failure vocabulary and
recovery fields live in [`src/music.ts`](src/music.ts).

[Source choices and frozen measurement contract](../audio-webaudio/bench/music/contract.md)
