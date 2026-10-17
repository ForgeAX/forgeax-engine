# Loading preparation and compact fixed query indices

## Scope and evidence

Engine `86f4e769`, Voxel `62e2239` then `a47d977`, full Dust2 map,
46 materials, nine real character rigs, native physics and actual AI fire.
The producer comparison retained 180 World ticks and 170 AI shots with equal
state, query, movement, navigation and publication results. Node owner timings
and after-GC storage are separate from Chrome completed-picture FPS.

| Evidence | Durable report |
| --- | --- |
| Eager preparation, missing first construction and initial memory cost | Loading producer |
| Compact private index, complete owner and adverse loader result | Compact index owner |
| Combined actual default combat after pipeline-manifest refresh | Composed combat |

## Move the actual first-use work

The existing selection-keyed private index was working: observed constructions
were distinct owner/filter captures at unchanged revision, rather than repeated
invalidation. A public per-admitted-Body preparation operation reused that exact
capture/index owner. Game called it inside loading admission for current map
owners and both actual filters. It did not fire a rehearsal shot, create unused
assets, expose unready bodies or add a new invalidation epoch.

| Population or cost | Lazy observation | Eager observation |
| --- | ---: | ---: |
| Loading index constructions | 39 | 683 |
| LIVE first constructions | 51 | 0 |
| Additional loading constructions | 0 | 644 |
| Additional reachable heap | Baseline | About 59.57 MB |

The explicit inserted preparation took 74.817 ms in one instrumented producer.
That is not total startup latency or a Chrome first-shot improvement. Preparing
the complete map touched many more captures than the recorded fireline needed.

## Replace the private fixed representation

Source and retained-memory partitioning found about 26.46 MB in added
snapshots/selections and 33.07 MB in the derived tree. This particular tree was
constructed once per immutable selection and used only for `queryBounds`.
Its generic dynamic representation retained membership, parent/height state,
child arrays and duplicate tight/padded bounds.

The replacement retained IDs and binary64 bounds in compact fixed storage.
It kept closed intersection, original candidate order, extreme-arithmetic and
rotation fallbacks. Edits still replace the ordinary selection/index. The
generic moving-Body tree was unchanged. Contracts covered current/old
publications, held admission, changes, poses, callback behavior and disposal.

| Complete local observation | Before | After |
| --- | ---: | ---: |
| Preparation plus 180 real World ticks | 570.360 ms | 546.888 ms |
| Additional index reachable heap | 33,070,712 B | 4,857,392 B |
| Additional index reachable ArrayBuffers | 0 B | 3,957,816 B |
| Additional index storage total | 33,070,712 B | 8,815,208 B |
| Complete asset-loader wall mean | 10.819 s | 11.069 s |

The four-arm local CPU owner improved about 4.12%; added index storage fell
24,255,504 bytes. The full loader moved adversely under its IO/JIT workload.
Intermediate forced collections in the memory experiment invalidate its wall
time as a loading benchmark. Neither external bytes nor RSS is silently added
again to the backing-buffer population.

## Preserve the remaining failure

The subsequent ordinary 30-second composed combat captured LIVE mean 59.16 FPS,
minimum rolling second 51.88 FPS and a 47.6 ms maximum interval. Its exact first
wall receipt interval was 34.9 ms and READY entry was 68.9 ms. Shared-machine
observations remained dirty; the previous better arm cannot establish causal
gain or replace this failure. The optimization reduced a proven local owner
and retained storage; stable rolling 54/60 and cold continuity remained open.
