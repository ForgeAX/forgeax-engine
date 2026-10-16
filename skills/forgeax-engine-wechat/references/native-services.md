# Native services through existing domain owners

Read the current [platform-wechat contract](../../../packages/platform-wechat/README.md)
before composing services. Import the focused public Engine subpath; wire each
lease into the existing Host lifecycle. Keep actual native callbacks and domain
results in the same evidence directory as the package identity.

| Task | Owner and verification |
|:--|:--|
| Binary multiplayer connection | `createWechatSocketConnector` implements NetEndpointConnector through task-local `wx.connectSocket`. NetSession owns reconnect/ACK/session policy. Verify actual binary slices, remote close, abort before open and replacement attachment. |
| Remote Catalog/Pack bytes | `createWechatRemotePackageFetcher` provides the existing PackageFetcher. Use the producer's HTTPS root and publication digest; configure native download domains. Verify an actual asset load, HTTP failure status and original permission/timeout causes. |
| Persistent byte cache | Give the Host a dedicated user-data directory and byte budget. Restart, corrupt one stored file, force producer recovery with `cache: 'reload'`, test quota/eviction, then verify the ordinary asset path again. Adopted resource lifetime remains with AssetRegistry. |
| Audio | `createWechatAudioBackend` binds a lazy native WebAudioContext to the existing AudioBackend and Web Audio owner. Verify actual decoded bytes, source/panner controls, visibility/interruption and native close; qualify phone output separately. |

For remote reads, pass `directory` at the top level even without caching; optional
`cache` contains only `publicationDigest` and `maxBytes`. The reader supplies this
owned destination to `wx.downloadFile` and validates the returned `filePath`.
Do not use or unlink WeChat-managed `tempFilePath` URLs: the official simulator
rejects that deletion with permission denied. Native recursive `mkdir` also
rejects existing directories, so open them before creating them.

`onError` must retain recoverable storage and late-cleanup
failures. Dispose the reader before reusing its directory. Native file
operations cannot be cancelled mid-call: cancellation prevents adoption while
the operation and download terminal callback drain. Record a stuck callback as a host failure, not successful
disposal. Temporary native download files and interrupted cache staging files
must be removed without deleting active resource state.

Native `memory-pressure` reaches the local App's AssetRegistry and releases only completed raw reads.
Pending reads, adopted payloads and Pack publication authority survive; this does not forward events to Workers or clear disk caches.

The deterministic resource tests use real local disk files and ordinary produced
Mesh/Catalog loading. Network tests include actual local socket traffic wrapped
in the native callback shape. These are owner regressions; run official simulator
operations before claiming native tool behavior, and qualify phones separately.

## Native audio composition and qualification

The generated ordinary Host installs `createWechatAudioBackend(wx, platform,
{ onError })` through the existing `audioBackendPlugin` and `audioPlugin`. A custom
Host does the same, then calls `audio.destroy()` after App retirement. The native
binding owns Context acquisition, touch resume, visibility/interruption leases and
close; `audio-webaudio` retains decode/cache, source, bus and spatial-node ownership.
The lazy borrowed Context factory creates no browser gesture listeners or global
AudioContext shim. Validate the actual AudioParam listener shape at demand; never
substitute InnerAudio for an incompatible Web Audio graph.

The official-simulator probe on 2026-10-11 passed native WAV decode to 48,000 mono
frames at 48 kHz, panner position, pause/seek/rate 1.5, two plays sharing one decode,
native suspend/resume driven by injected visibility/interruption callbacks, and
actual native `state: 'closed'` after disposal. No callbacks, source/cache bytes or
pending plays remained. Native methods may ignore monkey-patch assignment: inspect
their actual state instead of treating an absent instrumentation count as a leak.
When evaluating a bundled probe in the automator's driver realm, bind the game
realm's `structuredClone` and typed-array constructors explicitly.

Retain the bounded adapter unit test, `audio.browser.test.ts`, the existing
`audio-webaudio` spatial PCM tests and generated Host replacement test as owner
regressions. A supplemental simulator graph probe is separate from ordinary game
audio authoring and audible phone output. Physical background/interruption events,
phone codecs and Android/iOS output remain target qualifications. Streamed PCM
needs the audio owner's Range response/streaming-body/digest transport; the
complete-byte PackageFetcher does not supply that contract.
