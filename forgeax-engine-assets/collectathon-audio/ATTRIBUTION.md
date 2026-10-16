# Attribution for collectathon-audio/ assets

These audio cues drive the `apps/collectathon` showcase game: footstep loop,
Core pickup chime, Guardian growl, and a looping background track.

## License status: commercial-compatible (Apache-2.0, engine-authored)

Every file in this directory is **procedurally generated, original audio
authored by the forgeax engine project** (a small synthesis script produced the
PCM samples — sine/FM tones + shaped noise bursts). They carry **no third-party
license** and are governed by the same Apache-2.0 license as the parent
`forgeax-engine-assets` top-level tree (see the repo-root `README.md` license
boundaries). They satisfy AC-19 "distributable assets must be commercial-
compatible, no CC BY-NC 4.0": engine-authored originals are unencumbered.

> [!IMPORTANT]
> **Placeholder quality.** These are functional-but-synthetic stand-ins so the
> 3D spatial-audio path (AudioSource / AudioListener / spatialBlend / dual bus)
> is genuinely exercised and audible. The plan called for curated
> Pixabay/Freesound CC0 cues, but the implement sandbox has no network access
> (Pixabay returns HTTP 403). Replacing these with hand-picked
> commercial-compatible recordings is a follow-up for verify / a human — the
> wiring, GUIDs, and license posture stay identical when the WAV bytes are
> swapped. Tracked in the M5 milestone report concerns.

## Files

| File | Role | GUID | Source |
|:--|:--|:--|:--|
| `footstep-1.wav` | footstep variant 1 | `201222ef-ccf4-4538-96ce-14a96ecc993d` | engine-authored synth |
| `footstep-2.wav` | footstep variant 2 | `8f87b826-bcec-4be1-9ea1-caa964b0a9ba` | engine-authored synth |
| `footstep-3.wav` | footstep variant 3 | `724242e6-5df8-44b8-9b41-0e430d1acc2c` | engine-authored synth |
| `pickup.wav` | Core pickup chime | `2e23f877-a9e3-40cc-ba75-1126aef34cce` | engine-authored synth |
| `guardian.wav` | Guardian growl | `49c2c8b1-8091-4e9e-b782-f658ee4e31b0` | engine-authored synth |
| `bgm-loop.wav` | looping background music | `3b298083-a2bc-496f-91fb-80e5bb8cfe48` | engine-authored synth |

## Distribution boundary

These files are commercial-compatible and MAY ship in a distributable runtime
asset pack (unlike `vendor/fbx-test/humanoid.fbx`, which is an Autodesk-licensed
demo-only fixture — see that directory's `ATTRIBUTION.md`). The collectathon
game currently loads them via `pluginPack` + `loadAudioClipByGuid` at runtime,
the same path the audio cues for any shipped game would use.
