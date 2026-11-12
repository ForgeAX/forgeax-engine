# Standard lighting-lane parity fixture

Standard direct-vs-clustered pixel-parity fixture.

Renders the same scene (≤ 4 PointLight) twice — left canvas through the
Standard direct-lighting lane, right canvas through the Standard
clustered-lighting lane — and
exposes `window.__captureLeft` / `window.__captureRight` for the
`scripts/bench/pixel-parity.mjs` runner.

## AC-22 gate

- **AC-22 target** — Standard direct-vs-clustered pixel parity ε ≤ 0.001 (normalised), ≤ 4
  PointLight subset.
- **Frozen threshold** — the package metric keeps the pixel-count threshold at
  zero with per-pixel epsilon `0.001`; no empty-lane or legacy pipeline
  allowance is part of this gate.

The renderer profile and lane identity are the only configuration difference;
no pipeline registry or install step is involved.

The two independent hosts initialize concurrently, then each World completes
its first scene picture before the peer submits. This keeps a cold GPU frame
from holding the other host's pending barrier behind native compilation.
Startup logs identify host preparation, World preparation and completed-frame boundaries.
Both capture hooks are published immediately and await the same initialization promise;
both ready completion receipts are required before either hook draws or reads pixels.
The Browser hook-availability deadline remains 30 seconds, each ready-frame deadline
remains 15 seconds and the regression case remains bounded at 90 seconds.
Both renderers, snapshots and pixel comparisons retain the ordinary scene path.

The single-cube lighting fixture sets `gpuOcclusion: false`: no object can
occlude another, so building a hierarchical-depth pyramid adds unrelated cold
GPU work. GPU visibility, cluster membership and indirect PBR draws remain
active. The Browser regression also enables the default occlusion path on both
real devices and requires byte-identical pictures before restoring the lighting
profile and running the original light removal/restoration controls.
