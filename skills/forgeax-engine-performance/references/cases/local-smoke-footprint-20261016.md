# Local smoke: remove empty composite work at the view boundary

[Engine 4087](https://github.com/ForgeaX-Games/forgeax-engine/pull/4087)
bounded the existing five-tap volume composite without changing its optics,
sampling, density ownership or temporal reconstruction. The
[source report](../../../../packages/render/reports/smoke-composite-rectangle-20261016.json)
contains the contracts, native comparisons and timing pairs.

## Choose the boundary that owns the work

| Observation | Action and limit |
| --- | --- |
| Every local medium is outside the actual view | Use the existing `volumetricFogForView` admission before density residency/upload. Retain accepted resources for reentry; removing Game components would change their lifetime. |
| A medium intersects the view but covers a small screen area | Project the current accepted owners and scissor the composite encode. Its graph topology stays stable as the rectangle moves. |
| One of several media intersects the view | Retain the complete source set: other owners can affect integration subdivision and lighting. Bound the union, rather than independently dropping owners. |
| Camera is inside a medium, projection crosses the near plane, or target/view semantics are unsupported | Preserve the ordinary full draw. An uncertain projection is not an empty source. |
| A smoke marker appears beside a long completed-frame interval | Join the actual frame tasks and GPU receipts. A HUD zone count identifies gameplay appearance, not visibility, cold compilation or the cause of that interval. |

Use the current view-projection and actual target extent. A revision cache keyed
only by the source bounds misses camera motion. Round the rectangle outwards and
restore the encoder's full scissor after the draw so later passes retain their
own viewport behavior.

## Derive spatial support through temporal reconstruction

The original temporal shader clamps reprojected history to the current 3x3
minimum/maximum. Beyond that current support, even non-vacuum old history clamps
to vacuum. Bilinear reconstruction and the composite's neighboring samples also
expand support. This implementation pads by three resolved texels and two target
pixels, derived from those particular kernels; recalculate the bound when either
kernel changes.

| Native falsifier at 1920x1080 | Result |
| --- | --- |
| Authored nonempty grenade density, multiple sources and viewport edges | Unclipped and clipped outputs matched. |
| Shrinking/moving sources, camera motion and non-vacuum history across the old screen | No history outside the conservative rectangle was lost. |
| Near clipping and full-draw fallback | Ordinary command coverage was retained. |
| Eight cases, each comparing 17,418,240 readback bytes | Zero differing bytes; seven partial rectangles covered 1.31%-37.85% of the target. |

## Keep raster savings separate from frame acceptance

The native experiment used Apple Metal 3, the actual grenade density and canonical
integration/temporal/composite shaders, with a shared fixed injection input. It
qualifies the affected chain, not the complete four-pass World workload. Paired
timings were noisy and did not establish a universal saving from rectangle area.

The earlier game's roughly 5 ms composite interval was a recorded pass boundary;
some receipts shared timestamp beginnings with other work. Preserve individual
pass intervals and their overlap, using the existing
[GPU timing analyzer](../toolbox.md), before attributing exclusive cost. Neither
rectangle area nor summed overlapping intervals is removable frame latency.

The later
normal-SDK Game capture
combined this change with two Game material guards: full authored presentation,
1080p, three 1024 shadow cascades, five-tap shadows, GTAO and five-tap smoke,
normal 5v5 with continuous player wall fire. Test-only invulnerability and
infinite player ammunition retained finite bot magazines and original firing
cadence; destruction stayed disabled by the selected product default. It
qualified the workload at
32.27 completed FPS, p95 40.6 ms and maximum 144.8 ms, below the 54/60 FPS target.
That run had no fresh GPU sampling or matched A/B; it does not assign its FPS
change to smoke. Its worst interval was about 3.17 seconds after the first smoke
HUD marker, so that interval alone does not demonstrate a cold smoke preparation
stall. Follow [slow-frame attribution](../slow-frames.md) before another preload
or shader rewrite.
