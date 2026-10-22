# PR 225 Browser Check Repair

The failed checks on View `275c9e365d16838cd26e60e37ab51c1b343eb105` have two
browser-test causes. Build, architecture, sensitive scanning and browser shards
2/3 passed. Bootstrap failed because browser shards 0/1 failed.

## Failure and Fix

| Check | Original failure | Repair |
| --- | --- | --- |
| browser 1 | Runtime content waited for a standalone `Default` label in Mesh Properties, which the compact card replaced with `0 · Default`. | Scope the assertion to `mesh-material-slot-0` and check its exact indexed heading. |
| browser 0 | The Game 3D gesture produced only a pointer event on a DIV with `focused: false`, no keyboard events and no horizontal player displacement. | Wait for the Engine-owned startup overlay to be hidden, bring the test page forward, perform the real click and verify game-document focus before pressing keys. |

The selected Engine's startup owner keeps input disabled throughout its
completed-frame fade. A completed-frame count does not establish that the input
guard has retired. The existing Scene/Play probe already waits for the same
overlay-hidden condition. The repair consumes that DOM state and never removes
the overlay, enables input directly or dispatches synthetic gameplay events.

The original sixty-completed-frame gate, actual keyboard/mouse input, player
movement, Eject blocking, Possess restoration, World identity, native captures,
GPU-resource cleanup, live generation, source download and cold reopening remain
intact. No timeout, workload, CI configuration or Engine source is changed.

The dependency-identity rejection messages earlier in shard 0's log are expected
negative tests: the falsifier itself passed. They are not additional failures.

## Verification Boundary

Local runs use the already installed Engine `284f102`, with the startup owner
confirmed unchanged at CI's pinned `635e6bce68445fc4a22c9fa9dbd8a92b5c9fa778`.
The full 613-test suite and seven browser workload/sandbox checks pass. The
real Game 3D journey passes, including focused canvas key events, nonzero
horizontal movement, Eject/Possess and View/backend cleanup. The JavaScript and
TypeScript live runtime-content journeys pass the new card assertion and retain
their publication, geometry, save/restore and repeated GPU-retirement checks.

Both JavaScript and TypeScript cold-reopening journeys also pass in fresh
backends, Apps and browsers with only their saved snapshots supplied. All four
runtime cases retain at least sixty completed Scene frames and two repeated
resource cycles with zero retained GPU buffers/textures. The bounded
[result summary](check-repair-results.json) is derived from the native result
files and contains no connection credentials or image payloads.

Exact-head remote CI results are reported in the PR. Local evidence and remote
Linux/Chrome acceptance remain separate.
